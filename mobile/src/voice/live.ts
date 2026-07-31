/**
 * The spoken assistant: the phone's microphone and speaker wired straight to
 * Google, with the same tools the typed assistant has.
 *
 * What this replaces is the round trip — record a file, upload it, wait for a
 * transcript, wait for a reply, wait for that reply to be synthesised, play
 * it. Here audio streams while it is being spoken and the reply streams while
 * it is being said, which is most of the difference between an exchange and a
 * conversation.
 *
 * Why it is an assistant now, and not a mouth
 * -------------------------------------------
 * It used to be a relay: no tools, an instruction never to answer, the
 * transcript posted to /chat so the text assistant could think, and the
 * answer handed back for it to read aloud. That could not work, and the reason
 * is in the protocol rather than in the prompt. Closing a turn makes a Live
 * model generate; it generated an answer to the driver every single time, out
 * of nothing, because it had no tools and no car — "the battery is at 85%",
 * said with total confidence. The relay tried to swallow that audio with a
 * flag. Both the unwanted reply and the wanted one arrive on the same socket,
 * so the flag flipped mid-stream and the tail of a hallucination reached the
 * speaker in the assistant's own voice. That is the bug this rewrite removes,
 * and it removes it by giving the model nothing to invent: it holds the real
 * tools, so an answer about the battery is a tool call away.
 *
 * The two assistants are deliberately separate. This one owns the spoken
 * conversation and keeps its context inside the Live session; the typed one
 * owns /chat and keeps its history in the app. They share the tool list and
 * they share the gate — a sensitive command comes back parked from
 * /live/tool exactly as it does from /chat, and only a tap on the card runs
 * it. A model with tools still cannot open the car.
 */
import { Platform } from "react-native";
import { fetchLiveToken, runLiveTool } from "../api";
import { encodeWav } from "./recorder";

/**
 * Not the endpoint the Live documentation shows, and the difference is the
 * whole reason a first attempt failed.
 *
 * An ordinary API key opens `BidiGenerateContent` with `?key=`. An ephemeral
 * token — which is all a browser should ever hold — opens a *different*
 * method, `BidiGenerateContentConstrained`, with `?access_token=`, on v1alpha.
 * Sending a token to the documented endpoint is refused as "unregistered
 * caller"; sending it as `key=` is refused as an invalid key. Both look like
 * an authentication mistake and neither says which.
 *
 * Found by reading what the official SDK actually puts on the wire after every
 * documented combination had been tried and rejected.
 */
const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/** What the API expects on the way in. Not a preference — the stream is
 *  labelled with this rate, so audio that is actually at some other rate is
 *  played back to the model at the wrong speed. See resample() below. */
const INPUT_RATE = 16000;
/** What comes back. Different rate, hence its own context on playback. */
const OUTPUT_RATE = 24000;

/**
 * Nothing said and nothing happening for this long ends the conversation.
 *
 * The old loop counted empty turns because it drove the turn boundaries
 * itself. Turn detection now belongs to the model, which will happily listen
 * to an empty car until the token expires — so the guard has to be a clock.
 * It is reset by speech being recognised or by the assistant doing anything,
 * never by loudness alone: a car is a noisy room and road noise must not count
 * as company.
 */
const IDLE_TIMEOUT_MS = 90_000;

/** How much audio goes in one message. Small enough that the recogniser is
 *  never waiting on us, large enough that the main thread isn't encoding and
 *  sending a hundred times a second. */
const CHUNK_MS = 100;

/** How often the level meter is allowed to move. It only has to look alive;
 *  the audio thread hands over frames far faster than a screen refreshes. */
const LEVEL_INTERVAL_MS = 60;

/** How long to wait for the server to confirm the setup before treating the
 *  session as a failure worth falling back from. Generous, because this is a
 *  mobile connection, but finite — the alternative is a conversation that
 *  never starts and never says why. */
const SETUP_TIMEOUT_MS = 8000;

/** Longest stretch of one turn kept for re-transcription. The server refuses
 *  anything over ~1.5 MB and this is well inside it; a spoken command that
 *  runs past half a minute is not the case worth optimising for. */
const MAX_TURN_SECONDS = 30;

export interface LiveToolEvent {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Set when the command was parked rather than run — raise a card. */
  confirm?: { token: string; tool: string; args: Record<string, unknown> } | null;
}

export type LivePhase = "listening" | "thinking" | "speaking";

export interface LiveHandlers {
  /**
   * The driver said something, and this is what the session made of it —
   * plus the audio it made it from.
   *
   * Both, because they are not the same quality. The session's transcript
   * arrives instantly and is a general recogniser working blind; the audio can
   * be sent to the tuned transcription path, which knows the language and the
   * car vocabulary, and comes back right. The caller shows the first and
   * quietly replaces it with the second.
   *
   * `audio` is null when nothing was captured — a turn ended by a tool call
   * with no speech in it, or a session that has only just opened.
   */
  onUserTranscript: (text: string, audio: Blob | null) => void;
  /** The assistant said something, and this is what it was. */
  onAssistantTranscript: (text: string) => void;
  /** A tool ran (or refused to). Drives the instrument log and the cards. */
  onTool: (event: LiveToolEvent) => void;
  /** Listening / thinking / speaking, for the bar. */
  onPhase: (phase: LivePhase) => void;
  /** 0..1, for the listening indicator. */
  onLevel?: (level: number) => void;
  /** Long enough with nobody there. */
  onIdle: () => void;
  /** The session is gone and is not coming back — fall back to the old path. */
  onClosed: (reason: string) => void;
}

export function liveSupported(): boolean {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as any).webkitAudioContext)
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: String.fromCharCode with a very large spread overflows the
  // argument limit, and audio frames get long.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Linear resample, the same one the recorder uses and for the same reason: a
 * browser is free to ignore the sample rate an AudioContext asks for. Safari
 * commonly hands back 48 kHz whatever you request, and the fallback path below
 * — a context constructed with no options at all, after the requested one
 * threw — always does.
 *
 * Nothing warns you when that happens. The frames are still frames; they are
 * simply three times too many, and labelling them `rate=16000` tells the model
 * to play a sentence at a third of its speed. What comes back is a transcript
 * of something nobody said. The recorder has resampled since it was written;
 * this path streamed raw and got away with it only because Chrome on a desktop
 * honours the request.
 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

export class LiveSession {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private handlers: LiveHandlers;

  /** Which model this session actually opened on — the preferred one, or the
   *  fallback after it refused. Read by the caller for the log. */
  model: string | null = null;

  /** Set by stop(). Everything asynchronous checks it: a socket that closes
   *  because we closed it is not a session that died, and a frame that arrives
   *  after teardown must not reopen anything. */
  private closed = false;
  /** Transcript fragments for the turn in progress; the API sends them as
   *  they are recognised rather than in one piece. */
  private heard = "";
  private said = "";
  private speaking = false;
  /** The rest of this reply was cut off by a tap and must not be heard or
   *  logged. Cleared when the turn ends. */
  private suppressed = false;
  private idleAt = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  /** Audio waiting to make up a whole chunk, at the context's own rate. */
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private framePeak = 0;
  private lastLevelAt = 0;

  /** The current turn's audio, at 16 kHz, kept so it can be transcribed
   *  properly after the fact. Cleared when a turn ends and when the assistant
   *  starts speaking, so a reply leaking through the microphone is never part
   *  of the next question. */
  private turnAudio: Float32Array[] = [];
  private turnSamples = 0;

  /** Whether the microphone keeps streaming while the assistant talks. Off,
   *  the driver cannot interrupt by voice — which is the point of the setting:
   *  echo cancellation is not good enough on every phone and car speaker, and
   *  a reply that keeps interrupting itself is worse than a tap. */
  allowBargeIn = true;

  /** Where the next chunk of the assistant's speech goes. Kept as a moving
   *  cursor so chunks queue seamlessly instead of overlapping. */
  private playCursor = 0;
  private playingSources = 0;

  constructor(handlers: LiveHandlers) {
    this.handlers = handlers;
  }

  async start(voice: string, language?: string): Promise<void> {
    if (!liveSupported()) throw new Error("live audio unsupported here");

    // Must happen inside the gesture that started the conversation, like every
    // other audio path on iOS.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // Twice at most, and the second time is not a retry of the same thing.
    //
    // The live model is a preview, and a withdrawn preview does not fail where
    // you would expect: the server still mints a token for it — minting checks
    // the config, not the model's availability — and the refusal only appears
    // here, when the session will not open. So the second attempt tells the
    // server which model just refused, and it mints on the older one instead.
    // The microphone is already held and is kept across both.
    let refused: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { token, model, tools } = await fetchLiveToken(voice, language, refused);
      this.model = model;
      try {
        await this.openSocket(token, model, tools);
        break;
      } catch (e) {
        this.closeSocket();
        if (attempt === 1 || !model) throw e;
        refused = model;
      }
    }
    await this.startCapture();
    this.touch();
    this.idleTimer = setInterval(() => {
      if (!this.closed && Date.now() - this.idleAt >= IDLE_TIMEOUT_MS) {
        this.handlers.onIdle();
      }
    }, 5000);
    this.handlers.onPhase("listening");
  }

  private openSocket(
    token: string,
    model: string,
    tools: Record<string, unknown>[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // A query parameter rather than a header, which matters more than it
      // looks: browsers cannot set headers on a WebSocket at all, so a
      // header-only scheme would have made a direct connection impossible and
      // forced the audio back through our own server.
      const socket = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(token)}`);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      // Resolved by `setupComplete`, not by the socket opening.
      //
      // The distinction is what makes the fallback possible at all. A refused
      // model still opens the socket — the refusal arrives a moment later as a
      // close — so resolving on `onopen` reported success for a session that
      // was already dead, and the caller had no failure to retry. Waiting for
      // the server to confirm the setup means "started" means started.
      let ready = false;
      const fail = (reason: string) => {
        if (!ready) reject(new Error(reason));
      };

      socket.onerror = () => fail("live socket error");
      socket.onclose = (event) => {
        if (!ready) {
          fail(`live session refused (${event.code})`);
          return;
        }
        if (this.closed) return;
        this.handlers.onClosed(`closed ${event.code}`);
      };

      // Neither confirmed nor closed. Without this the conversation sits on a
      // dead socket rather than dropping to the path that still works.
      setTimeout(() => fail("live setup timed out"), SETUP_TIMEOUT_MS);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            setup: {
              model: `models/${model}`,
              generationConfig: { responseModalities: ["AUDIO"] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              // The tools are already bound to the token server-side; sending
              // the identical list changes nothing and costs one message. It is
              // here because a session that quietly ends up without tools is
              // exactly the failure this whole path was rebuilt to remove, and
              // "quietly" is the word that matters — a tool-less model does not
              // raise an error, it makes something up.
              tools,
              // Turn detection is the model's again, deliberately. Driving it
              // from here is what the old relay did, and it is why the model
              // was made to generate at moments nobody wanted an answer.
            },
          })
        );
      };

      socket.onmessage = (event) => {
        if (!ready && this.isSetupComplete(event)) {
          ready = true;
          resolve();
          return;
        }
        void this.onMessage(event);
      };
    });
  }

  private isSetupComplete(event: MessageEvent): boolean {
    try {
      const raw =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      return !!JSON.parse(raw).setupComplete;
    } catch {
      return false;
    }
  }

  /** Drop the socket without ending the session — used between the two
   *  connection attempts, where the microphone and handlers must survive. */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // already closing
    }
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (this.closed) return;
    let payload: any;
    try {
      const raw =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload.toolCall) {
      await this.runTools(payload.toolCall.functionCalls ?? []);
      return;
    }
    // The model gave up on calls it had asked for (the driver interrupted).
    // Nothing to undo: results are only ever sent for calls we actually ran.
    if (payload.toolCallCancellation) return;

    const content = payload.serverContent;
    if (!content) return;

    // What the driver said. Accumulated rather than replaced: it arrives in
    // fragments as recognition firms up.
    const heard = content.inputTranscription?.text;
    if (typeof heard === "string" && heard) {
      // New words from the driver start a new turn, whatever became of the
      // last one. Clearing here as well as on turnComplete is what keeps a
      // tapped-away reply from muting the next one: an interrupted generation
      // is not guaranteed to close its own turn, and nothing else would ever
      // lift the suppression.
      this.suppressed = false;
      this.heard += heard;
      this.touch();
    }

    const said = content.outputTranscription?.text;
    if (typeof said === "string" && said && !this.suppressed) {
      // The model has started answering, so whatever was heard is a finished
      // question — hand it up now, in the order it was said, rather than after
      // the answer it produced.
      this.flushHeard();
      this.said += said;
      this.touch();
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (!audio || this.suppressed) continue;
      if (!this.speaking) {
        this.speaking = true;
        // Anything the microphone picks up from here belongs to the reply, not
        // to the next question — echo cancellation is good, not perfect.
        this.clearTurnAudio();
        this.handlers.onPhase("speaking");
      }
      this.touch();
      this.play(decodeBase64(audio));
    }

    if (content.interrupted) {
      // The driver talked over the answer. Stop it mid-word — that is what an
      // interruption means — and keep whatever was said up to that point, so
      // the log matches what was actually heard in the car.
      this.stopPlayback();
      this.speaking = false;
      this.flushSaid();
      this.handlers.onPhase("listening");
      this.touch();
    }

    if (content.turnComplete) {
      this.suppressed = false;
      this.flushHeard();
      this.flushSaid();
      // Audio is queued ahead of the cursor, so the turn being complete is not
      // the same as the car having heard it. play()'s onended settles the
      // phase when the queue actually drains.
      if (!this.speaking || this.playingSources === 0) {
        this.speaking = false;
        this.handlers.onPhase("listening");
      }
    }
  }

  /**
   * Run what the model asked for, then tell it what happened.
   *
   * Sequentially, and that is a decision rather than an oversight: the backend
   * shares an "awake" cache and a wake-and-retry across calls, so two
   * concurrent commands would race to wake one car.
   *
   * A failure is reported to the model rather than thrown away — it can say
   * the charger lookup failed, or try a different one, which is a better car
   * than one that goes silent.
   */
  private async runTools(
    calls: { id?: string; name: string; args?: Record<string, unknown> }[]
  ): Promise<void> {
    if (!calls.length) return;
    this.suppressed = false;
    this.flushHeard();
    this.handlers.onPhase("thinking");
    this.touch();

    const responses: Record<string, unknown>[] = [];
    for (const call of calls) {
      const args = call.args ?? {};
      try {
        const outcome = await runLiveTool(call.name, args);
        this.handlers.onTool({
          tool: call.name,
          args,
          ok: outcome.ok,
          confirm: outcome.confirm ?? null,
        });
        responses.push({
          id: call.id,
          name: call.name,
          response: outcome.ok ? { result: outcome.result } : { error: outcome.error },
        });
      } catch (e) {
        // The backend was unreachable, or the session lapsed. Say so to the
        // model; the caller finds out separately when its own polling fails.
        this.handlers.onTool({ tool: call.name, args, ok: false, confirm: null });
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: e instanceof Error ? e.message : "tool call failed" },
        });
      }
      if (this.closed) return;
    }

    this.touch();
    this.send({ toolResponse: { functionResponses: responses } });
  }

  /** Hold on to the driver's audio, oldest dropped once the cap is reached —
   *  a turn that has run half a minute is no longer the sentence we want. */
  private keepForTranscription(samples: Float32Array): void {
    this.turnAudio.push(samples);
    this.turnSamples += samples.length;
    const cap = INPUT_RATE * MAX_TURN_SECONDS;
    while (this.turnSamples > cap && this.turnAudio.length > 1) {
      this.turnSamples -= this.turnAudio.shift()!.length;
    }
  }

  private clearTurnAudio(): void {
    this.turnAudio = [];
    this.turnSamples = 0;
  }

  /** The turn's audio as a WAV, and the buffer emptied. Null when there is too
   *  little to be a sentence — the server would reject it as silence anyway,
   *  and a request spent finding that out is a request wasted. */
  private takeTurnAudio(): Blob | null {
    const samples = this.turnSamples;
    const chunks = this.turnAudio;
    this.clearTurnAudio();
    if (samples < INPUT_RATE * 0.3) return null;

    const merged = new Float32Array(samples);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return encodeWav(merged, INPUT_RATE);
  }

  private flushHeard(): void {
    const text = this.heard.trim();
    this.heard = "";
    if (!text) return;
    this.handlers.onUserTranscript(text, this.takeTurnAudio());
  }

  private flushSaid(): void {
    const text = this.said.trim();
    this.said = "";
    if (text) this.handlers.onAssistantTranscript(text);
  }

  /** Something happened that means somebody is still there. */
  private touch(): void {
    this.idleAt = Date.now();
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  // --- microphone -------------------------------------------------------

  private async startCapture(): Promise<void> {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    try {
      this.inputContext = new Ctor({ sampleRate: INPUT_RATE });
    } catch {
      this.inputContext = new Ctor();
    }
    if (this.inputContext!.state === "suspended") await this.inputContext!.resume();

    this.source = this.inputContext!.createMediaStreamSource(this.stream!);
    this.node = await this.buildNode();
    this.source.connect(this.node);
    // Safari will not pull frames through a node that reaches nothing.
    const mute = this.inputContext!.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.inputContext!.destination);
  }

  /**
   * Take the microphone off the main thread.
   *
   * This path streamed through a ScriptProcessorNode, which is deprecated for
   * a concrete reason the recorder has known about since it was written: it
   * runs on the main thread, so a React re-render can make it drop samples
   * mid-sentence. That is worse here than there. The recorder merely collects
   * frames; this file was also encoding base64 and pushing a WebSocket message
   * inside the same callback, on the same thread that renders the chat — while
   * the driver was talking and the list was growing. Dropped samples do not
   * announce themselves. They arrive at the model as a sentence with holes in
   * it, and it answers the sentence it heard.
   *
   * Same worklet the recorder loads, so there is one audio-thread module to
   * keep working rather than two. The ScriptProcessor stays as the fallback:
   * occasional dropped samples beat no microphone at all.
   */
  private async buildNode(): Promise<AudioNode> {
    const context = this.inputContext!;
    try {
      await context.audioWorklet.addModule("/amp-recorder-worklet.js");
      const worklet = new AudioWorkletNode(context, "amp-recorder");
      worklet.port.onmessage = (event) => this.onFrame(event.data as Float32Array);
      return worklet;
    } catch {
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) =>
        this.onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
      return processor;
    }
  }

  /**
   * Collect the frame, and light the level meter.
   *
   * The worklet hands over 128 samples at a time — eight milliseconds. Sending
   * each one as its own message would be a WebSocket frame every 8 ms, all of
   * it base64 and JSON, which is how you turn an audio-thread fix back into a
   * main-thread problem. They are gathered into CHUNK_MS instead and sent in
   * one piece, which is also the cadence a streaming recogniser expects.
   *
   * No speech detection here any more. Deciding where a turn ends is the
   * model's job now — it has the whole utterance and far better evidence than
   * a peak level — and doing it in two places was how the old path ended up
   * asking for answers nobody wanted. The peak that remains drives the
   * listening indicator and nothing else, throttled because a state update
   * 125 times a second is exactly the render pressure that made the old
   * capture drop samples.
   */
  private onFrame(frame: Float32Array): void {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return;

    let peak = 0;
    for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
    this.framePeak = Math.max(this.framePeak, peak);
    const now = Date.now();
    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;
      this.handlers.onLevel?.(this.framePeak);
      this.framePeak = 0;
    }

    // With barge-in off the uplink goes quiet while the assistant talks, so
    // neither the reply leaking through the speaker nor the driver's own voice
    // can cut it short. A tap still interrupts.
    if (this.speaking && !this.allowBargeIn) {
      this.pending = [];
      this.pendingSamples = 0;
      return;
    }

    this.pending.push(frame);
    this.pendingSamples += frame.length;

    // Measured against the context's real rate, so a chunk is the same length
    // of *time* whatever rate the browser decided to give us.
    const rate = this.inputContext?.sampleRate ?? INPUT_RATE;
    if (this.pendingSamples < (rate * CHUNK_MS) / 1000) return;

    const merged = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const chunk of this.pending) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingSamples = 0;

    // The context's real rate, not the one that was asked for.
    const samples = resample(merged, rate, INPUT_RATE);
    this.keepForTranscription(samples);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.send({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_RATE}`,
          data: encodeBase64(new Uint8Array(pcm.buffer)),
        },
      },
    });
  }

  // --- turns ------------------------------------------------------------

  /**
   * Cut the answer off — the tap on the bar, and the only interruption
   * available when voice barge-in is switched off.
   *
   * Nothing is sent to the model, and that is the point. The obvious message
   * to send is a completed empty turn, which is also an instruction to
   * generate: it would answer a question nobody asked, in its own words, which
   * is the exact failure this file was rewritten to remove. So the rest of the
   * reply is simply dropped as it arrives — silenced here, not cancelled
   * there. Interrupting by *voice* is different and needs no help: the model's
   * own turn detection hears it and stops, and says so with `interrupted`.
   */
  interrupt(): void {
    if (!this.speaking) return;
    this.stopPlayback();
    this.speaking = false;
    this.suppressed = true;
    this.flushSaid();
    this.handlers.onPhase("listening");
    this.touch();
  }

  // --- playback ---------------------------------------------------------

  /**
   * Queue one chunk of the reply.
   *
   * Web Audio, because a stream still arriving cannot be handed to an <audio>
   * element. That was the open risk on iOS: Web Audio obeyed the ringer switch
   * when it was first measured, where an element did not, which would have
   * left a streamed voice mute in a car.
   *
   * Measured since, on the target phone: declaring the session as playback
   * lifts it. `audioSession.type` reads back as "playback" and the tone was
   * audible with the switch silent. Hence the assignment below being made
   * before the first chunk rather than hopefully somewhere at startup — it is
   * load-bearing, not decoration.
   */
  private play(pcm: Uint8Array): void {
    if (!this.outputContext) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.outputContext = new Ctor({ sampleRate: OUTPUT_RATE });
      try {
        const session = (navigator as any).audioSession;
        if (session) session.type = "playback";
      } catch {
        // Nothing to do; the fallback path is the caller's business.
      }
    }
    const context = this.outputContext!;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Chunks are scheduled end to end rather than "now", or they overlap into
    // an unintelligible mess when several arrive at once.
    const startAt = Math.max(context.currentTime, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + buffer.duration;
    this.playingSources += 1;
    source.onended = () => {
      this.playingSources -= 1;
      if (this.playingSources === 0 && this.speaking && !this.closed) {
        this.speaking = false;
        this.handlers.onPhase("listening");
      }
    };
  }

  private stopPlayback(): void {
    // Closing the context is the only reliable way to silence sources already
    // scheduled ahead of the cursor; a fresh one is made on the next chunk.
    try {
      this.outputContext?.close();
    } catch {
      // already gone
    }
    this.outputContext = null;
    this.playCursor = 0;
    this.playingSources = 0;
  }

  /**
   * End the session and give the microphone back.
   *
   * Every release is its own statement rather than one shared `try`. That is
   * the whole bug it fixes: the microphone used to be stopped in the middle of
   * a block that started by disconnecting audio nodes, so one throw on the way
   * — a context already closed, a node already gone — skipped it, and Chrome
   * went on showing the tab as recording after the conversation had visibly
   * ended. The stream is released first now, because it is the only step whose
   * absence is visible from outside the app.
   */
  stop(): void {
    this.closed = true;
    this.speaking = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;

    try {
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {
      // already stopped
    }
    this.stream = null;

    // Detached before the context closes, so neither capture path goes on
    // handing over frames it would try to encode against a socket that is
    // already going away.
    try {
      if (this.node && "port" in this.node) {
        (this.node as AudioWorkletNode).port.onmessage = null;
      } else if (this.node) {
        (this.node as ScriptProcessorNode).onaudioprocess = null;
      }
    } catch {
      // already torn down
    }
    this.pending = [];
    this.pendingSamples = 0;
    this.clearTurnAudio();
    try {
      this.source?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.node?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.inputContext?.close();
    } catch {
      // already closed
    }
    this.source = null;
    this.node = null;
    this.inputContext = null;

    this.stopPlayback();

    try {
      this.socket?.close();
    } catch {
      // already closing
    }
    this.socket = null;
  }
}

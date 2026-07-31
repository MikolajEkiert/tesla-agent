/**
 * A live audio session: the phone's microphone and speaker, wired straight to
 * Google, with this app's assistant still doing all the thinking.
 *
 * What this replaces is the round trip — record a file, upload it, wait for a
 * transcript, wait for a reply, wait for that reply to be synthesised, play
 * it. Here audio streams while it is being spoken and the reply streams while
 * it is being said, which is most of the difference between an exchange and a
 * conversation.
 *
 * What it deliberately does not replace is the assistant. The session is
 * opened with no tools, so it can hear and speak and nothing else; the
 * transcript goes to /chat exactly as a typed message would, and the answer
 * comes back through the same confirmation gate. One door, still.
 *
 * The awkward part, stated plainly because it shapes the whole file: a live
 * model's instinct is to *answer*. Left to itself it would reply to the driver
 * in its own words, which is precisely the second opinion this architecture
 * refuses to have. So automatic turn detection is switched off and the turn
 * boundaries are driven from here — the session is told when speech starts and
 * stops, and is only ever asked to generate when we hand it the assistant's
 * words to read. It transcribes continuously either way.
 */
import { Platform } from "react-native";
import { fetchLiveToken } from "../api";
import { BLOCK_SIZE, classifyBlock, HOP_SIZE, SPEECH_EVIDENCE } from "./vad";

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

/** What the API expects on the way in, and what the recorder already makes. */
const INPUT_RATE = 16000;
/** What comes back. Different rate, hence its own context on playback. */
const OUTPUT_RATE = 24000;

/** How long a hush ends the driver's turn. Same figure the recorder used —
 *  it was measured against real speech and there is no reason to re-guess it. */
const SILENCE_MS = 1100;

/** Nothing said for this long ends the turn as empty rather than holding the
 *  microphone open indefinitely. */
const NO_SPEECH_MS = 8000;

export interface LiveHandlers {
  /** The driver finished saying something, and this is what it was. */
  onTranscript: (text: string) => void;
  /** A turn went by with nothing said in it. */
  onSilence: () => void;
  /** The driver started talking over the assistant. */
  onBargeIn: () => void;
  /** The assistant's audio finished playing. */
  onSpokenEnd: () => void;
  /** 0..1, for the listening indicator. */
  onLevel?: (level: number) => void;
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

export class LiveSession {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private node: AudioNode | null = null;
  private handlers: LiveHandlers;

  /** Transcript fragments for the turn in progress; the API sends them as
   *  they are recognised rather than in one piece. */
  private transcript = "";
  private listening = false;
  private speaking = false;
  private activityOpen = false;

  private inBandSamples = 0;
  private consonantSamples = 0;
  private pendingBlock: Float32Array | null = null;
  private lastLoudAt = 0;
  private turnStartedAt = 0;

  /** Where the next chunk of the assistant's speech goes. Kept as a moving
   *  cursor so chunks queue seamlessly instead of overlapping. */
  private playCursor = 0;
  private playingSources = 0;

  constructor(handlers: LiveHandlers) {
    this.handlers = handlers;
  }

  async start(voice: string): Promise<void> {
    if (!liveSupported()) throw new Error("live audio unsupported here");

    const { token, model } = await fetchLiveToken(voice);

    // Must happen inside the gesture that started the conversation, like every
    // other audio path on iOS.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    await this.openSocket(token, model);
    await this.startCapture();
  }

  private openSocket(token: string, model: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // A query parameter rather than a header, which matters more than it
      // looks: browsers cannot set headers on a WebSocket at all, so a
      // header-only scheme would have made a direct connection impossible and
      // forced the audio back through our own server.
      const socket = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(token)}`);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      const failed = (reason: string) => reject(new Error(reason));
      socket.onerror = () => failed("live socket error");
      socket.onclose = (event) => {
        this.handlers.onClosed(`closed ${event.code}`);
      };

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            setup: {
              model: `models/${model}`,
              generationConfig: { responseModalities: ["AUDIO"] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              realtimeInputConfig: {
                // The heart of it. With automatic detection on, the model
                // decides the driver has finished and answers — in its own
                // words, which is the one thing it must never do. Turn
                // boundaries are sent from here instead.
                automaticActivityDetection: { disabled: true },
              },
            },
          })
        );
        resolve();
      };

      socket.onmessage = (event) => this.onMessage(event);
    });
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    let payload: any;
    try {
      const raw =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const content = payload.serverContent;
    if (!content) return;

    // What the driver said. Accumulated rather than replaced: it arrives in
    // fragments as recognition firms up.
    const heard = content.inputTranscription?.text;
    if (typeof heard === "string") this.transcript += heard;

    // Audio reaches the speaker only when we asked for it.
    //
    // This one condition is what keeps a second voice out of the car. Closing
    // the driver's turn makes the model answer whether we want it to or not,
    // and what it answers is invention — it has no tools and no connection to
    // the car. Playing every chunk that arrived is how that invention came out
    // of the speaker in the assistant's own voice: "the battery is at 85%".
    if (this.speaking) {
      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData?.data;
        if (audio) this.play(decodeBase64(audio));
      }
    }

    if (content.interrupted) {
      // The model stopped because we told it the driver was talking.
      this.stopPlayback();
    }
    if (content.turnComplete && this.speaking && this.playingSources === 0) {
      this.speaking = false;
      this.handlers.onSpokenEnd();
    }
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

    const source = this.inputContext!.createMediaStreamSource(this.stream!);
    const processor = this.inputContext!.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) =>
      this.onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor);
    // Safari will not pull frames through a node that reaches nothing.
    const mute = this.inputContext!.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(this.inputContext!.destination);
    this.node = processor;
  }

  /**
   * Every frame does three things: decide whether it is speech, forward it to
   * Google, and decide whether the turn has ended.
   *
   * The speech test is the same spectral one the recorder uses, and for the
   * same reason — a thump on a seat is loud, and loudness was never the
   * signal. Reusing it also means the two paths cannot disagree about what
   * counts as someone talking.
   */
  private onFrame(frame: Float32Array): void {
    if (!this.listening || this.socket?.readyState !== WebSocket.OPEN) return;

    let peak = 0;
    for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
    this.handlers.onLevel?.(peak);

    this.analyse(frame);
    this.sendAudio(frame);

    const now = Date.now();
    if (peak >= 0.02) this.lastLoudAt = now;

    if (this.speaking && this.hasSpeech()) {
      // Talking over the assistant. Tell the model to stop, and let the caller
      // treat this as the start of a new question.
      this.speaking = false;
      this.stopPlayback();
      this.handlers.onBargeIn();
      return;
    }

    if (this.hasSpeech() && now - this.lastLoudAt >= SILENCE_MS) {
      this.endTurn();
      return;
    }
    if (!this.hasSpeech() && now - this.turnStartedAt >= NO_SPEECH_MS) {
      this.resetTurn();
      this.handlers.onSilence();
    }
  }

  private analyse(frame: Float32Array): void {
    let source = frame;
    if (this.pendingBlock?.length) {
      const merged = new Float32Array(this.pendingBlock.length + frame.length);
      merged.set(this.pendingBlock, 0);
      merged.set(frame, this.pendingBlock.length);
      source = merged;
    }
    let offset = 0;
    while (offset + BLOCK_SIZE <= source.length) {
      const { inBand, consonant } = classifyBlock(source.subarray(offset, offset + BLOCK_SIZE));
      if (inBand) this.inBandSamples += HOP_SIZE;
      if (consonant) this.consonantSamples += HOP_SIZE;
      offset += HOP_SIZE;
    }
    this.pendingBlock = offset < source.length ? source.slice(offset) : null;
  }

  private hasSpeech(): boolean {
    const rate = this.inputContext?.sampleRate ?? INPUT_RATE;
    const ms = (samples: number) => (samples / rate) * 1000;
    return (
      ms(this.inBandSamples) >= SPEECH_EVIDENCE.minInBandMs &&
      ms(this.consonantSamples) >= SPEECH_EVIDENCE.minConsonantMs
    );
  }

  private sendAudio(frame: Float32Array): void {
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (!this.activityOpen) {
      this.socket!.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      this.activityOpen = true;
    }
    this.socket!.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${INPUT_RATE}`,
            data: encodeBase64(new Uint8Array(pcm.buffer)),
          },
        },
      })
    );
  }

  // --- turns ------------------------------------------------------------

  /** Open the microphone for the driver's next turn. */
  listen(): void {
    this.resetTurn();
    this.listening = true;
  }

  private resetTurn(): void {
    this.transcript = "";
    this.inBandSamples = 0;
    this.consonantSamples = 0;
    this.pendingBlock = null;
    this.lastLoudAt = 0;
    this.turnStartedAt = Date.now();
  }

  /**
   * End the driver's turn and hand up whatever was heard.
   *
   * `activityEnd` has to be sent, and it has an unwanted consequence that is
   * handled rather than avoided. Both halves of that were measured:
   *
   * Sending it makes the session answer in its own words. Asked "jaki jest
   * stan baterii" — with a system instruction telling it never to answer — it
   * replied "poziom naładowania baterii wynosi 85%". It has no connection to
   * the car. It invented the number, confidently, in a voice the driver cannot
   * tell from the assistant's. The instruction never stood a chance: it asked
   * for silence while the protocol asked for speech.
   *
   * The obvious fix — don't send it — was tried and is worse: without it no
   * transcript arrives at all. Recognition materialises when the turn closes.
   *
   * So the turn is closed, the model answers into the void, and that answer is
   * simply never played: see onMessage, where audio only reaches the speaker
   * while `speaking` is set, which happens in speak() and nowhere else. It
   * costs tokens to generate a reply nobody hears, which is a fair price for
   * the driver never hearing a number that was made up.
   */
  endTurn(): void {
    if (!this.listening) return;
    this.listening = false;
    if (this.activityOpen && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
      this.activityOpen = false;
    }
    // Give the last fragments a moment to arrive; transcription trails the
    // audio slightly and cutting here would clip the final word.
    setTimeout(() => {
      const text = this.transcript.trim();
      if (text) this.handlers.onTranscript(text);
      else this.handlers.onSilence();
    }, 350);
  }

  /**
   * Have the session read the assistant's answer aloud.
   *
   * Sent as a turn the model must complete, which is the only time it is ever
   * asked to generate. The instruction to read verbatim lives in the system
   * prompt (see backend/app/live.py) — repeated here in the turn itself
   * because a model that has been quiet for a while drifts, and repetition is
   * cheap next to it improvising an answer to the driver.
   */
  speak(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.speaking = true;
    this.socket.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: `Przeczytaj dokładnie te słowa: ${text}` }] }],
          turnComplete: true,
        },
      })
    );
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
      if (this.playingSources === 0 && this.speaking) {
        this.speaking = false;
        this.handlers.onSpokenEnd();
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

  stop(): void {
    this.listening = false;
    this.speaking = false;
    this.stopPlayback();
    try {
      this.node?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.inputContext?.close();
    } catch {
      // torn down already
    }
    try {
      this.socket?.close();
    } catch {
      // already closing
    }
    this.socket = null;
    this.stream = null;
    this.inputContext = null;
    this.node = null;
  }
}

/**
 * Microphone capture for the push-to-talk button, producing 16 kHz mono
 * 16-bit WAV.
 *
 * We encode the WAV ourselves rather than using MediaRecorder because iOS
 * decides the container (it hands back audio/mp4, not the webm every tutorial
 * assumes), and that choice then has to be matched by whatever transcribes it.
 * Writing the bytes here removes the guesswork: one format, known to be
 * accepted, on every browser.
 *
 * 16 kHz is not a compromise — speech recognition gains nothing above it,
 * while 48 kHz would quadruple the upload and blow the server's size cap after
 * about fifteen seconds.
 *
 * Web-only. On native there is no getUserMedia and the keyboard's own dictation
 * key already covers voice input.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { prepareForCapture } from "./audioSession";
import { BLOCK_SIZE, classifyBlock, HOP_SIZE, SPEECH_EVIDENCE, VOICE_PROFILE } from "./vad";

export const SAMPLE_RATE = 16000;

/** Server accepts ~1.5 MB; at 32 KB/s this stops well short of it. */
export const MAX_SECONDS = 30;

/** Below this the recording is almost certainly a mis-tap, not speech. */
const MIN_SECONDS = 0.3;

export class VoiceUnavailableError extends Error {}
export class NothingRecordedError extends Error {}

/**
 * Get a microphone, asking for less if the browser objects to the details.
 *
 * The tuned request is the one worth having: one channel, echo cancellation on
 * (barge-in depends on it), noise suppression on (a car is loud). Chrome takes
 * all three and so does desktop Safari.
 *
 * iOS does not, reliably. `channelCount` and `noiseSuppression` are the two it
 * has historically refused outright rather than ignored, and a refused
 * constraint is an OverconstrainedError thrown before any permission prompt —
 * which is why this failed the instant the button was pressed, on a phone that
 * had already granted access, while the same build worked on a laptop.
 *
 * So the constraints are treated as a preference rather than a requirement: if
 * the detailed request is refused for any reason other than the owner saying
 * no, ask again for a plain microphone. A mono 16 kHz stream is what the
 * recorder wants, but a stereo 48 kHz one it downmixes is infinitely better
 * than no microphone at all.
 */
export async function openMicrophone(): Promise<MediaStream> {
  // Before anything else: a page whose audio session is still set to `playback`
  // — which primeSpeech() declares from this very tap — cannot capture at all.
  prepareForCapture();
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    // A refusal is a refusal — asking again in a plainer voice will not change
    // the owner's mind, and retrying would only produce a second prompt.
    const name = e instanceof Error ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw e;
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export function voiceInputSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as any).webkitAudioContext)
  );
}

const BARGE_IN_KEY = "amp.bargein";

/**
 * Whether the microphone stays open while the assistant is talking, so
 * starting to speak cuts it off — instead of only a tap doing that.
 *
 * Defaults on, but this is the one voice setting in the app that rests
 * entirely on the browser's own echo cancellation being good enough that the
 * mic doesn't hear the reply coming out of the same phone's speaker and
 * mistake it for someone talking. Nothing here can guarantee that for every
 * phone and every car speaker — the fix for a pairing that echoes badly is
 * switching this off, not code.
 */
export async function loadBargeIn(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(BARGE_IN_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // storage unavailable — the default stands
  }
  return true;
}

export async function saveBargeIn(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(BARGE_IN_KEY, enabled ? "1" : "0");
  } catch {
    // best-effort persistence only
  }
}

const VOICE_CONFIRM_KEY = "amp.voiceconfirm";

/**
 * Whether a spoken word may settle a confirmation card mid-conversation.
 *
 * Defaults on, because reaching for the screen is the thing the owner asked to
 * stop doing. Off is a real choice though: a car with passengers is a room
 * where somebody else can say the word, and the backend's own switch
 * (AMP_VOICE_CONFIRM) can withdraw it without shipping an app build.
 */
export async function loadVoiceConfirm(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(VOICE_CONFIRM_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // storage unavailable — the default stands
  }
  return true;
}

const LIVE_KEY = "amp.live";

/**
 * Whether a conversation runs over a live audio session or the older
 * record-and-upload path.
 *
 * The reason this started as a setting — that streamed replies go through Web
 * Audio, which obeyed the ringer switch when first measured — turned out not
 * to bite: declaring the session as playback lifts the mute, measured on the
 * phone this runs on.
 *
 * It stays a setting anyway. A held-open socket has failure modes a series of
 * requests does not, and a stretch of bad signal on a drive is a worse place
 * to discover that than a settings screen is to switch away from it.
 */
export async function loadLiveMode(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(LIVE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // storage unavailable — the default stands
  }
  return true;
}

export async function saveLiveMode(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(LIVE_KEY, enabled ? "1" : "0");
  } catch {
    // best-effort persistence only
  }
}

export async function saveVoiceConfirm(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_CONFIRM_KEY, enabled ? "1" : "0");
  } catch {
    // best-effort persistence only
  }
}

/** Linear resample. The browser is free to ignore a requested sample rate —
 *  Safari commonly gives 48 kHz whatever you ask for — so the conversion has
 *  to happen here rather than being assumed away. */
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

/** Shared with the live session, which buffers a turn's audio for the same
 *  reason this exists: one format, known to be accepted, on every browser. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Stop listening on its own once the speaker has clearly finished, instead of
 * waiting for a finger to lift.
 *
 * Two separate questions get asked here, and conflating them was a bug:
 *
 *   "has the talking stopped?" — a loudness question, answered by
 *   `quietLevel` below. Cheap, and right: when someone stops speaking the
 *   level drops, whatever the frequency content was.
 *
 *   "was any of this speech at all?" — *not* a loudness question. Hitting the
 *   seat is loud, sustained, and passed an amplitude-only check, producing a
 *   recording that the transcriber turned into a command nobody spoke. That
 *   one is answered in vad.ts, on frequency content, and read back in stop().
 */
export interface Endpointing {
  /** Level below which the recording counts as quiet, for deciding the
   *  speaker has finished. Not a speech test — see the note above. */
  quietLevel: number;
  /** How long a hush has to hold, after speech was heard, before it reads as
   *  a finished sentence rather than a breath between words. */
  silenceMs: number;
  /** Give up and hand back an empty turn if nothing resembling speech has
   *  arrived by now. Without it, a turn where nobody spoke sits with the
   *  microphone open until MAX_SECONDS — thirty seconds of dead air before
   *  the conversation loop gets its next go. */
  noSpeechTimeoutMs: number;
}

/**
 * Fires once, the first time the level has held above threshold for a full
 * sustainMs — not on the first loud frame. A door closing or a bump in the
 * road is a spike; a word held over it is not. This is the primitive a
 * barge-in listener watches: unlike Endpointing, it looks for the *start* of
 * speech rather than the silence after it, and it never stops the recording
 * itself — the caller decides what a genuine interruption means to do.
 */
export interface Onset {
  threshold: number;
  sustainMs: number;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;
  private stopping = false;
  private lastLoudAt = 0;
  private startedAt = 0;
  // Evidence accumulators, counted in samples so they measure recorded audio
  // rather than wall-clock scheduling. See vad.ts for what each one means.
  private inBandSamples = 0;
  private consonantSamples = 0;
  private pendingBlock: Float32Array | null = null;
  private onsetStartAt: number | null = null;
  private onsetFired = false;

  /** Set before start(). Unset, the recorder only ever stops on release or
   *  MAX_SECONDS, which is the existing hold-to-talk behaviour. */
  endpointing?: Endpointing;

  /** Set before start() to watch for a speech onset without affecting when
   *  the recording itself stops — see Onset above. */
  onset?: Onset;

  /** Peak level of the most recent frame, 0..1 — drives the "it's hearing
   *  you" affordance, which is the difference between a dead button and a
   *  silent one. */
  onLevel?: (level: number) => void;

  /** Fired when the recording ends itself — MAX_SECONDS, or endpointing
   *  silence — rather than by a caller releasing it. The UI treats both the
   *  same way: stop showing "listening" and move on. */
  onAutoStop?: () => void;

  /** Fired once when `onset` conditions are met. */
  onOnset?: () => void;

  async start(): Promise<void> {
    if (!voiceInputSupported()) throw new VoiceUnavailableError("no microphone API");

    this.stream = await openMicrophone();

    // cancel() may have run while that was pending — a conversation ended, the
    // app locked, the screen unmounted. It had nothing to release at the time,
    // because the stream did not exist yet; it does now, and nobody is holding
    // it any more. Left alone it stays open forever and the browser goes on
    // showing the tab as recording.
    if (this.stopping) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      throw new VoiceUnavailableError("cancelled before it started");
    }

    // At whatever rate the hardware runs. Asking for 16 kHz is how this broke
    // on the phone: Safari accepts the constructor and then refuses to attach
    // a microphone to the result, because it will not resample across that
    // join — createMediaStreamSource throws InvalidStateError, on a build that
    // is fine in Chrome, which honours the request outright.
    //
    // Nothing downstream cares any more. stop() resamples to 16 kHz on the way
    // out, and the speech classifier is told the rate it is looking at, since
    // its thresholds are only meaningful at the rate they were measured at.
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    this.context = new Ctor();
    if (this.context!.state === "suspended") await this.context!.resume();

    this.chunks = [];
    this.frames = 0;
    this.stopping = false;
    this.lastLoudAt = 0;
    this.startedAt = Date.now();
    this.inBandSamples = 0;
    this.consonantSamples = 0;
    this.pendingBlock = null;
    this.onsetStartAt = null;
    this.onsetFired = false;
    this.source = this.context!.createMediaStreamSource(this.stream);
    this.node = await this.buildNode();
    this.source.connect(this.node);
    // Safari will not pull frames through a node that reaches no destination.
    // Zero gain keeps that path alive without playing the microphone back into
    // the cabin, which on a phone speaker is an instant feedback loop.
    const mute = this.context!.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.context!.destination);
  }

  private async buildNode(): Promise<AudioNode> {
    const context = this.context!;
    try {
      await context.audioWorklet.addModule("/amp-recorder-worklet.js");
      const worklet = new AudioWorkletNode(context, "amp-recorder");
      worklet.port.onmessage = (event) => this.collect(event.data as Float32Array);
      return worklet;
    } catch {
      // Worklet unavailable or the module failed to load. The deprecated
      // processor still works everywhere and degrades to occasional dropped
      // samples under load, which beats no microphone at all.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) =>
        this.collect(new Float32Array(event.inputBuffer.getChannelData(0)));
      return processor;
    }
  }

  /**
   * Feed the frame through the speech test in fixed-size blocks.
   *
   * The two capture paths hand over very different frame sizes (128 from the
   * worklet, 4096 from the ScriptProcessor fallback), and the measure this
   * relies on is frequency content — average a fricative across 256 ms and it
   * stops looking like one. Leftovers carry to the next frame rather than
   * being padded, so no block is analysed half-empty.
   */
  private analyse(frame: Float32Array): void {
    let source = frame;
    if (this.pendingBlock && this.pendingBlock.length) {
      const merged = new Float32Array(this.pendingBlock.length + frame.length);
      merged.set(this.pendingBlock, 0);
      merged.set(frame, this.pendingBlock.length);
      source = merged;
    }

    // The rate matters to the classifier, not just to the clock: tilt is a
    // ratio between neighbouring samples, so the same voice reads differently
    // at 48 kHz than at the 16 kHz the thresholds were measured at.
    const rate = this.context?.sampleRate ?? SAMPLE_RATE;
    let offset = 0;
    while (offset + BLOCK_SIZE <= source.length) {
      const { inBand, consonant } = classifyBlock(
        source.subarray(offset, offset + BLOCK_SIZE),
        VOICE_PROFILE,
        rate
      );
      // Advance the totals by the hop, not the block: windows overlap, and
      // counting the block would report twice the audio that actually played.
      if (inBand) this.inBandSamples += HOP_SIZE;
      if (consonant) this.consonantSamples += HOP_SIZE;
      offset += HOP_SIZE;
    }
    this.pendingBlock = offset < source.length ? source.slice(offset) : null;
  }

  /** Both kinds of evidence, together. Rumble supplies the first on its own
   *  all day; only speech supplies the second. */
  private hasSpeech(): boolean {
    const rate = this.context?.sampleRate ?? SAMPLE_RATE;
    const msOf = (samples: number) => (samples / rate) * 1000;
    return (
      msOf(this.inBandSamples) >= SPEECH_EVIDENCE.minInBandMs &&
      msOf(this.consonantSamples) >= SPEECH_EVIDENCE.minConsonantMs
    );
  }

  private collect(frame: Float32Array): void {
    if (this.stopping) return;
    this.chunks.push(frame);
    this.frames += frame.length;

    let peak = 0;
    for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
    this.onLevel?.(peak);

    if (this.endpointing) {
      this.analyse(frame);

      const now = Date.now();
      if (peak >= this.endpointing.quietLevel) this.lastLoudAt = now;

      const heardSpeech = this.hasSpeech();
      if (heardSpeech && now - this.lastLoudAt >= this.endpointing.silenceMs) {
        // Said their piece and stopped.
        this.stopping = true;
        this.onAutoStop?.();
        return;
      }
      if (!heardSpeech && now - this.startedAt >= this.endpointing.noSpeechTimeoutMs) {
        // Nobody spoke. End the turn now rather than holding the microphone
        // open to MAX_SECONDS; stop() will reject it as silence either way.
        this.stopping = true;
        this.onAutoStop?.();
        return;
      }
    }

    if (this.onset && !this.onsetFired) {
      const now = Date.now();
      if (peak >= this.onset.threshold) {
        if (this.onsetStartAt === null) this.onsetStartAt = now;
        else if (now - this.onsetStartAt >= this.onset.sustainMs) {
          this.onsetFired = true;
          this.onOnset?.();
        }
      } else {
        this.onsetStartAt = null;
      }
    }

    const rate = this.context?.sampleRate ?? SAMPLE_RATE;
    if (this.frames / rate >= MAX_SECONDS) {
      this.stopping = true;
      this.onAutoStop?.();
    }
  }

  /** Stops capture and returns the recording. Always releases the microphone,
   *  including on the error paths — a live stream leaves the orange recording
   *  dot on iOS and makes the app look like it is still listening. */
  async stop(): Promise<Blob> {
    const rate = this.context?.sampleRate ?? SAMPLE_RATE;
    const chunks = this.chunks;
    const frames = this.frames;
    const requireSpeech = !!this.endpointing;
    const hadSpeech = this.hasSpeech();
    this.release();

    if (frames / rate < MIN_SECONDS) throw new NothingRecordedError("too short");
    // The speech test is the authority whenever endpointing is configured. The
    // peak check further down only asks "was any single sample above 0.005
    // anywhere in the buffer" — a bar that road noise, a door, or one thump on
    // the seat clears without a word being said, which is exactly how a
    // recording of banging became a spoken command. No speech evidence, no
    // transcription.
    if (requireSpeech && !hadSpeech) throw new NothingRecordedError("silence");

    const merged = new Float32Array(frames);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    let peak = 0;
    for (let i = 0; i < merged.length; i++) peak = Math.max(peak, Math.abs(merged[i]));
    // A granted permission that captures silence is a real iOS failure mode,
    // and it is worth catching here: uploading it would spend an API call to
    // be told there was no speech.
    if (peak < 0.005) throw new NothingRecordedError("silence");

    return encodeWav(resample(merged, rate, SAMPLE_RATE), SAMPLE_RATE);
  }

  cancel(): void {
    this.release();
  }

  private release(): void {
    this.stopping = true;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      if (this.node && "port" in this.node) {
        (this.node as AudioWorkletNode).port.onmessage = null;
      }
    } catch {
      // Already torn down — nothing to do.
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.source = null;
    this.node = null;
    this.chunks = [];
    this.frames = 0;
  }
}

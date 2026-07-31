import { Platform } from "react-native";
import { encodeWav, SAMPLE_RATE } from "./recorder";

/**
 * The sound that means "now it can hear you".
 *
 * A label saying "Łączę…" is the honest thing to show, but it is the wrong
 * thing to depend on: this is used by someone driving, and the whole point of
 * talking to a car is not looking at it. A tone costs a tenth of a second and
 * says the same thing without the glance.
 *
 * An <audio> element rather than Web Audio, deliberately. Safari allows only a
 * handful of AudioContexts at once and a conversation already holds two — one
 * for capture, one for the reply — so adding a third for a beep would spend a
 * scarce resource on the least important sound in the app. An element also
 * survives the audio session being `play-and-record`, which is what a
 * conversation runs under.
 *
 * Primed inside the tap that starts the conversation, because iOS only lets a
 * page arm playback from a gesture, and by the time this plays — a second or
 * two later, when the session is finally up — that gesture is long gone.
 */

/**
 * Two notes, not one.
 *
 * A single sine at a fixed level is a smoke alarm's vocabulary — it says
 * "attention" when the thing it means is "go ahead". Two notes rising a fourth
 * (E5 to A5) read as an opening rather than a warning, which is what this is.
 *
 * Each is struck rather than switched on: a fast attack and an exponential
 * decay, plus a quiet second harmonic, which is roughly what a small bell does
 * and what a phone speaker reproduces well. A flat-topped tone at the same
 * loudness sounds twice as intrusive.
 */
const NOTES = [
  { hz: 659.25, startMs: 0, lengthMs: 150 },
  { hz: 880.0, startMs: 85, lengthMs: 220 },
] as const;

const CUE_MS = 320;

/** Quiet on purpose. It confirms something; it is not an alarm. */
const CUE_VOLUME = 0.3;

/** How fast each note dies away. Higher is shorter; this lands between a
 *  marimba and a small bell. */
const DECAY = 11;

/** The attack, in milliseconds. Not zero: a note that begins on a
 *  discontinuity clicks, and a click is exactly the kind of broadband
 *  transient the speech detector is built to distrust. */
const ATTACK_MS = 4;

/** Second harmonic, quiet enough to add body without adding pitch. */
const HARMONIC = 0.22;

let element: HTMLAudioElement | null = null;

function buildUrl(): string {
  const samples = new Float32Array(Math.round((SAMPLE_RATE * CUE_MS) / 1000));
  const attack = Math.max(1, Math.round((SAMPLE_RATE * ATTACK_MS) / 1000));

  for (const note of NOTES) {
    const from = Math.round((SAMPLE_RATE * note.startMs) / 1000);
    const length = Math.round((SAMPLE_RATE * note.lengthMs) / 1000);
    for (let i = 0; i < length && from + i < samples.length; i++) {
      const seconds = i / SAMPLE_RATE;
      // Struck, then left to ring: full amplitude within a few milliseconds,
      // then an exponential tail.
      const envelope = Math.min(1, i / attack) * Math.exp(-DECAY * seconds);
      const phase = (2 * Math.PI * note.hz * i) / SAMPLE_RATE;
      samples[from + i] +=
        (Math.sin(phase) + HARMONIC * Math.sin(2 * phase)) * envelope;
    }
  }

  // The notes overlap, so normalise rather than trusting the sum to behave —
  // a WAV that clips is a click at the loudest moment.
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] /= peak;

  // The recorder's own encoder: one WAV writer in the app, so a tone and a
  // recording cannot disagree about what a WAV is.
  return URL.createObjectURL(encodeWav(samples, SAMPLE_RATE));
}

/** Call from the gesture that starts a conversation. */
export function primeCue(): void {
  if (Platform.OS !== "web" || typeof Audio === "undefined") return;
  try {
    if (!element) {
      element = new Audio(buildUrl());
      element.volume = CUE_VOLUME;
      element.preload = "auto";
    }
    element.load();
  } catch {
    // No audio element to be had. The label still says what is happening.
  }
}

/** The session is up and the microphone is live. */
export function playReadyCue(): void {
  if (!element) return;
  try {
    element.currentTime = 0;
    void element.play().catch(() => {});
  } catch {
    // Playback refused — a cue nobody hears is not worth an error.
  }
}

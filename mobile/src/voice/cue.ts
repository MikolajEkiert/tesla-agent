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

/** Short enough to be a blip rather than a beep, long enough to be heard over
 *  road noise. */
const CUE_MS = 110;

/** Above the voice's fundamental so it does not read as someone speaking, below
 *  the range that makes a phone speaker sound shrill. */
const CUE_HZ = 880;

/** Quiet on purpose. It confirms something; it is not an alarm. */
const CUE_VOLUME = 0.35;

/** Milliseconds of fade at each end. Without them the tone starts and stops on
 *  a discontinuity, which a speaker reproduces as a click — and a click is
 *  exactly the kind of broadband transient the speech detector is built to
 *  distrust. */
const FADE_MS = 12;

let element: HTMLAudioElement | null = null;

function buildUrl(): string {
  const samples = new Float32Array(Math.round((SAMPLE_RATE * CUE_MS) / 1000));
  const fade = Math.round((SAMPLE_RATE * FADE_MS) / 1000);
  for (let i = 0; i < samples.length; i++) {
    const envelope = Math.min(1, i / fade, (samples.length - i) / fade);
    samples[i] = Math.sin((2 * Math.PI * CUE_HZ * i) / SAMPLE_RATE) * envelope;
  }
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

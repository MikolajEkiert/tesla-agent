/**
 * Spoken replies, using the voice already built into the phone.
 *
 * Free, offline, and — measured on the target device, an installed PWA on
 * iOS — it keeps speaking when the ringer switch is set to silent. That last
 * point decided the design: had the switch muted it, this would have needed an
 * audio element and a synthesised-speech round trip to the server, since a
 * phone kept permanently on silent would otherwise have a mute assistant in
 * the car. It does not, so the browser's own synthesiser is enough.
 *
 * The same measurement is why "always" is not the default. A synthesiser that
 * ignores the silent switch will happily talk out loud in a meeting, so the
 * default only speaks when the question was itself asked out loud.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { Language } from "../i18n";

export type SpeechMode = "off" | "voice" | "always";

/** Speak back only when spoken to. See the note above on why not "always". */
export const DEFAULT_SPEECH_MODE: SpeechMode = "voice";

const STORAGE_KEY = "amp.speech";

/** Replies are meant to be a sentence or two (see the system prompt). This is
 *  a backstop so an unusually long one does not monologue at you in traffic. */
const MAX_SPOKEN_CHARS = 600;

const LOCALE: Record<Language, string> = { pl: "pl-PL", en: "en-US" };

/**
 * The platform default reads noticeably slower than a person speaking, which
 * makes even a one-sentence answer feel like waiting. Slightly above 1 is
 * brisk without turning into a chipmunk; past about 1.3 the compact voices
 * start slurring.
 */
const SPEECH_RATE = 1.15;

export function speechSupported(): boolean {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    !!window.speechSynthesis &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

export async function loadSpeechMode(): Promise<SpeechMode> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === "off" || stored === "voice" || stored === "always") return stored;
  } catch {
    // storage unavailable (private browsing) — fall through to the default
  }
  return DEFAULT_SPEECH_MODE;
}

export async function saveSpeechMode(mode: SpeechMode): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // best-effort persistence only
  }
}

// getVoices() is empty on the first call in Safari and fills in asynchronously,
// which reads as "this device has no Polish voice" if you ask once and believe
// the answer.
let voices: SpeechSynthesisVoice[] = [];

function refreshVoices(): void {
  if (!speechSupported()) return;
  voices = window.speechSynthesis.getVoices() || [];
}

if (speechSupported()) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshVoices);
}

/**
 * The default Polish voice on a fresh phone is the compact one, and it sounds
 * it. iOS can download a far better version of the same voice for free
 * (Settings → Accessibility → Spoken Content → Voices), and once it is there
 * it simply shows up in this list — labelled "Enhanced" or "Premium" — so
 * preferring it costs nothing and needs no setting in the app.
 *
 * Local voices come second: they are offline and start instantly, where a
 * network voice can stall mid-sentence on a bad signal, which in a car is
 * exactly when it is least welcome.
 */
function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  if (!voices.length) refreshVoices();
  const prefix = locale.slice(0, 2).toLowerCase();
  const matching = voices.filter((v) => v.lang?.toLowerCase().startsWith(prefix));
  return (
    matching.find((v) => /enhanced|premium|neural/i.test(v.name)) ??
    matching.find((v) => v.localService) ??
    matching[0]
  );
}

/** The best-quality voice actually available, for reporting in Settings. */
export function currentVoiceName(language: Language): string | null {
  return pickVoice(LOCALE[language] ?? LOCALE.en)?.name ?? null;
}

let primed = false;

/**
 * Must be called from a real tap.
 *
 * iOS wants the first utterance of a session to originate in a user gesture,
 * and a reply arrives seconds after the tap that asked for it — long past the
 * point where the browser still counts it. Speaking one silent utterance while
 * the finger is still down opens the door for the real ones later.
 */
export function primeSpeech(): void {
  if (primed || !speechSupported()) return;
  primed = true;
  try {
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Priming is an optimisation; failing it must not break sending a message.
  }
}

/** Notified when speech stops for any reason at all — finished, cancelled or
 *  failed. Deliberately no `onStart`: the caller shows its stop control the
 *  moment it asks for speech, rather than waiting for an event that some
 *  engines never send (measured: a browser with no audio device reports
 *  `speaking === true` and fires nothing at all). */
export interface SpeechHandlers {
  onEnd?: () => void;
}

/** Ground truth, for callers that cannot rely on the end event arriving. */
export function isSpeaking(): boolean {
  if (!speechSupported()) return false;
  return window.speechSynthesis.speaking || window.speechSynthesis.pending;
}

export function speak(text: string, language: Language, handlers?: SpeechHandlers): void {
  if (!speechSupported()) return;
  const spoken = text.trim().slice(0, MAX_SPOKEN_CHARS);
  if (!spoken) return;
  try {
    // Cancel first: two replies talking over each other is worse than either.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = LOCALE[language] ?? LOCALE.en;
    utterance.rate = SPEECH_RATE;
    const voice = pickVoice(utterance.lang);
    if (voice) utterance.voice = voice;

    // Browsers disagree about which event a cancel() produces — some fire
    // `end`, some `error`, Safari has managed both. Collapsing them into one
    // guarded call means the UI settles either way, and never twice.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      handlers?.onEnd?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
  } catch {
    // A silent assistant is an acceptable degradation; a crashed one is not.
    handlers?.onEnd?.();
  }
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // nothing to stop
  }
}

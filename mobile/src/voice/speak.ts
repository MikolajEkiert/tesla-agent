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

function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  if (!voices.length) refreshVoices();
  const prefix = locale.slice(0, 2).toLowerCase();
  return voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
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

export function speak(text: string, language: Language): void {
  if (!speechSupported()) return;
  const spoken = text.trim().slice(0, MAX_SPOKEN_CHARS);
  if (!spoken) return;
  try {
    // Cancel first: two replies talking over each other is worse than either.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = LOCALE[language] ?? LOCALE.en;
    const voice = pickVoice(utterance.lang);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  } catch {
    // A silent assistant is an acceptable degradation; a crashed one is not.
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

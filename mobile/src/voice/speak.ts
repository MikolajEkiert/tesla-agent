/**
 * Spoken replies, in two voices with one falling back to the other.
 *
 * The phone's built-in Polish voice is the only one iOS offers and it sounds
 * its age, so the preferred path fetches audio from the server, where a speech
 * model reads the reply and takes direction on *how* to read it. The built-in
 * synthesiser stays as the fallback.
 *
 * That fallback is not decoration. The free tier limits requests per minute
 * — measured, not assumed — so a few questions in quick succession will have
 * one come back empty-handed, and the car is the worst place for an assistant
 * to answer with silence. Anything that goes wrong with the cloud voice, from
 * a rate limit to no signal at all, quietly becomes the old voice.
 *
 * Both paths were measured on the target device, an installed PWA on iOS 18:
 * `speechSynthesis` and an `<audio>` element both keep playing with the ringer
 * switch set to silent. Web Audio does not, which is why the cloud audio plays
 * through an element and never through an AudioContext.
 *
 * That same measurement is why "always" is not the default. A voice that
 * ignores the silent switch will happily talk out loud in a meeting, so the
 * default only speaks when the question was itself asked out loud.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { fetchSpeech } from "../api";
import { toPlainText } from "../markdown";
import type { Language } from "../i18n";

export type SpeechMode = "off" | "voice" | "always";

/** Speak back only when spoken to. See the note above on why not "always". */
export const DEFAULT_SPEECH_MODE: SpeechMode = "voice";

const STORAGE_KEY = "amp.speech";
const VOICE_KEY = "amp.voice";

/**
 * Which voice reads the replies: a named voice from the server, or the one
 * built into the phone.
 *
 * "device" is kept as an explicit choice rather than only a fallback, because
 * it is the offline one. On a drive with no signal it is the only one that
 * works, and someone who spends time there may reasonably want it always.
 */
export type VoiceChoice = "device" | string;

export const DEFAULT_VOICE: VoiceChoice = "Charon";

export async function loadVoiceChoice(): Promise<VoiceChoice> {
  try {
    const stored = await AsyncStorage.getItem(VOICE_KEY);
    if (stored) return stored;
  } catch {
    // storage unavailable — the default is a fine answer
  }
  return DEFAULT_VOICE;
}

export async function saveVoiceChoice(voice: VoiceChoice): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_KEY, voice);
  } catch {
    // best-effort persistence only
  }
}

// Read once at startup and kept here so speak() stays synchronous for its
// callers: the reply is already on screen by then, and awaiting storage before
// making a sound would show a stop button with nothing yet to stop.
let voiceChoice: VoiceChoice = DEFAULT_VOICE;

export function setActiveVoice(voice: VoiceChoice): void {
  voiceChoice = voice;
}

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
 * One element for the whole session, not one per reply.
 *
 * iOS grants permission to play to the *element* that a gesture touched, so a
 * freshly created one would be blocked exactly when it matters — seconds after
 * the tap, when the answer comes back.
 */
let player: HTMLAudioElement | null = null;
let playerUrl: string | null = null;

/** The shortest legal WAV: a 44-byte header describing no samples at all.
 *  Enough for iOS to consider the element played, inaudible by construction. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

/**
 * Must be called from a real tap.
 *
 * iOS wants the first sound of a session to originate in a user gesture, and a
 * reply arrives seconds after the tap that asked for it — long past the point
 * where the browser still counts it. Both paths are opened here while the
 * finger is still down: one silent utterance for the synthesiser, one silent
 * file for the element.
 */
export function primeSpeech(): void {
  if (primed || Platform.OS !== "web" || typeof window === "undefined") return;
  primed = true;

  try {
    // Tells iOS this element carries playback rather than a notification
    // bleep, which is what earns the right to be heard with the ringer switch
    // silent. Measured as "auto" on iOS 18.7, meaning Safari was deciding for
    // us; saying it outright turns a behaviour we observed into one we asked
    // for. Absent on every other browser, hence the guard.
    const session = (navigator as any).audioSession;
    if (session) session.type = "playback";
  } catch {
    // An unwritable property must not cost us the rest of the priming.
  }

  try {
    player = new Audio(SILENT_WAV);
    // Without this iOS refuses to load anything until the element is played,
    // which is the very thing we are trying to get ahead of.
    player.preload = "auto";
    void player.play().catch(() => {
      // Blocked priming only means the first reply may fall back to the
      // built-in voice, which is a working assistant either way.
    });
  } catch {
    player = null;
  }

  if (!speechSupported()) return;
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
  /**
   * The cloud voice could not be reached and the built-in one took over.
   *
   * In the chat this is deliberately ignored — mid-drive, a working answer in
   * a worse voice is not news. The settings screen is the opposite case: there
   * the whole point of the tap is to hear a particular voice, and silence
   * about why a different one answered turns a quota message the server
   * already sent into a mystery. That happened, and cost an evening.
   */
  onFallback?: (reason: string) => void;
}

/** In flight: the audio for the current reply is still being made. */
let pending: AbortController | null = null;

/**
 * Bumped by every request to speak and by every stop.
 *
 * Audio that arrives after its reply stopped being the current one must not
 * play. That happens for real: a question asked while the previous answer is
 * still being synthesised, or the stop button pressed during the round trip.
 * A late arrival compares its own number and drops itself.
 */
let generation = 0;

/**
 * Ground truth, for callers that cannot rely on the end event arriving.
 *
 * Counts a request still in flight as speaking. Otherwise the stop control
 * would vanish during the second or two between asking for audio and hearing
 * it — the one stretch where the user has the least idea what is happening and
 * most wants a way out.
 */
export function isSpeaking(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  if (pending) return true;
  if (player && !player.paused && !player.ended) return true;
  if (!speechSupported()) return false;
  return window.speechSynthesis.speaking || window.speechSynthesis.pending;
}

function releaseUrl(): void {
  if (!playerUrl) return;
  URL.revokeObjectURL(playerUrl);
  playerUrl = null;
}

/**
 * The short lines that get said again and again — above all the voice sample
 * in Settings, which is spoken on every single tap because a name like
 * "Vindemiatrix" means nothing until you hear it.
 *
 * The backend caches these on disk too, so the synthesiser is paid once ever
 * rather than once per tap. This one is in front of that: flicking back and
 * forth between two voices should not be a network round trip at all, and in a
 * car the network is the slow part.
 *
 * Bounded and small — twelve is the whole sample matrix, six voices in two
 * languages. Replies are not cached: they are long, said once, and holding
 * their audio would be a memory leak dressed as an optimisation.
 */
const CLIP_CACHE_MAX_CHARS = 200;
const CLIP_CACHE_MAX_ENTRIES = 12;
const clipCache = new Map<string, Blob>();

function rememberClip(key: string, blob: Blob): void {
  clipCache.delete(key);
  clipCache.set(key, blob);
  // Map keeps insertion order, so the first key is the least recently stored.
  while (clipCache.size > CLIP_CACHE_MAX_ENTRIES) {
    const oldest = clipCache.keys().next().value;
    if (oldest === undefined) break;
    clipCache.delete(oldest);
  }
}

export function speak(text: string, language: Language, handlers?: SpeechHandlers): void {
  // Marks off first. A reply listing restaurants is full of "**", and a
  // synthesiser handed those either reads them aloud or stumbles over them —
  // the same missing step that put asterisks on the screen was also putting
  // them in the car's speakers, where they are harder to notice and worse.
  const spoken = toPlainText(text).slice(0, MAX_SPOKEN_CHARS);
  if (!spoken) return;

  // Whatever is speaking now belongs to an older reply. Two answers talking
  // over each other is worse than either.
  stopSpeaking();
  const mine = ++generation;

  // No element means priming never ran or was refused, and an unprimed element
  // on iOS will not play — so the built-in voice is not merely the fallback
  // here, it is the only one that can make a sound.
  if (voiceChoice === "device" || !player) {
    speakWithDevice(spoken, language, handlers, mine);
    return;
  }

  const cacheable = spoken.length <= CLIP_CACHE_MAX_CHARS;
  const key = `${language}|${voiceChoice}|${spoken}`;
  const cached = cacheable ? clipCache.get(key) : undefined;
  if (cached) {
    playFile(cached, spoken, language, mine, handlers);
    return;
  }

  const controller = new AbortController();
  pending = controller;
  fetchSpeech(spoken, language, voiceChoice, controller.signal)
    .then((blob) => {
      if (mine !== generation) return;
      pending = null;
      if (cacheable) rememberClip(key, blob);
      playFile(blob, spoken, language, mine, handlers);
    })
    .catch((e) => {
      if (mine !== generation) return;
      pending = null;
      // Rate limit, no signal, a 503 — the response to all of them is the
      // same, and in the chat it is not an error message. Say the words in the
      // other voice; the user hears a slightly worse assistant, not a broken
      // one. The reason is handed over for anyone who asked to be told.
      handlers?.onFallback?.(reasonOf(e));
      speakWithDevice(spoken, language, handlers, mine);
    });
}

/** The server's own words where there are any — a BackendError carries the
 *  API's message, which is usually the entire explanation. */
function reasonOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "");
  return message.trim() || "unknown";
}

function playFile(
  blob: Blob,
  spoken: string,
  language: Language,
  mine: number,
  handlers?: SpeechHandlers
): void {
  if (!player) {
    speakWithDevice(spoken, language, handlers, mine);
    return;
  }
  try {
    releaseUrl();
    playerUrl = URL.createObjectURL(blob);
    player.src = playerUrl;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      handlers?.onEnd?.();
    };
    player.onended = finish;
    // An element that fails mid-file has already said part of the sentence.
    // Starting the whole reply again in the other voice would repeat it, so a
    // failure here just ends: the text is on screen regardless.
    player.onerror = finish;

    void player.play().catch((e) => {
      if (mine !== generation) return;
      // Refused before a single sample was heard — nothing was said yet, so
      // the fallback can say all of it.
      handlers?.onFallback?.(reasonOf(e));
      speakWithDevice(spoken, language, handlers, mine);
    });
  } catch {
    speakWithDevice(spoken, language, handlers, mine);
  }
}

function speakWithDevice(
  spoken: string,
  language: Language,
  handlers: SpeechHandlers | undefined,
  mine: number
): void {
  if (!speechSupported()) {
    handlers?.onEnd?.();
    return;
  }
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
    //
    // The generation check is the part that actually matters: stopSpeaking()
    // cancels this utterance from the outside but has no reference to detach
    // its handlers (unlike the <audio> element, which it nulls out directly),
    // so a stale onend can still fire here for a reply nobody asked about any
    // more. Conversation mode turns that into a real bug rather than a no-op:
    // its onEnd starts listening again, and a cancelled reply from two
    // questions ago has no business restarting the microphone.
    let finished = false;
    const finish = () => {
      if (finished || mine !== generation) return;
      finished = true;
      handlers?.onEnd?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    window.speechSynthesis.speak(utterance);
  } catch {
    // A silent assistant is an acceptable degradation; a crashed one is not.
    if (mine === generation) handlers?.onEnd?.();
  }
}

export function stopSpeaking(): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;

  // Bumping first is what makes the stop reliable: audio already on its way
  // back from the server cannot be recalled, only disowned.
  generation += 1;

  if (pending) {
    pending.abort();
    pending = null;
  }

  try {
    if (player) {
      player.pause();
      // Rewind before dropping the source, or a later play() resumes the old
      // sentence from where this one was cut off.
      player.currentTime = 0;
      player.onended = null;
      player.onerror = null;
      releaseUrl();
    }
  } catch {
    // nothing to stop
  }

  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // nothing to stop
  }
}

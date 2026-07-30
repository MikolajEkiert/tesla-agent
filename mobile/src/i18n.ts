import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export type Language = "en" | "pl";

const STORAGE_KEY = "amp.language";

const STRINGS = {
  en: {
    greetingMorning: "Good morning",
    greetingAfternoon: "Good afternoon",
    greetingEvening: "Good evening",
    greetingSuffix: "How can I help?",
    connectedGreeting: "Connected to your Tesla. How can I help?",
    askPlaceholder: "Ask Amp…",
    connectHeadline: "Connect your Tesla",
    connectBody:
      "Amp needs access to your Tesla account to read your car's state and send commands. This links directly with Tesla — your credentials never touch this app.",
    connectButton: "Connect Tesla Account",
    disconnectTitle: "Disconnect Tesla account?",
    disconnectBody: "You'll need to reconnect to control the car again.",
    disconnectCancel: "Cancel",
    disconnectConfirm: "Disconnect",
    errorUnreachable: "Couldn't reach Amp's backend. Is it running?",
    asleep: "asleep",
    staleJustNow: "just now",
    locked: "locked",
    unlocked: "unlocked",
    settingsTitle: "Settings",
    settingsLanguageLabel: "Language",
    settingsLanguageHint:
      "Sets the app's language and the assistant's default reply language in chat.",
    settingsClose: "Done",
    langEnglish: "English",
    langPolish: "Polski",
    menu: "Menu",
    queueTitle: "Scheduled",
    queueEmpty: "Nothing scheduled",
    queueClimate: "Climate",
    queueStartsIn: "starts in {n}",
    queueStopsIn: "stops in {n}",
    queueRunning: "running",
    queueDone: "finished",
    queueCancelled: "cancelled",
    queueFailed: "failed",
    queueCancel: "Cancel",
    minutesShort: "{n} min",
    lessThanAMinute: "<1 min",
    passcodeHeadline: "Enter your passcode",
    passcodeBody:
      "Amp can unlock and control your car, so it stays locked until you sign in.",
    passcodePlaceholder: "Passcode",
    passcodeTotpPlaceholder: "000000",
    passcodeSubmit: "Unlock",
    lockApp: "Lock app",
    passkeySignIn: "Sign in with Face ID",
    passkeyOr: "or",
    passkeySection: "Face ID",
    passkeyAdd: "Set up Face ID sign-in",
    passkeyAdded: "Face ID sign-in is on",
    passkeyRemove: "Remove",
    passkeyHint:
      "Sign in by looking at your phone. Your passcode keeps working as a backup.",
    passkeyUnsupported: "This device can't use Face ID sign-in.",
    confirmQuestion: "Confirm: {what}?",
    confirmYes: "Confirm",
    confirmNo: "Cancel",
    confirmExecuted: "Confirmed and sent to the car.",
    confirmDismissed: "Cancelled — nothing was sent.",
    confirmUnlock: "unlock the car",
    confirmTrunk: "open the trunk",
    confirmHomelink: "trigger HomeLink (garage/gate)",
    confirmWindows: "move the windows",
    confirmSentry: "change Sentry Mode",
    passkeyPasscodePrompt: "Enter your passcode to set up Face ID",
    voiceHold: "Hold to speak",
    voiceListening: "Listening…",
    voiceTranscribing: "Transcribing…",
    voiceTooShort: "Too short — hold the button while you speak",
    voiceSilence: "Didn't catch anything",
    voiceDenied: "Microphone access denied",
    voiceFailed: "Couldn't transcribe that",
    speechSection: "Spoken replies",
    speechOff: "Off",
    speechVoice: "After voice",
    speechAlways: "Always",
    speechHint:
      "Reads the assistant's reply aloud. \"After voice\" only speaks when you asked out loud — worth keeping, since the phone's voice plays even on silent.",
  },
  pl: {
    greetingMorning: "Dzień dobry",
    greetingAfternoon: "Dzień dobry",
    greetingEvening: "Dobry wieczór",
    greetingSuffix: "W czym mogę pomóc?",
    connectedGreeting: "Połączono z Teslą. W czym mogę pomóc?",
    askPlaceholder: "Zapytaj Amp…",
    connectHeadline: "Połącz swoją Teslę",
    connectBody:
      "Amp potrzebuje dostępu do Twojego konta Tesla, aby odczytywać stan auta i wysyłać polecenia. Łączy się bezpośrednio z Teslą — Twoje dane logowania nigdy nie trafiają do tej aplikacji.",
    connectButton: "Połącz konto Tesla",
    disconnectTitle: "Odłączyć konto Tesla?",
    disconnectBody: "Aby ponownie sterować autem, będziesz musiał połączyć się jeszcze raz.",
    disconnectCancel: "Anuluj",
    disconnectConfirm: "Odłącz",
    errorUnreachable: "Nie można połączyć się z backendem Amp. Czy jest uruchomiony?",
    asleep: "uśpiony",
    staleJustNow: "przed chwilą",
    locked: "zablokowany",
    unlocked: "odblokowany",
    settingsTitle: "Ustawienia",
    settingsLanguageLabel: "Język",
    settingsLanguageHint:
      "Ustawia język aplikacji oraz domyślny język odpowiedzi asystenta na czacie.",
    settingsClose: "Gotowe",
    langEnglish: "English",
    langPolish: "Polski",
    menu: "Menu",
    queueTitle: "Zaplanowane",
    queueEmpty: "Nic nie zaplanowano",
    queueClimate: "Klimatyzacja",
    queueStartsIn: "start za {n}",
    queueStopsIn: "koniec za {n}",
    queueRunning: "trwa",
    queueDone: "zakończone",
    queueCancelled: "anulowane",
    queueFailed: "błąd",
    queueCancel: "Anuluj",
    minutesShort: "{n} min",
    lessThanAMinute: "<1 min",
    passcodeHeadline: "Podaj kod dostępu",
    passcodeBody:
      "Amp może otworzyć i sterować Twoim autem, więc pozostaje zamknięty do czasu zalogowania.",
    passcodePlaceholder: "Kod dostępu",
    passcodeTotpPlaceholder: "000000",
    passcodeSubmit: "Odblokuj",
    lockApp: "Zablokuj aplikację",
    passkeySignIn: "Zaloguj z Face ID",
    passkeyOr: "albo",
    passkeySection: "Face ID",
    passkeyAdd: "Skonfiguruj logowanie Face ID",
    passkeyAdded: "Logowanie Face ID włączone",
    passkeyRemove: "Usuń",
    passkeyHint:
      "Logowanie spojrzeniem w telefon. Kod dostępu nadal działa jako zapas.",
    passkeyUnsupported: "To urządzenie nie obsługuje logowania Face ID.",
    confirmQuestion: "Potwierdź: {what}?",
    confirmYes: "Potwierdzam",
    confirmNo: "Anuluj",
    confirmExecuted: "Potwierdzone i wysłane do auta.",
    confirmDismissed: "Anulowane — nic nie wysłano.",
    confirmUnlock: "otworzyć auto",
    confirmTrunk: "otworzyć bagażnik",
    confirmHomelink: "uruchomić HomeLink (brama/garaż)",
    confirmWindows: "ruszyć szybami",
    confirmSentry: "zmienić Sentry Mode",
    passkeyPasscodePrompt: "Podaj kod dostępu, aby włączyć Face ID",
    voiceHold: "Przytrzymaj, aby mówić",
    voiceListening: "Słucham…",
    voiceTranscribing: "Rozpoznaję…",
    voiceTooShort: "Za krótko — przytrzymaj przycisk podczas mówienia",
    voiceSilence: "Nic nie usłyszałem",
    voiceDenied: "Brak dostępu do mikrofonu",
    voiceFailed: "Nie udało się rozpoznać mowy",
    speechSection: "Czytanie odpowiedzi",
    speechOff: "Nigdy",
    speechVoice: "Po głosie",
    speechAlways: "Zawsze",
    speechHint:
      "Czyta odpowiedź asystenta na głos. „Po głosie” odzywa się tylko wtedy, gdy sam zapytałeś głosem — warto przy tym zostać, bo głos telefonu gra także przy wyciszeniu.",
  },
} as const;

export type TranslationKey = keyof (typeof STRINGS)["en"];

/** Only used the very first time the app runs, before any preference is saved. */
function detectDefaultLanguage(): Language {
  if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  }
  return "en";
}

export async function loadLanguage(): Promise<Language> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "pl") return stored;
  } catch {
    // storage unavailable (e.g. private browsing) — fall through to device default
  }
  return detectDefaultLanguage();
}

export async function saveLanguage(language: Language): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, language);
  } catch {
    // best-effort persistence only
  }
}

export function t(
  language: Language,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const template: string = STRINGS[language][key];
  if (!vars) return template;
  // Word order differs between the two languages ("stops in 6 min" vs "koniec
  // za 6 min"), so values are interpolated by name rather than concatenated
  // at the call site.
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
}

/** Time-of-day greeting — replaces a greeting that used to always say "evening". */
export function greeting(language: Language, hour: number): string {
  const part =
    hour >= 5 && hour < 12
      ? "greetingMorning"
      : hour >= 12 && hour < 18
      ? "greetingAfternoon"
      : "greetingEvening";
  return `${t(language, part)}. ${t(language, "greetingSuffix")}`;
}

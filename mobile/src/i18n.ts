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
    errorRetry: "Try again",
    errorDismiss: "Dismiss",
    sendMessage: "Send",
    speakMessage: "Read aloud",
    resendMessage: "Ask again",
    chatRename: "Rename",
    confirmEyebrow: "Needs your go-ahead",
    // The four things people actually ask a car in a car park, phrased exactly
    // as they are sent — tapping one teaches you what you could have said.
    chipWarm: "Warm the car to 21°C",
    chipRange: "How much range do I have?",
    chipCharger: "Nearest Supercharger",
    chipLock: "Lock the car",
    chatDeleteTitle: "Delete this chat?",
    chatDeleteBody: "The conversation is removed from this device for good.",
    chatDeleteConfirm: "Delete",
    copied: "Copied",
    copyMessage: "Copy message",
    scrollToLatest: "Jump to latest",
    charging: "charging",
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
    chatsTitle: "Chats",
    chatsEmpty: "No saved chats yet",
    chatNew: "New chat",
    chatUntitled: "Untitled",
    heardApprox: "heard",
    chatToday: "today",
    chatYesterday: "yesterday",
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
    confirmSettledDone: "Sent to the car: {what}",
    confirmSettledDismissed: "Cancelled: {what}",
    confirmExpiresIn: "expires in {n} s",
    confirmExpired: "Expired — ask again to get a fresh confirmation.",
    confirmUnlock: "unlock the car",
    confirmTrunk: "open the trunk",
    confirmHomelink: "trigger HomeLink (garage/gate)",
    confirmWindows: "move the windows",
    confirmSentry: "change Sentry Mode",
    confirmUpdate: "install the software update",
    passkeyPasscodePrompt: "Enter your passcode to set up Face ID",
    voiceHold: "Hold to speak",
    voiceListening: "Listening…",
    voiceTranscribing: "Transcribing…",
    voiceTooShort: "Too short — hold the button while you speak",
    voiceSilence: "Didn't catch anything",
    voiceDenied: "Microphone access denied",
    voiceFailed: "Couldn't transcribe that",
    // Names the microphone rather than the transcriber, and carries the
    // browser's own word for what went wrong. A failure to open the mic used
    // to report "couldn't transcribe that" — a sentence about a step that had
    // not been reached, which is how a refused audio constraint on one phone
    // looked exactly like a spent transcription quota.
    voiceMicFailed: "Couldn't start the microphone ({reason})",
    speechSection: "Spoken replies",
    speechOff: "Off",
    speechVoice: "After voice",
    speechAlways: "Always",
    speechHint:
      "Reads the assistant's reply aloud. \"After voice\" only speaks when you asked out loud — worth keeping, since the phone's voice plays even on silent.",
    speechSpeaking: "Reading aloud",
    speechStop: "Stop",
    speechVoiceLabel: "Voice: {name}",
    speechVoiceUpgrade:
      "For a much better voice, download the enhanced Polish one: Settings → Accessibility → Spoken Content → Voices → Polish. It's free, and Amp picks it up on its own.",
    speechVoiceSection: "Voice",
    speechVoiceDevice: "Phone",
    speechVoiceHint:
      "Tap a voice to hear it. The phone's own voice needs no signal, so Amp falls back to it whenever the better one can't be reached.",
    speechVoiceSample:
      "The car has sixty-three percent battery, two hundred and ten kilometres of range. Nearest Supercharger is four kilometres away.",
    speechVoiceFallback: "Phone voice used — {reason}",
    conversationStart: "Start voice conversation",
    conversationListening: "Listening…",
    conversationThinking: "Thinking…",
    conversationSpeaking: "Speaking — tap to interrupt",
    conversationEnd: "End conversation",
    conversationBargeInSection: "Interrupting a reply",
    conversationBargeInOn: "By voice",
    conversationBargeInOff: "Tap only",
    conversationBargeInHint:
      "\"By voice\" keeps the microphone open while the assistant talks, so starting to speak cuts it off — same as Grok or Gemini. It relies on the phone's own echo cancellation, which isn't equally good on every phone and speaker. If replies start cutting themselves off for no reason, switch to \"Tap only\".",
    voiceConfirmSection: "Confirming by voice",
    voiceConfirmOn: "Say \"confirm\"",
    voiceConfirmOff: "Tap only",
    voiceConfirmHint:
      "In a conversation, say \"confirm\" to approve what's waiting instead of reaching for the screen. Unlocking the car always needs a tap. Anyone within earshot can say the word too, so turn this off if you often drive with passengers.",
    voiceConfirmSpoken: "Say \"confirm\" or tap",
    voiceConfirmMissed: "I didn't catch that — tap to confirm.",
    liveSection: "Conversation mode",
    liveOn: "Live audio",
    liveOff: "Recordings",
    liveHint:
      "\"Live audio\" streams the conversation both ways: your words are recognised as you speak them and the reply starts before it's finished being made. It's a separate assistant from the one you type to — same commands, same confirmation cards, but its own memory of what was said, so it won't know about a typed exchange and the other way round. \"Recordings\" is the older path — slower, and it answers in the typed assistant's own thread, but it only needs a working request rather than a connection held open, so it's the one to fall back to on a bad signal.",
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
    errorRetry: "Ponów",
    errorDismiss: "Zamknij",
    sendMessage: "Wyślij",
    speakMessage: "Przeczytaj na głos",
    resendMessage: "Zapytaj ponownie",
    chatRename: "Zmień nazwę",
    confirmEyebrow: "Czeka na Twoją zgodę",
    chipWarm: "Nagrzej auto do 21°C",
    chipRange: "Ile mam zasięgu?",
    chipCharger: "Najbliższy Supercharger",
    chipLock: "Zablokuj auto",
    chatDeleteTitle: "Usunąć ten czat?",
    chatDeleteBody: "Rozmowa zniknie z tego urządzenia na dobre.",
    chatDeleteConfirm: "Usuń",
    copied: "Skopiowano",
    copyMessage: "Kopiuj wiadomość",
    scrollToLatest: "Przejdź na dół",
    charging: "ładowanie",
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
    chatsTitle: "Czaty",
    chatsEmpty: "Brak zapisanych czatów",
    chatNew: "Nowy czat",
    chatUntitled: "Bez tytułu",
    heardApprox: "usłyszane",
    chatToday: "dziś",
    chatYesterday: "wczoraj",
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
    confirmSettledDone: "Wysłane do auta: {what}",
    confirmSettledDismissed: "Anulowane: {what}",
    confirmExpiresIn: "wygasa za {n} s",
    confirmExpired: "Ważność minęła — poproś ponownie o potwierdzenie.",
    confirmUnlock: "otworzyć auto",
    confirmTrunk: "otworzyć bagażnik",
    confirmHomelink: "uruchomić HomeLink (brama/garaż)",
    confirmWindows: "ruszyć szybami",
    confirmSentry: "zmienić Sentry Mode",
    confirmUpdate: "zainstalować aktualizację oprogramowania",
    passkeyPasscodePrompt: "Podaj kod dostępu, aby włączyć Face ID",
    voiceHold: "Przytrzymaj, aby mówić",
    voiceListening: "Słucham…",
    voiceTranscribing: "Rozpoznaję…",
    voiceTooShort: "Za krótko — przytrzymaj przycisk podczas mówienia",
    voiceSilence: "Nic nie usłyszałem",
    voiceDenied: "Brak dostępu do mikrofonu",
    voiceFailed: "Nie udało się rozpoznać mowy",
    voiceMicFailed: "Nie udało się uruchomić mikrofonu ({reason})",
    speechSection: "Czytanie odpowiedzi",
    speechOff: "Nigdy",
    speechVoice: "Po głosie",
    speechAlways: "Zawsze",
    speechHint:
      "Czyta odpowiedź asystenta na głos. „Po głosie” odzywa się tylko wtedy, gdy sam zapytałeś głosem — warto przy tym zostać, bo głos telefonu gra także przy wyciszeniu.",
    speechSpeaking: "Czytam",
    speechStop: "Zatrzymaj",
    speechVoiceLabel: "Głos: {name}",
    speechVoiceUpgrade:
      "Po znacznie lepszy głos: Ustawienia → Dostępność → Treść mówiona → Głosy → Polski i pobierz wersję rozszerzoną. Jest darmowa, a Amp sam ją wybierze.",
    speechVoiceSection: "Głos",
    speechVoiceDevice: "Telefon",
    speechVoiceHint:
      "Dotknij głosu, żeby go usłyszeć. Głos telefonu nie potrzebuje zasięgu, więc Amp wraca do niego zawsze, gdy lepszy jest nieosiągalny.",
    speechVoiceSample:
      "Auto ma sześćdziesiąt trzy procent baterii, zasięg dwieście dziesięć kilometrów. Najbliższy Supercharger jest cztery kilometry stąd.",
    speechVoiceFallback: "Zadziałał głos telefonu — {reason}",
    conversationStart: "Rozpocznij rozmowę głosową",
    conversationListening: "Słucham…",
    conversationThinking: "Myślę…",
    conversationSpeaking: "Mówię — dotknij, aby przerwać",
    conversationEnd: "Zakończ rozmowę",
    conversationBargeInSection: "Przerywanie odpowiedzi",
    conversationBargeInOn: "Głosem",
    conversationBargeInOff: "Tylko dotknięciem",
    conversationBargeInHint:
      "„Głosem” trzyma mikrofon otwarty, gdy asystent mówi, więc zaczęcie mówienia go przerywa — tak jak w Groku czy Gemini. Polega na anulowaniu echa w telefonie, które nie na każdym telefonie i głośniku działa tak samo dobrze. Jeśli odpowiedzi zaczną się urywać bez powodu, przełącz na „Tylko dotknięciem”.",
    voiceConfirmSection: "Potwierdzanie głosem",
    voiceConfirmOn: "Powiedz „potwierdzam”",
    voiceConfirmOff: "Tylko dotknięciem",
    voiceConfirmHint:
      "W rozmowie powiedz „potwierdzam”, żeby zatwierdzić to, co czeka, zamiast sięgać po ekran. Otwarcie auta zawsze wymaga dotknięcia. To słowo może wypowiedzieć każdy w zasięgu głosu, więc wyłącz to, jeśli często wozisz pasażerów.",
    voiceConfirmSpoken: "Powiedz „potwierdzam” albo dotknij",
    voiceConfirmMissed: "Nie zrozumiałem — dotknij, żeby potwierdzić.",
    liveSection: "Tryb rozmowy",
    liveOn: "Na żywo",
    liveOff: "Nagrania",
    liveHint:
      "„Na żywo” przesyła rozmowę strumieniem w obie strony: Twoje słowa są rozpoznawane w trakcie mówienia, a odpowiedź zaczyna płynąć, zanim powstanie w całości. To osobny asystent od tego, do którego piszesz — te same polecenia i te same karty potwierdzeń, ale własna pamięć rozmowy, więc nie wie, co padło w czacie tekstowym, i odwrotnie. „Nagrania” to starsza droga — wolniejsza i odpowiada w wątku czatu tekstowego, ale wymaga tylko udanego żądania zamiast trzymanego połączenia, więc to na nią warto wrócić przy słabym zasięgu.",
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

/**
 * The two halves of the opening line, kept apart.
 *
 * The empty chat sets them as one heading in two tones — the greeting bright,
 * the question underneath it quiet — so they are returned separately rather
 * than pre-joined into a sentence a layout would then have to take apart.
 */
export function greetingParts(
  language: Language,
  hour: number
): { greeting: string; question: string } {
  const part =
    hour >= 5 && hour < 12
      ? "greetingMorning"
      : hour >= 12 && hour < 18
      ? "greetingAfternoon"
      : "greetingEvening";
  return { greeting: t(language, part), question: t(language, "greetingSuffix") };
}

/** Time-of-day greeting as one sentence, for anywhere that wants it whole. */
export function greeting(language: Language, hour: number): string {
  const parts = greetingParts(language, hour);
  return `${parts.greeting}. ${parts.question}`;
}

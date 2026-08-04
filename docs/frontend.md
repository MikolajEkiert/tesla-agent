# The Expo app (`mobile/`)

Covers `mobile/App.tsx` and everything under `mobile/src/`: how the app boots, how it
decides which of the four screens is on screen, the passcode gate, the API client, chat
persistence, the confirmation UI, the whole voice stack, i18n, theming, and the PWA
packaging. Read this before touching anything under `mobile/` — it is the thing a new
engineer should read to actually understand the subsystem, not a summary to skim.

---

## 1. `App.tsx`: composition without a router

There is no router library in this app (see `package.json` — no `react-navigation`, no
`expo-router`). `App.tsx` is 155 lines and picks between four screens with plain
conditional rendering, gated on two pieces of state that are resolved in sequence.

```
App
 └─ LanguageProvider           (mobile/App.tsx:150-154)
     └─ AppInner
         ├─ font loading (useFonts)
         ├─ useAuthCallbackNotice()   — reads ?tesla_auth=... on web only
         ├─ probe() → fetchAuthStatus()  — doubles as session + connection check
         └─ renders one of:
             ├─ blank View            (fonts/language/unlocked not yet known)
             ├─ PasscodeScreen         (unlocked === false)
             ├─ blank View             (unlocked, authStatus not yet fetched)
             ├─ ConnectScreen          (authStatus.required && !authStatus.connected)
             └─ ChatScreen             (otherwise)
```

The gating order matters and is deliberate. `unlocked` is resolved first: nothing about
a Tesla account should be reachable by someone who merely opened the URL
(`mobile/src/screens/PasscodeScreen.tsx:19-23`). Only once the passcode gate has passed
does the app look at `authStatus.required` — which is `false` on the mock adapter, so a
dev build backed by `TESLA_ADAPTER=mock` skips `ConnectScreen` entirely and goes straight
to chat (`mobile/src/types.ts:88-92`).

`probe()` is a single request that answers two unrelated questions at once:

> "Probing `/auth/status` doubles as the session check: it is behind the gate, so a 401
> means 'locked' rather than 'broken'. One request answers both questions."
> — `mobile/App.tsx:72-74`

Its `.catch()` is unconditional — *any* failure (401, network error, an edge proxy
demanding its own credentials) lands on the passcode screen rather than trying to guess
whether the failure was really an auth failure:

> "An earlier version fell through to the chat whenever the cause wasn't a clean 401,
> which rendered a fully working-looking chat over a backend that refused every request."
> — `mobile/App.tsx:82-88`

`onLocked` is threaded down into `ChatScreen` and called from any API call that raises
`NotUnlockedError` (see §3) — that's the path by which a session that expires mid-use
snaps back to `PasscodeScreen` without a full reload, by calling `probe`'s setter
(`setUnlocked(false)`) again through the same code path App.tsx wired up initially.

`ConnectScreen` and `PasscodeScreen` are visually near-identical (same `AmpMark`, same
button styles) but solve different problems, and the file comments say so explicitly:

> "Distinct from ConnectScreen, which links the *Tesla account*: that authenticates this
> server to Tesla and says nothing about who is holding the phone."
> — `mobile/src/screens/PasscodeScreen.tsx:19-22`

`SettingsScreen` is not one of the four top-level screens — it's rendered as an
absolutely-positioned overlay *inside* `ChatScreen` (`mobile/src/screens/ChatScreen.tsx:1717-1738`)
so that closing it doesn't unmount and re-scroll the transcript underneath it. An earlier
version used an early-return, which unmounted the chat and dropped the reader back to the
bottom of a list they may have scrolled up in.

---

## 2. The passcode/session lifecycle: `NotUnlockedError` vs `BackendError`

`mobile/src/api.ts` defines two error classes that every screen relies on to distinguish
"you're not allowed in" from "something broke":

```ts
export class BackendError extends Error {}      // api.ts:28
export class NotUnlockedError extends Error {}   // api.ts:35
```

`BackendError` means the backend actually answered with an HTTP error — a real status
code, e.g. an LLM rate limit or a bad tool call — and its message is the server's own
`detail` string when the response is JSON (`errorDetail`, `api.ts:150-158`). It is thrown
by `guard()` for any non-2xx, non-401 response.

`NotUnlockedError` means the session cookie is missing or expired. `guard()` special-cases
401 before checking `res.ok` at all:

```ts
async function guard(res: Response): Promise<void> {   // api.ts:40
  if (res.status === 401) {
    throw new NotUnlockedError("locked");
  }
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
}
```

The distinction exists so that a locked app never *looks* like a broken one
(`api.ts:31-34`). Every call site in `ChatScreen.tsx` that touches the network
(`refreshVehicle`, `refreshScheduled`, `handleSend`, `finishConversationTurn`, …)
special-cases `NotUnlockedError` first and calls `onLocked?.()`, letting everything else
fall into the generic "show an error bar" path. See for example
`mobile/src/screens/ChatScreen.tsx:394-402` and `:883-903`.

Two endpoints deliberately bypass `guard()` because a 401 from them means something
different from "you're locked out":

- `unlock()` (`api.ts:61-71`) — a *wrong* passcode is also a 401, but it means "try
  again", not "show the passcode screen [again]"; the caller is already there.
- Most fetches that only *read* state (`fetchGateStatus`, `fetchVoices`) call `guard()`
  or check `res.ok` directly depending on whether a 401 there is meaningful — check each
  call site rather than assuming a pattern.

`lock()` (`api.ts:73-83`) is the one place where *not* throwing on failure would be a
bug — the comment there is instructive about why a "best effort" default is sometimes
wrong:

> "Throws if the server did not actually clear the session. Previously this ignored the
> result and the UI returned to the passcode screen regardless, so a failed logout looked
> identical to a successful one."
> — `mobile/src/api.ts:74-77`

`discardAction()` (canceling a pending confirm card) is the opposite: it swallows every
failure, because the card has already settled by the time the request runs and the
server's own TTL is the backstop (`api.ts:85-102`).

---

## 3. `api.ts`: base URL resolution and credentials

`mobile/src/api.ts` (619 lines) is the single HTTP client for the app — nothing else
constructs a `fetch()` to the backend. The base URL is resolved once, at module load:

```ts
const DEFAULT_BASE_URL =                                     // api.ts:12-18
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "web"
    ? ""
    : Platform.OS === "android"
    ? "http://10.0.2.2:8000"
    : "http://localhost:8000");
```

| Platform | Base URL | Why |
|---|---|---|
| web (deployed PWA) | `""` (same-origin) | Caddy already routes `/chat`, `/vehicle`, `/auth`, `/.well-known` on the same domain that serves the frontend — nothing needs to be hardcoded. |
| Android emulator | `http://10.0.2.2:8000` | The emulator's alias for the host machine's loopback. |
| iOS Simulator | `http://localhost:8000` | The simulator shares the host Mac's network directly. |
| anything else (physical device, native build against prod) | `EXPO_PUBLIC_API_URL` | Must be set explicitly — there's no way to infer it. |

Note the port mismatch with `npm run api` (`:8123`, per the CLAUDE.md command table) —
`8000` here is the historical default baked into the fallback; a local native run against
a backend on a different port needs `EXPO_PUBLIC_API_URL` set regardless of platform.

Every request sends cookies:

```ts
const CREDENTIALS: RequestInit = { credentials: "include" };   // api.ts:38
```

with the one-line justification `"Cookies are the session carrier, so every call must
send them."` The session cookie is set by `POST /gate/unlock` and read by `auth/gate.py`
server-side — it's the *access-control* layer, orthogonal to the *Tesla OAuth* layer
(`startTeslaLogin` / `/auth/login` / `/auth/callback`, `api.ts:463-476`), which is why
`ConnectScreen` and `PasscodeScreen` are separate screens gating separate things (§1).

`api.ts` also holds the WebAuthn (passkey) glue — `registerPasskey`, `loginWithPasskey`,
`fetchPasskeys`, `deletePasskey` (`api.ts:478-619`) — including the base64url ⇄
`ArrayBuffer` conversion the browser's Credential API demands
(`b64urlToBuffer`/`bufferToB64url`/`decodeRequestOptions`/`encodeCredential`,
`api.ts:482-551`), and it's explicitly web-only: "the browser's credential API is what
talks to Face ID… on native the passcode remains the way in" (`api.ts:478-480`).
Enrolling a passkey re-asks for the passcode even though a session already exists —
"enrolling a credential is exactly the step a borrowed unlocked phone should not be able
to take on its own" (`api.ts:558-560`).

---

## 4. Chat state and persistence: `chats.ts` + `AsyncStorage`

`mobile/src/chats.ts` (254 lines) makes conversations survive a reload — necessary
because a backgrounded PWA on a phone can have its tab reclaimed at any point, which used
to mean a refresh in the car was amnesia (`chats.ts:1-8`).

**Storage shape.** Two AsyncStorage key families rather than one blob:

- `amp.chats.index` — one `ChatSummary[]` (`{id, title, updatedAt, renamed?}`), cheap to
  parse on every boot to draw the sidebar.
- `amp.chat.<id>` — one `StoredChat` per conversation body (`items` + `history`), read
  only when that chat is actually opened. Tool results (vehicle state, charger lists) run
  to tens of kilobytes; parsing all of them just to draw six sidebar rows would be paid on
  every launch (`chats.ts:10-14`).
- `amp.chats.last` — which chat to reopen on the next launch.

On web, `AsyncStorage` *is* `localStorage`; on native it's the platform's own store —
same code path either way (`chats.ts:16-18`).

**Caps**, all with a stated reason:

| Constant | Value | Why |
|---|---|---|
| `MAX_CHATS` | 25 | Generous for a personal assistant, still inside 5 MB |
| `MAX_TURNS` | 60 | Mirrors `MAX_HISTORY_TURNS` in `backend/app/llm/prompt.py` — no point storing what the model will never be sent |
| `MAX_ITEMS` | 240 | Higher than `MAX_TURNS`: one turn can produce several rows (a message, plus one tool line per call) |
| `MAX_TITLE` | 60 chars | Length of the auto-derived chat name |

**What gets stripped before storage** (`forStorage`, `chats.ts:109-111`): confirm cards.
A parked command's token is forgotten by the server after `PENDING_TTL_S` (120s, mirrored
in `ConfirmCard.tsx`, see §5) — a restored card would be "a button that can only fail…
and worse, it looks live." The tool-trace line above it survives (the record of what was
proposed stays); only the pretence that it's still tappable goes.

**Titling** (`titleFor`, `chats.ts:70-82`): named after the first thing the *owner* said,
skipping the greeting (every chat opens with the same one, so titling after it would
produce identical rows). A conversation held entirely by voice has no user-authored text
at all — its turns are durations, not transcripts — so it falls back to the first thing
the *assistant* said.

**`isWorthSaving`** (`chats.ts:91-99`): a chat holding only the opening greeting is not a
conversation and must not be saved — but a chat that is *only* voice turns (no `message`
item with `role: "user"`) does count, because voice turns carry no text at all (they're
`{kind: "voice", seconds}` — see `types.ts:19-23`); testing only for a user `message`
would have discarded every live conversation the instant it ended.

**Save flow**: `saveChat()` (`chats.ts:165-200`) handles storage quota by *retrying*
rather than failing outright — if the write throws (quota), it drops the oldest chat that
isn't the one being written and tries again, until it fits or there's nothing left to
drop, at which point it gives up silently: "a chat that cannot be saved is not a reason to
interrupt the one being had."

**`ChatScreen`'s save effect** (`ChatScreen.tsx:499-516`) debounces writes by 600ms
because a live voice turn appends several rows in quick succession and a streamed reply
arrives fragment by fragment — writing on every change would rewrite the whole body dozens
of times a sentence. `skipSaveRef` (`ChatScreen.tsx:216-221`) suppresses exactly one save
right after loading a stored chat, so merely *opening* an old conversation doesn't bump
its `updatedAt` and reshuffle the sidebar. A running voice conversation is deliberately
*not* carried across when switching chats (`openChat`, `ChatScreen.tsx:1040-1069`) — it
belongs to the chat it started in.

A live conversation is stored **as its transcript only** — its actual context lives in
the session Google holds, not in `history` — "the same separation the two assistants have
everywhere else" (`ChatScreen.tsx:494-497`).

---

## 5. The confirmation UI: `ConfirmCard` / `ConfirmDialog`

Two different components solving two different problems, and conflating them was a real
bug.

### `ConfirmDialog` — generic "are you sure?"

`mobile/src/components/ConfirmDialog.tsx` exists because `Alert.alert` is a no-op on web
(`static alert() {}` in `react-native-web`), and web is where this app actually runs. It
was discovered when disconnecting the Tesla account (wired to `Alert.alert`) did
literally nothing on a phone, silently. It's now the one component for every destructive
confirmation not tied to a physical car command — e.g. deleting a custom persona in
`SettingsScreen` (`SettingsScreen.tsx:714-724`).

### `ConfirmCard` — the physical-command gate

`mobile/src/components/ConfirmCard.tsx` is the UI half of the load-bearing safety design
described in the top-level CLAUDE.md:

> "The assistant can only *propose* unlocking the car, opening the trunk or triggering
> HomeLink — the backend parks those and hands back a token (see
> `backend/app/actions.py`). This card is the only path from proposal to execution, and
> it needs a human finger. That matters because the model's context includes free text
> from anonymously-editable map databases: an injected instruction can, at worst, make
> this card appear, which is visible and refusable rather than a silently opened car."
> — `ConfirmCard.tsx:9-19`

It renders from a `ChatItem` of `kind: "confirm"` (`types.ts:26-38`), produced in
`ChatScreen.handleSend` whenever a tool result carries
`{confirmation_required: true, confirm_token}` (`ChatScreen.tsx:791-816`) — this maps
directly onto `actions.CONFIRM_REQUIRED` server-side. The set of gated tools is mirrored
client-side purely for labelling, in `LABEL_FOR_TOOL` (`ConfirmCard.tsx:20-28`):
`unlock`, `actuate_trunk`, `trigger_homelink`, `control_windows`, `set_sentry_mode`,
`software_update`.

`DETAIL_ARG` (`ConfirmCard.tsx:30-43`) picks which argument actually distinguishes what
the card is asking about, per tool — "'Open the trunk' is two different commands
depending on one word, and the card used to show neither." Trunk asks `which`, windows
asks `command`, sentry asks `on`, update asks `action`.

Three timers, all mirroring server-side constants and stated as such:

| Constant | Value | Mirrors | Meaning |
|---|---|---|---|
| `TOKEN_TTL_S` | 120 | `PENDING_TTL_S` in `backend/app/actions.py` | Card stops being tappable |
| `VOICE_WINDOW_S` | 25 | `VOICE_WINDOW_S` in `backend/app/actions.py` | Spoken "confirm" stops working, well before the tap does |
| `COUNTDOWN_FROM_S` | 45 | (client-only) | When the ticking countdown becomes visible — showing it from the start would put a clock on a decision that usually takes three seconds |

`voice` (a prop, `ConfirmCard.tsx:87-88`) controls whether the spoken shortcut hint shows
at all. It's only ever `true` mid-conversation, and never for `unlock`
(`ChatScreen.tsx:805-812`) — "the server refuses that anyway, so offering it in the UI
would just be a promise it won't keep." The card's countdown gates the hint further:
`voice && TOKEN_TTL_S - remaining <= VOICE_WINDOW_S` (`ConfirmCard.tsx:178`) — the hint
only appears once the card is inside the voice-answerable window, because outside it a
clear "potwierdzam" would be met with a refusal from the server.

Dismissing a card calls both `discardAction(token)` (best-effort — §2) *and* the local
`onDismiss` — declining actually removes the parked command server-side rather than only
hiding the card.

**Voice settlement** is a separate code path entirely — `settleByVoice`
(`ChatScreen.tsx:1215-1257`) sends the *recording itself* to `POST
/actions/confirm/voice`, never through `/chat`:

> "The audio never goes near /chat, so the assistant is not told a word was said and
> cannot act on it — the server matches the phrase in code and either runs the parked
> command or does not."
> — `mobile/src/api.ts:116-118`

`awaitingVoiceConfirmRef` (`ChatScreen.tsx:296-301`) holds at most one `{token, tool}` —
"last wins" if the model somehow proposed two pending commands in one turn, since the
server would refuse the ambiguous case anyway (`ChatScreen.tsx:820-834`). It's cleared on
settlement, on dismissal, on leaving the conversation, and when the "voice confirm"
setting is switched off mid-conversation.

---

## 6. The voice stack, file by file

All under `mobile/src/voice/`. Two capture *paths* exist and share one microphone-opening
function (`openMicrophone`, `recorder.ts:41-48`) precisely because they used to be
written twice and drifted — a fix landing in one and not the other for a whole afternoon.

### `audioSession.ts` — telling iOS what the page is doing with audio

Wraps Safari's `navigator.audioSession`, which is page-wide and takes effect immediately.
Two states matter: `playback` (obeys the ringer switch, cannot capture) and
`play-and-record` (obeys the ringer switch, can capture). Getting this wrong is not a
soft degradation — `getUserMedia` throws `InvalidStateError: AudioSession category is not
compatible with audio capture`, and this "made every voice control on the phone fail the
instant it was pressed, while the same build worked in Chrome" (`audioSession.ts:10-17`,
Chrome has no audio session concept to get wrong). `prepareForCapture()` and
`prepareForPlayback()` are the two entry points; whichever runs last in a given gesture
wins, which happens to be correct by construction since capture always asks for the
microphone *after* speech has been primed in the same tap.

### `vad.ts` — telling speech apart from a thump

Not amplitude-based. The whole file exists because of a measured incident:

> "Hitting the seat produced a recording that passed an amplitude-only check, went to the
> transcriber, and came back as a confidently-worded command nobody had spoken."
> — `vad.ts:5-8`

It classifies 128-sample blocks (`BLOCK_SIZE`) with 50% overlap (`HOP_SIZE`) on two
measures: `rms` (loudness, still needed as a floor) and `tilt` (ratio of sample-to-sample
difference energy to block energy — a cheap stand-in for spectral centroid, low for
rumble, high for hiss, mid for speech). A block only counts as speech evidence if it's
loud *and* has the right spectral tilt; a fricative-band threshold (`consonantTilt`) is
the load-bearing one, because engine/road rumble reliably clears the loudness and
in-band tests but produces zero fricative-band content — measured directly in the table
at `vad.ts:20-32`. Two kinds of evidence must both be present
(`SPEECH_EVIDENCE.minInBandMs` + `minConsonantMs`, `vad.ts:191-205`) before a recording
counts as containing speech at all; a single stray transient is insufficient by design.

`normaliseTilt()` (`vad.ts:151-155`) corrects for sample rate: tilt is a ratio of
differences, so the *same voice* reads almost ten times lower at 48 kHz than at 16 kHz
(the rate every threshold in `VOICE_PROFILE` was measured at) — left uncorrected, a
phone whose hardware refuses 16 kHz would decide nobody had spoken, every time.

The file is deliberately free of React and of any import at all
(`vad.ts:49-51`) so it can be compiled standalone and run over recorded WAV files — that
is literally how the measurement table in the header comment was produced, and how it
should be re-verified if the thresholds are ever changed.

`speechSpanMs()` (`vad.ts:226-237`) answers a different question: not "is there speech in
here" but "how long, as a span from first speech-shaped block to last" — used by
`live.ts` to report `onUserSpoke(seconds)` without the microphone-open silence before and
after a sentence inflating the number.

### `recorder.ts` — turn-based capture (push-to-talk / one-shot conversation turns)

`VoiceRecorder` (`recorder.ts:242-511`) captures 16 kHz mono 16-bit WAV, encoded by hand
rather than via `MediaRecorder` — iOS decides the container itself (`audio/mp4`, not the
`webm` every tutorial assumes), so writing the bytes here removes that guesswork
(`recorder.ts:1-9`). It always requests the microphone at the hardware's own rate and
resamples down afterward, because asking `AudioContext` for 16 kHz outright makes Safari
refuse to attach a microphone to the result (`InvalidStateError` from
`createMediaStreamSource`, `recorder.ts:296-305`).

Two independent, optional behaviors layered onto the same class:

- `endpointing` (`Endpointing` interface, `recorder.ts:215-227`) — auto-stops the
  recording once speech has been heard and then gone quiet for `silenceMs`, or gives up
  after `noSpeechTimeoutMs` if nothing speech-shaped ever arrived. Used for full
  conversation turns.
- `onset` (`Onset` interface, `recorder.ts:237-241`) — fires once when level has held
  above a threshold for `sustainMs`, used only by the barge-in watcher (a second, parallel
  `VoiceRecorder` instance that exists solely to *detect* an interruption, never to
  capture a full turn — `ChatScreen.tsx:289-293`, `1100-1120`).

`stop()` (`recorder.ts:453-485`) is where the VAD evidence is actually enforced: if
`endpointing` was configured and `hasSpeech()` is false, it throws `NothingRecordedError`
rather than returning a WAV — "No speech evidence, no transcription." A final raw-peak
check (`< 0.005`) catches the case of a granted permission that captured pure silence, so
the app doesn't spend an API call being told there was nothing to hear.

Also home to a handful of AsyncStorage-backed settings used across `ChatScreen` and
`SettingsScreen`: `loadBargeIn`/`saveBargeIn` (`amp.bargein`, default on),
`loadVoiceConfirm`/`saveVoiceConfirm` (`amp.voiceconfirm`, default on),
`loadLiveMode`/`saveLiveMode` (`amp.live`, default on).

### `cue.ts` — the "now it can hear you" tone

A synthesized two-note WAV (E5→A5, struck-and-decay envelope, `cue.ts:36-56`), played
through an `<audio>` element rather than Web Audio — Safari caps the number of live
`AudioContext`s and a conversation already holds two (capture + reply playback), so a
third one just for a beep would spend a scarce resource on the least important sound in
the app (`cue.ts:12-17`). `primeCue()` must run inside the gesture that starts a
conversation (iOS gesture-arming rule, same constraint as everything else audio-related
here); `playReadyCue()` fires when the session actually becomes able to listen.

### `speak.ts` — spoken replies

Two voices, one falling back to the other. The preferred path (`fetchSpeech` →
`backend/app/tts.py`) is a cloud voice reading the reply with direction on *how* to read
it; the platform's built-in `speechSynthesis` is the fallback, used whenever the cloud
path fails for any reason — rate limit, no signal, a 503 (`speak.ts:1-13`, the fallback
logic lives in `speak()`'s `.catch()`, `speak.ts:411-420`).

Voice choice (`VoiceChoice = "device" | string`) is server-held, not per-device
(`backend/app/prefs_store.py`), so the phone and a laptop agree — `loadVoiceChoice()`
(`speak.ts:68-87`) fetches it and caches a copy in AsyncStorage purely as an offline
fallback and a one-way handoff for a device that picked something before this was
server-side.

`SpeechMode` (`"off" | "voice" | "always"`) defaults to `"voice"` — reply aloud only when
asked aloud — deliberately not `"always"`, because both `speechSynthesis` and an `<audio>`
element were measured to keep playing with the phone's ringer switch silenced, and an
always-on voice would happily talk in a meeting (`speak.ts:9-22`).

iOS gesture-priming: `primeSpeech()` (`speak.ts:241-283`) must be called from a real tap,
because a reply's audio arrives seconds after the tap that requested it — long past the
point a browser still counts it as "from a gesture." It arms *both* the audio element (a
silent WAV, played once) and `speechSynthesis` (an empty, silent utterance) in the same
call, in the same gesture, and declares the audio session as `playback` — which is why
the capture paths (`recorder.ts`, `live.ts`) always call `prepareForCapture()` themselves
immediately before opening a microphone: `primeSpeech()` runs first in the *same* tap that
then opens the mic, and whichever runs last wins.

`generation` (`speak.ts:315`) is bumped on every new `speak()` call and every
`stopSpeaking()`, and is the mechanism by which a slow network response for an *old*
reply is prevented from starting to play after a newer question has already been asked or
the stop button already pressed — "audio that arrives after its reply stopped being the
current one must not play... a late arrival compares its own number and drops itself"
(`speak.ts:308-315`).

Caching: `clipCache` (`speak.ts:358-371`) is a small (16-entry, 200-char) in-memory LRU
for *short, repeated* lines — chiefly the voice-preview sample in Settings, spoken again
on every tap of a voice chip. Replies themselves are never cached — "long, said once, and
holding their audio would be a memory leak dressed as an optimisation."

### `live.ts` — the realtime session

`LiveSession` (`live.ts:226-1152`) wires the phone's microphone and speaker straight to
Gemini's Live API over a WebSocket, with the same tool list the typed assistant has. This
is a from-scratch rewrite of an earlier design, and the file's header explains why the
earlier one couldn't work:

> "It used to be a relay: no tools, an instruction never to answer, the transcript posted
> to /chat so the text assistant could think, and the answer handed back for it to read
> aloud. That could not work... Closing a turn makes a Live model generate; it generated
> an answer to the driver every single time, out of nothing, because it had no tools and
> no car... Both the unwanted reply and the wanted one arrive on the same socket, so the
> flag flipped mid-stream and the tail of a hallucination reached the speaker in the
> assistant's own voice."
> — `live.ts:11-24`

The two assistants (typed `/chat` and live) are deliberately separate: separate context
(Live keeps its own session state on Google's side, `/chat` keeps `history` in the app),
sharing only the tool list, the confirmation gate, and the visible transcript
(`live.ts:26-31`).

Endpoint detail worth knowing if this ever needs debugging: it does **not** use the
documented `BidiGenerateContent` + `?key=` combination. An ephemeral token (which is all a
browser should ever hold) needs `BidiGenerateContentConstrained` on `v1alpha` with
`?access_token=` — the wrong combination fails with a misleading error either way
(`live.ts:42-55`).

Two independent audio rates: `INPUT_RATE = 16000` (what the API expects in) and
`OUTPUT_RATE = 24000` (what comes back) — `live.ts:62-64`.

`IDLE_TIMEOUT_MS = 30_000` is a backstop, not the primary end-of-conversation mechanism —
turn *boundaries* now belong entirely to the model's own turn detection, and this timer
only fires when nobody has said anything and the assistant hasn't spoken for that long.
Its history is instructive about a subtle trap:

> "In a car, tyres and wipers cleared the threshold continuously, so the clock never ran
> down and the guard did nothing at all; at a desk, nothing cleared it, so the session
> hung up on anyone who paused to think. Loudness was never the question."
> — `live.ts:76-81`

So the idle clock (`touch()`, `live.ts:834-836`) is reset only by things that mean
"somebody is actually talking to the car" — recognised speech, assistant audio arriving,
a tool call running — never by raw microphone level.

**How a session decides it has ended** — the part `mobile/dev/check_live_end.js` exists
to pin down, because the model can call `end_conversation` and speak its farewell in
either order:

1. The model calls the declared tool `end_conversation` (`END_CONVERSATION_TOOL`,
   `live.ts:92`) — or, having been observed *saying* the tool's name out loud instead of
   calling it (twice, in one drive: `"...szerokiej drogi! end_conversation"`), the client
   also treats the bare identifier appearing in the spoken transcript as the same request
   (`SPOKEN_TOOL_NAME` regex, `live.ts:97`, applied in `flushSaid()`, `live.ts:813-831`).
2. `requestEnd()` (`live.ts:622-636`) sets `endAfterReply = true` and starts an
   `END_GRACE_MS` (8s) backstop timer, in case the model asks to close and then says
   nothing at all.
3. `endSpoke` tracks whether *any* audio has played since the request — not "audio
   played after the request," because the model just as often says the farewell first and
   calls the tool on the way out of the same turn, meaning the farewell is already
   finished and gone by the time the request is even seen. `endSpoke` is initialised from
   `spokeThisTurn` at request time for exactly this reason (`live.ts:619-628`, the
   difference between `endSpoke` and `spokeThisTurn` is explained at length at
   `live.ts:253-274`).
4. `maybeSettle()` (`live.ts:638-658`) is the single point every route through a turn
   converges on. It only concludes the session once **both** `turnEnded` (server says
   generation is finished) and `playingSources === 0` (the *car* has finished actually
   playing the audio) are true — conflating "generated" with "heard" was what used to cut
   long replies off mid-sentence, since a reply generated faster than it plays drains the
   playback queue several times on the way through.
5. If the driver speaks again before the farewell has started, `cancelPendingEnd()`
   (`live.ts:669-677`) drops the pending close *and* its backstop timer — otherwise the
   timer fires 8 seconds after the original tool call regardless of what's happened since,
   hanging up mid-sentence on a driver who changed their mind.

`check_live_end.js` runs six of these orderings against the *actual* `live.ts` (not a
reimplementation — see §8) with all four of its imports stubbed out, and a seventh case
(`spokenTurnIsADuration`) that verifies `onUserSpoke` reports only a numeric duration,
never the session's own (unreliable) transcript of the driver — see the reasoning at
`live.ts:140-152`.

Barge-in (`allowBargeIn`, `live.ts:310`, `947-951`): with it off, the uplink audio is
simply dropped while the assistant is speaking, so neither the reply leaking back through
the speaker nor a stray sound can interrupt — a tap remains the only way to interrupt.

`interrupt()` (`live.ts:1002-1010`) — the tap-triggered stop — deliberately sends
*nothing* to the model. Sending a completed-empty-turn message would itself be an
instruction to generate, "which would answer a question nobody asked, in its own words,
which is the exact failure this file was rewritten to remove"; the rest of the reply is
just silently dropped as it arrives instead.

---

## 7. Turn-based recording vs. a live session — how `ChatScreen` picks

`ChatScreen.startConversation()` (`ChatScreen.tsx:1440-1459`) always tries
`startLive()` first and falls back to the record-and-upload loop
(`listenAgain`/`finishConversationTurn`) only if live is disabled, unsupported, the
`device` voice is selected (which has no server-side model to speak through), or the live
socket itself fails to come up (`startLive`, `ChatScreen.tsx:1334-1438`):

> "Falling back rather than failing is the whole point: a refused token, a blocked socket
> or a flaky tunnel drops the conversation onto the record-and-upload path that has been
> working all along, and the driver hears a slightly slower assistant instead of none."
> — `ChatScreen.tsx:1323-1326`

The two paths differ in almost everything:

| | Turn-based (`recorder.ts` + `/voice/transcribe` + `/chat`) | Live (`live.ts`, WebSocket) |
|---|---|---|
| Turn boundary | Client-side VAD (`Endpointing`) | The model's own turn detection |
| What travels over the network | One WAV file per turn, uploaded after capture | Streaming PCM chunks, both directions, continuously |
| Where the driver's words are transcribed | Server (`/voice/transcribe`), then sent as text through `/chat` like a typed message | The Live API's own (weaker, unread-by-the-model) transcriber, quoted nowhere — only its *duration* is surfaced |
| Assistant's voice | `fetchSpeech` (Cloud TTS) or device `speechSynthesis`, played after the whole reply is generated | Streamed audio chunks, playing while still being generated |
| Tool calls | Go through `/chat`'s `tool_trace` | Go through `/live/tool`, same confirmation gate |
| History | Accumulated in React state, sent back to `/chat` each turn | Held entirely server-side by Google inside the Live session |

`ChatScreen.handleConversationTap()` (`ChatScreen.tsx:1461-1486`) also behaves
differently per path: for a live session, a tap while it's *listening* is a no-op — "a
live session decides for itself when the driver has finished talking... asking the model
to close a turn it did not think was over is what used to make it answer out of turn" —
whereas the turn-based path treats a tap during `listening` as "release early," calling
`finishConversationTurn()` immediately instead of waiting out the silence timer.

---

## 8. `mobile/dev/` check scripts

Two standalone Node scripts, the mobile-side equivalent of `backend/dev/check_*.py` —
adversarial, hand-run regression checks rather than a conventional test runner. Both
transpile the *actual* TypeScript source with the real `typescript` package
(`ts.transpileModule`), stub out its imports (`react-native`, `../api`,
`./audioSession`, `./recorder`, `./vad` as applicable), and `new Function(...)` the
result — so what's under test is the code that ships, not a parallel reimplementation of
its logic.

### `check_live_end.js`

> "Does a live conversation close when the goodbye stops, whatever order the model does
> things in? Driving the real LiveSession, not a copy of its logic."
> — `mobile/dev/check_live_end.js:1-6`

Network-free and model-free — no socket opens, no audio is decoded; a fake
`AudioContext` with instrumented `createBufferSource()` lets the test fire `onended`
manually (`finishPlayback()`) to simulate "the car finished saying it." Feeds JSON
payloads shaped like the real Gemini Live protocol (`heard()`, `said()`,
`turnComplete()`, `endCall()`) directly into `session.onMessage()`. Covers the six
orderings and the transcript-vs-duration behavior described in §6.

Run from `mobile/`:

```
node dev/check_live_end.js
```

### `check_spoken_turn.js`

Verifies two independent things: that `speechSpanMs` (from `vad.ts`) measures only the
*span* of speech-shaped audio and correctly ignores the silence before/after/between
(five cases, `check_spoken_turn.js:78-89`), and that `spokenFor()` (from `i18n.ts`)
produces grammatically correct Polish plural forms — Polish declines the noun three ways
(1 / 2–4 / 5+) with the teens (12–14) as an exception to the 2–4 rule, so "22 sekundy"
but "12 sekund." Every boundary case is listed explicitly rather than sampled
(`check_spoken_turn.js:92-116`), plus a handful of English cases.

Run from `mobile/`:

```
node dev/check_spoken_turn.js
```

Both scripts exit non-zero on any failure and print `ok`/`FAIL` per assertion — suitable
for wiring into CI, though nothing in the repo currently does.

---

## 9. i18n, `LanguageContext`, and the reply-language rule

`mobile/src/i18n.ts` (484 lines) is a flat, hand-written string table —
`STRINGS.en` / `STRINGS.pl` — with `TranslationKey = keyof (typeof STRINGS)["en"]`
(`i18n.ts:390`) enforcing that both languages define exactly the same key set at compile
time. There is no ICU/pluralization library; `t()` (`i18n.ts:418-431`) does simple
`{name}` interpolation by regex.

`Language = "en" | "pl"` is persisted under `amp.language` (`loadLanguage`/`saveLanguage`,
`i18n.ts:400-416`), defaulting on first run to whatever `navigator.language` says on web
(`detectDefaultLanguage`, `i18n.ts:393-398`) and to `"en"` everywhere else.

**The rule that the app's language sets the *reply* language, not what the driver may
say**, is stated directly in the settings copy the app ships:

> `settingsLanguageHint`: "Sets the app's language and the assistant's default reply
> language in chat." — `i18n.ts:51-52`

Mechanically: `language` from `useLanguage()` is threaded as a parameter into every call
that can produce a reply — `sendMessage(text, history, language, …)` (`api.ts:160-184`),
`fetchLiveToken(voice, language, …)` (`api.ts:318-344`), `transcribe(audio, language, …)`
(`api.ts:254-275`) — so the *language setting*, not anything spoken or typed, is what the
backend is told to answer in. A driver who asks a question in Polish while the app is set
to English still gets an English reply; switching the app's language is the only way to
change that.

`spokenFor()` (§8) and `greetingParts()`/`greeting()` (`i18n.ts:467-484`) are the two
other language-aware helpers of note — the latter splits the opening line into a bright
greeting and a quiet question, returned separately rather than pre-joined, because the
empty-chat layout (`ChatScreen.tsx:1622-1632`) styles them in two different tones.

`LanguageContext.tsx` is a thin 43-line provider: holds `language` state, a `ready` flag
that gates first render on the stored preference having actually loaded (consumed in
`App.tsx:108`, alongside font-loading, before anything renders), and `setLanguage` /
`t` bound to the current language. `useLanguage()` throws if called outside the provider.

---

## 10. `theme.ts` — the design vocabulary

114 lines, and its organizing idea is stated in the header comment:

> "Amp talks to a car, so colour is reserved for the car: each accent below maps to one
> real vehicle system, and a coloured mark anywhere in the app always means that system
> did something. Ambient readings — the ones you glance at rather than act on — are
> deliberately colourless."
> — `theme.ts:8-13`

`color` (`theme.ts:16-48`): four steps of one dark background (`bg` → `surfaceHover`),
three text tiers all guaranteed 4.5:1 contrast ("read at arm's length, in daylight, by
someone who should be looking at the road" — `theme.ts:26-28`), one `brand` accent
(violet, `#7D7AFF` — chosen specifically to sit away from the climate blue, which an
earlier blue `brand` sat a shade too close to and "quietly stole its meaning"), and one
accent per vehicle system: `climate`, `charge`, `security`, `alert`. `toolMeta.ts` (§11)
is the map from backend tool name to one of these.

`font` (`theme.ts:57-65`): three families, one job each — Archivo for anything that names
the product (a "signage face," "which is what a car is covered in"), Figtree for
everything read as prose, JetBrains Mono reserved for "the machine's own voice: tool
calls, readings, timers."

`type` (`theme.ts:68-82`) are named text styles built from those families (`hero`,
`title`, `body`, `bodyStrong`, `label`, `caption`, `eyebrow`) — components reference
`type.hero` etc. rather than setting `fontFamily`/`fontSize` inline, which is why every
screen file in `mobile/src/screens/` imports from `theme.ts` rather than hardcoding
typography.

`space` and `radius` are the usual scale tokens; `READING_WIDTH` (760) and `WIDE_LAYOUT`
(900) are the two layout breakpoints — `WIDE_LAYOUT` decides whether `Sidebar` renders
docked as a column or as an overlay drawer (`ChatScreen.tsx:265, 1524`), `READING_WIDTH`
caps the transcript's width once there's room to spare (`ChatScreen.tsx:1755-1759`).

---

## 11. `toolMeta.ts` — rendering the tool trace

267 lines, one entry per backend tool, explicitly kept in sync by comment with
`backend/app/tools.py`:

```ts
interface ToolMeta {
  system: string;                                              // toolMeta.ts:8-12
  dot: string;
  describe: (input: Record<string, unknown>, ok: boolean) => string;
}
```

Every tool call in a `tool_trace` renders through `describeTool()`
(`toolMeta.ts:253-267`) as a system name (uppercase, machine-voice — `CLIMATE`,
`SECURITY`, `CHARGE`, `NAV`, …), a colored dot (`ok ? meta.dot : color.alert` — a failed
call always shows red regardless of which system it belongs to), and a one-line
description built from the call's actual arguments (e.g. `set_climate_temp` →
`"target set 21°C"`, `add_schedule` → `"charge 07:30 Mon,Tue"`). A tool with no entry in
`META` falls back to `{system: TOOL_NAME.toUpperCase(), dot: textTertiary, text: "done"/"failed"}`
rather than crashing — so a tool added server-side without a corresponding `toolMeta.ts`
entry still renders something, just undecorated.

Grouping choices worth knowing if extending this file: `actuate_trunk`,
`control_windows`, `trigger_homelink`, `set_sentry_mode` all share the `security` accent
— "from the outside of the car they are one system — the things that let a person in"
(`toolMeta.ts:173-177`) — while `software_update` gets its *own* system name (`UPDATE`,
still using the security dot color) rather than being grouped under `SECURITY`, because
"it is the one command that takes the car out of use, and the log line should not read
like a door lock" (`toolMeta.ts:114-116`). The app's own scheduled-action tools
(`list_scheduled_actions`, `cancel_scheduled_action`) use `system: "TIMER"` in the same
amber as `security`, "the same colour, so the two agree" with the sidebar's own queue
badge.

`ToolLogLine.tsx` is the component that actually consumes `describeTool()`'s output per
row in the transcript.

---

## 12. `update.ts` — picking up a newer build without asking

105 lines. There is no service worker in this app, so nothing was watching for a new
deploy; Caddy's cache headers only govern what a *fresh* load gets, and an installed PWA
that never cold-starts could run a stale build for days (`update.ts:1-8`).

The mechanism compares *the actual running bundle* against what the server is serving
right now — not a version number stamped at build time:

- `runningBundle()` (`update.ts:35-41`) reads the `<script src="/_expo/static/js/web/…">`
  tag the currently-running document was loaded from.
- `deployedBundle()` (`update.ts:44-51`) fetches `/index.html` with `cache: "no-store"`
  (deliberately not `no-cache`, since a revalidated copy of the answer is no answer to
  "did something change") and extracts the same pattern from whatever the server is
  serving *right now*.
- `watchForNewBuild()` (`update.ts:61-96`) polls every 15 minutes and also checks on
  every `visibilitychange` back to `"visible"` — "the app being picked up again... is
  also when acting on the answer is least disruptive." Every failure mode (offline, host
  mid-restart, unrecognized document) is silent — "none of them are worth a word to
  somebody driving."

`applyNewBuild()` (`update.ts:101-105`) is just `window.location.reload()` — safe because
the deployed shell revalidates on every load now (`deploy/Caddyfile`'s Cache-Control
block).

`ChatScreen` decides *when* it's safe to actually call `applyNewBuild()`
(`ChatScreen.tsx:544-585`) — this module only reports, never acts. The gating logic
(`idleForReloadRef`) refuses to reload while anything is "in progress": pending, speaking,
mid-conversation, a live session open, or a confirm card on screen — reloading mid-answer
"is indistinguishable, from the passenger seat, from a crash," and reloading while a
confirm card is up would leave the driver looking for a card that's no longer there.

---

## 13. The PWA story

**`app.json`**'s `expo.web` block (`mobile/app.json:19-26`) sets the PWA identity Expo
bakes into the exported `index.html`: `themeColor`/`backgroundColor` `#0F1114` (matches
`theme.ts`'s `color.bg`), `display: "standalone"`, and the `name`/`shortName` `"Amp"`.
`userInterfaceStyle: "dark"` at the top level fixes the app to dark mode regardless of the
OS setting — there is no light theme.

**`public/manifest.json`** is a hand-maintained, separate manifest (not generated by
Expo) referenced directly from `public/index.html:18`
(`<link rel="manifest" href="/manifest.json" />`). It declares `start_url: "/"`,
`id: "/"`, `display: "standalone"`, and three icon entries under `public/icons/` —
`icon-192`, `icon-512` (purpose `any`), and `maskable-icon-512` (purpose `maskable`, for
Android's adaptive-icon masking). Its `background_color`/`theme_color`
(`#0C0E12`) is very slightly darker than `app.json`'s `#0F1114` and than
`theme.ts`'s `color.bg` — a small, currently-unreconciled drift worth knowing about if
touching either file, not something this doc can resolve on its own.

**`public/index.html`** carries the iOS-specific meta tags that `app.json` cannot express:
`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style:
black-translucent` (which is *why* `SettingsScreen` had to fight a status-bar overlap bug
— see the extended comment at `SettingsScreen.tsx:256-270` about `SafeAreaView` padding
boxes and absolutely-positioned overlays), and `apple-mobile-web-app-title`. It
deliberately omits its own `theme-color` meta tag — a comment there notes Expo injects
one from `app.json` at build time (`public/index.html:27`) — and carries a substantial
block of CSS/JS working around `100vh` vs. `100dvh` behavior inside a standalone,
`viewport-fit=cover` PWA (`public/index.html:60-103`), which matters for `SafeAreaView`
insets to resolve correctly under the notch.

**`public/amp-recorder-worklet.js`** is the `AudioWorkletProcessor` module both
`recorder.ts` and `live.ts` load via `context.audioWorklet.addModule(...)`
(`recorder.ts:335`, `live.ts:892`) — one audio-thread module shared by both capture
paths, with a `ScriptProcessorNode` fallback in each file if the worklet fails to load.

**Build and deploy**: nothing under `mobile/` is built on the server. `deploy.sh` builds
the static export locally —

```sh
( cd mobile && npx expo export -p web --clear )   # deploy.sh:24
```

— `--clear` specifically to defeat Metro's bundler cache, which can otherwise silently
serve back a bundle built earlier against a different (or absent)
`EXPO_PUBLIC_API_URL` (`deploy.sh:20-23`). The resulting `mobile/dist/` (containing
`_expo/`, `assets/`, `index.html`, `manifest.json`, the icons, and the worklet — verified
present in this checkout) is what `rsync` ships to the server, and
`deploy/Dockerfile.web` serves that pre-built tree directly rather than running a build
inside the container — stated explicitly in `deploy.sh`'s own log line: `"Building the
PWA (deploy/Dockerfile.web ships the pre-built dist/, it doesn't build it on the
server)…"` (`deploy.sh:20`).

---

## Appendix: file index

| File | Lines | Role |
|---|---|---|
| `mobile/App.tsx` | 155 | Root composition, screen switching, auth-callback notice |
| `mobile/src/api.ts` | 619 | The one HTTP client; base URL, `guard()`, all backend calls, passkeys |
| `mobile/src/chats.ts` | 254 | AsyncStorage-backed chat index + bodies |
| `mobile/src/i18n.ts` | 484 | PL/EN string table, `t()`, plural rules, greetings |
| `mobile/src/LanguageContext.tsx` | 43 | React context wrapping `i18n.ts` |
| `mobile/src/theme.ts` | 114 | Color/font/type/space/radius tokens |
| `mobile/src/toolMeta.ts` | 267 | Tool → system/color/description map for the trace log |
| `mobile/src/update.ts` | 105 | Detects a newer deployed bundle |
| `mobile/src/persona.ts` | 248 | Built-in + custom persona storage (see backend `persona_store.py`) |
| `mobile/src/types.ts` | 92 | `ChatItem`, `VehicleState`, `ChatResponse`, etc. |
| `mobile/src/markdown.ts` | 95 | Markdown → plain text (used before speaking a reply) |
| `mobile/src/clipboard.ts` | 49 | Copy-to-clipboard helper |
| `mobile/src/screens/ChatScreen.tsx` | 1836 | The whole conversation UI, both typed and voice |
| `mobile/src/screens/ConnectScreen.tsx` | 111 | Tesla OAuth gate |
| `mobile/src/screens/PasscodeScreen.tsx` | 252 | App-access gate (passcode + optional passkey/TOTP) |
| `mobile/src/screens/SettingsScreen.tsx` | 1005 | Language, persona, voice, conversation, passkey settings |
| `mobile/src/components/ConfirmCard.tsx` | 331 | Physical-command confirmation, tap or voice |
| `mobile/src/components/ConfirmDialog.tsx` | 149 | Generic "are you sure?" (Alert.alert replacement) |
| `mobile/src/voice/recorder.ts` | 511 | Turn-based WAV capture + VAD-gated endpointing |
| `mobile/src/voice/vad.ts` | 237 | Speech-vs-noise classifier |
| `mobile/src/voice/audioSession.ts` | 71 | iOS `navigator.audioSession` playback/capture switch |
| `mobile/src/voice/cue.ts` | 113 | The "ready to listen" tone |
| `mobile/src/voice/speak.ts` | 548 | TTS playback, device-voice fallback, iOS priming |
| `mobile/src/voice/live.ts` | 1152 | Realtime Gemini Live session over WebSocket |
| `mobile/dev/check_live_end.js` | 239 | Adversarial check: live-session end-of-conversation ordering |
| `mobile/dev/check_spoken_turn.js` | 130 | Adversarial check: speech-span measurement + PL/EN pluralization |
| `mobile/app.json` | — | Expo config, incl. PWA web block |
| `mobile/public/manifest.json` | — | Hand-maintained web app manifest |
| `mobile/public/index.html` | — | iOS PWA meta tags, viewport/safe-area CSS |
| `mobile/public/amp-recorder-worklet.js` | — | Shared `AudioWorkletProcessor` |

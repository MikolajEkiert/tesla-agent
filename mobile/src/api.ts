import { Linking, Platform } from "react-native";
import type { AuthStatus, ChatResponse, ScheduledAction, VehicleState } from "./types";

/**
 * Web (the deployed PWA) defaults to same-origin — Caddy already routes
 * /chat, /vehicle, /auth, and /.well-known on the same domain that serves
 * the frontend, so no domain needs to be hardcoded here at all. Native iOS
 * Simulator shares the host Mac's network (localhost works directly);
 * Android's emulator needs 10.0.2.2 instead. A physical device, or pointing
 * a native build at production, needs EXPO_PUBLIC_API_URL set explicitly.
 */
const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "web"
    ? ""
    : Platform.OS === "android"
    ? "http://10.0.2.2:8000"
    : "http://localhost:8000");

/**
 * Thrown only when the backend actually responded with an error (a real
 * HTTP status, not a network failure) — e.g. an LLM rate limit or a bad
 * tool call. `fetch()` itself throwing a plain (non-Backend) error means
 * the request never reached the backend at all. Callers use this
 * distinction to show "here's what went wrong" vs. "is the backend even
 * running?" instead of collapsing both into the same generic message.
 */
export class BackendError extends Error {}

/**
 * The session cookie is missing or expired — the caller should show the
 * passcode screen rather than an error. Distinct from BackendError so a
 * locked app never looks like a broken one.
 */
export class NotUnlockedError extends Error {}

/** Cookies are the session carrier, so every call must send them. */
const CREDENTIALS: RequestInit = { credentials: "include" };

async function guard(res: Response): Promise<void> {
  if (res.status === 401) {
    throw new NotUnlockedError("locked");
  }
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
}

export interface GateStatus {
  configured: boolean;
  totp_required: boolean;
  passkey_available: boolean;
}

export async function fetchGateStatus(): Promise<GateStatus> {
  const res = await fetch(`${DEFAULT_BASE_URL}/gate/status`, CREDENTIALS);
  if (!res.ok) throw new BackendError(await errorDetail(res));
  return res.json();
}

export async function unlock(passcode: string, totp?: string): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/gate/unlock`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode, totp: totp || null }),
  });
  // A wrong passcode is also 401 here, but it means "try again", not "show
  // the passcode screen" — so this endpoint deliberately bypasses guard().
  if (!res.ok) throw new BackendError(await errorDetail(res));
}

export async function lock(): Promise<void> {
  // Throws if the server did not actually clear the session. Previously this
  // ignored the result and the UI returned to the passcode screen regardless,
  // so a failed logout looked identical to a successful one — the reassuring
  // direction, which is the wrong one for a "lock" button.
  const res = await fetch(`${DEFAULT_BASE_URL}/gate/lock`, {
    ...CREDENTIALS,
    method: "POST",
  });
  if (!res.ok) throw new BackendError(await errorDetail(res));
}

/**
 * Throw the proposal away when the owner declines it.
 *
 * "Cancel" used to be purely cosmetic — the card hid itself and the command
 * stayed parked and tappable until it expired. Best-effort on purpose: the
 * card has already settled by the time this runs, and a failed discard leaves
 * a proposal that expires by itself in under two minutes, which is not worth
 * an error message over a decision the owner has already made.
 */
export async function discardAction(token: string): Promise<void> {
  try {
    await fetch(`${DEFAULT_BASE_URL}/actions/pending/${encodeURIComponent(token)}`, {
      ...CREDENTIALS,
      method: "DELETE",
    });
  } catch {
    // offline, or the session lapsed — the TTL is the backstop
  }
}

/** What the server made of a spoken answer to a confirmation card. */
export interface VoiceConfirmResult {
  ok: boolean;
  outcome?: "no_match" | "cancelled" | "no_speech";
  tool?: string;
}

/**
 * Send the recording straight to the confirmation route instead of the
 * transcriber.
 *
 * The audio never goes near /chat, so the assistant is not told a word was
 * said and cannot act on it — the server matches the phrase in code and either
 * runs the parked command or does not. See backend/app/confirm_phrase.py.
 */
export async function confirmByVoice(
  audio: Blob,
  token: string,
  language: string
): Promise<VoiceConfirmResult> {
  const query = `?token=${encodeURIComponent(token)}&language=${encodeURIComponent(language)}`;
  const res = await fetch(`${DEFAULT_BASE_URL}/actions/confirm/voice${query}`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": audio.type || "audio/wav" },
    body: audio,
  });
  // 409 means the proposal is no longer voice-settleable — expired, already
  // tried, ambiguous, or tap-only. That is an answer, not a failure: the card
  // is still on screen and still tappable.
  if (res.status === 409) return { ok: false, outcome: "no_match" };
  await guard(res);
  return res.json();
}

export async function confirmAction(token: string): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/actions/confirm`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new BackendError(await errorDetail(res));
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    // Not a JSON body (e.g. a raw 404/502 from Caddy/nginx) — fall through.
  }
  return `Backend returned ${res.status}`;
}

export async function sendMessage(
  message: string,
  history: Record<string, unknown>[],
  language?: string,
  /** How the assistant should sound — see src/persona.ts. A built-in id needs
   *  nothing else; one the owner wrote is only meaningful with its style text,
   *  which the server holds no copy of. */
  persona?: string,
  personaStyle?: string
): Promise<ChatResponse> {
  const res = await fetch(`${DEFAULT_BASE_URL}/chat`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      language,
      persona,
      persona_style: personaStyle,
    }),
  });
  await guard(res);
  return res.json();
}

/**
 * Which built-in manners the backend honours.
 *
 * Fetched for the same reason the voice list is: the ids are shared between
 * the app's picker and the server's prompt builder, and a hardcoded list here
 * would eventually offer one the server has forgotten. A failure leaves the
 * app's own constants in place, which is the list it was built against.
 */
export async function fetchPersonas(): Promise<{
  personas: string[];
  default: string;
  max_style_chars: number;
}> {
  const res = await fetch(`${DEFAULT_BASE_URL}/personas`, CREDENTIALS);
  await guard(res);
  return res.json();
}

/**
 * Speech to text. The transcript comes back as a plain string and is then sent
 * through sendMessage like anything typed — voice adds no second path to the
 * car, which is what keeps the confirmation gate meaningful.
 *
 * Posts the recording as the raw body rather than multipart form data: one
 * blob, one content type, no parser on either end.
 */
export async function transcribe(
  audio: Blob,
  language?: string,
  /** What the live session's own recogniser made of this audio, when there is
   *  one. Sent as evidence rather than as an answer: it is right about names
   *  and brands exactly where the tuned transcriber is tempted to bend them
   *  onto the car's vocabulary. See _draft_clause in backend/app/voice.py. */
  draft?: string
): Promise<string> {
  const params = new URLSearchParams();
  if (language) params.set("language", language);
  if (draft) params.set("draft", draft);
  const query = params.toString() ? `?${params}` : "";
  const res = await fetch(`${DEFAULT_BASE_URL}/voice/transcribe${query}`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": audio.type || "audio/wav" },
    body: audio,
  });
  await guard(res);
  return (await res.json()).text ?? "";
}

/**
 * The reply, spoken by the server's voice.
 *
 * Takes an AbortSignal because the reply this belongs to can stop being wanted
 * while the audio is still being made: the stop button, or a second question
 * asked before the first answer finished arriving. Without it the old audio
 * would start playing over the new one.
 */
export async function fetchSpeech(
  text: string,
  language: string,
  voice: string,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch(`${DEFAULT_BASE_URL}/voice/speak`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, language, voice }),
    signal,
  });
  await guard(res);
  return res.blob();
}

export interface LiveToken {
  token: string;
  model: string;
  expires_in_seconds: number;
  /** Gemini function declarations, minted with the token — see fetchLiveToken. */
  tools: Record<string, unknown>[];
}

/**
 * A one-use credential for the phone's own audio session.
 *
 * Short-lived and bound server-side to one model, one configuration and one
 * tool list, so what arrives here cannot be turned into anything else. The
 * tools come back with it only so the client can repeat them in its own setup
 * message; they are already bound to the token. See backend/app/live.py.
 */
export async function fetchLiveToken(
  voice: string,
  language?: string,
  /** A model that minted a token and then refused the session — ask for a
   *  different one. Only this side ever sees that happen. */
  avoid?: string,
  /** The chosen manner, bound into the session's system instruction at mint
   *  time. It has to be sent here as well as with a chat message: while a live
   *  session is open it is the assistant, and /chat is not involved at all. */
  persona?: string,
  personaStyle?: string
): Promise<LiveToken> {
  const res = await fetch(`${DEFAULT_BASE_URL}/voice/live-token`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      voice,
      language,
      avoid,
      persona,
      persona_style: personaStyle,
    }),
  });
  await guard(res);
  return res.json();
}

/** What running one of the live session's tool calls produced. */
export interface LiveToolResult {
  ok: boolean;
  /** What to hand back to the model. Absent when the call failed. */
  result?: Record<string, unknown>;
  /** Why it failed, in the model's own terms, so it can say so or try again. */
  error?: string;
  /** The command was parked instead of executed — raise a card for it. The
   *  token stays out of the model's context on purpose (see backend). */
  confirm?: { token: string; tool: string; args: Record<string, unknown> } | null;
}

/**
 * Execute a tool the live audio session asked for.
 *
 * The live conversation runs between the phone and Google; this call is the
 * only point at which it touches the car, and it goes through the same
 * dispatch — and the same confirmation gate — as anything typed into the chat.
 */
export async function runLiveTool(
  name: string,
  args: Record<string, unknown>
): Promise<LiveToolResult> {
  const res = await fetch(`${DEFAULT_BASE_URL}/live/tool`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  await guard(res);
  return res.json();
}

export async function fetchVoices(): Promise<{ voices: string[]; default: string }> {
  const res = await fetch(`${DEFAULT_BASE_URL}/voice/voices`, CREDENTIALS);
  await guard(res);
  return res.json();
}

/**
 * What Amp would add to a hand-written manner, before it is saved.
 *
 * Ids, not sentences — the app owns the words the owner reads. The additions
 * happen server-side whether or not this is called, so a failure here costs the
 * preview and nothing else; the caller shows no list rather than an error.
 */
export async function fetchPersonaAdditions(style: string): Promise<string[]> {
  const res = await fetch(`${DEFAULT_BASE_URL}/personas/preview`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ style }),
  });
  await guard(res);
  return (await res.json()).additions ?? [];
}

export async function fetchVehicleState(): Promise<VehicleState> {
  const res = await fetch(`${DEFAULT_BASE_URL}/vehicle/state`, CREDENTIALS);
  await guard(res);
  return res.json();
}

export async function fetchScheduledActions(): Promise<ScheduledAction[]> {
  const res = await fetch(`${DEFAULT_BASE_URL}/jobs`, CREDENTIALS);
  await guard(res);
  const body = await res.json();
  return body.actions ?? [];
}

export async function cancelScheduledAction(id: string): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/jobs/${encodeURIComponent(id)}`, {
    ...CREDENTIALS,
    method: "DELETE",
  });
  await guard(res);
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${DEFAULT_BASE_URL}/auth/status`, CREDENTIALS);
  await guard(res);
  return res.json();
}

export async function disconnectTesla(): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/auth/disconnect`, {
    ...CREDENTIALS,
    method: "POST",
  });
  await guard(res);
}

/**
 * Starts the Tesla OAuth flow. On web this is a full-page navigation (it has
 * to be — the backend redirects the browser to auth.tesla.com, then Tesla
 * redirects back to /auth/callback on our own domain). On native there's no
 * "current page" to navigate away from, so open the system browser instead.
 */
export function startTeslaLogin(): void {
  const url = `${DEFAULT_BASE_URL}/auth/login`;
  if (Platform.OS === "web") {
    window.location.href = url;
  } else {
    Linking.openURL(url);
  }
}

// --- passkeys (WebAuthn) ---------------------------------------------------
// Web-only: the browser's credential API is what talks to Face ID. On native
// the passcode remains the way in.

function b64urlToBuffer(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bufferToB64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  bytes.forEach((b) => (raw += String.fromCharCode(b)));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when this device can actually do the Face ID dance. */
export function passkeysSupported(): boolean {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials
  );
}

/** The server sends WebAuthn options as base64url JSON; the browser wants
 *  ArrayBuffers. This is the whole impedance mismatch of the WebAuthn API. */
function decodeRequestOptions(options: any): any {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    ...(options.user ? { user: { ...options.user, id: b64urlToBuffer(options.user.id) } } : {}),
    ...(options.excludeCredentials
      ? {
          excludeCredentials: options.excludeCredentials.map((c: any) => ({
            ...c,
            id: b64urlToBuffer(c.id),
          })),
        }
      : {}),
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((c: any) => ({
            ...c,
            id: b64urlToBuffer(c.id),
          })),
        }
      : {}),
  };
}

function encodeCredential(credential: any): any {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      ...(response.attestationObject
        ? { attestationObject: bufferToB64url(response.attestationObject) }
        : {}),
      ...(response.authenticatorData
        ? { authenticatorData: bufferToB64url(response.authenticatorData) }
        : {}),
      ...(response.signature ? { signature: bufferToB64url(response.signature) } : {}),
      ...(response.userHandle ? { userHandle: bufferToB64url(response.userHandle) } : {}),
    },
  };
}

export async function registerPasskey(
  passcode: string,
  totp?: string,
  label?: string
): Promise<void> {
  // The passcode is required again even though a session exists — enrolling a
  // credential is exactly the step a borrowed unlocked phone should not be
  // able to take on its own.
  const begin = await fetch(`${DEFAULT_BASE_URL}/gate/passkey/register/begin`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode, totp: totp || null }),
  });
  await guard(begin);
  const options = decodeRequestOptions(await begin.json());
  const credential = await navigator.credentials.create({ publicKey: options });
  if (!credential) throw new BackendError("Passkey setup was cancelled");

  const finish = await fetch(`${DEFAULT_BASE_URL}/gate/passkey/register/finish`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: encodeCredential(credential), label }),
  });
  if (!finish.ok) throw new BackendError(await errorDetail(finish));
}

export async function loginWithPasskey(): Promise<void> {
  const begin = await fetch(`${DEFAULT_BASE_URL}/gate/passkey/login/begin`, {
    ...CREDENTIALS,
    method: "POST",
  });
  if (!begin.ok) throw new BackendError(await errorDetail(begin));
  const options = decodeRequestOptions(await begin.json());
  const credential = await navigator.credentials.get({ publicKey: options });
  if (!credential) throw new BackendError("Sign-in was cancelled");

  const finish = await fetch(`${DEFAULT_BASE_URL}/gate/passkey/login/finish`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: encodeCredential(credential) }),
  });
  if (!finish.ok) throw new BackendError(await errorDetail(finish));
}

export interface Passkey {
  credential_id: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

export async function fetchPasskeys(): Promise<Passkey[]> {
  const res = await fetch(`${DEFAULT_BASE_URL}/gate/passkey/list`, CREDENTIALS);
  await guard(res);
  return (await res.json()).passkeys ?? [];
}

export async function deletePasskey(credentialId: string): Promise<void> {
  const res = await fetch(
    `${DEFAULT_BASE_URL}/gate/passkey/${encodeURIComponent(credentialId)}`,
    { ...CREDENTIALS, method: "DELETE" }
  );
  await guard(res);
}

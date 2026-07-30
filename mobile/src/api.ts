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

/** A sensitive command the assistant proposed; only a tap executes it. */
export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
}

export async function fetchPendingAction(token: string): Promise<PendingAction> {
  const res = await fetch(
    `${DEFAULT_BASE_URL}/actions/pending/${encodeURIComponent(token)}`,
    CREDENTIALS
  );
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
  language?: string
): Promise<ChatResponse> {
  const res = await fetch(`${DEFAULT_BASE_URL}/chat`, {
    ...CREDENTIALS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history, language }),
  });
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
export async function transcribe(audio: Blob, language?: string): Promise<string> {
  const query = language ? `?language=${encodeURIComponent(language)}` : "";
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

export async function fetchVoices(): Promise<{ voices: string[]; default: string }> {
  const res = await fetch(`${DEFAULT_BASE_URL}/voice/voices`, CREDENTIALS);
  await guard(res);
  return res.json();
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

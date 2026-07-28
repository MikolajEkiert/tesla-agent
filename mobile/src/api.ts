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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history, language }),
  });
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
  return res.json();
}

export async function fetchVehicleState(): Promise<VehicleState> {
  const res = await fetch(`${DEFAULT_BASE_URL}/vehicle/state`);
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
  return res.json();
}

export async function fetchScheduledActions(): Promise<ScheduledAction[]> {
  const res = await fetch(`${DEFAULT_BASE_URL}/jobs`);
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
  const body = await res.json();
  return body.actions ?? [];
}

export async function cancelScheduledAction(id: string): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${DEFAULT_BASE_URL}/auth/status`);
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
  return res.json();
}

export async function disconnectTesla(): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/auth/disconnect`, { method: "POST" });
  if (!res.ok) {
    throw new BackendError(await errorDetail(res));
  }
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

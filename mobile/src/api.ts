import { Platform } from "react-native";
import type { ChatResponse, VehicleState } from "./types";

/**
 * iOS Simulator shares the host Mac's network, so `localhost` reaches a
 * backend running on your machine directly. Android's emulator does not —
 * 10.0.2.2 is its alias for the host. A physical device needs your Mac's LAN
 * IP; override with EXPO_PUBLIC_API_URL in that case.
 */
const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000");

export async function sendMessage(
  message: string,
  history: Record<string, unknown>[]
): Promise<ChatResponse> {
  const res = await fetch(`${DEFAULT_BASE_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  return res.json();
}

export async function fetchVehicleState(): Promise<VehicleState> {
  const res = await fetch(`${DEFAULT_BASE_URL}/vehicle/state`);
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status}`);
  }
  return res.json();
}

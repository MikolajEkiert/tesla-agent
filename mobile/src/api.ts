import { Platform } from "react-native";
import type { ChatResponse, VehicleState } from "./types";

/**
 * The API url defaults to the production endpoint if EXPO_PUBLIC_API_URL is not set.
 */
const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "https://tesla-amp.duckdns.org";

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

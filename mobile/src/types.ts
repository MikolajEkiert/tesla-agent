export type Role = "user" | "assistant";

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
}

/** One turn in the conversation, or an inline instrument-log entry. */
export type ChatItem =
  | { kind: "message"; id: string; role: Role; text: string }
  | { kind: "tool"; id: string; call: ToolCall };

export interface VehicleState {
  awake?: boolean;
  /**
   * Seconds since this snapshot was actually fetched from the car. 0 when
   * live (awake), > 0 when serving a last-known snapshot while asleep,
   * null if we've never observed the car awake since the backend started.
   */
  stale_seconds?: number | null;
  battery_percent?: number;
  charge_limit_percent?: number;
  charging?: boolean;
  locked?: boolean;
  climate_on?: boolean;
  inside_temp_c?: number;
  target_temp_c?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  reply: string;
  history: Record<string, unknown>[];
  tool_trace: ToolCall[];
}

export interface AuthStatus {
  /** false on the mock adapter — no Tesla login needed at all. */
  required: boolean;
  connected: boolean;
}

export type Role = "user" | "assistant";

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** Present when the backend parked a sensitive command awaiting confirmation. */
  result?: Record<string, unknown>;
}

/** One turn in the conversation, or an inline instrument-log entry. */
export type ChatItem =
  | { kind: "message"; id: string; role: Role; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  // A physically consequential command the assistant proposed; only a tap on
  // this row executes it (see components/ConfirmCard.tsx).
  | { kind: "confirm"; id: string; token: string; tool: string };

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

/**
 * One thing the user asked for ("run climate for 10 minutes"), which the
 * backend may implement as several jobs. `meta` is structured rather than a
 * ready-made sentence so the sidebar can label it in the chosen language.
 */
export interface ScheduledAction {
  id: string;
  kind: string;
  state: "scheduled" | "running" | "done" | "failed" | "cancelled";
  meta: {
    temp_c?: number | null;
    delay_minutes?: number | null;
    run_for_minutes?: number | null;
    [key: string]: unknown;
  };
  created_at: number;
  starts_at: number;
  ends_at: number;
  /** Unix seconds of the next job still to run, or null if none are pending. */
  next_run_at: number | null;
  cancellable: boolean;
  error: string | null;
}

export interface AuthStatus {
  /** false on the mock adapter — no Tesla login needed at all. */
  required: boolean;
  connected: boolean;
}

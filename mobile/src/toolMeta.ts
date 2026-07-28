import { color } from "./theme";

/**
 * Maps each backend tool to the vehicle system it belongs to, so the log
 * line's dot color always means the same real thing. Keep this in sync with
 * backend/app/tools.py.
 */
interface ToolMeta {
  system: string;
  dot: string;
  describe: (input: Record<string, unknown>, ok: boolean) => string;
}

const META: Record<string, ToolMeta> = {
  set_climate_temp: {
    system: "CLIMATE",
    dot: color.climate,
    describe: (i) => `target set ${i.celsius}°C`,
  },
  start_climate: {
    system: "CLIMATE",
    dot: color.climate,
    describe: () => "on",
  },
  stop_climate: {
    system: "CLIMATE",
    dot: color.climate,
    describe: () => "off",
  },
  set_seat_heater: {
    system: "CLIMATE",
    dot: color.climate,
    describe: (i) => `${i.seat} → level ${i.level}`,
  },
  media_control: {
    system: "MEDIA",
    dot: color.brand,
    describe: (i) => `${i.action}`,
  },
  lock: {
    system: "SECURITY",
    dot: color.security,
    describe: () => "locked",
  },
  unlock: {
    system: "SECURITY",
    dot: color.security,
    describe: () => "unlocked",
  },
  honk: {
    system: "SECURITY",
    dot: color.security,
    describe: () => "horn",
  },
  flash_lights: {
    system: "SECURITY",
    dot: color.security,
    describe: () => "lights flashed",
  },
  set_charge_limit: {
    system: "CHARGE",
    dot: color.charge,
    describe: (i) => `limit set ${i.percent}%`,
  },
  start_charging: {
    system: "CHARGE",
    dot: color.charge,
    describe: () => "started",
  },
  stop_charging: {
    system: "CHARGE",
    dot: color.charge,
    describe: () => "stopped",
  },
  get_vehicle_state: {
    system: "STATE",
    dot: color.textTertiary,
    describe: () => "read",
  },
};

export function describeTool(
  tool: string,
  input: Record<string, unknown>,
  ok: boolean
): { system: string; dot: string; text: string } {
  const meta = META[tool];
  if (!meta) {
    return { system: tool.toUpperCase(), dot: color.textTertiary, text: ok ? "done" : "failed" };
  }
  return {
    system: meta.system,
    dot: ok ? meta.dot : color.alert,
    text: ok ? meta.describe(input, ok) : "failed",
  };
}

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
  set_charging_amps: {
    system: "CHARGE",
    dot: color.charge,
    describe: (i) => `${i.amps} A`,
  },
  add_schedule: {
    system: "CHARGE",
    dot: color.charge,
    describe: (i) =>
      `${i.kind === "precondition" ? "preheat" : "charge"} ` +
      `${String(i.hour ?? 0).padStart(2, "0")}:${String(i.minute ?? 0).padStart(2, "0")}` +
      (i.days && i.days !== "All" ? ` ${i.days}` : ""),
  },
  list_schedules: {
    system: "CHARGE",
    dot: color.charge,
    describe: () => "read",
  },
  remove_schedule: {
    system: "CHARGE",
    dot: color.charge,
    describe: (i) => `removed ${i.kind ?? "charge"} #${i.id}`,
  },
  set_steering_wheel_heater: {
    system: "CLIMATE",
    dot: color.climate,
    describe: (i) => (i.on ? "wheel heat on" : "wheel heat off"),
  },
  set_volume: {
    system: "MEDIA",
    dot: color.brand,
    describe: (i) => `volume ${i.level}`,
  },
  media_favorite: {
    system: "MEDIA",
    dot: color.brand,
    describe: (i) => `favourite ${i.direction}`,
  },
  software_update: {
    // Its own system rather than SECURITY: it is the one command that takes
    // the car out of use, and the log line should not read like a door lock.
    system: "UPDATE",
    dot: color.security,
    describe: (i) =>
      i.action === "cancel"
        ? "cancelled"
        : i.delay_minutes
        ? `install in ${i.delay_minutes} min`
        : "install now",
  },
  find_places: {
    system: "PLACES",
    dot: color.brand,
    describe: (i) => `${i.query}${i.place ? ` — ${i.place}` : ""}`,
  },
  find_chargers: {
    system: "CHARGE",
    dot: color.charge,
    describe: (i) => (i.place ? `near ${i.place}` : "nearby"),
  },
  set_navigation_destination: {
    system: "NAV",
    dot: color.brand,
    describe: (i) => String(i.address ?? ""),
  },
  set_route: {
    system: "NAV",
    dot: color.brand,
    describe: (i) => {
      const stops = Array.isArray(i.stops) ? i.stops : [];
      const labels = stops
        .map((s) => (s as { label?: string })?.label)
        .filter(Boolean)
        .join(" → ");
      return labels || `${stops.length} stops`;
    },
  },
  where_is_car: {
    system: "NAV",
    dot: color.brand,
    describe: () => "located",
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

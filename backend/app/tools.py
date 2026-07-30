"""Tool schemas the LLM is allowed to call. Each maps 1:1 to a TeslaAdapter method.

This list is also, in effect, your Fleet API scope surface — keep it small and
explicit. The dispatch table connects a tool name to the adapter coroutine.
"""
from __future__ import annotations

from typing import Any

from app import actions, chargers
from app.tesla.adapter import TeslaAdapter

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_vehicle_state",
        "description": (
            "Read the car's current state: battery %, charge limit, whether it's "
            "charging, locked/unlocked, climate on/off, inside and target "
            "temperature, seat heaters, media. Prefer this before answering "
            "questions about the car. Cheap and safe."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "set_climate_temp",
        "description": "Set the cabin target temperature in Celsius.",
        "input_schema": {
            "type": "object",
            "properties": {"celsius": {"type": "number", "minimum": 15, "maximum": 28}},
            "required": ["celsius"],
            "additionalProperties": False,
        },
    },
    {
        "name": "start_climate",
        "description": "Turn on climate control / preconditioning.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "stop_climate",
        "description": "Turn off climate control.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "set_seat_heater",
        "description": "Set a seat heater level (0=off .. 3=high).",
        "input_schema": {
            "type": "object",
            "properties": {
                "seat": {
                    "type": "string",
                    "enum": ["front_left", "front_right", "rear_left", "rear_center", "rear_right"],
                },
                "level": {"type": "integer", "minimum": 0, "maximum": 3},
            },
            "required": ["seat", "level"],
            "additionalProperties": False,
        },
    },
    {
        "name": "media_control",
        "description": "Control media playback.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["play", "pause", "next", "previous", "volume_up", "volume_down"],
                }
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    {
        "name": "lock",
        "description": "Lock the car.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "unlock",
        "description": "Unlock the car. Sensitive — confirm intent if ambiguous.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "set_charge_limit",
        "description": "Set the charge limit as a percentage (50-100).",
        "input_schema": {
            "type": "object",
            "properties": {"percent": {"type": "integer", "minimum": 50, "maximum": 100}},
            "required": ["percent"],
            "additionalProperties": False,
        },
    },
    {
        "name": "start_charging",
        "description": "Start charging (car must be plugged in).",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "stop_charging",
        "description": "Stop charging.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "honk",
        "description": "Honk the horn (helps locate the car).",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "flash_lights",
        "description": "Flash the headlights (helps locate the car).",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "schedule_climate",
        "description": (
            "Turn climate on with a timer: start after a delay, run for a set "
            "number of minutes, or both. Use this instead of start_climate "
            "whenever the user says 'for N minutes' or 'in N minutes'. "
            "Omit start_in_minutes to start immediately; omit run_for_minutes "
            "to leave it running until stopped. Timed runs are capped at 30 "
            "minutes — for longer comfort holds tell the user to use the car's "
            "own Climate Keeper / Dog Mode instead. Returns an id the user can "
            "use to cancel."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "celsius": {"type": "number", "minimum": 15, "maximum": 28},
                "start_in_minutes": {"type": "number", "minimum": 0},
                "run_for_minutes": {"type": "number", "minimum": 1, "maximum": 30},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_scheduled_actions",
        "description": (
            "List timers and scheduled actions that are still pending or "
            "currently running, with the id needed to cancel each one."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "cancel_scheduled_action",
        "description": (
            "Cancel a pending or running scheduled action by its id (get ids "
            "from list_scheduled_actions). Cancelling a running climate timer "
            "leaves the climate on — stop it separately if that's the intent."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"action_id": {"type": "string"}},
            "required": ["action_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_sentry_mode",
        "description": "Turn the car's Sentry Mode security cameras on or off.",
        "input_schema": {
            "type": "object",
            "properties": {"on": {"type": "boolean"}},
            "required": ["on"],
            "additionalProperties": False,
        },
    },
    {
        "name": "control_windows",
        "description": (
            "Vent the windows slightly (useful when the car is hot) or close "
            "them. Sensitive — confirm before venting if the user's intent is "
            "unclear, since vented windows stay open until closed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string", "enum": ["vent", "close"]}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "actuate_trunk",
        "description": (
            "Open the rear trunk or the front trunk (frunk). On this car the "
            "rear trunk toggles — sending it again closes a powered trunk."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"which": {"type": "string", "enum": ["front", "rear"]}},
            "required": ["which"],
            "additionalProperties": False,
        },
    },
    {
        "name": "charge_port",
        "description": "Open or close the charge port door.",
        "input_schema": {
            "type": "object",
            "properties": {"open": {"type": "boolean"}},
            "required": ["open"],
            "additionalProperties": False,
        },
    },
    {
        "name": "trigger_homelink",
        "description": (
            "Trigger the HomeLink device paired to where the car currently is "
            "— typically a garage door or gate. Only works if HomeLink has "
            "been set up in the car for that location."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "where_is_car",
        "description": (
            "Where the car is parked: street address, coordinates and a map "
            "link. Use for 'where is my car' style questions."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "set_scheduled_charging",
        "description": (
            "Set (or clear) the daily time at which the car starts charging — "
            "the usual reason is a cheaper night tariff. The time is the car's "
            "own local time, given as hour and minute. This is stored in the "
            "car, so it keeps working regardless of this app. Pass enable=false "
            "to turn the schedule off."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "enable": {"type": "boolean"},
                "hour": {"type": "integer", "minimum": 0, "maximum": 23},
                "minute": {"type": "integer", "minimum": 0, "maximum": 59},
            },
            "required": ["enable"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_cabin_overheat_protection",
        "description": (
            "Cabin Overheat Protection: the car cools itself automatically "
            "when the interior gets hot while parked. Better than a climate "
            "timer for summer heat, because the car decides when to run. "
            "fan_only uses ventilation instead of air conditioning (less "
            "battery)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "on": {"type": "boolean"},
                "fan_only": {"type": "boolean"},
            },
            "required": ["on"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_climate_keeper_mode",
        "description": (
            "Keep climate running while parked: 'on' (Keep Climate On), 'dog' "
            "(Dog Mode — keeps pets comfortable and shows a message on the "
            "screen), 'camp' (Camp Mode), or 'off'. Use this instead of a "
            "climate timer when the user wants climate held for a long or "
            "open-ended period — the car manages it and watches the battery."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": ["off", "on", "dog", "camp"]},
            },
            "required": ["mode"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_chargers",
        "description": (
            "Find charging sites, nearest first. By default: Tesla's own "
            "network around the car, including live free-stall counts. "
            "Set `place` to search somewhere else (a town, address or "
            "landmark) instead of around the car. Set include_other_networks "
            "to true only when the user actually asks about non-Tesla "
            "chargers. Results away from the car, and all non-Tesla results, "
            "come from a community database and have no live availability — "
            "never state or imply free-stall counts for those. Tesla's data "
            "carries no charging power at all: if a site has no "
            "`max_power_kw`, its power is unknown — say so rather than "
            "quoting a typical figure. Mind the `type`: 'supercharger' is a "
            "fast DC Supercharger, while 'tesla_destination' is a slow AC "
            "Tesla wall charger at a hotel or similar — call those "
            "destination chargers, never Superchargers. To route to a site, "
            "pass its `navigate_to` value straight to "
            "set_navigation_destination; never pass the site name, which is "
            "often just a town label and would navigate to the town centre."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "place": {"type": "string"},
                "include_other_networks": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "set_navigation_destination",
        "description": (
            "Send a destination to the car's navigation. Requires a real, "
            "geocodable address or named place (e.g. 'Central Station, "
            "Warsaw', 'Eiffel Tower') — Tesla geocodes it server-side, so it "
            "doesn't need to be a full formal address, but it does need to "
            "resolve to one specific place. Tesla rejects vague categories "
            "like 'nearest supercharger' or 'a charger' — for those, call "
            "find_chargers first and pass the chosen site's `navigate_to` "
            "coordinates here."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"address": {"type": "string"}},
            "required": ["address"],
            "additionalProperties": False,
        },
    },
]


# Server-side bounds, applied regardless of what the model sends. The JSON
# schema advertised to the model is a hint to it, not a guarantee to us: the
# model may emit anything, and after an injected instruction it may do so
# deliberately.
NUMERIC_BOUNDS = {
    "set_climate_temp": {"celsius": (15, 28)},
    "set_charge_limit": {"percent": (50, 100)},
    "set_seat_heater": {"level": (0, 3)},
    "schedule_climate": {"celsius": (15, 28), "run_for_minutes": (1, 30)},
    "set_scheduled_charging": {"hour": (0, 23), "minute": (0, 59)},
}


def _validate(name: str, args: dict[str, Any]) -> None:
    for field, (low, high) in NUMERIC_BOUNDS.get(name, {}).items():
        if field not in args or args[field] is None:
            continue
        try:
            value = float(args[field])
        except (TypeError, ValueError):
            raise ValueError(f"{field} must be a number")
        if not low <= value <= high:
            raise ValueError(f"{field} must be between {low} and {high}")


async def dispatch(adapter: TeslaAdapter, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Route a tool call to the adapter, refusing to *execute* the physically
    consequential ones on the model's word alone.

    Sensitive commands come back as a proposal the owner must tap to confirm
    (see app.actions). Everything reachable from here may have been chosen by a
    model whose context contains anonymously-editable map text, so the gate
    lives in code rather than in the prompt.
    """
    _validate(name, args)
    if actions.needs_confirmation(name):
        return actions.propose(name, args)
    return await dispatch_unguarded(adapter, name, args)


async def dispatch_unguarded(
    adapter: TeslaAdapter, name: str, args: dict[str, Any]
) -> dict[str, Any]:
    """The raw routing table. Only two callers may use it: `dispatch` (for
    commands that need no confirmation) and `actions.confirm` (after a human
    tapped). The scheduler goes through `dispatch`, so a queued job can never
    smuggle in a sensitive command either."""
    _validate(name, args)
    handlers = {
        "get_vehicle_state": lambda: adapter.get_state(),
        "set_climate_temp": lambda: adapter.set_temperature(args["celsius"]),
        "start_climate": lambda: adapter.start_climate(),
        "stop_climate": lambda: adapter.stop_climate(),
        "set_seat_heater": lambda: adapter.set_seat_heater(args["seat"], args["level"]),
        "media_control": lambda: adapter.media_control(args["action"]),
        "lock": lambda: adapter.lock(),
        "unlock": lambda: adapter.unlock(),
        "set_charge_limit": lambda: adapter.set_charge_limit(args["percent"]),
        "start_charging": lambda: adapter.start_charging(),
        "stop_charging": lambda: adapter.stop_charging(),
        "honk": lambda: adapter.honk(),
        "flash_lights": lambda: adapter.flash_lights(),
        "find_chargers": lambda: chargers.find_chargers(
            adapter,
            place=args.get("place"),
            include_other_networks=args.get("include_other_networks", False),
        ),
        "where_is_car": lambda: adapter.get_location(),
        "set_sentry_mode": lambda: adapter.set_sentry_mode(args["on"]),
        "control_windows": lambda: adapter.control_windows(args["command"]),
        "actuate_trunk": lambda: adapter.actuate_trunk(args["which"]),
        "charge_port": lambda: adapter.charge_port(args["open"]),
        "trigger_homelink": lambda: adapter.trigger_homelink(),
        "set_scheduled_charging": lambda: adapter.set_scheduled_charging(
            args["enable"],
            int(args.get("hour", 0)) * 60 + int(args.get("minute", 0)),
        ),
        "set_cabin_overheat_protection": lambda: adapter.set_cabin_overheat_protection(
            args["on"], args.get("fan_only", False)
        ),
        "set_climate_keeper_mode": lambda: adapter.set_climate_keeper_mode(args["mode"]),
        "set_navigation_destination": lambda: adapter.set_navigation_destination(args["address"]),
        # App-level actions (scheduler-backed), not a single call to the car.
        "schedule_climate": lambda: actions.schedule_climate(
            adapter,
            celsius=args.get("celsius"),
            start_in_minutes=args.get("start_in_minutes", 0),
            run_for_minutes=args.get("run_for_minutes"),
        ),
        "list_scheduled_actions": lambda: actions.list_scheduled(),
        "cancel_scheduled_action": lambda: actions.cancel_scheduled(args["action_id"]),
    }
    if name not in handlers:
        raise ValueError(f"Unknown tool: {name}")
    return await handlers[name]()

"""Tool schemas the LLM is allowed to call. Each maps 1:1 to a TeslaAdapter method.

This list is also, in effect, your Fleet API scope surface — keep it small and
explicit. The dispatch table connects a tool name to the adapter coroutine.
"""
from __future__ import annotations

from typing import Any

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
]


async def dispatch(adapter: TeslaAdapter, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Route a tool call to the adapter. Returns a JSON-serializable result."""
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
    }
    if name not in handlers:
        raise ValueError(f"Unknown tool: {name}")
    return await handlers[name]()

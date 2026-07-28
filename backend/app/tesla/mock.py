"""In-memory fake car. Lets you build and test the whole chat loop with no Tesla
account, no signing proxy, and no risk of waking a real vehicle."""
from __future__ import annotations

from typing import Any


class MockImpl:
    def __init__(self) -> None:
        # A tiny mutable "vehicle state" so commands visibly change reads.
        self._state: dict[str, Any] = {
            "awake": True,
            "battery_percent": 72,
            "charge_limit_percent": 80,
            "charging": False,
            "locked": True,
            "climate_on": False,
            "inside_temp_c": 18.0,
            "target_temp_c": 21.0,
            "seat_heaters": {"front_left": 0, "front_right": 0},
            "media": {"playing": False, "volume": 5},
        }

    async def get_state(self) -> dict[str, Any]:
        return dict(self._state)

    async def set_temperature(self, celsius: float) -> dict[str, Any]:
        self._state["target_temp_c"] = celsius
        return {"ok": True, "target_temp_c": celsius}

    async def start_climate(self) -> dict[str, Any]:
        self._state["climate_on"] = True
        return {"ok": True, "climate_on": True}

    async def stop_climate(self) -> dict[str, Any]:
        self._state["climate_on"] = False
        return {"ok": True, "climate_on": False}

    async def set_seat_heater(self, seat: str, level: int) -> dict[str, Any]:
        self._state["seat_heaters"][seat] = level
        return {"ok": True, "seat": seat, "level": level}

    async def media_control(self, action: str) -> dict[str, Any]:
        media = self._state["media"]
        if action == "play":
            media["playing"] = True
        elif action == "pause":
            media["playing"] = False
        elif action == "volume_up":
            media["volume"] = min(11, media["volume"] + 1)
        elif action == "volume_down":
            media["volume"] = max(0, media["volume"] - 1)
        return {"ok": True, "action": action, "media": dict(media)}

    async def lock(self) -> dict[str, Any]:
        self._state["locked"] = True
        return {"ok": True, "locked": True}

    async def unlock(self) -> dict[str, Any]:
        self._state["locked"] = False
        return {"ok": True, "locked": False}

    async def set_charge_limit(self, percent: int) -> dict[str, Any]:
        self._state["charge_limit_percent"] = percent
        return {"ok": True, "charge_limit_percent": percent}

    async def start_charging(self) -> dict[str, Any]:
        self._state["charging"] = True
        return {"ok": True, "charging": True}

    async def stop_charging(self) -> dict[str, Any]:
        self._state["charging"] = False
        return {"ok": True, "charging": False}

    async def honk(self) -> dict[str, Any]:
        return {"ok": True, "honked": True}

    async def flash_lights(self) -> dict[str, Any]:
        return {"ok": True, "flashed": True}

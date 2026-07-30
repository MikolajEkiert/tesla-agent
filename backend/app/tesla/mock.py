"""In-memory fake car. Lets you build and test the whole chat loop with no Tesla
account, no signing proxy, and no risk of waking a real vehicle."""
from __future__ import annotations

from typing import Any


class MockImpl:
    def __init__(self) -> None:
        # A tiny mutable "vehicle state" so commands visibly change reads.
        self._state: dict[str, Any] = {
            "awake": True,
            "stale_seconds": 0,  # mock is always "live" — no real sleep/staleness concept
            "battery_percent": 72,
            "charge_limit_percent": 80,
            "charging": False,
            "locked": True,
            "climate_on": False,
            "inside_temp_c": 18.0,
            "target_temp_c": 21.0,
            "seat_heaters": {"front_left": 0, "front_right": 0},
            "media": {"playing": False, "volume": 5},
            # Mirrors what _normalize now sends from a real car, so the
            # assistant can be developed against questions about range and
            # charging without one.
            "range_km": 340.5,
            "range_estimated_km": 312.0,
            "outside_temp_c": 4.0,
            "odometer_km": 41230,
            "plugged_in": False,
            "charge_port_open": False,
            "software_version": "2026.14.3 mock",
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

    async def set_navigation_destination(self, address: str) -> dict[str, Any]:
        self._state["navigating_to"] = address
        return {"ok": True, "destination": address}

    async def nearby_chargers(self) -> dict[str, Any]:
        return {
            "sites": [
                {
                    "name": "Kraków, Poland",
                    "type": "supercharger",
                    "distance_km": 9.4,
                    "available_stalls": 8,
                    "total_stalls": 16,
                    "closed": False,
                    "navigate_to": "50.0273,19.9528",
                },
                {
                    "name": "INX Design Hotel",
                    "type": "destination",
                    "distance_km": 10.5,
                    "navigate_to": "50.051056,19.95106",
                },
            ],
            "source": "tesla",
        }

    async def get_location(self) -> dict[str, Any]:
        return {
            "latitude": 50.006477,
            "longitude": 20.08068,
            "address": "Wielicka, Kraków, Poland",
            "map_url": "https://www.openstreetmap.org/?mlat=50.006477&mlon=20.08068",
        }

    async def set_scheduled_charging(
        self, enable: bool, minutes_after_midnight: int
    ) -> dict[str, Any]:
        self._state["scheduled_charging"] = (
            {"enabled": True, "minutes_after_midnight": minutes_after_midnight}
            if enable
            else {"enabled": False}
        )
        return {"ok": True, **self._state["scheduled_charging"]}

    async def set_cabin_overheat_protection(
        self, on: bool, fan_only: bool = False
    ) -> dict[str, Any]:
        self._state["cabin_overheat_protection"] = {"on": on, "fan_only": fan_only}
        return {"ok": True, "on": on, "fan_only": fan_only}

    async def set_climate_keeper_mode(self, mode: str) -> dict[str, Any]:
        self._state["climate_keeper_mode"] = mode
        return {"ok": True, "mode": mode}

    async def set_sentry_mode(self, on: bool) -> dict[str, Any]:
        self._state["sentry_mode"] = on
        return {"ok": True, "sentry_mode": on}

    async def control_windows(self, command: str) -> dict[str, Any]:
        if command not in ("vent", "close"):
            raise ValueError("command must be 'vent' or 'close'")
        self._state["windows"] = command
        return {"ok": True, "windows": command}

    async def actuate_trunk(self, which: str) -> dict[str, Any]:
        if which not in ("front", "rear"):
            raise ValueError("which must be 'front' or 'rear'")
        return {"ok": True, "trunk": which}

    async def charge_port(self, open_port: bool) -> dict[str, Any]:
        self._state["charge_port_open"] = open_port
        return {"ok": True, "charge_port_open": open_port}

    async def trigger_homelink(self) -> dict[str, Any]:
        return {"ok": True, "homelink": "triggered"}

    async def set_charging_amps(self, amps: int) -> dict[str, Any]:
        self._state["charging_amps"] = amps
        return {"ok": True, "charging_amps": amps}

    async def set_scheduled_departure(
        self, enable: bool, minutes_after_midnight: int, precondition: bool
    ) -> dict[str, Any]:
        return {
            "ok": True,
            "scheduled_departure": enable,
            "departure_minutes_after_midnight": minutes_after_midnight,
            "precondition": precondition,
        }

    async def set_steering_wheel_heater(self, on: bool) -> dict[str, Any]:
        self._state["steering_wheel_heater"] = on
        return {"ok": True, "steering_wheel_heater": on}

    async def schedule_software_update(self, delay_seconds: int) -> dict[str, Any]:
        return {"ok": True, "update_starts_in_seconds": delay_seconds}

    async def cancel_software_update(self) -> dict[str, Any]:
        return {"ok": True, "update": "cancelled"}

    async def set_volume(self, level: float) -> dict[str, Any]:
        self._state["media"]["volume"] = level
        return {"ok": True, "volume": level}

    async def media_favorite(self, direction: str) -> dict[str, Any]:
        return {"ok": True, "favorite": direction}

"""Real Tesla Fleet API implementation — STUB.

This is intentionally not finished: the Fleet auth + command-signing setup is the
one-time hard part you do LAST, once the mock-backed chat loop already works.

What each method must do when you fill it in:
  * READS  (get_state)  -> GET the Fleet API directly. No signing needed.
      GET {TESLA_FLEET_BASE}/api/1/vehicles/{id}/vehicle_data
  * COMMANDS (everything else) -> POST through the local vehicle-command PROXY,
      which signs the request with your enrolled virtual key before forwarding.
      POST {TESLA_PROXY_URL}/api/1/vehicles/{id}/command/{name}
    A 2021 Model 3 REJECTS unsigned commands, so commands must go via the proxy.

Token handling (access/refresh) lives in app/auth/oauth.py; inject it here.
Wrap reads in a short-TTL cache and only wake the car on an actual command to
stay inside the free API credit.
"""
from __future__ import annotations

from typing import Any

import httpx

from app.auth.oauth import TokenStore
from app.config import get_settings


class FleetImpl:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.tokens = TokenStore()  # provides a valid access token, refreshing as needed
        self._vehicle_id: str | None = None

    async def _access_token(self) -> str:
        return await self.tokens.get_access_token()

    async def _vehicle(self) -> str:
        """Resolve and cache the vehicle id (Fleet uses the 'id' / 'vehicle_tag')."""
        if self._vehicle_id:
            return self._vehicle_id
        token = await self._access_token()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles",
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            vehicles = r.json()["response"]
            if not vehicles:
                raise RuntimeError("No vehicles on this Tesla account")
            self._vehicle_id = str(vehicles[0]["id"])
            return self._vehicle_id

    async def _command(self, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send a SIGNED command through the vehicle-command proxy."""
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=20, verify=False) as c:  # proxy uses a local cert
            r = await c.post(
                f"{self.settings.tesla_proxy_url}/api/1/vehicles/{vid}/command/{name}",
                headers={"Authorization": f"Bearer {token}"},
                json=payload or {},
            )
            r.raise_for_status()
            return r.json()

    # --- reads ---
    async def get_state(self) -> dict[str, Any]:
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/vehicle_data",
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            data = r.json()["response"]
        # TODO: normalize to the same shape MockImpl returns so the AI sees one schema.
        return data

    # --- commands (all go through the signing proxy) ---
    async def set_temperature(self, celsius: float) -> dict[str, Any]:
        return await self._command(
            "set_temps", {"driver_temp": celsius, "passenger_temp": celsius}
        )

    async def start_climate(self) -> dict[str, Any]:
        return await self._command("auto_conditioning_start")

    async def stop_climate(self) -> dict[str, Any]:
        return await self._command("auto_conditioning_stop")

    async def set_seat_heater(self, seat: str, level: int) -> dict[str, Any]:
        seat_map = {
            "front_left": 0, "front_right": 1,
            "rear_left": 2, "rear_center": 4, "rear_right": 5,
        }
        return await self._command(
            "remote_seat_heater_request",
            {"seat_position": seat_map[seat], "level": level},
        )

    async def media_control(self, action: str) -> dict[str, Any]:
        cmd = {
            "play": "media_toggle_playback", "pause": "media_toggle_playback",
            "next": "media_next_track", "previous": "media_prev_track",
            "volume_up": "media_volume_up", "volume_down": "media_volume_down",
        }[action]
        return await self._command(cmd)

    async def lock(self) -> dict[str, Any]:
        return await self._command("door_lock")

    async def unlock(self) -> dict[str, Any]:
        return await self._command("door_unlock")

    async def set_charge_limit(self, percent: int) -> dict[str, Any]:
        return await self._command("set_charge_limit", {"percent": percent})

    async def start_charging(self) -> dict[str, Any]:
        return await self._command("charge_start")

    async def stop_charging(self) -> dict[str, Any]:
        return await self._command("charge_stop")

    async def honk(self) -> dict[str, Any]:
        return await self._command("honk_horn")

    async def flash_lights(self) -> dict[str, Any]:
        return await self._command("flash_lights")

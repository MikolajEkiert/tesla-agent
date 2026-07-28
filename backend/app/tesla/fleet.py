"""Real Tesla Fleet API implementation.

READS (get_state) never wake the car and never fail. A sleeping vehicle
makes `vehicle_data` return 408 rather than cached data — confirmed against
Tesla's own documented behavior, not assumed. Tesla's own app can still show
a last-known snapshot because the car reports one to Tesla's backend right
before sleeping, but that snapshot isn't exposed through the public Fleet
API's `vehicle_data` endpoint. We replicate the same *effect* ourselves:
cache the last successful read in-process, and serve it back — marked
`awake: False` plus how many seconds stale — instead of erroring or forcing
a wake just to answer "what's the battery at". `vehicle_data` itself never
wakes the car either way, confirmed — so this path is always safe to call.

COMMANDS go through the local vehicle-command PROXY, signed with the
enrolled virtual key (a 2021 Model 3 rejects unsigned commands). If the car
is asleep, wake it first (POST .../wake_up — a plain, unsigned Fleet API
call, not a vehicle command) and poll `vehicle_data` until it stops 408ing,
then retry the original command. This is the only path that ever wakes the
car — reads never do.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.auth.oauth import TokenStore
from app.config import get_settings

WAKE_POLL_INTERVAL_S = 3
WAKE_TIMEOUT_S = 40
# Skip the wake-check dance on a command if we confirmed the car was online
# this recently — avoids a redundant round trip when several commands land
# in the same chat turn (e.g. "set 22 and unlock").
AWAKE_CACHE_TTL_S = 90


class VehicleAsleepError(Exception):
    """Internal signal that a Fleet API call 408'd because the car is
    asleep/unreachable. Never escapes FleetImpl — every public method either
    handles it (reads: serve cache; commands: wake and retry) or converts it
    to a clear RuntimeError."""


class FleetImpl:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.tokens = TokenStore()  # provides a valid access token, refreshing as needed
        self._vehicle_id: str | None = None
        # Last-known-good snapshot + when we got it (monotonic clock — this
        # is only ever compared to itself within one process's lifetime, so
        # wall-clock/timezone concerns don't apply).
        self._last_state: dict[str, Any] | None = None
        self._last_state_at: float | None = None
        self._last_awake_at: float | None = None

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

    async def _fetch_vehicle_data(self) -> dict[str, Any]:
        """Raw vehicle_data fetch. Raises VehicleAsleepError on 408 instead
        of a generic HTTP error, so callers decide what "asleep" means to
        them. Never wakes the car — a plain GET, confirmed Tesla doesn't
        treat this as a wake trigger."""
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/vehicle_data",
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        r.raise_for_status()
        return r.json()["response"]

    def _normalize(self, data: dict[str, Any]) -> dict[str, Any]:
        charge_state = data.get("charge_state", {})
        climate_state = data.get("climate_state", {})
        vehicle_state = data.get("vehicle_state", {})
        return {
            "awake": True,
            "battery_percent": charge_state.get("battery_level", 0),
            "charge_limit_percent": charge_state.get("charge_limit_soc", 80),
            "charging": charge_state.get("charging_state") == "Charging",
            "locked": vehicle_state.get("locked", True),
            "climate_on": climate_state.get("is_climate_on", False),
            "inside_temp_c": climate_state.get("inside_temp", 0.0),
            "target_temp_c": climate_state.get("driver_temp_setting", 21.0),
            "seat_heaters": {
                "front_left": climate_state.get("seat_heater_left", 0),
                "front_right": climate_state.get("seat_heater_right", 0),
            },
            "media": {"playing": False, "volume": 5},  # not reliably exposed by vehicle_data
        }

    def _remember(self, normalized: dict[str, Any]) -> None:
        now = time.monotonic()
        self._last_state = normalized
        self._last_state_at = now
        self._last_awake_at = now

    async def _wake_request(self) -> None:
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/wake_up",
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()

    async def _wake_and_wait(self) -> None:
        """POST wake_up, then poll vehicle_data until it stops 408ing (the
        car's back online) or we give up. Only ever called from the command
        path — reads never wake the car."""
        await self._wake_request()
        deadline = time.monotonic() + WAKE_TIMEOUT_S
        nudged = False
        while time.monotonic() < deadline:
            try:
                data = await self._fetch_vehicle_data()
            except VehicleAsleepError:
                # Halfway through with no luck yet — the first wake_up may
                # not have reached the car (weak signal, etc). Nudge once.
                if not nudged and time.monotonic() > deadline - WAKE_TIMEOUT_S / 2:
                    nudged = True
                    await self._wake_request()
                await asyncio.sleep(WAKE_POLL_INTERVAL_S)
                continue
            self._remember(self._normalize(data))
            return
        raise RuntimeError(
            "Couldn't wake the car in time — check it has signal and the "
            "12V battery isn't flat, then try again."
        )

    async def _send_signed(
        self, token: str, vid: str, name: str, payload: dict[str, Any] | None
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20, verify=False) as c:  # proxy uses a local cert
            r = await c.post(
                f"{self.settings.tesla_proxy_url}/api/1/vehicles/{vid}/command/{name}",
                headers={"Authorization": f"Bearer {token}"},
                json=payload or {},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        r.raise_for_status()
        return r.json()

    async def _command(self, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send a SIGNED command through the vehicle-command proxy, waking
        the car first if it's not already known to be awake."""
        recently_awake = (
            self._last_awake_at is not None
            and time.monotonic() - self._last_awake_at < AWAKE_CACHE_TTL_S
        )
        if not recently_awake:
            await self._wake_and_wait()

        token = await self._access_token()
        vid = await self._vehicle()
        try:
            return await self._send_signed(token, vid, name, payload)
        except VehicleAsleepError:
            # Fell back asleep between the check above and now, or the
            # awake-cache was stale. Wake once more and retry exactly once
            # — if it fails again, let the error surface rather than loop.
            await self._wake_and_wait()
            token = await self._access_token()
            return await self._send_signed(token, vid, name, payload)

    # --- reads ---
    async def get_state(self) -> dict[str, Any]:
        """Never wakes the car, never raises. Live data when the car is
        reachable; otherwise the last snapshot we saw, marked asleep — same
        effect as Tesla's own app showing the last-known status."""
        try:
            data = await self._fetch_vehicle_data()
        except VehicleAsleepError:
            if self._last_state is not None:
                age = time.monotonic() - self._last_state_at
                return {**self._last_state, "awake": False, "stale_seconds": age}
            return {"awake": False, "stale_seconds": None}
        self._remember(self._normalize(data))
        return {**self._last_state, "stale_seconds": 0}

    # --- commands (all go through the signing proxy; wake-and-retry above) ---
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

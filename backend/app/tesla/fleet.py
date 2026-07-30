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
import os
import time
from typing import Any

import httpx

from app.auth.oauth import TokenStore
from app.config import get_settings
from app.geo import reverse_geocode

# Mode numbers come from the proxy's own dispatch table (pkg/proxy/command.go).
CLIMATE_KEEPER_MODES = {"off": 0, "on": 1, "dog": 2, "camp": 3}

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


def _raise_for_status(r: httpx.Response, source: str) -> None:
    """httpx's own raise_for_status reports only the status line and URL,
    dropping the response body — which is where both Tesla and the proxy put
    the actual reason. That cost a real debugging session (a 404 whose body
    said "expected 17-character VIN in path" looked like a generic outage,
    and the assistant guessed "the car is asleep"). Keep the body."""
    if r.is_success:
        return
    # The upstream body is attacker-influenceable and travels into the model's
    # context via the tool-error path, so cap it hard and strip control
    # characters rather than reflecting it verbatim.
    detail = " ".join(r.text.split())[:200]
    detail = "".join(ch for ch in detail if ch.isprintable())
    raise RuntimeError(
        f"{source} returned HTTP {r.status_code}"
        + (f": {detail}" if detail else "")
    )


MILES_TO_KM = 1.609344


def _summarise_schedules(raw: Any, time_field: str) -> list[dict[str, Any]]:
    """Just enough of each schedule for the model to talk about it and to
    remove the right one.

    The full records carry coordinates, and the car's parking spots are the
    owner's home and workplace — there is no reason for them to travel into a
    model's context to answer "when do I charge".
    """
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw[:10]:
        if not isinstance(entry, dict):
            continue
        minutes = entry.get(time_field)
        item: dict[str, Any] = {
            "id": entry.get("id"),
            "enabled": entry.get("enabled", True),
            "days": entry.get("days_of_week"),
            "one_time": entry.get("one_time", False),
        }
        if isinstance(minutes, int):
            item["time"] = f"{minutes // 60:02d}:{minutes % 60:02d}"
        if entry.get("name"):
            item["name"] = _clean_label(entry["name"])
        out.append(item)
    return out


def _put(target: dict[str, Any], key: str, value: Any) -> None:
    """Set only when there is something to set. Keeps "we don't know" and
    "the value is zero/false" distinguishable in the state the model reads."""
    if value is not None:
        target[key] = value

# The signing proxy presents a self-signed certificate; pin to it so the
# channel carrying the Tesla bearer token is authenticated rather than blindly
# trusted. Falls back to no verification only if the file is absent, which
# would otherwise break every command on a fresh deploy.
PROXY_CA: Any = os.getenv("TESLA_PROXY_CA", "/certs/proxy-cert.pem")
if not os.path.exists(str(PROXY_CA)):
    PROXY_CA = False

# Third-party place names reach the model as tool results.
MAX_LABEL_LEN = 120


def _clean_label(text: Any) -> str | None:
    if text is None:
        return None
    flat = " ".join(str(text).split())
    flat = "".join(ch for ch in flat if ch.isprintable())
    return flat[:MAX_LABEL_LEN] or None


def _coords(location: dict[str, Any] | None) -> str | None:
    """A "lat,long" string that set_navigation_destination accepts verbatim.

    Supplied ready-made because Tesla names its Superchargers after the town
    ("Kraków, Poland"), and sending that as free text geocodes to the town
    centre rather than the charger. Coordinates are accepted by the same
    endpoint and land on the actual site — verified against the car.
    """
    if not location:
        return None
    lat, lon = location.get("lat"), location.get("long")
    if lat is None or lon is None:
        return None
    return f"{lat},{lon}"


def _normalize_chargers(data: dict[str, Any]) -> dict[str, Any]:
    """Flatten Tesla's two arrays into one ranked list.

    Distances arrive in miles regardless of the car's own display units, so
    they're converted here — everything downstream (and the user) is metric.
    """
    sites: list[dict[str, Any]] = []
    for entry in data.get("superchargers", []) or []:
        sites.append(
            {
                "name": _clean_label(entry.get("name")),
                "type": "supercharger",
                "distance_km": round(entry.get("distance_miles", 0) * MILES_TO_KM, 1),
                "available_stalls": entry.get("available_stalls"),
                "total_stalls": entry.get("total_stalls"),
                "closed": entry.get("site_closed", False),
                "navigate_to": _coords(entry.get("location")),
            }
        )
    for entry in data.get("destination_charging", []) or []:
        sites.append(
            {
                "name": _clean_label(entry.get("name")),
                "type": "destination",
                "distance_km": round(entry.get("distance_miles", 0) * MILES_TO_KM, 1),
                "navigate_to": _coords(entry.get("location")),
            }
        )
    sites.sort(key=lambda s: s["distance_km"])
    return {"sites": sites, "source": "tesla"}


class FleetImpl:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.tokens = TokenStore()  # provides a valid access token, refreshing as needed
        self._vehicle_id: str | None = None
        self._vehicle_vin: str | None = None
        # Last-known-good snapshot + when we got it (monotonic clock — this
        # is only ever compared to itself within one process's lifetime, so
        # wall-clock/timezone concerns don't apply).
        self._last_state: dict[str, Any] | None = None
        self._last_state_at: float | None = None
        self._last_awake_at: float | None = None

    async def _access_token(self) -> str:
        return await self.tokens.get_access_token()

    async def _resolve_vehicle(self) -> None:
        """Fetch and cache both identifiers for the account's first vehicle.

        They are NOT interchangeable across our two backends: the Fleet API
        takes the numeric `id` as its vehicle_tag, while the signing proxy
        insists on the 17-character VIN and 404s on anything else (its own
        error: "expected 17-character VIN in path (do not use Fleet API
        ID)"). Resolve both once from the same response so neither path has
        to guess."""
        if self._vehicle_id and self._vehicle_vin:
            return
        token = await self._access_token()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles",
                headers={"Authorization": f"Bearer {token}"},
            )
            _raise_for_status(r, "Tesla Fleet API (vehicle list)")
            vehicles = r.json()["response"]
            if not vehicles:
                raise RuntimeError("No vehicles on this Tesla account")
            self._vehicle_id = str(vehicles[0]["id"])
            self._vehicle_vin = str(vehicles[0]["vin"])

    async def _vehicle(self) -> str:
        """Numeric Fleet API vehicle_tag — for direct Fleet API calls."""
        await self._resolve_vehicle()
        return self._vehicle_id  # type: ignore[return-value]

    async def _vin(self) -> str:
        """17-character VIN — required by the signing proxy's URL path."""
        await self._resolve_vehicle()
        return self._vehicle_vin  # type: ignore[return-value]

    async def _fetch_vehicle_data(self) -> dict[str, Any]:
        """Raw vehicle_data fetch. Raises VehicleAsleepError on 408 instead
        of a generic HTTP error, so callers decide what "asleep" means to
        them. Never wakes the car — a plain GET, confirmed Tesla doesn't
        treat this as a wake trigger.

        A car that's asleep doesn't always 408 — one caught in production:
        a car that had just gone idle returned a plain 200 with a payload
        whose top-level `state` was "asleep"/"offline", but whose
        charge_state/climate_state fields still held Tesla's last-cached
        values from hours earlier (a real drive's worth of battery drain
        stale). Trusting any 200 as "live" served that stale snapshot as
        current. So check `state` explicitly, not just the HTTP status."""
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/vehicle_data",
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        _raise_for_status(r, "Tesla Fleet API (vehicle_data)")
        data = r.json()["response"]
        if data.get("state") != "online":
            raise VehicleAsleepError()
        return data

    def _normalize(self, data: dict[str, Any]) -> dict[str, Any]:
        """Pick the fields worth answering questions with.

        This used to stop at nine, and the omission showed: asked for range
        the assistant answered "I don't have that", which read as a limit of
        Tesla's API and was nothing of the sort — `battery_range` had been
        arriving in the same response all along and was being dropped here.
        Everything below already comes in that one call, so exposing it costs
        no extra request and no extra permission; the anti-confabulation rule
        in llm/prompt.py then has real data to work with instead of a gap it
        must decline to fill.

        Absent keys are left out rather than defaulted. A missing field and a
        field that is genuinely zero mean different things — "range unknown"
        is not "0 km left" — and the model is told to say what it does not
        have, which it can only do if the difference survives to here.
        """
        charge_state = data.get("charge_state", {})
        climate_state = data.get("climate_state", {})
        vehicle_state = data.get("vehicle_state", {})

        state: dict[str, Any] = {
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

        def km(field: str) -> float | None:
            """Tesla reports distance in miles regardless of the car's display
            units, so every one of these needs converting rather than
            relaying."""
            miles = charge_state.get(field)
            return round(miles * MILES_TO_KM, 1) if isinstance(miles, (int, float)) else None

        # Two different answers to "how far can I go", and the difference
        # matters enough to send both: `battery_range` is the rated figure the
        # dash shows, `est_battery_range` is Tesla's own estimate from how this
        # car has actually been driven lately — the honest one in winter.
        _put(state, "range_km", km("battery_range"))
        _put(state, "range_estimated_km", km("est_battery_range"))

        _put(state, "outside_temp_c", climate_state.get("outside_temp"))
        _put(state, "charge_port_open", charge_state.get("charge_port_door_open"))
        _put(state, "plugged_in", charge_state.get("conn_charge_cable") not in (None, "<invalid>"))

        # Only meaningful mid-charge. Tesla leaves them at 0 when idle, which
        # would otherwise read as "fully charged, zero minutes to go".
        if state["charging"]:
            _put(state, "charging_power_kw", charge_state.get("charger_power"))
            _put(state, "charging_amps", charge_state.get("charge_amps"))
            _put(state, "charging_volts", charge_state.get("charger_voltage"))
            minutes = charge_state.get("minutes_to_full_charge")
            if not minutes:
                hours = charge_state.get("time_to_full_charge")
                minutes = round(hours * 60) if isinstance(hours, (int, float)) else None
            _put(state, "minutes_to_charge_limit", minutes or None)
            rate = charge_state.get("charge_rate")
            if isinstance(rate, (int, float)) and rate:
                _put(state, "charging_km_per_hour", round(rate * MILES_TO_KM, 1))

        odometer = vehicle_state.get("odometer")
        if isinstance(odometer, (int, float)):
            state["odometer_km"] = round(odometer * MILES_TO_KM)

        # Anything open is worth mentioning unprompted before a drive; all
        # closed is the normal case and not worth the words, so only the
        # exceptions travel.
        openings = {
            "driver_door": vehicle_state.get("df"),
            "passenger_door": vehicle_state.get("pf"),
            "rear_left_door": vehicle_state.get("dr"),
            "rear_right_door": vehicle_state.get("pr"),
            "frunk": vehicle_state.get("ft"),
            "trunk": vehicle_state.get("rt"),
            "driver_window": vehicle_state.get("fd_window"),
            "passenger_window": vehicle_state.get("fp_window"),
            "rear_left_window": vehicle_state.get("rd_window"),
            "rear_right_window": vehicle_state.get("rp_window"),
        }
        open_now = [name for name, value in openings.items() if value]
        if open_now:
            state["open"] = open_now

        update = vehicle_state.get("software_update") or {}
        if update.get("status"):
            state["software_update"] = {
                "status": update.get("status"),
                "version": update.get("version"),
            }
        _put(state, "software_version", vehicle_state.get("car_version"))

        return state

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
            _raise_for_status(r, "Tesla Fleet API (wake_up)")

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
        self, token: str, name: str, payload: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Addressed by VIN, not the Fleet API id — the proxy rejects the
        latter outright (see _resolve_vehicle)."""
        vin = await self._vin()
        # Pinned to the proxy's own certificate rather than verify=False. The
        # cert is self-signed (CN=tesla-proxy, issued by itself), so plain
        # verification could never pass — but disabling it meant a live Tesla
        # bearer token would be handed to whatever answered at
        # TESLA_PROXY_URL, silently, if that setting were ever wrong.
        async with httpx.AsyncClient(timeout=20, verify=PROXY_CA) as c:
            r = await c.post(
                f"{self.settings.tesla_proxy_url}/api/1/vehicles/{vin}/command/{name}",
                headers={"Authorization": f"Bearer {token}"},
                json=payload or {},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        # The car rejects every signed command until our virtual key is in
        # its keychain. Raw, this reads like an outage; spell out the actual
        # (one-time, user-side) fix instead — see fleet_status's
        # unpaired_vins for the authoritative state.
        if "not been paired" in r.text:
            raise RuntimeError(
                "Amp's virtual key isn't paired with the car yet, so it "
                "rejects remote commands. Open https://tesla.com/_ak/"
                "tesla-amp.duckdns.org in the Tesla app to add it. The "
                "vehicle's owner account can do this from anywhere; a "
                "driver/co-owner account has to be next to the car, in "
                "Bluetooth range, with the physical key card."
            )
        _raise_for_status(r, "Tesla signing proxy")
        return r.json()

    async def _send_direct(
        self, token: str, name: str, payload: dict[str, Any] | None
    ) -> dict[str, Any]:
        """POST straight to the Fleet API, bypassing the signing proxy. Only
        for the handful of commands the proxy itself refuses to sign — its
        own source (pkg/proxy/command.go) returns ErrCommandUseRESTAPI for
        `navigation_request`/`share`, since these need server-side geocoding
        that can't be end-to-end authenticated with the vehicle key."""
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/command/{name}",
                headers={"Authorization": f"Bearer {token}"},
                json=payload or {},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        _raise_for_status(r, "Tesla Fleet API")
        return r.json()

    async def _command(
        self, name: str, payload: dict[str, Any] | None = None, *, signed: bool = True
    ) -> dict[str, Any]:
        """Send a command, waking the car first if it's not already known to
        be awake. `signed` (default) routes through the vehicle-command
        proxy — required for anything this car treats as a real vehicle
        command (locks, climate, ...). Pass `signed=False` for the few
        commands (navigation/share) the proxy refuses to handle itself."""
        recently_awake = (
            self._last_awake_at is not None
            and time.monotonic() - self._last_awake_at < AWAKE_CACHE_TTL_S
        )
        if not recently_awake:
            await self._wake_and_wait()

        token = await self._access_token()
        send = self._send_signed if signed else self._send_direct
        try:
            return await send(token, name, payload)
        except VehicleAsleepError:
            # Fell back asleep between the check above and now, or the
            # awake-cache was stale. Wake once more and retry exactly once
            # — if it fails again, let the error surface rather than loop.
            await self._wake_and_wait()
            token = await self._access_token()
            return await send(token, name, payload)

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
        payload = {"seat_position": seat_map[seat], "level": level}
        result = await self._command("remote_seat_heater_request", payload)
        # This one refuses with HTTP 200 and result: false rather than an
        # error status, so _raise_for_status never sees it — the raw dict just
        # travels on to the model, which is why the owner saw a literal Tesla
        # reason string ("cabin comfort remote settings not enabled") instead
        # of a fix. The actual requirement, confirmed against other Fleet API
        # clients hitting the same thing: climate has to already be running.
        # Turning it on and asking again once is the same quiet-recovery move
        # _command already makes for a sleeping car — and climate is
        # explicitly ungated and reversible (see BASE_SYSTEM_PROMPT's
        # confirmation rules), so doing it without asking first stays in scope.
        if not result.get("result") and "cabin comfort" in str(result.get("reason", "")).lower():
            await self.start_climate()
            result = await self._command("remote_seat_heater_request", payload)
        return result

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

    # --- charging sites ---
    async def nearby_chargers(self) -> dict[str, Any]:
        """Tesla's own list of charging sites around the car, including live
        stall availability — nothing third-party comes close on that, and it
        costs no extra API key.

        Unlike get_state this *may* wake the car: the answer depends on where
        the car currently is, and the user asked for it explicitly (it's not
        background polling), so a stale or empty answer would be worse than a
        wake. The cheap read is still tried first.
        """
        token = await self._access_token()
        vid = await self._vehicle()

        async def fetch() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=25) as c:
                r = await c.get(
                    f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/nearby_charging_sites",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if r.status_code == 408:
                raise VehicleAsleepError()
            _raise_for_status(r, "Tesla Fleet API (nearby_charging_sites)")
            return r.json()["response"]

        try:
            data = await fetch()
        except VehicleAsleepError:
            await self._wake_and_wait()
            data = await fetch()
        return _normalize_chargers(data)

    # --- location ---
    async def _coordinates(self) -> tuple[float, float]:
        """Raw position, with no third-party lookup — commands that merely
        need coordinates (HomeLink) shouldn't ship the car's location off to
        a geocoder just to get a street name nobody asked for.

        `location_data` has to be requested explicitly: a plain vehicle_data
        call comes back without coordinates even though the scope allows them.
        """
        token = await self._access_token()
        vid = await self._vehicle()

        async def fetch() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(
                    f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/vehicle_data",
                    headers={"Authorization": f"Bearer {token}"},
                    params={"endpoints": "drive_state;location_data"},
                )
            if r.status_code == 408:
                raise VehicleAsleepError()
            _raise_for_status(r, "Tesla Fleet API (location)")
            return r.json()["response"]

        try:
            data = await fetch()
        except VehicleAsleepError:
            await self._wake_and_wait()
            data = await fetch()

        drive = data.get("drive_state", {}) or {}
        lat, lon = drive.get("latitude"), drive.get("longitude")
        if lat is None or lon is None:
            raise RuntimeError("The car didn't report a position.")
        return lat, lon

    async def get_location(self) -> dict[str, Any]:
        """Coordinates plus a street address."""
        lat, lon = await self._coordinates()
        address = _clean_label(await reverse_geocode(lat, lon))
        return {
            "latitude": lat,
            "longitude": lon,
            "address": address,
            "map_url": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}",
        }

    async def set_cabin_overheat_protection(
        self, on: bool, fan_only: bool = False
    ) -> dict[str, Any]:
        return await self._command(
            "set_cabin_overheat_protection", {"on": on, "fan_only": fan_only}
        )

    async def set_climate_keeper_mode(self, mode: str) -> dict[str, Any]:
        return await self._command(
            "set_climate_keeper_mode", {"climate_keeper_mode": CLIMATE_KEEPER_MODES[mode]}
        )

    # --- everyday odds and ends ---
    async def set_sentry_mode(self, on: bool) -> dict[str, Any]:
        return await self._command("set_sentry_mode", {"on": on})

    async def control_windows(self, command: str) -> dict[str, Any]:
        if command not in ("vent", "close"):
            raise ValueError("command must be 'vent' or 'close'")
        return await self._command("window_control", {"command": command})

    async def actuate_trunk(self, which: str) -> dict[str, Any]:
        if which not in ("front", "rear"):
            raise ValueError("which must be 'front' or 'rear'")
        return await self._command("actuate_trunk", {"which_trunk": which})

    async def charge_port(self, open_port: bool) -> dict[str, Any]:
        return await self._command(
            "charge_port_door_open" if open_port else "charge_port_door_close"
        )

    async def trigger_homelink(self) -> dict[str, Any]:
        # The car matches these coordinates against the HomeLink device it has
        # paired for that spot, so they must be the car's own position.
        lat, lon = await self._coordinates()
        return await self._command("trigger_homelink", {"lat": lat, "lon": lon})

    # --- schedules (the current API; see the note on the old commands) ---
    #
    # Tesla's own docs mark set_scheduled_charging and set_scheduled_departure
    # as not recommended from firmware 2024.26 onward, pointing at these
    # instead. This car is well past that. The new ones are a different shape
    # rather than a rename: schedules have identities, repeat on chosen days,
    # and are tied to a place — the car applies them when it is parked near
    # the coordinates they were created with, which is what makes "charge
    # overnight" mean at home rather than wherever it happens to be.

    async def list_schedules(self) -> dict[str, Any]:
        token = await self._access_token()
        vid = await self._vehicle()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{self.settings.tesla_fleet_base}/api/1/vehicles/{vid}/vehicle_data",
                headers={"Authorization": f"Bearer {token}"},
                # Asked for explicitly: these two are not in the default
                # payload, and requesting only them keeps this cheap.
                params={"endpoints": "charge_schedule_data;preconditioning_schedule_data"},
            )
        if r.status_code == 408:
            raise VehicleAsleepError()
        _raise_for_status(r, "Tesla Fleet API (schedules)")
        data = r.json().get("response", {})
        return {
            "charge_schedules": _summarise_schedules(
                data.get("charge_schedule_data", {}).get("charge_schedules", []), "start_time"
            ),
            "precondition_schedules": _summarise_schedules(
                data.get("preconditioning_schedule_data", {}).get(
                    "preconditioning_schedules", []
                ),
                "precondition_time",
            ),
        }

    async def add_charge_schedule(
        self, minutes_after_midnight: int, days: str, one_time: bool, schedule_id: int | None
    ) -> dict[str, Any]:
        lat, lon = await self._coordinates()
        payload: dict[str, Any] = {
            "days_of_week": days,
            "enabled": True,
            "lat": lat,
            "lon": lon,
            # Start time only: an end time would cap charging part-way, which
            # is a different intention from "begin at this hour".
            "start_enabled": True,
            "start_time": minutes_after_midnight,
            "end_enabled": False,
            "one_time": one_time,
        }
        if schedule_id is not None:
            payload["id"] = schedule_id
        return await self._command("add_charge_schedule", payload)

    async def add_precondition_schedule(
        self, minutes_after_midnight: int, days: str, one_time: bool, schedule_id: int | None
    ) -> dict[str, Any]:
        lat, lon = await self._coordinates()
        payload: dict[str, Any] = {
            "days_of_week": days,
            "enabled": True,
            "lat": lat,
            "lon": lon,
            "precondition_time": minutes_after_midnight,
            "one_time": one_time,
        }
        if schedule_id is not None:
            payload["id"] = schedule_id
        return await self._command("add_precondition_schedule", payload)

    async def remove_schedule(self, kind: str, schedule_id: int) -> dict[str, Any]:
        command = (
            "remove_precondition_schedule"
            if kind == "precondition"
            else "remove_charge_schedule"
        )
        return await self._command(command, {"id": schedule_id})

    async def set_charging_amps(self, amps: int) -> dict[str, Any]:
        return await self._command("set_charging_amps", {"charging_amps": amps})


    async def set_steering_wheel_heater(self, on: bool) -> dict[str, Any]:
        return await self._command("remote_steering_wheel_heater_request", {"on": on})

    async def schedule_software_update(self, delay_seconds: int) -> dict[str, Any]:
        return await self._command(
            "schedule_software_update", {"offset_sec": delay_seconds}
        )

    async def cancel_software_update(self) -> dict[str, Any]:
        return await self._command("cancel_software_update")

    async def set_volume(self, level: float) -> dict[str, Any]:
        return await self._command("adjust_volume", {"volume": level})

    async def media_favorite(self, direction: str) -> dict[str, Any]:
        return await self._command(
            "media_next_fav" if direction == "next" else "media_prev_fav"
        )

    async def set_route(self, stops: list[dict[str, Any]]) -> dict[str, Any]:
        """Send the stops in order, one command each.

        `order` is documented — "Order can be used to specify order of multiple
        stops" — but what is *not* documented is whether separate calls
        accumulate into one route or each replaces the destination. That is the
        difference between this working and only the last stop arriving, and it
        cannot be settled from the outside.

        So the result says what actually happened and no more:
        `verified_multi_stop` stays false until the car is observed building a
        route from these, and the tool description tells the model not to
        promise the driver a multi-stop route on the strength of it. An
        optimistic claim here becomes a confident wrong sentence in the cabin.
        """
        sent: list[dict[str, Any]] = []
        for order, stop in enumerate(stops, start=1):
            # Unsigned, like every navigation command: the signing proxy
            # handles none of them (verified against its own command table).
            result = await self._command(
                "navigation_gps_request",
                {"lat": stop["latitude"], "lon": stop["longitude"], "order": order},
                signed=False,
            )
            sent.append({"order": order, "label": stop.get("label"), "accepted": bool(result)})
        return {
            "ok": True,
            "stops_sent": len(sent),
            "stops": sent,
            "verified_multi_stop": False,
        }

    # --- navigation (unsigned — the proxy itself refuses this command) ---
    async def set_navigation_destination(self, address: str) -> dict[str, Any]:
        """Free-text address/place; Tesla geocodes it server-side. This is
        `share` (the current, documented replacement for the retired
        `navigation_request`), not `navigation_sc_request` — that endpoint's
        request parameters were never documented by Tesla, and developers
        who've tried it report it returns "success" but the car's nav just
        sits at "calculating" forever."""
        return await self._command(
            "share",
            {
                "type": "share_ext_content_raw",
                "value": {"android.intent.extra.TEXT": address},
                "locale": "en-US",
                "timestamp_ms": str(int(time.time() * 1000)),
            },
            signed=False,
        )

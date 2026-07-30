"""The one seam that matters: everything above this interface is provider-agnostic.

Swap MockImpl (dev) -> FleetImpl (prod, self-hosted signing proxy) -> a broker impl
later, and nothing in the orchestrator or the API layer changes.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class TeslaAdapter(ABC):
    """Minimal surface the AI layer is allowed to touch.

    Reads should be cheap and cache-friendly; commands may wake the car (expensive).
    Each method maps 1:1 to one or a few Fleet API endpoints — keep it that way so
    failures are easy to trace.
    """

    # --- reads (cheap; serve from cache where possible) ---
    @abstractmethod
    async def get_state(self) -> dict[str, Any]:
        """Return a normalized snapshot: temp, battery, locked, climate_on, etc."""

    # --- climate ---
    @abstractmethod
    async def set_temperature(self, celsius: float) -> dict[str, Any]: ...

    @abstractmethod
    async def start_climate(self) -> dict[str, Any]: ...

    @abstractmethod
    async def stop_climate(self) -> dict[str, Any]: ...

    @abstractmethod
    async def set_seat_heater(self, seat: str, level: int) -> dict[str, Any]:
        """seat in {front_left, front_right, rear_left, rear_center, rear_right}; level 0-3."""

    # --- media ---
    @abstractmethod
    async def media_control(self, action: str) -> dict[str, Any]:
        """action in {play, pause, next, previous, volume_up, volume_down}."""

    # --- security / charging ---
    @abstractmethod
    async def lock(self) -> dict[str, Any]: ...

    @abstractmethod
    async def unlock(self) -> dict[str, Any]: ...

    @abstractmethod
    async def set_charge_limit(self, percent: int) -> dict[str, Any]: ...

    @abstractmethod
    async def start_charging(self) -> dict[str, Any]: ...

    @abstractmethod
    async def stop_charging(self) -> dict[str, Any]: ...

    # --- signals ---
    @abstractmethod
    async def honk(self) -> dict[str, Any]: ...

    @abstractmethod
    async def flash_lights(self) -> dict[str, Any]: ...

    # --- navigation ---
    @abstractmethod
    async def set_route(self, stops: list[dict[str, Any]]) -> dict[str, Any]:
        """Ordered waypoints: [{'latitude', 'longitude', 'label'?}, ...].

        Separate from set_navigation_destination because the car takes them by
        different commands — coordinates with an order, versus a shared string
        Tesla geocodes itself."""

    @abstractmethod
    async def set_navigation_destination(self, address: str) -> dict[str, Any]:
        """Free-text address/place name; Tesla geocodes it server-side."""

    @abstractmethod
    async def nearby_chargers(self) -> dict[str, Any]:
        """Charging sites around the car's current position."""

    @abstractmethod
    async def get_location(self) -> dict[str, Any]:
        """Where the car is: coordinates plus a human-readable address."""

    # --- native scheduling / comfort (run in the car, not on our server) ---
    #
    # Tesla marks the old single-setting commands as not recommended from
    # firmware 2024.26; these replace them. Schedules have identities and repeat
    # on chosen days, so turning one off means removing it by id rather than
    # flipping a flag — hence list_schedules being part of the interface rather
    # than a convenience.
    @abstractmethod
    async def list_schedules(self) -> dict[str, Any]:
        """Charge and preconditioning schedules the car is holding."""

    @abstractmethod
    async def add_charge_schedule(
        self, minutes_after_midnight: int, days: str, one_time: bool, schedule_id: int | None
    ) -> dict[str, Any]:
        """Start charging at this time. Bound to where the car is now, so it
        applies at that place — usually home."""

    @abstractmethod
    async def add_precondition_schedule(
        self, minutes_after_midnight: int, days: str, one_time: bool, schedule_id: int | None
    ) -> dict[str, Any]:
        """Be warm and ready to leave at this time, same place-binding."""

    @abstractmethod
    async def remove_schedule(self, kind: str, schedule_id: int) -> dict[str, Any]:
        """kind in {charge, precondition}."""

    @abstractmethod
    async def set_cabin_overheat_protection(self, on: bool, fan_only: bool = False) -> dict[str, Any]: ...

    @abstractmethod
    async def set_climate_keeper_mode(self, mode: str) -> dict[str, Any]:
        """mode in {off, on, dog, camp}."""

    # --- everyday odds and ends ---
    @abstractmethod
    async def set_sentry_mode(self, on: bool) -> dict[str, Any]: ...

    @abstractmethod
    async def control_windows(self, command: str) -> dict[str, Any]:
        """command in {vent, close}."""

    @abstractmethod
    async def actuate_trunk(self, which: str) -> dict[str, Any]:
        """which in {front, rear}."""

    @abstractmethod
    async def charge_port(self, open_port: bool) -> dict[str, Any]: ...

    @abstractmethod
    async def trigger_homelink(self) -> dict[str, Any]:
        """Garage door etc. at the car's current position."""

    # --- charging detail ---
    @abstractmethod
    async def set_charging_amps(self, amps: int) -> dict[str, Any]:
        """Current draw while charging. The lever that matters on a weak
        domestic circuit, where the car's default would trip a breaker."""

    # --- comfort ---
    @abstractmethod
    async def set_steering_wheel_heater(self, on: bool) -> dict[str, Any]:
        """Cars without the hardware reject this; the error is relayed rather
        than guessed at here, since trim levels vary."""

    # --- software ---
    @abstractmethod
    async def schedule_software_update(self, delay_seconds: int) -> dict[str, Any]:
        """Start an installation. Confirmation-gated: an update leaves the car
        unusable for a stretch and cannot be called back once running."""

    @abstractmethod
    async def cancel_software_update(self) -> dict[str, Any]:
        """Only works before the install actually begins."""

    # --- media ---
    @abstractmethod
    async def set_volume(self, level: float) -> dict[str, Any]:
        """Absolute level, where media_control only steps up and down."""

    @abstractmethod
    async def media_favorite(self, direction: str) -> dict[str, Any]:
        """direction in {next, previous} — moves through saved stations."""


def build_adapter() -> TeslaAdapter:
    """Factory: pick the implementation from config. Import lazily so the mock
    path never needs the Fleet dependencies (and vice versa)."""
    from app.config import get_settings

    settings = get_settings()
    if settings.tesla_adapter == "fleet":
        from app.tesla.fleet import FleetImpl

        return FleetImpl()
    from app.tesla.mock import MockImpl

    return MockImpl()

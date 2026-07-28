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
    async def set_navigation_destination(self, address: str) -> dict[str, Any]:
        """Free-text address/place name; Tesla geocodes it server-side."""

    @abstractmethod
    async def nearby_chargers(self) -> dict[str, Any]:
        """Charging sites around the car's current position."""

    @abstractmethod
    async def get_location(self) -> dict[str, Any]:
        """Where the car is: coordinates plus a human-readable address."""

    # --- native scheduling / comfort (run in the car, not on our server) ---
    @abstractmethod
    async def set_scheduled_charging(self, enable: bool, minutes_after_midnight: int) -> dict[str, Any]:
        """Daily start time for charging, in the car's own local time."""

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

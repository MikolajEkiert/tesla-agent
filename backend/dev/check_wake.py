#!/usr/bin/env python3
"""Does asking about a sleeping car actually wake it?

Written after the assistant spent a whole conversation saying "waking it up…"
and never doing it. The cause was not a broken wake — the wake worked, and had
worked all along on the command path. The cause was that no tool existed to
reach it, so the model produced the sentence a person would produce and nothing
happened. Four times in a row, with the owner watching.

What this pins down is therefore the wiring rather than the network: that a
read on a sleeping car wakes it exactly once, that an awake car is left alone,
that the explicit tool exists, and that a car which refuses to wake comes back
as an answer instead of an exception. Network-free — the car here is a stub, so
this runs in a second and cannot be broken by the weather.

Run from backend/:  ./.venv/bin/python dev/check_wake.py
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, ".")

os.environ.setdefault("TESLA_ADAPTER", "mock")
os.environ.setdefault("GEMINI_API_KEY", "dummy-key-for-the-probe")

from app import tools  # noqa: E402
from app.tesla.mock import MockImpl  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'}  {name}{'' if condition else f'  <- {detail}'}")
    if not condition:
        failures.append(name)


class SleepingCar(MockImpl):
    """Asleep until woken, and counts how many times it was asked."""

    def __init__(self, wakes: bool = True) -> None:
        super().__init__()
        self._state["awake"] = False
        self._state["battery_percent"] = 11
        self.asked = 0
        self._wakes = wakes

    async def wake(self) -> dict:
        self.asked += 1
        if not self._wakes:
            # What FleetImpl does when the car never comes online: the last
            # snapshot, marked, rather than a raised error.
            return {**dict(self._state), "woke": False, "wake_error": "no answer in time"}
        self._state["awake"] = True
        return {**dict(self._state), "woke": True}


async def main() -> None:
    print("a question about a sleeping car")
    car = SleepingCar()
    state = await tools.dispatch(car, "get_vehicle_state", {})
    check("the read wakes it", car.asked == 1, f"asked {car.asked} times")
    check("and comes back awake", state.get("awake") is True, str(state.get("awake")))
    check("saying so", state.get("woke") is True, str(state.get("woke")))
    check(
        "with the live reading attached",
        state.get("battery_percent") == 11,
        str(state.get("battery_percent")),
    )

    again = await tools.dispatch(car, "get_vehicle_state", {})
    check("a second read does not wake it again", car.asked == 1, f"asked {car.asked} times")
    check("and still answers", again.get("awake") is True, str(again))

    print("\na question about a car that is already awake")
    awake = MockImpl()
    woken = {"n": 0}

    async def count_wake() -> dict:
        woken["n"] += 1
        return {}

    awake.wake = count_wake  # type: ignore[method-assign]
    await tools.dispatch(awake, "get_vehicle_state", {})
    check("is not woken at all", woken["n"] == 0, f"woken {woken['n']} times")

    print("\nasked to wake the car outright")
    car = SleepingCar()
    out = await tools.dispatch(car, "wake_vehicle", {})
    check("there is a tool for it", "wake_vehicle" in {t["name"] for t in tools.TOOLS})
    check("and it wakes the car", out.get("woke") is True and car.asked == 1, str(out))

    print("\na car that will not wake")
    stubborn = SleepingCar(wakes=False)
    out = await tools.dispatch(stubborn, "get_vehicle_state", {})
    check("is an answer, not an exception", isinstance(out, dict), str(type(out)))
    check("that admits it", out.get("woke") is False, str(out.get("woke")))
    check(
        "and still hands over the last known reading",
        out.get("battery_percent") == 11,
        str(out.get("battery_percent")),
    )

    print("\nevery adapter can be asked")
    from app.tesla.adapter import TeslaAdapter
    from app.tesla.fleet import FleetImpl

    for impl in (MockImpl, FleetImpl):
        check(f"{impl.__name__} implements wake", callable(getattr(impl, "wake", None)))
    check("and the interface demands it", "wake" in TeslaAdapter.__abstractmethods__)

    print()
    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")
        raise SystemExit(1)
    print("all good")


asyncio.run(main())

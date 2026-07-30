"""App-level actions — the ones that aren't a single call to the car.

Everything here composes adapter calls with the scheduler. Kept out of
tools.py so that module stays a flat name -> adapter mapping.

It also owns the confirmation gate for physically consequential commands.
That gate exists because the assistant's context is not trustworthy input:
charger and place lookups pull free text straight out of OpenStreetMap and
Nominatim, which anyone may edit anonymously, and that text is handed back to
the model as a tool result. A model that treats such text as an instruction
could reach `unlock`, `actuate_trunk` or `trigger_homelink` — the garage door.
The system prompt asks the model to confirm first, but a prompt is guidance,
not a control.

So the authority to *execute* those commands is taken away from the model
entirely. The model may only propose them; the proposal is parked server-side
and executed by a separate endpoint that a human taps. Prompt injection can
therefore at most make an unexpected confirmation card appear, which is
visible and refusable — not a silently opened car.
"""
from __future__ import annotations

import secrets
import time
from typing import Any

from app import scheduler
from app.tesla.adapter import TeslaAdapter

# Commands whose effect is physical, immediate and hard to undo. Climate and
# charging are deliberately absent: they are reversible, cost only energy, and
# gating them would train the owner to tap "confirm" without reading — which
# is how a confirmation habit stops being a safeguard.
CONFIRM_REQUIRED = {
    "unlock",
    "actuate_trunk",
    "trigger_homelink",
    "control_windows",
    "set_sentry_mode",
    # Not a physical risk like the rest, but the least reversible thing here:
    # once an install starts the car is out of use until it finishes and there
    # is no calling it back. Cancelling is gated too — the same card serves
    # both, and a mistaken cancel costs nothing.
    "software_update",
}

# A proposal is worthless to an attacker after a moment, and expiring them
# keeps a stale card from being tapped much later out of context.
PENDING_TTL_S = 120
_pending: dict[str, dict[str, Any]] = {}


def needs_confirmation(tool: str) -> bool:
    return tool in CONFIRM_REQUIRED


def _prune_pending(now: float) -> None:
    for token, entry in list(_pending.items()):
        if now - entry["created_at"] > PENDING_TTL_S:
            del _pending[token]


def propose(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Park a sensitive command and return what the model should tell the user.

    Deliberately returns no error: the model's job here is to relay that a
    confirmation is waiting, not to retry or find a way around it.
    """
    now = time.time()
    _prune_pending(now)
    token = secrets.token_urlsafe(16)
    _pending[token] = {"tool": tool, "args": args, "created_at": now}
    return {
        "confirmation_required": True,
        "confirm_token": token,
        "tool": tool,
        "args": args,
        "expires_in_seconds": PENDING_TTL_S,
        "message": (
            "Not executed. This command needs the owner to confirm it in the app. "
            "Tell them what is waiting and stop — do not retry or call other tools "
            "to achieve the same effect."
        ),
    }


def discard(token: str) -> bool:
    """Forget a proposal the owner declined. True if there was one to forget."""
    _prune_pending(time.time())
    return _pending.pop(token, None) is not None


async def confirm(adapter: TeslaAdapter, token: str) -> dict[str, Any]:
    """Execute a parked command. Single use, so a replayed tap cannot fire it
    twice."""
    _prune_pending(time.time())
    entry = _pending.pop(token, None)
    if entry is None:
        raise ValueError("This confirmation has expired or was already used.")
    # Imported here to avoid a circular import (tools imports this module).
    from app.tools import dispatch_unguarded

    return await dispatch_unguarded(adapter, entry["tool"], entry["args"])

# The car's own remote-climate auto-off is firmware-dependent and unreliable
# (see scheduler.py), so our stop job is the real limit. 30 minutes is well
# past what cabin heat-up/cool-down needs, and short enough that a worst-case
# stranded session isn't a flat battery. Longer "keep the cabin comfortable"
# use belongs in Tesla's own Climate Keeper / Dog Mode, which is battery-aware
# and runs in the car.
MAX_RUN_MINUTES = 30
MAX_DELAY_MINUTES = 12 * 60
# Refuse to schedule a drain on an already-low battery — same reasoning Tesla
# applies to Dog Mode.
MIN_BATTERY_PERCENT = 20


async def schedule_climate(
    adapter: TeslaAdapter,
    celsius: float | None = None,
    start_in_minutes: float = 0,
    run_for_minutes: float | None = None,
) -> dict[str, Any]:
    """Turn climate on now (or later), optionally switching it off again after
    a set time. Returns a summary including the id needed to cancel."""
    if run_for_minutes is not None:
        if run_for_minutes <= 0:
            raise ValueError("run_for_minutes must be positive")
        if run_for_minutes > MAX_RUN_MINUTES:
            raise ValueError(
                f"Climate timers are capped at {MAX_RUN_MINUTES} minutes to protect "
                "the battery. For longer, use the car's own Climate Keeper / Dog Mode."
            )
    if start_in_minutes < 0:
        raise ValueError("start_in_minutes cannot be negative")
    if start_in_minutes > MAX_DELAY_MINUTES:
        raise ValueError(f"Can't schedule further out than {MAX_DELAY_MINUTES // 60} hours")

    state = await adapter.get_state()
    battery = state.get("battery_percent")
    if isinstance(battery, (int, float)) and battery < MIN_BATTERY_PERCENT:
        raise ValueError(
            f"Battery is at {round(battery)}% — too low to safely run climate on a timer. "
            f"Charge above {MIN_BATTERY_PERCENT}% first."
        )

    now = time.time()
    starts_at = now + start_in_minutes * 60
    meta = {
        "temp_c": celsius,
        "delay_minutes": start_in_minutes or 0,
        "run_for_minutes": run_for_minutes,
    }

    # Starting *now* runs inline rather than through the queue: the user gets
    # the real outcome (including a wake-up failure) in the same reply,
    # instead of a cheerful "scheduled" for something that never happened.
    if start_in_minutes == 0:
        if celsius is not None:
            await adapter.set_temperature(celsius)
        await adapter.start_climate()
        if run_for_minutes is None:
            return {"ok": True, "climate_on": True, "scheduled": False}
        group_id = await scheduler.schedule_group(
            "climate",
            {**meta, "started": True},
            [("stop_climate", {}, now + run_for_minutes * 60)],
        )
        return {
            "ok": True,
            "climate_on": True,
            "stops_in_minutes": run_for_minutes,
            "id": group_id,
        }

    jobs: list[tuple[str, dict[str, Any], float]] = []
    if celsius is not None:
        jobs.append(("set_climate_temp", {"celsius": celsius}, starts_at))
    jobs.append(("start_climate", {}, starts_at))
    if run_for_minutes is not None:
        jobs.append(("stop_climate", {}, starts_at + run_for_minutes * 60))

    group_id = await scheduler.schedule_group("climate", meta, jobs)
    return {
        "ok": True,
        "scheduled": True,
        "starts_in_minutes": start_in_minutes,
        "run_for_minutes": run_for_minutes,
        "id": group_id,
    }


async def list_scheduled(include_finished: bool = False) -> dict[str, Any]:
    groups = await scheduler.list_groups(include_finished=include_finished)
    now = time.time()
    return {
        "actions": [
            {
                "id": g["id"],
                "kind": g["kind"],
                "state": g["state"],
                "details": g["meta"],
                "next_in_minutes": (
                    round((g["next_run_at"] - now) / 60, 1) if g["next_run_at"] else None
                ),
                "error": g["error"],
            }
            for g in groups
        ]
    }


async def cancel_scheduled(action_id: str) -> dict[str, Any]:
    cancelled = await scheduler.cancel_group(action_id)
    if not cancelled:
        raise ValueError(
            f"Nothing pending with id '{action_id}' — it may have already run or been cancelled."
        )
    return {"ok": True, "cancelled": action_id}

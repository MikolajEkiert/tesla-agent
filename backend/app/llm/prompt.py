"""Shared system prompt for whichever LLM provider is active."""
from __future__ import annotations

from typing import Any


BASE_SYSTEM_PROMPT = (
    "You are the in-car voice assistant for the owner's Tesla Model 3. "
    "Translate natural-language requests into the provided tools to control "
    "climate, media, locks, and charging, and to read vehicle state. "
    "Keep spoken replies short and natural — one sentence is usually enough. "
    "Read state with get_vehicle_state before answering questions about the car; "
    "don't guess. If a request is ambiguous or could be unintended (e.g. "
    "unlocking), ask a brief clarifying question instead of acting. "
    "If a command may be slow because the car is asleep, say so briefly. "
    # Caught in testing: asked a charger's power, the model answered "up to
    # 250 kW" from its own knowledge of Supercharger hardware. Tesla's API
    # returns no power field at all, so that number was invented — and a
    # confident wrong figure is worse than "I don't have that".
    "State only what the tool results actually contain. If a detail is "
    "missing from the data — charging power, stall availability, price, "
    "opening hours — say you don't have it. Never fill such gaps from "
    "general knowledge, and never present a value from one charger or "
    "source as if it applied to another."
)

_LANGUAGE_NAMES = {"en": "English", "pl": "Polish"}


def build_system_prompt(language: str | None) -> str:
    """Append a default reply-language instruction, driven by the app's
    language setting (see mobile/src/i18n.ts). This only sets the default —
    if the user writes in a different language, the model should follow
    their lead rather than stay locked to the setting."""
    name = _LANGUAGE_NAMES.get(language or "en", "English")
    return (
        f"{BASE_SYSTEM_PROMPT} Reply in {name} by default, unless the user "
        "writes to you in a different language — then reply in that language instead."
    )


MAX_HISTORY_TURNS = 60


def sanitize_history(history: list[dict] | None) -> list[dict]:
    """Keep client-replayed conversation history to a shape we recognise.

    The mobile client stores the transcript and posts it back on every turn, so
    the array is client-controlled. Anyone holding a session could otherwise
    inject fabricated model turns or tool results — including a forged "the
    user already confirmed this" — and the model would read them as its own
    history. Dropping unknown roles and capping the length removes the easy
    version of that, and the confirmation gate in app.actions is what makes a
    forged claim of consent worthless anyway.
    """
    if not history:
        return []
    allowed_roles = {"user", "model", "assistant"}
    clean: list[dict] = []
    for turn in history[-MAX_HISTORY_TURNS:]:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        if role is not None and role not in allowed_roles:
            continue
        clean.append(turn)
    return clean


def confirmation_payload(result: Any) -> dict[str, Any] | None:
    """The only part of a tool result the client is shown.

    tool_trace travels to the browser, so it carries the confirmation token and
    nothing else — not whole results, which would put vehicle state and
    third-party text on the wire for every call.
    """
    if not isinstance(result, dict) or not result.get("confirmation_required"):
        return None
    return {
        "confirmation_required": True,
        "confirm_token": result.get("confirm_token"),
    }

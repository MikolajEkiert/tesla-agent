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
    # Written because the assistant used to announce a wake it had no way to
    # perform — there was no such tool, so "I'll wake it up" was a sentence
    # about nothing, and the car stayed asleep however many times it was asked.
    "Never say you are waking, starting, or checking something unless a tool "
    "you actually called did it. Reading state wakes the car by itself when it "
    "has to; if a result says woke: false, the car did not come online — say "
    "that plainly and give the last known values as last known, rather than "
    "reporting them as current. "
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

# The words this assistant hears constantly and a general speech model gets
# wrong — in ordinary Polish they are rare and their near-neighbours are common.
# Measured on the transcription path, where naming them fixed both real errors
# in a six-phrase test: "ładowarki" had been coming back as "lądowisko" (a
# landing pad), "Superchargera" as "Super-Hargera".
#
# Kept here, in one place, because two different callers need the same list and
# for the same reason: the transcriber (app/voice.py) and the live audio model
# (app/live.py), which since it stopped being a relay does its own listening.
# A list that drifted would mean the assistant hears one vocabulary by voice
# and another by recording.
DOMAIN_VOCABULARY = (
    "klimatyzacja, temperatura, stopni, ładowanie, ładowarka, Supercharger, "
    "limit ładowania, procent, bateria, zasięg, nawigacja, bagażnik, szyby, "
    "klakson, światła, podgrzewanie foteli, Sentry, HomeLink, minut, godzin"
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

# How many times one chat turn may go round asking for tools before we stop it.
#
# The loop is driven by model output, so `while True` meant a single question
# could spend LLM quota and Fleet API wake-ups without limit — and hold the
# request open while doing it. Eight covers the deepest legitimate chain this
# app has (read state, look up chargers, set a destination, with room for a
# retry after a failed call) with margin to spare.
MAX_TOOL_ROUNDS = 8


def _holds_tool_calls(turn: dict) -> bool:
    """A model turn that asked for tools. Both provider shapes: Gemini puts
    `function_call` in parts[], Anthropic `tool_use` blocks in content[]."""
    if turn.get("role") not in ("model", "assistant"):
        return False
    for block in _blocks(turn):
        if "function_call" in block or block.get("type") == "tool_use":
            return True
    return False


def _is_plain_user_turn(turn: dict) -> bool:
    """A user turn carrying words rather than tool answers — the only safe
    place to cut history, because everything before it is self-contained."""
    if turn.get("role") != "user":
        return False
    blocks = _blocks(turn)
    if not blocks:
        # Anthropic's plain user turn is `{"role": "user", "content": "text"}`,
        # which has no blocks to inspect and is exactly what we want.
        return isinstance(turn.get("content"), str)
    return not any(
        "function_response" in b or b.get("type") == "tool_result" for b in blocks
    )


def _blocks(turn: dict) -> list[dict]:
    raw = turn.get("parts") if "parts" in turn else turn.get("content")
    return [b for b in raw if isinstance(b, dict)] if isinstance(raw, list) else []


def sanitize_history(history: list[dict] | None) -> list[dict]:
    """Keep client-replayed conversation history to a shape we recognise.

    The mobile client stores the transcript and posts it back on every turn, so
    the array is client-controlled. Anyone holding a session could otherwise
    inject fabricated model turns or tool results — including a forged "the
    user already confirmed this" — and the model would read them as its own
    history. Dropping unknown roles and capping the length removes the easy
    version of that, and the confirmation gate in app.actions is what makes a
    forged claim of consent worthless anyway.

    The cap cannot fall just anywhere. A model turn asking for tools and the
    turn carrying the answers are one indivisible unit to both APIs, and a
    plain slice at a fixed index will eventually land between them — leaving a
    tool call nobody answered at the head of the history, which the provider
    rejects outright. Since the slice only bites once a conversation is long,
    that failure arrives late and looks like the app breaking for no reason.
    So: slice, then walk forward to a turn that starts a self-contained
    stretch, and drop a dangling call off the end.
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

    # Only when the cap actually cut something: an untouched history already
    # begins at the beginning, and trimming it further would throw away
    # context for nothing.
    if len(history) > MAX_HISTORY_TURNS:
        start = next(
            (i for i, turn in enumerate(clean) if _is_plain_user_turn(turn)), len(clean)
        )
        clean = clean[start:]

    # A trailing request for tools with no answer after it is the same problem
    # from the other end, and arises on its own when a turn is cut short.
    while clean and _holds_tool_calls(clean[-1]):
        clean.pop()
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

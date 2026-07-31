"""Shared system prompt for whichever LLM provider is active."""
from __future__ import annotations

from typing import Any

from app.llm.persona import resolve as resolve_persona


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
    "source as if it applied to another. "
    # Written after a drive that ended at the wrong company's charger. Asked to
    # route to the nearest Orlen — a petrol station — the assistant searched for
    # chargers near "Orlen", found no Tesla site, and sent the car to a GreenWay
    # charger instead. Every step followed from one assumption: that a car
    # errand is a charging errand. It is the same pull that made the transcriber
    # rewrite "Orlenu" as "Superchargera" (see app/voice.py), one layer up —
    # this time deciding not what was heard but what to do about it.
    "The car is electric; not every errand is about charging. When the driver "
    "names a business, a brand, or a kind of place — a petrol station, a shop, "
    "a restaurant, a hotel, a car wash — that is somewhere to find with "
    "find_places, even when the same chain also sells electricity. Use "
    "find_chargers only when the request is about charging this car: a "
    "charger, a Supercharger, plugging in, topping the battery up, or a range "
    "problem you have just established. Never pass a business or a category "
    "you were asked to find as the `place` to search around — that argument is "
    "a town, address or landmark, and putting a brand there turns 'take me to "
    "X' into 'find chargers somewhere near an X'. "
    # The half that turned a bad guess into a journey. A wrong tool costs one
    # question; a wrong tool whose emptiness gets filled in costs a detour.
    "When a word could mean either — Polish 'stacja' is a petrol station and a "
    "charging station both, and 'tankować' is said of both — ask which, in one "
    "short line, rather than assuming the one this assistant is usually about. "
    "And never answer with something other than what was asked for. If nothing "
    "matching is nearby, say so: none of that chain in range, nothing of that "
    "kind found. A different brand, a different operator or a different kind "
    "of place is not that result. Offering one as an alternative is fine; "
    "navigating to it as though it were what was asked for is not. "
    # A search engine answers a name it does not know with the nearest thing it
    # does: asked for a station called Zopharol, find_places returned "Zoplar
    # Corporate Office" and the assistant set course for it without remark.
    # Comparing two names is something a model can do perfectly well — it just
    # has to be told that this is its job and not the search's.
    "Check the name that came back against the name you were given. When they "
    "are not the same place — a similar-sounding company, an office instead of "
    "a station, a different chain — do not treat it as a find: say what you "
    "were looking for, say what came back instead, and ask before setting it "
    "as the destination."
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


def build_system_prompt(
    language: str | None,
    persona: str | None = None,
    custom_style: str | None = None,
) -> str:
    """Append a default reply-language instruction, driven by the app's
    language setting (see mobile/src/i18n.ts). This only sets the default —
    if the user writes in a different language, the model should follow
    their lead rather than stay locked to the setting.

    The persona goes last, after every rule it must not override, and carries
    only manner: see app/llm/persona.py. Passing none is the default manner,
    which is what every caller that predates personas gets.
    """
    name = _LANGUAGE_NAMES.get(language or "en", "English")
    # Stripped: the built-in notes and the custom wrapper each carry their own
    # leading space for callers that concatenate them directly, and two of them
    # meeting here would put a double space mid-prompt.
    style = resolve_persona(persona, custom_style).strip()
    return (
        f"{BASE_SYSTEM_PROMPT} Reply in {name} by default, unless the user "
        "writes to you in a different language — then reply in that language "
        f"instead.{(' ' + style) if style else ''}"
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

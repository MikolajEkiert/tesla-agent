"""Shared system prompt for whichever LLM provider is active."""

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

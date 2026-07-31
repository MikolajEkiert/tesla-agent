"""Deciding whether a spoken word was a confirmation.

Deliberately a pure function over a string, in its own module, with no imports
beyond `re`. That is the load-bearing property of the whole voice-confirmation
feature: the decision is made by code that cannot be talked into anything.

The model is not consulted and never sees the word. There is no `confirm`
tool, and there must never be one — the moment a model can decide that consent
happened, injected text in a tool result can decide it too, and the gate in
actions.py stops meaning anything.

Two rules do the rest of the work:

The phrase must be the *whole* utterance. "Potwierdzam" confirms; "potwierdzam
że nie" does not, and neither does a sentence that merely contains the word.
This matters because of a measured failure, not a hypothetical one: the
transcriber invents fluent commands out of engine noise, and the ones it
invented were whole sentences. A single bare word is a far smaller target.

Both languages are always accepted. The app's language setting says what to
reply in, not what the driver will say — the owner speaks Polish to an
interface that may well be set to English, and refusing the word he actually
said would be an odd way to make him tap instead.
"""
from __future__ import annotations

import re

# Long enough for the words below with punctuation, short enough that a
# fabricated sentence cannot be trimmed into a match.
MAX_UTTERANCE_CHARS = 32

# Taken from the button labels the card already shows (see i18n.ts), so the
# word you say is the word you can see. Nobody has to learn a magic phrase.
_CONFIRM = r"(potwierdzam|confirm|confirmed)"
_CANCEL = r"(anuluj|anuluje|anuluję|cancel|nie|no)"

# Leading/trailing punctuation and whitespace only. The model likes to add a
# full stop or wrap a one-word answer in quotes even when told not to, and
# `[Muzyka]`-style stage directions turn up in speechless audio.
_PADDING = r"[\s\W_]*"


def _matches(text: str, word: str) -> bool:
    return re.fullmatch(f"{_PADDING}{word}{_PADDING}", text, re.IGNORECASE | re.UNICODE) is not None


def classify(transcript: str) -> str:
    """'confirm', 'cancel' or 'other'.

    'other' is the safe answer and every uncertain case returns it: too long,
    empty, a sentence, a word with anything else attached.
    """
    text = (transcript or "").strip()
    if not text or len(text) > MAX_UTTERANCE_CHARS:
        return "other"
    # Cancel is checked first so that a phrase somehow matching both is read as
    # the refusal. Erring towards not acting is the whole point here.
    if _matches(text, _CANCEL):
        return "cancel"
    if _matches(text, _CONFIRM):
        return "confirm"
    return "other"

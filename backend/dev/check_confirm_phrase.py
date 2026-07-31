#!/usr/bin/env python3
"""Would anything other than a deliberate word open the trunk?

This is the one piece of the voice-confirmation path where a mistake executes
a command, so its adversarial list is committed rather than reasoned about
once. Two of the cases below are not invented: they are the exact sentences
the transcriber produced from pure engine noise while being told not to guess.

Run from backend/:  ./.venv/bin/python dev/check_confirm_phrase.py
"""
from __future__ import annotations

import sys

sys.path.insert(0, ".")

from app.confirm_phrase import classify  # noqa: E402  (path set above)

CASES: list[tuple[str, str, str]] = [
    # (transcript, expected, why it is in the list)
    ("potwierdzam", "confirm", "the word itself"),
    ("Potwierdzam.", "confirm", "the model adds a full stop unasked"),
    ("  POTWIERDZAM  ", "confirm", "case and padding"),
    ('"potwierdzam"', "confirm", "the model quotes one-word answers"),
    ("confirm", "confirm", "English, whatever the app language is set to"),
    ("anuluj", "cancel", "refusal"),
    ("Nie.", "cancel", "the short refusal is a refusal, not 'other'"),
    ("cancel", "cancel", "English refusal"),
    # The dangerous half — everything here must be 'other'.
    ("nie potwierdzam", "other", "contains the word and means the opposite"),
    ("potwierdzam że nie", "other", "contains the word inside a sentence"),
    ("chyba potwierdzam", "other", "hedged"),
    ("Włącz podgrzewanie prawego fotela.", "other", "MEASURED hallucination from noise"),
    ("Zmień temperaturę na 21 stopni.", "other", "MEASURED hallucination from noise"),
    ("[Muzyka]", "other", "what speechless audio comes back as"),
    ("[Muzyka] potwierdzam", "other", "stage direction plus the word"),
    ("", "other", "empty"),
    ("   ", "other", "whitespace only"),
    ("[NO_SPEECH]", "other", "our own sentinel must not confirm anything"),
    ("otwórz bagażnik", "other", "a command is not a confirmation"),
    ("tak", "other", "deliberately NOT a confirmation — too common in speech"),
    ("p" * 40, "other", "over the length cap"),
    ("potwierdzam potwierdzam", "other", "repeated is not the whole word once"),
]

failures = 0
for transcript, expected, why in CASES:
    got = classify(transcript)
    ok = got == expected
    if not ok:
        failures += 1
    shown = repr(transcript if len(transcript) <= 34 else transcript[:31] + "...")
    print(f"  {'ok  ' if ok else 'FAIL'}  {shown:38} -> {got:8} ({why})")

print()
if failures:
    print(f"NIEPOWODZENIA: {failures}")
    raise SystemExit(1)
print(f"wszystkie {len(CASES)} przypadki zgodne")

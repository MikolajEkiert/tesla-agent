#!/usr/bin/env python3
"""Would half a sentence be acted on as if it were the whole one?

The owner's complaint was that an utterance he had to repeat got answered
instead: "nie jest zrozumiala, duzo szumu, jest ucieta". The cut-off half is
what this list is mostly about, because it is the one that costs something — a
truncated command still parses, so nothing downstream notices, and climate is
ungated by design.

Two lists, both load-bearing. The rejections are the point of the feature; the
acceptances are the point of it staying usable, because "stop" and "otwórz" are
whole commands and a check that ate them would be worse than no check. Several
cases here are measured rather than invented: the hallucinated sentences are
the ones the transcriber produced from engine noise (they appear in
dev/check_confirm_phrase.py for the opposite reason), and they must read as
'ok' here — this function judges whether words arrived whole, not whether they
were true. What stops those is the audio gate and the sentinel, upstream.

Run from backend/:  ./.venv/bin/python dev/check_unclear_speech.py
"""
from __future__ import annotations

import sys

sys.path.insert(0, ".")

from app.voice import clarity  # noqa: E402  (path set above)

CASES: list[tuple[str, str, str]] = [
    # (transcript, expected, why it is in the list)
    # --- nobody spoke -------------------------------------------------------
    ("", "no_speech", "empty"),
    ("   ", "no_speech", "whitespace only"),
    ("[NO_SPEECH]", "no_speech", "our own sentinel"),
    ('"[NO_SPEECH]."', "no_speech", "the model punctuates a sentinel it was told to emit verbatim"),
    ("[Muzyka]", "no_speech", "MEASURED: what speechless audio comes back as"),
    ("[Music]", "no_speech", "the English half of the same artefact"),
    ("(muzyka w tle)", "no_speech", "same thing in round brackets"),
    ("00:00", "no_speech", "MEASURED: a plain tone came back as a timestamp"),
    ("...", "no_speech", "punctuation is not speech"),

    # --- somebody spoke and it did not arrive whole -------------------------
    ("Ustaw temperaturę na", "unclear", "cut before the number — the expensive case"),
    ("Podnieś temperaturę o", "unclear", "the stem of a MEASURED hallucination, cut"),
    ("Ustaw limit ładowania na", "unclear", "cut before a charge limit"),
    ("Włącz klimatyzację i", "unclear", "cut on a conjunction"),
    ("take me to the", "unclear", "English determiner cannot end a sentence"),
    ("Set the charge limit to the", "unclear", "same, mid-command"),
    ("Ustaw temperaturę na 21 stopni…", "unclear", "trailed off rather than stopped"),
    ("otwórz bagaż-", "unclear", "the model writes a dash where the audio was cut"),
    ("Ustaw limit ładowania na yyy", "unclear", "hesitation removed, the cut underneath it shows"),
    ("yyy", "unclear", "hesitation is a sound, not a request"),
    ("eee yyy", "unclear", "and neither are two of them"),
    ("a.", "unclear", "one letter is what a transcriber writes when it had to write something"),
    ("[Muzyka] i", "unclear", "a stage direction and a dangling word is not a request"),
    ("włącz wszcz", "unclear", "a fragment with no vowel in it is a word in neither language"),

    # --- short, and perfectly fine ------------------------------------------
    ("stop", "ok", "a whole command in four letters"),
    ("otwórz", "ok", "and in one Polish word"),
    ("zimno", "ok", "the driver states a problem; that is a request"),
    ("cieplej", "ok", "comparative, no object needed"),
    ("głośniej", "ok", "same, media"),
    ("lock", "ok", "English, whatever the app language is set to"),
    ("warmer", "ok", "English comparative"),
    ("tak", "ok", "an answer to something the assistant asked"),
    ("nie", "ok", "the refusal is an answer, not a fragment"),
    ("no", "ok", "English 'no' is an answer; Polish 'no' is a filler, and the answer wins"),
    ("ok", "ok", "two letters is a word"),
    ("hej", "ok", "opening a conversation is a use of this assistant"),

    # --- ordinary sentences that must not be mistaken for cut ones ----------
    ("Ustaw temperaturę na 21 stopni.", "ok", "the complete version of the case above"),
    ("Zaplanuj ładowanie na 7:30", "ok", "ends on a number, which ends a command properly"),
    ("Ile mam zasięgu?", "ok", "a question"),
    ("How much range do I have?", "ok", "English question ending on a verb"),
    ("what can you do", "ok", "why 'do' is not on the dangling list — a stock question"),
    ("nie wiem co to", "ok", "why 'to' is not on it either — ordinary Polish"),
    ("turn it on", "ok", "English particle verb; 'on' governs nothing"),
    ("wake it up", "ok", "the same trap from the other end"),
    ("powiedz mi jak", "ok", "'jak' ends a real request, so it stays off the list"),
    ("what's this for", "ok", "English strands prepositions; that is not a cut"),
    ("wyślij SMS", "ok", "an upper-case acronym has no vowels and is not a fragment"),
    ("[Muzyka] ustaw 21 stopni", "ok", "the radio was on; the command still arrived"),

    # --- measured hallucinations: whole sentences, and that is the point ----
    (
        "Włącz podgrzewanie prawego fotela.",
        "ok",
        "MEASURED hallucination from noise — arrived whole, so this check is not what stops it",
    ),
    (
        "Zmień temperaturę na 21 stopni.",
        "ok",
        "MEASURED hallucination from noise — same; the audio gate and sentinel are upstream",
    ),

    # --- known gaps, recorded on purpose ------------------------------------
    (
        "zawieź mnie do",
        "ok",
        "DELIBERATE MISS: 'do' also ends 'what can you do'; llm/prompt.py asks where instead",
    ),
    (
        "otwórz bagaż",
        "ok",
        "DELIBERATE MISS: the tail of 'bagażnik' is itself a word — no string can tell",
    ),
]

failures = 0
for transcript, expected, why in CASES:
    got = clarity(transcript)
    ok = got == expected
    if not ok:
        failures += 1
    shown = repr(transcript if len(transcript) <= 34 else transcript[:31] + "...")
    print(f"  {'ok  ' if ok else 'FAIL'}  {shown:38} -> {got:9} ({why})")

print()
if failures:
    print(f"NIEPOWODZENIA: {failures}")
    raise SystemExit(1)
print(f"wszystkie {len(CASES)} przypadki zgodne")

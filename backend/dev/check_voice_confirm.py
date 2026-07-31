#!/usr/bin/env python3
"""Can a spoken word settle something it shouldn't?

Every refusal rule in the voice-confirmation path, exercised without touching
the network. The transcriber is stubbed on purpose: what needs proving here is
the decision logic, and a probe that depends on a daily API quota is a probe
that stops running exactly when someone is in a hurry. The transcription itself
shares its audio gate and its sentinel with the chat path, which has its own
checks; the word-matching has dev/check_confirm_phrase.py.

Run from backend/:  TESLA_ADAPTER=mock ./.venv/bin/python dev/check_voice_confirm.py
"""
from __future__ import annotations

import asyncio
import sys

sys.path.insert(0, ".")

from app import actions, confirm_phrase, tools, voice  # noqa: E402
from app.tesla.adapter import build_adapter  # noqa: E402

adapter = build_adapter()
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'}  {name}{'' if condition else f'  <- {detail}'}")
    if not condition:
        failures.append(name)


async def propose(tool: str, args: dict) -> str:
    return (await tools.dispatch(adapter, tool, args))["confirm_token"]


async def settle(token: str, heard: str) -> str:
    """The endpoint's decision sequence, with the transcript supplied rather
    than transcribed. Mirrors main.confirm_action_by_voice deliberately: if
    that order ever changes, this stops reflecting it and should be updated
    together."""
    try:
        actions.voice_eligible(token)
    except actions.VoiceConfirmRefused as e:
        return f"refused: {e}"
    if not heard:
        return "no_speech"
    verdict = confirm_phrase.classify(heard)
    if verdict == "cancel":
        actions.discard(token)
        return "cancelled"
    if verdict != "confirm":
        actions.burn_voice_attempt(token)
        return "no_match"
    await actions.confirm(adapter, token)
    return "executed"


async def main() -> None:
    print("Co ma zadziałać")
    check("bagażnik + 'potwierdzam'",
          await settle(await propose("actuate_trunk", {"which": "rear"}), "potwierdzam") == "executed")
    check("szyby + 'potwierdzam'",
          await settle(await propose("control_windows", {"command": "vent"}), "potwierdzam") == "executed")

    print("Czego głos nie może ruszyć")
    token = await propose("unlock", {})
    result = await settle(token, "potwierdzam")
    check("unlock odmawia mimo poprawnego słowa", result.startswith("refused"), result)
    check("...i zostaje do potwierdzenia dotknięciem", actions.peek_exists(token))

    print("Cisza i szum")
    token = await propose("actuate_trunk", {"which": "front"})
    check("puste nagranie -> no_speech", await settle(token, "") == "no_speech")
    check("...nie zużywa jedynej próby", await settle(token, "potwierdzam") == "executed",
          "hałaśliwa kabina nie może zablokować właścicielowi jego własnej karty")

    print("Usłyszane, ale nie to słowo")
    token = await propose("actuate_trunk", {"which": "rear"})
    check("zdanie zamiast słowa -> no_match", await settle(token, "otwórz bagażnik") == "no_match")
    second = await settle(token, "potwierdzam")
    check("...i próba jest zużyta", second.startswith("refused"), second)

    print("Zmierzone halucynacje z szumu")
    for hallucination in ("Włącz podgrzewanie prawego fotela.", "Zmień temperaturę na 21 stopni."):
        token = await propose("actuate_trunk", {"which": "rear"})
        check(f"{hallucination[:28]}... nie potwierdza",
              await settle(token, hallucination) == "no_match")
        actions.discard(token)

    print("Anulowanie")
    token = await propose("actuate_trunk", {"which": "rear"})
    check("'anuluj' anuluje", await settle(token, "anuluj") == "cancelled")
    check("...i token przestaje istnieć", not actions.peek_exists(token))

    print("Okno czasowe")
    token = await propose("actuate_trunk", {"which": "rear"})
    actions._pending[token]["created_at"] -= actions.VOICE_WINDOW_S + 5
    result = await settle(token, "potwierdzam")
    check("po oknie głos odmawia", result.startswith("refused"), result)
    check("...ale dotknięcie dalej działa (TTL jest dłuższy)", actions.peek_exists(token))
    actions.discard(token)

    print("Niejednoznaczność")
    first = await propose("actuate_trunk", {"which": "rear"})
    second_token = await propose("control_windows", {"command": "close"})
    result = await settle(first, "potwierdzam")
    check("dwie karty naraz -> głos odmawia", result.startswith("refused"), result)
    actions.discard(first)
    actions.discard(second_token)

    print("Sanity: transcribe_confirmation nie zna słownika samochodowego")
    check("prompt potwierdzenia nie zawiera domeny",
          "klimatyzacja" not in voice._CONFIRM_PROMPT and "Supercharger" not in voice._CONFIRM_PROMPT,
          "to właśnie słownik domenowy napędzał zmierzone halucynacje")

    print()
    if failures:
        print(f"NIEPOWODZENIA: {len(failures)} — {', '.join(failures)}")
        raise SystemExit(1)
    print("wszystko zgodne")


asyncio.run(main())

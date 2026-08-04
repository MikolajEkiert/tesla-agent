#!/usr/bin/env python3
"""Does the voice the owner picked survive being kept for them?

It moved off one browser's storage and into the same mounted directory as the
Tesla token, so that the phone and the laptop answer in the same voice. The
ways that goes wrong are all quiet ones: a name stored that the synthesiser
would refuse and silently replace, a voice that no longer exists reported as
the selection while something else is speaking, or an unset choice reported as
the default — which would stop a device from ever handing over the voice it
picked before this existed.

Also checks the two halves of the voice list against each other, since the
picker, the synthesiser and the live session all read the one set.

Runs against a throwaway database, so it neither reads nor touches the real
one. No network and no model.

Run from backend/:  ./.venv/bin/python dev/check_prefs_store.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, ".")
os.environ.setdefault("TESLA_ADAPTER", "mock")

from app import prefs_store as store  # noqa: E402
from app import tts  # noqa: E402

store.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="amp-prefs-"), "prefs.db")

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {name}{'' if ok else f'  — {detail}'}")
    if not ok:
        failures.append(name)


async def main() -> None:
    check("nobody has chosen yet", await store.get_voice() is None)

    check("a voice is stored as given", await store.set_voice("Sulafat") == "Sulafat")
    check("and comes back", await store.get_voice() == "Sulafat")

    check("choosing again replaces", await store.set_voice("Iapetus") == "Iapetus")
    check("with one row, not two", await store.get_voice() == "Iapetus")

    # The phone's own synthesiser is a legitimate choice — it is the offline
    # one — even though this server cannot speak with it.
    check("the phone's own voice is allowed", await store.set_voice("device") == "device")
    check("and is not turned into a real voice", await store.get_voice() == "device")

    for bad, why in (
        ("Gandalf", "a voice nobody offers"),
        ("", "nothing at all"),
        ("   ", "whitespace"),
        ("../../etc/passwd", "a path"),
    ):
        try:
            await store.set_voice(bad)
            check(f"{why} is refused", False, "it was stored")
        except store.PrefRejected:
            check(f"{why} is refused", True)

    check("a refused value leaves the old one alone", await store.get_voice() == "device")

    # A voice withdrawn by Google, or dropped from the list here, must read as
    # "unset" rather than be handed to the picker: otherwise the screen would
    # highlight nothing while the assistant spoke in the fallback.
    await store._set(store.VOICE_KEY, "Retired")
    check("a voice no longer offered reads as unset", await store.get_voice() is None)

    # The one list, seen from the three places that read it.
    check("the default is a voice that exists", tts.DEFAULT_VOICE in tts.VOICES)
    check("the store takes the default", await store.set_voice(tts.DEFAULT_VOICE))
    check(
        "every offered voice is one the synthesiser accepts",
        all(tts.resolve_voice(v) == v for v in tts.VOICES),
    )
    check(
        "and the phone's own is not one of them",
        store.DEVICE_VOICE not in tts.VOICES
        and tts.resolve_voice(store.DEVICE_VOICE) == tts.DEFAULT_VOICE,
    )


asyncio.run(main())

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all good")

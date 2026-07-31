#!/usr/bin/env python3
"""Do the owner's own manners survive being kept for them?

They moved off the phone and into the same mounted directory as the Tesla
token and the passkeys, so that they are one list rather than one per browser.
That move brings a handful of ways to lose somebody's writing, and each of them
is quiet: an id that collides with a built-in and is stored but never used, an
edit that inserts a second copy instead of overwriting, a phone's own ids
discarded on the way up so that whatever was selected points at nothing.

Runs against a throwaway database, so it neither reads nor touches the real
one. No network and no model.

Run from backend/:  ./.venv/bin/python dev/check_persona_store.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, ".")
os.environ.setdefault("TESLA_ADAPTER", "mock")

from app import persona_store as store  # noqa: E402
from app.llm.persona import MAX_CUSTOM_CHARS  # noqa: E402

store.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="amp-personas-"), "personas.db")

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {name}{'' if ok else f'  — {detail}'}")
    if not ok:
        failures.append(name)


async def main() -> None:
    check("starts empty", await store.list_personas() == [])

    saved = await store.save_persona("Inżynier", "Krótkie meldunki. Zawsze jedno zdanie.")
    first = saved[0]["id"]
    check("one written is one listed", len(saved) == 1 and saved[0]["name"] == "Inżynier")
    check("the words come back by id", "meldunki" in await store.style_for(first))

    # The two ids that must never reach the database, for opposite reasons.
    check("a built-in id resolves without a lookup", await store.style_for("vulgar") == "")
    check("an id nobody has is the standard manner", await store.style_for("p-nope") == "")
    check("and so is no id at all", await store.style_for(None) == "")

    edited = await store.save_persona("Inżynier v2", "Jeszcze krócej.", first)
    check(
        "an edit overwrites rather than adds",
        len(edited) == 1 and edited[0]["name"] == "Inżynier v2",
        f"list is {edited}",
    )

    # What a phone's own manners look like arriving for the first time. The id
    # has to survive: it is what the selected-manner setting points at.
    carried = await store.save_persona("Z telefonu", "Styl z migracji.", "p-local-123")
    check(
        "an id from a phone is kept, not reissued",
        any(p["id"] == "p-local-123" for p in carried),
        f"list is {carried}",
    )

    for bad, why in (("", "empty"), ("   ", "whitespace"), ("\n\t", "control characters only")):
        try:
            await store.save_persona("x", bad)
            check(f"a {why} manner is refused", False, "it was stored")
        except store.PersonaLimit:
            check(f"a {why} manner is refused", True)

    try:
        await store.save_persona("x", "y", "elegant")
        check("a built-in id cannot be shadowed", False, "it was stored")
    except store.PersonaLimit:
        check("a built-in id cannot be shadowed", True)

    check(
        "a long note is cut where the prompt would cut it",
        len((await store.save_persona("Długi", "a" * (MAX_CUSTOM_CHARS * 3)))[-1]["style"])
        == MAX_CUSTOM_CHARS,
    )
    check(
        "a nameless manner borrows its own first words",
        (await store.save_persona("   ", "Mów wierszem i tylko wierszem."))[-1]["name"].startswith("Mów"),
    )

    while len(await store.list_personas()) < store.MAX_PERSONAS:
        await store.save_persona(f"n{len(await store.list_personas())}", "cokolwiek")
    try:
        await store.save_persona("jeden za dużo", "cokolwiek")
        check("the count is capped", False, "one too many was stored")
    except store.PersonaLimit:
        check("the count is capped", True)
    check(
        "and an edit still works at the cap",
        len(await store.save_persona("Inżynier v3", "Krótko.", first)) == store.MAX_PERSONAS,
    )

    before = len(await store.list_personas())
    check("deleting removes one", len(await store.delete_persona(first)) == before - 1)
    check("deleting it again is not an error", isinstance(await store.delete_persona(first), list))
    check("its words are gone with it", await store.style_for(first) == "")

    # Ordering is what keeps the picker still: a grid whose chips move when one
    # is renamed has to be re-read every time.
    ids = [p["id"] for p in await store.list_personas()]
    check("the list keeps its order across a rewrite", [p["id"] for p in await store.save_persona("n0 again", "cokolwiek", ids[0])] == ids)


asyncio.run(main())

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all good")

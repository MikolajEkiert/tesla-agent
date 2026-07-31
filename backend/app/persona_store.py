"""The manners the owner wrote, kept where the car is rather than on a phone.

They used to live in the phone's own storage, and the reasoning was that this
server holds no per-owner state. It holds plenty — Tesla's refresh token, the
enrolled passkeys, the scheduled jobs — and all of it lives in the same mounted
directory precisely so a redeploy does not throw it away. A manner is the same
kind of thing: something the owner wrote once and expects to still be there,
including from the laptop, and including after a browser clears its storage
because it felt like it.

Which "account" this belongs to is a question with one answer. There is one
owner here (see USER_ID in app/auth/passkey.py — a passkey identifies a device,
not a person), so the table has no owner column: everything behind the gate is
theirs, and anything not behind the gate never reaches this module.

The security shape improves on the way. While manners were on the phone, the
style text travelled with every single chat request, which meant an endpoint
that accepted arbitrary prompt text from whoever held a session. Now the
request names an id and the text is looked up here, so the only way to put
words into a system prompt is to have written them through the gated route
below.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any

import aiosqlite

from app.llm.persona import MAX_CUSTOM_CHARS, PERSONAS, sanitize_custom

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "personas.db")

# A chip in a grid, not a title. Mirrors MAX_NAME_CHARS in mobile/src/persona.ts
# and, unlike that one, is the copy that decides.
MAX_NAME_CHARS = 24

# High enough never to be met by someone writing manners for their own car, low
# enough that the picker stays a grid you can read at a glance in a moving one.
MAX_PERSONAS = 12


class PersonaLimit(RuntimeError):
    """The owner asked for something the store will not hold."""


async def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS personas (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                style TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        await db.commit()
    # Nothing here is a credential, but it is the owner's own writing and it is
    # read straight into a system prompt. Same posture as every other file in
    # this directory.
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


async def list_personas() -> list[dict[str, Any]]:
    """Oldest first, so the picker does not reshuffle itself when one is
    edited — a grid whose chips move when you rename one is a grid you have to
    re-read every time."""
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, style FROM personas ORDER BY created_at, id"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def style_for(persona_id: str | None) -> str:
    """The words behind an id, or "" for anything this store has never heard
    of — a built-in, a manner deleted on another device, or nothing at all.
    Empty is the right answer to all three: it lands on the standard manner,
    which is never wrong, just plain."""
    if not persona_id or persona_id in PERSONAS:
        return ""
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT style FROM personas WHERE id = ?", (persona_id,)) as cur:
            row = await cur.fetchone()
    return row[0] if row else ""


async def save_persona(
    name: str, style: str, persona_id: str | None = None
) -> list[dict[str, Any]]:
    """Write one and hand back the list as it now stands.

    `persona_id` names an existing manner to overwrite. It also carries the ids
    that came off a phone the first time this ran, so a manner that was already
    selected stays selected instead of becoming a stranger the moment its
    words moved to the server.

    Both fields are cut to what the prompt builder would cut them to anyway, so
    what comes back from here is exactly what a request will use — no surprise
    between what the editor shows and what the assistant reads.
    """
    clean_style = sanitize_custom(style)
    if not clean_style:
        raise PersonaLimit("A manner needs something to say.")
    clean_name = " ".join((name or "").split())[:MAX_NAME_CHARS] or clean_style[:MAX_NAME_CHARS]
    # A built-in id would shadow a built-in manner: resolve() checks PERSONAS
    # first, so the row would be stored, listed, and never once used.
    if persona_id in PERSONAS:
        raise PersonaLimit("That name belongs to a built-in manner.")

    await init_db()
    now = time.time()
    async with aiosqlite.connect(DB_PATH) as db:
        if persona_id:
            cur = await db.execute(
                "UPDATE personas SET name = ?, style = ?, updated_at = ? WHERE id = ?",
                (clean_name, clean_style, now, persona_id),
            )
            if cur.rowcount == 0:
                # An id the store does not have is a create, not an error: it
                # is what the phone's own manners look like arriving here for
                # the first time, and keeping their ids is the whole point.
                await _insert(db, persona_id, clean_name, clean_style, now)
        else:
            await _insert(db, f"p-{uuid.uuid4().hex[:10]}", clean_name, clean_style, now)
        await db.commit()
    return await list_personas()


async def _insert(db: aiosqlite.Connection, persona_id: str, name: str, style: str, now: float) -> None:
    async with db.execute("SELECT COUNT(*) FROM personas") as cur:
        (count,) = await cur.fetchone()
    if count >= MAX_PERSONAS:
        raise PersonaLimit(f"That is as many manners as Amp keeps ({MAX_PERSONAS}).")
    await db.execute(
        "INSERT INTO personas (id, name, style, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (persona_id, name, style, now, now),
    )


async def delete_persona(persona_id: str) -> list[dict[str, Any]]:
    """Deleting one that is already gone is the outcome the caller wanted, so
    it is not an error — and the list comes back either way, which is what the
    screen needs."""
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
        await db.commit()
    return await list_personas()


__all__ = [
    "MAX_CUSTOM_CHARS",
    "MAX_NAME_CHARS",
    "MAX_PERSONAS",
    "PersonaLimit",
    "delete_persona",
    "list_personas",
    "save_persona",
    "style_for",
]

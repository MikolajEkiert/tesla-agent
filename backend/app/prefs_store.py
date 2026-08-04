"""The settings the owner picked, kept where the car is rather than on a phone.

The same argument as app/persona_store.py, one setting later. A voice was a
value in one browser's storage, which meant the laptop answered in a different
voice than the phone, a cleared store silently reset it, and the picker on a
fresh install showed the default while the assistant was already speaking
something else.

Which "account" this belongs to is a question with one answer here: there is
one owner (see USER_ID in app/auth/passkey.py — a passkey identifies a device,
not a person), so the table has no owner column. Everything behind the gate is
theirs, and nothing not behind the gate reaches this module.

A key/value table rather than a column per setting, because the settings screen
holds a dozen of these and they will not all arrive at once; a new one is a new
key, not a migration. Only the voice is read and written through here so far,
and each setting gets its own pair of accessors — the validation belongs next
to the setting, not in a generic setter that would happily store "purple" as a
voice.
"""
from __future__ import annotations

import os
import time

import aiosqlite

from app.tts import DEFAULT_VOICE, VOICES

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "prefs.db")

VOICE_KEY = "voice"

# Not a voice this server can synthesise — it names the synthesiser built into
# the phone, which is the offline one and a legitimate thing to prefer (see
# mobile/src/voice/speak.ts). It is stored and handed back untouched; the one
# place it must never reach is the URL of a paid API, and it cannot, because
# tts.resolve_voice does not know it and falls back.
DEVICE_VOICE = "device"


class PrefRejected(ValueError):
    """A value this store will not hold, named so the caller can say why."""


async def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS prefs (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        await db.commit()
    # Nothing here is a credential, but it is the owner's own settings and it
    # sits beside the Tesla token. Same posture as every other file here.
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


async def _get(key: str) -> str | None:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM prefs WHERE key = ?", (key,)) as cur:
            row = await cur.fetchone()
    return row[0] if row else None


async def _set(key: str, value: str) -> None:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                           updated_at = excluded.updated_at
            """,
            (key, value, time.time()),
        )
        await db.commit()


async def get_voice() -> str | None:
    """Which voice was chosen, or None if nobody has ever chosen one.

    None rather than the default on purpose: it is what lets a device that
    still holds its own choice from before this existed hand it over exactly
    once, instead of a fresh server's default quietly overwriting it.

    A stored value that is no longer offered — a voice Google withdrew, or one
    dropped from VOICES — reads as unset, so the picker lands on the default
    rather than highlighting nothing while the assistant speaks something else.
    That is the exact failure this file was written after.
    """
    stored = await _get(VOICE_KEY)
    if stored is None:
        return None
    return stored if stored == DEVICE_VOICE or stored in VOICES else None


async def set_voice(name: str) -> str:
    """Remember a voice, and hand back what was actually stored.

    Checked against the same allow-list the synthesiser checks, rather than
    stored and resolved later: a rejected value should be a message in the
    settings screen at the moment of the tap, not a setting that appears to
    have taken and then speaks in a different voice forever.
    """
    clean = (name or "").strip()
    if clean != DEVICE_VOICE and clean not in VOICES:
        raise PrefRejected(f"{clean or 'That'} is not a voice Amp can speak with.")
    await _set(VOICE_KEY, clean)
    return clean


__all__ = [
    "DEFAULT_VOICE",
    "DEVICE_VOICE",
    "PrefRejected",
    "get_voice",
    "set_voice",
]

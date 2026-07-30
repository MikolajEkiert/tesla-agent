"""Passkey (WebAuthn) login — Face ID instead of a typed passcode.

Why this exists alongside gate.py's passcode: a shared secret is the weakest
part of the setup. It can be shoulder-surfed, phished, reused, or read from a
backup. A passkey has no shared secret at all — the private key never leaves
the phone's Secure Enclave, the server only ever stores a public key, and
there is nothing on the server worth stealing.

The passcode stays as the recovery path. A passkey alone would mean a lost
phone locks the owner out of their own car permanently.

Credentials live in the same volume-mounted SQLite directory as the Tesla
tokens, so they survive redeploys (see deploy/docker-compose.yml).
"""
from __future__ import annotations

import os
import time
from typing import Any

import aiosqlite
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "passkeys.db")

# Challenges are single-use and short-lived; kept in memory because a replay
# window measured in minutes has no business outliving the process.
#
# Keyed by the challenge itself rather than by a constant "register"/"auth"
# slot. With one global slot per flow, anyone could call login/begin (it is
# necessarily public) and overwrite the challenge of a login already in
# progress, so the owner's own attempt failed — a denial of service anybody
# could trigger. The browser echoes the challenge back inside clientDataJSON,
# so it identifies the attempt without needing a session that does not exist
# yet.
CHALLENGE_TTL_S = 300
MAX_OUTSTANDING = 32
_challenges: dict[bytes, tuple[str, float]] = {}

# One owner, one identity — the passkey identifies the device, not a person.
USER_ID = b"amp-owner"
USER_NAME = "amp"


def relying_party() -> tuple[str, str]:
    """(rp_id, origin). Must match the browser's address exactly: WebAuthn
    binds credentials to the origin, which is precisely what makes it
    phishing-proof — and equally what makes a mismatch fail hard."""
    origin = os.getenv("AMP_ORIGIN", "https://tesla-amp.duckdns.org").rstrip("/")
    rp_id = origin.split("://", 1)[-1].split("/")[0].split(":")[0]
    return rp_id, origin


async def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS passkeys (
                credential_id TEXT PRIMARY KEY,
                public_key BLOB NOT NULL,
                sign_count INTEGER NOT NULL DEFAULT 0,
                label TEXT,
                created_at REAL NOT NULL,
                last_used_at REAL
            )
            """
        )
        await db.commit()
    # Public keys only, so far less sensitive than the token store — but the
    # credential list still tells an attacker which devices are enrolled.
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass


async def list_passkeys() -> list[dict[str, Any]]:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT credential_id, label, created_at, last_used_at FROM passkeys ORDER BY created_at"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def has_passkeys() -> bool:
    return bool(await list_passkeys())


async def delete_passkey(credential_id: str) -> bool:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("DELETE FROM passkeys WHERE credential_id = ?", (credential_id,))
        await db.commit()
        return cur.rowcount > 0


def _remember_challenge(flow: str, challenge: bytes) -> None:
    now = time.time()
    for k, (_, issued) in list(_challenges.items()):
        if now - issued > CHALLENGE_TTL_S:
            del _challenges[k]
    # Bounded so an unauthenticated caller cannot grow this dict without limit.
    while len(_challenges) >= MAX_OUTSTANDING:
        oldest = min(_challenges, key=lambda k: _challenges[k][1])
        del _challenges[oldest]
    _challenges[challenge] = (flow, now)


def _take_challenge(flow: str, challenge: bytes) -> bytes | None:
    """Consume the specific challenge the browser echoed back."""
    entry = _challenges.pop(challenge, None)  # single use, popped even on failure
    if not entry:
        return None
    stored_flow, issued = entry
    if stored_flow != flow or time.time() - issued > CHALLENGE_TTL_S:
        return None
    return challenge


def _challenge_from_client_data(credential: dict[str, Any]) -> bytes | None:
    """The challenge as the authenticator saw it. Only used to look up our own
    stored copy — verification against it still happens in the webauthn
    library, so a forged value simply finds nothing."""
    import base64 as _b64mod
    import json as _json

    try:
        raw = (credential.get("response") or {}).get("clientDataJSON")
        data = _json.loads(_b64url_decode(raw).decode())
        return _b64url_decode(data["challenge"])
    except Exception:
        return None


# --- registration (adding a passkey; requires an already-unlocked session) ---

async def registration_options() -> str:
    await init_db()
    rp_id, _ = relying_party()
    existing = [
        PublicKeyCredentialDescriptor(id=_b64url_decode(p["credential_id"]))
        for p in await list_passkeys()
    ]
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name="Amp",
        user_id=USER_ID,
        user_name=USER_NAME,
        user_display_name="Amp",
        # Discoverable so the phone can offer the passkey before any username
        # is typed, and user verification required so Face ID (not mere
        # possession of an unlocked phone) is what authorises car access.
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=existing,
    )
    _remember_challenge("register", options.challenge)
    return options_to_json(options)


async def verify_registration(credential: dict[str, Any], label: str | None = None) -> None:
    echoed = _challenge_from_client_data(credential)
    challenge = _take_challenge("register", echoed) if echoed else None
    if challenge is None:
        raise ValueError("Registration expired — start again.")
    rp_id, origin = relying_party()
    verified = verify_registration_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id,
        expected_origin=origin,
        require_user_verification=True,
    )
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT OR REPLACE INTO passkeys
                (credential_id, public_key, sign_count, label, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                _b64url_encode(verified.credential_id),
                verified.credential_public_key,
                verified.sign_count,
                label or "Passkey",
                time.time(),
            ),
        )
        await db.commit()


# --- authentication (logging in) --------------------------------------------

async def authentication_options() -> str:
    await init_db()
    rp_id, _ = relying_party()
    options = generate_authentication_options(
        rp_id=rp_id,
        allow_credentials=[
            PublicKeyCredentialDescriptor(id=_b64url_decode(p["credential_id"]))
            for p in await list_passkeys()
        ],
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _remember_challenge("auth", options.challenge)
    return options_to_json(options)


async def verify_authentication(credential: dict[str, Any]) -> None:
    """Raises on any failure; returning normally means the caller may issue a
    session."""
    echoed = _challenge_from_client_data(credential)
    challenge = _take_challenge("auth", echoed) if echoed else None
    if challenge is None:
        raise ValueError("Login expired — try again.")

    credential_id = credential.get("id")
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT public_key, sign_count FROM passkeys WHERE credential_id = ?",
            (credential_id,),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        raise ValueError("Unknown passkey")

    rp_id, origin = relying_party()
    verified = verify_authentication_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id,
        expected_origin=origin,
        credential_public_key=row["public_key"],
        credential_current_sign_count=row["sign_count"],
        require_user_verification=True,
    )
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
            (verified.new_sign_count, time.time(), credential_id),
        )
        await db.commit()


# --- helpers ----------------------------------------------------------------

def _b64url_encode(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64url_decode(text: str) -> bytes:
    import base64

    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

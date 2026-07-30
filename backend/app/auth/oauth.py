"""Tesla OAuth (Authorization Code)."""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import time
from typing import Any

import aiosqlite
import httpx

from app.config import get_settings

AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize"
TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token"
SCOPES = "openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds"

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "tesla_tokens.db")

# Pending PKCE flows: state -> (verifier, issued_at). The timestamp matters —
# without it an unused state stayed valid for the process's whole life, and the
# dict grew without bound for anyone able to hit /auth/login (now behind the
# session gate, which is what keeps this from being reachable by strangers).
pending_auths: dict[str, tuple[str, float]] = {}
AUTH_STATE_TTL_S = 600
MAX_PENDING_AUTHS = 8


def _prune_pending_auths() -> None:
    now = time.time()
    for state, (_, issued) in list(pending_auths.items()):
        if now - issued > AUTH_STATE_TTL_S:
            del pending_auths[state]
    while len(pending_auths) > MAX_PENDING_AUTHS:
        oldest = min(pending_auths, key=lambda k: pending_auths[k][1])
        del pending_auths[oldest]


async def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS tokens (
                id INTEGER PRIMARY KEY,
                access_token TEXT NOT NULL,
                refresh_token TEXT NOT NULL,
                expires_at REAL NOT NULL
            )
            """
        )
        await db.commit()
    # This file holds the Tesla refresh token in cleartext. That token drives
    # the car through Tesla's own API, bypassing this app's gate, passcode,
    # passkey and rate limits entirely — so it is strictly more sensitive than
    # the session secret. SQLite creates it with the process umask (measured
    # 0644 on the server), hence the explicit tightening.
    _restrict(DB_PATH)


def _restrict(path: str) -> None:
    """Owner-only, best effort: a failure here must not stop the app starting."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


async def has_tokens() -> bool:
    """Lightweight check for the mobile app's connect-status UI — no network
    call, just whether a row exists."""
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT 1 FROM tokens LIMIT 1") as cursor:
            return await cursor.fetchone() is not None


async def disconnect() -> None:
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM tokens")
        await db.commit()


def get_authorize_url() -> tuple[str, str]:
    """Generates the authorization URL and state/verifier."""
    settings = get_settings()
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode("utf-8")).digest()
    ).rstrip(b"=").decode("utf-8")
    state = secrets.token_urlsafe(32)

    _prune_pending_auths()
    pending_auths[state] = (code_verifier, time.time())

    params = {
        "client_id": settings.tesla_client_id,
        "redirect_uri": settings.tesla_redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{AUTHORIZE_URL}?{query}", state


async def exchange_code(code: str, state: str) -> None:
    _prune_pending_auths()
    entry = pending_auths.pop(state, None)
    if not entry:
        raise ValueError("Invalid or expired state.")
    verifier, issued = entry
    if time.time() - issued > AUTH_STATE_TTL_S:
        raise ValueError("Invalid or expired state.")

    settings = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": settings.tesla_client_id,
                "client_secret": settings.tesla_client_secret,
                "code": code,
                "redirect_uri": settings.tesla_redirect_uri,
                "code_verifier": verifier,
            },
        )
        r.raise_for_status()
        data = r.json()

    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        expires_at = time.time() + data.get("expires_in", 28800)
        await db.execute("DELETE FROM tokens")
        await db.execute(
            "INSERT INTO tokens (access_token, refresh_token, expires_at) VALUES (?, ?, ?)",
            (data["access_token"], data["refresh_token"], expires_at)
        )
        await db.commit()


class TokenStore:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def get_access_token(self) -> str:
        await init_db()
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT access_token, refresh_token, expires_at FROM tokens LIMIT 1") as cursor:
                row = await cursor.fetchone()
        
        if not row:
            raise RuntimeError(
                "Not authenticated with Tesla yet. Complete the OAuth flow "
                "(/auth/login -> /auth/callback), or run with TESLA_ADAPTER=mock."
            )
        
        access_token, refresh_token, expires_at = row
        
        # Refresh if expiring within 5 minutes
        if time.time() > expires_at - 300:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": self.settings.tesla_client_id,
                        "client_secret": self.settings.tesla_client_secret,
                        "refresh_token": refresh_token,
                    },
                )
                r.raise_for_status()
                data = r.json()
            
            access_token = data["access_token"]
            refresh_token = data["refresh_token"]
            new_expires_at = time.time() + data.get("expires_in", 28800)
            
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute("DELETE FROM tokens")
                await db.execute(
                    "INSERT INTO tokens (access_token, refresh_token, expires_at) VALUES (?, ?, ?)",
                    (access_token, refresh_token, new_expires_at)
                )
                await db.commit()
                
        return access_token

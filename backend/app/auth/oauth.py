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

# In-memory store for pending PKCE auth flows (state -> verifier)
pending_auths: dict[str, str] = {}


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


def get_authorize_url() -> tuple[str, str]:
    """Generates the authorization URL and state/verifier."""
    settings = get_settings()
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode("utf-8")).digest()
    ).rstrip(b"=").decode("utf-8")
    state = secrets.token_urlsafe(32)

    pending_auths[state] = code_verifier

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
    verifier = pending_auths.pop(state, None)
    if not verifier:
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

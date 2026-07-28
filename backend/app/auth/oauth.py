"""Tesla OAuth (Authorization Code) — STUB.

Fill this in during the final "real car" phase. Flow for a 2021 Model 3:

  1. Redirect the user to Tesla's authorize URL (with PKCE) so they grant access.
  2. Tesla calls back to TESLA_REDIRECT_URI with a ?code=...
  3. Exchange that code for an access_token + refresh_token at the token endpoint.
  4. Store the refresh_token durably (SQLite/Postgres). Refresh before expiry.

Separately (one-time, not OAuth): register your partner account and enroll a
virtual key in the car so the signing proxy's commands are accepted. See README.

For local development you can leave this as-is and run with TESLA_ADAPTER=mock.
"""
from __future__ import annotations

# Tesla Fleet auth endpoints (region-independent auth host).
AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize"
TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token"

# Scopes: read state + issue commands + charging commands. Keep this minimal.
SCOPES = "openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds"


class TokenStore:
    """Owns access/refresh tokens. Replace the in-memory stub with real storage."""

    def __init__(self) -> None:
        self._access_token: str | None = None
        self._refresh_token: str | None = None

    async def get_access_token(self) -> str:
        if not self._access_token:
            raise RuntimeError(
                "Not authenticated with Tesla yet. Complete the OAuth flow "
                "(/auth/login -> /auth/callback), or run with TESLA_ADAPTER=mock."
            )
        # TODO: check expiry; if expired, refresh via TOKEN_URL using _refresh_token.
        return self._access_token

    def save_tokens(self, access_token: str, refresh_token: str) -> None:
        # TODO: persist to a database so tokens survive restarts.
        self._access_token = access_token
        self._refresh_token = refresh_token

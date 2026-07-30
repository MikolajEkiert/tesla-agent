"""Access control for the app itself — who may talk to this server at all.

Not to be confused with auth/oauth.py, which authenticates *this server to
Tesla*. That flow says nothing about who is holding the phone: before this
module existed, anyone who loaded the URL could unlock the car, open the
frunk and trigger HomeLink. The hostname is not a secret either — Let's
Encrypt publishes it to Certificate Transparency logs.

One shared passcode rather than user accounts: there is one owner and one
car, so accounts would be ceremony without benefit. TOTP is optional and
turns a stolen passcode from "full control of the car" into "not enough".

Crypto is deliberately boring: PBKDF2 from the standard library for the
passcode, an HMAC-signed token for the session. No hand-rolled primitives.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

PBKDF2_ITERATIONS = 600_000  # OWASP guidance for PBKDF2-HMAC-SHA256
SESSION_MAX_AGE_S = 90 * 24 * 3600
COOKIE_NAME = "amp_session"

# Brute force is already slow (a PBKDF2 check costs ~0.3 s), but an explicit
# lockout also stops someone burning the CPU of a single-core free-tier VM.
MAX_ATTEMPTS = 5
LOCKOUT_WINDOW_S = 15 * 60

# A second, deliberately *generous and short* global cap. The per-client
# lockout above is the real brute-force defence; this only protects the
# single-core VM's CPU from a distributed flood of PBKDF2 checks.
#
# It is short on purpose: any global limit is a lever an attacker can pull to
# inconvenience the owner, so the worst they can achieve here is a one-minute
# wait — not the 15-minute lockout that a shared counter used to hand them.
GLOBAL_MAX_ATTEMPTS = 60
GLOBAL_WINDOW_S = 60

_attempts: dict[str, list[float]] = {}
_global_attempts: list[float] = []

# TOTP codes stay valid for a ~90 s window (one step either side of now), so
# without this a code observed once could be replayed for the rest of it.
# Remembering the codes already spent makes them genuinely one-time.
_used_totp: dict[str, float] = {}


class NotConfigured(RuntimeError):
    """No passcode set — the gate cannot be enforced or bypassed silently."""


# --- passcode ---------------------------------------------------------------

def hash_passcode(passcode: str) -> str:
    """Fields joined with ':' rather than the conventional '$'. Docker Compose
    interpolates '$' inside env_file values, which silently truncates any
    secret containing one — that exact bug produced a Caddy hash that rejected
    every password, owner included. ':' cannot occur in hex or a digit string,
    so the format stays unambiguous without needing escapes."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", passcode.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256:{PBKDF2_ITERATIONS}:{salt.hex()}:{digest.hex()}"


def verify_passcode(passcode: str, stored: str) -> bool:
    try:
        algo, iterations, salt_hex, digest_hex = stored.split(":")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", passcode.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
    except Exception:
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


# --- TOTP (optional second factor) ------------------------------------------

def verify_totp(code: str, secret_b32: str, at: float | None = None) -> bool:
    """RFC 6238, SHA-1, 6 digits, 30 s step. Accepts the neighbouring steps so
    a slightly wrong phone clock doesn't lock the owner out.

    The ASCII check is load-bearing, not decoration. `str.isdigit()` is true for
    non-ASCII digits such as '٣', which then reach hmac.compare_digest and make
    it raise TypeError. That exception escaped before the caller could record a
    failed attempt, so the endpoint answered 401 for a wrong passcode and 500
    for a *right* one — a passcode oracle that also consumed no rate-limit
    budget. Rejecting non-ASCII here keeps the failure a plain `False`.
    """
    code = code.strip().replace(" ", "")
    if not code.isascii() or not code.isdigit() or len(code) != 6:
        return False
    try:
        key = base64.b32decode(secret_b32.strip().replace(" ", "").upper(), casefold=True)
    except Exception:
        return False
    now = at if at is not None else time.time()
    for spent, when in list(_used_totp.items()):
        if now - when > 120:
            del _used_totp[spent]
    if code in _used_totp:
        return False  # already spent within its own validity window

    counter = int(now // 30)
    for drift in (-1, 0, 1):
        block = (counter + drift).to_bytes(8, "big")
        digest = hmac.new(key, block, hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
        if hmac.compare_digest(f"{value % 1_000_000:06d}", code):
            _used_totp[code] = now
            return True
    return False


# --- session token ----------------------------------------------------------

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_session(secret: str) -> str:
    payload = json.dumps({"iat": int(time.time())}, separators=(",", ":")).encode()
    body = _b64(payload)
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(signature)}"


def session_is_valid(token: str | None, secret: str) -> bool:
    if not token or "." not in token:
        return False
    body, _, signature = token.partition(".")
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _unb64(signature)):
            return False
        issued_at = json.loads(_unb64(body))["iat"]
    except Exception:
        return False
    # Rotating AMP_SESSION_SECRET invalidates every outstanding session at
    # once — the remote "log out all devices" for a lost phone.
    return 0 <= time.time() - issued_at <= SESSION_MAX_AGE_S


# --- client identity --------------------------------------------------------

def client_key(peer: str | None, forwarded_for: str | None) -> str:
    """The address to count failed attempts against.

    Behind Caddy every request arrives from the proxy container, so the raw
    peer address is one shared value for the entire internet — measured as a
    single 172.18.0.x for every request in production. Keying the lockout on
    it meant any stranger could spend five wrong guesses and lock the owner
    out of their own car, repeatedly.

    Caddy appends the address it saw to X-Forwarded-For, so the rightmost
    entry is the closest hop we actually trust; anything further left is
    client-supplied and forgeable. Falls back to the peer address when the
    header is absent (a direct call inside the compose network).
    """
    if forwarded_for:
        hops = [h.strip() for h in forwarded_for.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return peer or "unknown"


# --- rate limiting ----------------------------------------------------------

def _prune(client: str, now: float) -> list[float]:
    recent = [t for t in _attempts.get(client, []) if now - t < LOCKOUT_WINDOW_S]
    _attempts[client] = recent
    return recent


def _prune_global(now: float) -> list[float]:
    global _global_attempts
    _global_attempts = [t for t in _global_attempts if now - t < GLOBAL_WINDOW_S]
    return _global_attempts


def is_locked_out(client: str) -> bool:
    now = time.time()
    if len(_prune(client, now)) >= MAX_ATTEMPTS:
        return True
    # Distributed flood guard — see GLOBAL_* for why this stays short.
    return len(_prune_global(now)) >= GLOBAL_MAX_ATTEMPTS


def record_failure(client: str) -> None:
    now = time.time()
    _prune(client, now).append(now)
    _prune_global(now).append(now)


def clear_failures(client: str) -> None:
    _attempts.pop(client, None)


# --- configuration ----------------------------------------------------------

def passcode_hash() -> str:
    value = os.getenv("AMP_PASSCODE_HASH", "")
    if not value:
        raise NotConfigured(
            "AMP_PASSCODE_HASH is not set. Run ./backend/set-passcode.sh — the app "
            "refuses to serve unauthenticated rather than silently exposing the car."
        )
    return value


def session_secret() -> str:
    value = os.getenv("AMP_SESSION_SECRET", "")
    if not value:
        raise NotConfigured("AMP_SESSION_SECRET is not set. Run ./backend/set-passcode.sh")
    return value


def totp_secret() -> str | None:
    """None disables the second factor."""
    return os.getenv("AMP_TOTP_SECRET") or None


# --- shortcut token (Siri / Apple Shortcuts) --------------------------------
# A Shortcut cannot do WebAuthn and does not keep a cookie jar between runs, so
# hands-free voice needs a bearer credential. That is a second way in, and it is
# scoped as narrowly as the feature allows:
#
#   * exactly one route accepts it (see TOKEN_ROUTES in main.py) — asking a
#     question. It cannot reach /actions/confirm, so the physically
#     consequential commands still require a tap in the app, on a real session.
#   * absent by default. Without AMP_SHORTCUT_TOKEN nothing changes and no
#     token is accepted at all.
#   * revoked by editing one env var and restarting.

SHORTCUT_TOKEN_MIN_LENGTH = 32

_warned_short_token = False


def shortcut_token() -> str | None:
    """None when the feature is off — including when a token is set but too
    weak to be worth accepting.

    A short token is refused rather than used: this credential is typed once
    into a Shortcut and then never seen again, so there is no reason for it to
    be memorable, and every reason for it to be long. Refusing loudly beats
    quietly guarding the car with eight characters.
    """
    global _warned_short_token
    value = os.getenv("AMP_SHORTCUT_TOKEN", "").strip()
    if not value:
        return None
    if len(value) < SHORTCUT_TOKEN_MIN_LENGTH:
        if not _warned_short_token:
            _warned_short_token = True
            print(
                f"[gate] AMP_SHORTCUT_TOKEN is shorter than "
                f"{SHORTCUT_TOKEN_MIN_LENGTH} characters and is being ignored. "
                f"Generate one with: openssl rand -hex 32",
                flush=True,
            )
        return None
    return value


def shortcut_token_valid(authorization: str | None) -> bool:
    expected = shortcut_token()
    if not expected or not authorization:
        return False
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return False
    presented = presented.strip()
    if not presented:
        return False
    return hmac.compare_digest(presented, expected)


def totp_required() -> bool:
    return totp_secret() is not None


def gate_status() -> dict[str, Any]:
    try:
        passcode_hash()
        configured = True
    except NotConfigured:
        configured = False
    return {"configured": configured, "totp_required": totp_required()}

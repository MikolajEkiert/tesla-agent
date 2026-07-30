#!/bin/bash
# Sets the passcode that guards the app (see app/auth/gate.py), and optionally
# enables a TOTP second factor.
#
# The passcode is typed here and hashed immediately; only the PBKDF2 hash lands
# in backend/.env, which is git-ignored. The plaintext is never stored or
# echoed.
set -euo pipefail

cd "$(dirname "$0")"

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

read -rsp "Kod dostępu (min. 10 znaków): " PASSCODE; echo
read -rsp "Powtórz: " PASSCODE2; echo

if [ "$PASSCODE" != "$PASSCODE2" ]; then
    echo "Kody się różnią — nic nie zmieniono." >&2
    exit 1
fi
if [ ${#PASSCODE} -lt 10 ]; then
    echo "Za krótki: min. 10 znaków. Nic nie zmieniono." >&2
    exit 1
fi

read -rp "Włączyć drugi składnik (TOTP, np. Google Authenticator)? [t/N]: " WANT_TOTP

AMP_PASSCODE="$PASSCODE" WANT_TOTP="$WANT_TOTP" "$PY" - <<'PY'
import base64, os, re, secrets, sys
sys.path.insert(0, ".")
from app.auth.gate import hash_passcode

env_path = ".env"
lines = []
if os.path.exists(env_path):
    with open(env_path) as f:
        lines = f.read().splitlines()

def put(key, value):
    global lines
    lines = [l for l in lines if not l.startswith(f"{key}=")]
    lines.append(f"{key}={value}")

put("AMP_PASSCODE_HASH", hash_passcode(os.environ["AMP_PASSCODE"]))

# Rotating this invalidates every existing session — the "log out all devices"
# lever. Only generated when absent, so setting a new passcode doesn't
# needlessly sign everyone out.
if not any(l.startswith("AMP_SESSION_SECRET=") for l in lines):
    put("AMP_SESSION_SECRET", secrets.token_urlsafe(48))

if os.environ.get("WANT_TOTP", "").lower() in ("t", "tak", "y", "yes"):
    existing = [l for l in lines if l.startswith("AMP_TOTP_SECRET=")]
    if existing:
        print("\nTOTP już skonfigurowany — zostawiam bez zmian.")
    else:
        secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
        put("AMP_TOTP_SECRET", secret)
        uri = f"otpauth://totp/Amp?secret={secret}&issuer=Amp"
        print("\n=== DODAJ TO DO APLIKACJI AUTHENTICATOR (pokazane tylko raz) ===")
        print(f"  klucz : {secret}")
        print(f"  URI   : {uri}")
        print("================================================================")

# umask only governs files this process creates. backend/.env normally already
# exists (copied from .env.example, or written by an earlier run), and open("w")
# truncates without touching the mode — so it kept whatever permissions it had.
# Measured 0644 in practice, with AMP_SESSION_SECRET inside: enough for any
# local reader to forge a session cookie and drive the car without the passcode.
# chmod unconditionally, after writing.
os.umask(0o077)
with open(env_path, "w") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(env_path, 0o600)
print("\nZapisano backend/.env (tylko hash). Teraz uruchom ./deploy.sh")
PY

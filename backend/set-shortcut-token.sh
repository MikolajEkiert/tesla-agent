#!/bin/bash
# Generates the bearer token an Apple Shortcut uses to reach POST /voice/ask
# ("Hey Siri, Amp"). See app/auth/gate.py:shortcut_token.
#
# Unlike the passcode, this one has to be shown: it gets typed into the
# Shortcut once and is never needed again. It is printed a single time here and
# only the .env copy is kept, so if you lose it, generate a new one rather than
# hunting for the old.
#
# What this token can reach is deliberately small — asking questions and
# starting reversible things. It cannot confirm a command that moves the car;
# opening the doors still needs a tap in the app. That matters because "Hey
# Siri" answers from the lock screen to whoever is standing nearest.
set -euo pipefail

cd "$(dirname "$0")"

ENV_PATH=.env
[ -f "$ENV_PATH" ] || { echo "Brak backend/.env — najpierw skopiuj .env.example." >&2; exit 1; }

if grep -q '^AMP_SHORTCUT_TOKEN=.\+' "$ENV_PATH"; then
    echo "Token dla Skrótu już istnieje."
    read -rp "Wygenerować nowy? Stary natychmiast przestanie działać. [t/N]: " REPLACE
    case "$REPLACE" in
        t|T|tak|y|Y|yes) ;;
        *) echo "Nic nie zmieniono."; exit 0 ;;
    esac
fi

TOKEN=$(openssl rand -hex 32)

# Rewrite via a temp file so a failure part-way cannot leave a truncated .env —
# that file also holds the session secret and the Tesla credentials.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
grep -v '^AMP_SHORTCUT_TOKEN=' "$ENV_PATH" > "$TMP" || true
printf 'AMP_SHORTCUT_TOKEN=%s\n' "$TOKEN" >> "$TMP"
cat "$TMP" > "$ENV_PATH"
chmod 600 "$ENV_PATH"

cat <<EOF

=== TOKEN DLA SKRÓTU (pokazany tylko raz) ===

  $TOKEN

Wklej go w Skrócie, w nagłówku:  Authorization: Bearer <token>

Nie wysyłaj go nikomu i nie wklejaj do czatu — kto go ma, ten może
przez Twój serwer wypytać auto i włączyć klimatyzację.

Teraz uruchom ./deploy.sh, żeby serwer zaczął go akceptować.
Cofnięcie: usuń linię AMP_SHORTCUT_TOKEN z backend/.env i zdeployuj ponownie.
=============================================
EOF

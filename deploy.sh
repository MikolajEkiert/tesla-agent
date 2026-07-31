#!/bin/bash

if [ "$#" -ne 2 ]; then
    echo "Usage: ./deploy.sh <IP_ADDRESS> <SSH_KEY_PATH>"
    echo "Example: ./deploy.sh 123.45.67.89 ~/Downloads/ssh-key-2026-07-28.key"
    exit 1
fi

IP=$1
KEY=$2

echo "🚀 Deploying to $IP..."

echo "🔎 Checking every backend route has a Caddy entry..."
# Caddy's catch-all hands unlisted paths to the static frontend, so a missing
# route ships as an nginx 404 that looks like a broken app. Cheap to check,
# twice already shipped without it.
PYBIN=backend/.venv/bin/python
[ -x "$PYBIN" ] || PYBIN=python3
"$PYBIN" deploy/check-routes.py || { echo "Aborting deploy — add the missing handle blocks first."; exit 1; }

echo "🏗️  Building the PWA (deploy/Dockerfile.web ships the pre-built dist/,
     it doesn't build it on the server)..."
# --clear: Metro's bundler cache can serve a stale build across runs with
# different EXPO_PUBLIC_API_URL values (or none) — without this, a bundle
# built earlier for local testing with a different API URL can silently get
# reused here instead of a fresh same-origin production build.
( cd mobile && npx expo export -p web --clear ) || { echo "PWA build failed — aborting deploy."; exit 1; }

echo "📦 Copying files to server..."
rsync -avz -e "ssh -i \"$KEY\" -o StrictHostKeyChecking=accept-new" \
    --exclude 'mobile/node_modules' \
    --exclude '.git' \
    --exclude 'mobile/.expo' \
    --exclude 'backend/.venv' \
    --exclude '__pycache__' \
    --exclude 'backend/data' \
    ./ "ubuntu@$IP:~/tesla-agent/"

echo "🐳 Installing Docker on server and starting the app (this might take a minute)..."
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$IP" << 'EOF'
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker ubuntu
fi

# The api container runs as uid 10001 (see backend/Dockerfile) and this bind
# mount holds the Tesla token, passkey and scheduler databases. Ownership has
# to match, or the container cannot write them and the symptom is a silent
# forced re-login rather than a visible failure.
mkdir -p ~/tesla-agent/backend/data
sudo chown -R 10001:10001 ~/tesla-agent/backend/data
sudo chmod 700 ~/tesla-agent/backend/data

cd ~/tesla-agent/deploy

# A Caddyfile that does not parse takes the whole site down, and it does it at
# the worst moment: the recreate below has already stopped the container that
# was serving perfectly well, so the failure arrives as "site unreachable"
# rather than as an error about a config file. Checking first costs one
# container start against an image that is already local.
if ! sudo docker run --rm -v ~/tesla-agent/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
        caddy:2 caddy validate --config /etc/caddy/Caddyfile; then
    echo "❌ Caddyfile is invalid — leaving the running proxy untouched."
    exit 1
fi

sudo docker compose up -d --build
# Caddyfile is bind-mounted (no `build:` step for caddy), so `up -d --build`
# never recreates that container on its own — and a plain `caddy reload`
# from inside it isn't enough either: rsync replaces the file via an atomic
# rename, which swaps in a new inode at the same path, but a long-running
# container's bind mount keeps referencing the OLD inode. Caddy ends up
# reloading a config that never actually changed from its point of view.
# Only a real container recreate re-resolves the mount against the current
# file.
sudo docker compose up -d --force-recreate caddy
EOF

echo "✅ Deployment complete! Your app is now running on the server."

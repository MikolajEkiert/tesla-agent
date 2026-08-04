# Deployment and operations

What this covers: the production topology, what `deploy.sh` does and why each guard exists, every file under `backend/data` and `deploy/{certs,keys}`, every environment variable the backend reads, the Caddyfile contract, first-time server setup, and a troubleshooting section built from incidents the repo's own commit messages and comments record. Read this before touching `deploy.sh`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, or anything under `backend/app/auth/`.

## Topology: three containers plus one

`deploy/docker-compose.yml` defines four services. Three run always; the fourth only matters once you switch off the mock adapter.

| Service | Image / build | Reachable from | Holds |
|---|---|---|---|
| `api` | `../backend` (`backend/Dockerfile`) | `caddy`, and `tesla-proxy` via the `signing` network | Tesla refresh token, session secret, all SQLite state |
| `frontend` | `mobile/dist` baked into `deploy/Dockerfile.web` (nginx) | `caddy` only | the pre-built static PWA, nothing sensitive |
| `caddy` | `caddy:2`, config bind-mounted | the public internet (`80`/`443`) | the Let's Encrypt cert/key (`caddy_data` volume) |
| `tesla-proxy` | built from `github.com/teslamotors/vehicle-command` via `deploy/Dockerfile.proxy` | `api` only, over the `signing` network | the enrolled virtual key that signs vehicle commands |

Two Compose networks, not one (`deploy/docker-compose.yml:79-83`):

```
networks:
  default:
  signing:
```

`default` is what `caddy`, `api`, and `frontend` share. `signing` is joined by exactly `api` and `tesla-proxy`. The comment on the block is the reason, verbatim: *"`signing` is joined only by api and tesla-proxy, so nothing else on the compose network can ask for a command to be signed with the vehicle key."* `tesla-proxy` also never gets a `ports:` entry, only `expose: ["4443"]` — it is reachable by sibling containers but never by the internet. The service comment spells out why it exists at all: the proxy defaults to binding `localhost`, which only accepts connections from *inside its own container*; a separate network namespace like `api`'s got a bare "connection refused" for every signed command until the compose command line pinned `-host 0.0.0.0` (`deploy/docker-compose.yml:59-63`). `-verbose` is deliberately left off the proxy's command line too — it terminates OAuth bearer tokens and signed command payloads, and verbose logging would put them in `docker compose logs` (`deploy/docker-compose.yml:70-72`).

The isolation matters because `tesla-proxy` is the one process in the whole stack that holds a key capable of moving the car without going through this app's confirmation gate at all. Nothing about `frontend` or `caddy` needs to reach it, so nothing about them *can*.

`api` is on both networks: it needs `signing` to reach the proxy, and `default` to be reachable by `caddy` and to run migrations/queries against its own SQLite files. It mounts three things beyond its own image (`deploy/docker-compose.yml:16-25`):

- `../backend/keys:/app/keys:ro` — the virtual-key PEM pair for the `.well-known` route (fleet adapter only).
- `../backend/data:/app/data` — every SQLite database, read-write. See below.
- `./certs/proxy-cert.pem:/certs/proxy-cert.pem:ro` — so `api` can pin its HTTPS client to the proxy's self-signed cert instead of disabling TLS verification on the channel carrying the Tesla bearer token (`backend/app/tesla/fleet.py:405-410`).

## `deploy.sh` step by step

Invocation: `./deploy.sh <IP_ADDRESS> <SSH_KEY_PATH>`. Both arguments are required — the script exits with a usage message if either is missing (`deploy.sh:3-7`). It needs the server's public IP and the path to the SSH private key that was downloaded when the Oracle Cloud instance was created (or whatever key you've since rotated to).

The script runs five stages, each with a specific failure it exists to prevent.

### 1. Route/Caddyfile check

```bash
PYBIN=backend/.venv/bin/python
[ -x "$PYBIN" ] || PYBIN=python3
"$PYBIN" deploy/check-routes.py || { echo "Aborting deploy — add the missing handle blocks first."; exit 1; }
```

`deploy/check-routes.py` imports `app.main` with `TESLA_ADAPTER=mock` forced (so it never needs real Fleet credentials just to enumerate routes), walks `app.routes`, and diffs every FastAPI path against the `handle /prefix*` patterns parsed out of `deploy/Caddyfile`. Anything in FastAPI without a matching Caddy block fails the check. The script's own docstring names the cost of skipping this: *"That mistake shipped twice (`/jobs`, then `/gate/*`) before this check existed, both times only visible in the browser."* — because Caddy's catch-all silently hands an unmatched path to the static frontend, so the failure mode is a confusing nginx-style 404 on what looks like a normal API call, not an error that points at the real cause.

If the check script itself can't even import (e.g. a broken backend venv), it prints why and returns 0 rather than blocking the deploy — a checker that can't run is noise, not a signal (`deploy/check-routes.py:37-45`).

### 2. Build the PWA locally

```bash
( cd mobile && npx expo export -p web --clear ) || { echo "PWA build failed — aborting deploy."; exit 1; }
```

`deploy/Dockerfile.web` is just `nginx:alpine` plus `COPY ./dist /usr/share/nginx/html` — it ships a pre-built `dist/`, it does not build anything on the server. That's why this step exists client-side, before rsync.

`--clear` was added after a real incident (commit `083f0ee`, "Fix black-screen deploy: rsync exclude nuking fonts, stale Caddy bind mount"): Metro's bundler cache can serve a stale build across separate `expo export` runs that used *different* `EXPO_PUBLIC_API_URL` values (or none). Without `--clear`, a bundle built earlier for local scratch-testing against a different API URL could get silently reused for what should have been a fresh same-origin production build. The fix note is blunt about the consequence: the deploy briefly shipped a build carrying the wrong API URL baked in.

### 3. rsync to the server

```bash
rsync -avz -e "ssh -i \"$KEY\" -o StrictHostKeyChecking=accept-new" \
    --exclude 'mobile/node_modules' \
    --exclude '.git' \
    --exclude 'mobile/.expo' \
    --exclude 'backend/.venv' \
    --exclude '__pycache__' \
    --exclude 'backend/data' \
    ./ "ubuntu@$IP:~/tesla-agent/"
```

**The fonts incident.** The exclude list used to read `--exclude 'node_modules'` (no `mobile/` prefix). rsync's `--exclude` matches a pattern at *any depth* in the tree, not just at the root — and Expo's web export mirrors font packages under `mobile/dist/assets/node_modules/@expo-google-fonts/...` as part of the *built output*, completely unrelated to the real npm dependency tree at `mobile/node_modules`. The bare pattern excluded both. Every font file 404'd on production, `useFonts()` in the app never resolved, and the PWA sat forever on its loading screen — indistinguishable from a crash from the user's side. Fixed by anchoring the exclude to the real path, `mobile/node_modules`, so it only ever matches the actual dependency directory. This is exactly the kind of failure `deploy/check-routes.py` cannot catch: nothing was missing from the Caddyfile, the built assets that *were* shipped were just incomplete.

**Why `backend/data` is excluded.** That directory holds live SQLite state — Tesla tokens, passkeys, prefs, scheduled jobs (see the next section). Syncing it from a laptop would overwrite production's live database with whatever stale copy happens to sit locally. It's also `.gitignore`d for the same reason plus the obvious secrecy one.

Everything else excluded is either build-time junk that gets rebuilt on the server (`__pycache__`, `backend/.venv`, `mobile/.expo`) or shouldn't leave the laptop at all (`.git`).

### 4. Docker install + `backend/data` ownership

The heredoc that follows runs entirely on the server over one SSH session. It installs Docker via `get.docker.com` if missing, then:

```bash
mkdir -p ~/tesla-agent/backend/data
sudo chown -R 10001:10001 ~/tesla-agent/backend/data
sudo chmod 700 ~/tesla-agent/backend/data
```

`backend/Dockerfile` creates a fixed unprivileged user, `useradd --uid 10001 ... amp`, and runs the whole process as it (`USER amp`). The Dockerfile's own comment explains why the uid is a hardcoded literal rather than "whatever uid 1000 is on the host": *"which host account happens to hold uid 1000 varies (on this server it is `opc`, not `ubuntu`)."* `deploy.sh` chowns the bind mount to that same literal `10001` so the two sides agree without depending on account names matching between environments. If they ever drift apart, the container can't write to its own bind mount — and the visible symptom is not an error, it's a **forced Tesla re-login on every redeploy**, because `tesla_tokens.db` silently fails to persist. The Dockerfile comment says this outright: *"A mismatch would surface as the container silently failing to write the Tesla token database — i.e. a forced re-login after every deploy, not an obvious error."*

### 5. Validate Caddyfile, then bring the stack up

```bash
if ! sudo docker run --rm -v ~/tesla-agent/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
        caddy:2 caddy validate --config /etc/caddy/Caddyfile; then
    echo "❌ Caddyfile is invalid — leaving the running proxy untouched."
    exit 1
fi

sudo docker compose up -d --build
sudo docker compose up -d --force-recreate caddy
```

The validate-before-recreate step exists because of timing, not correctness: by the point Compose would normally touch `caddy`, the *previous*, perfectly working container is already what's serving traffic. If the new config doesn't parse, the failure shows up as "site unreachable" with no indication a config file is even involved — worse than a build failure, because nothing in the deploy log points at the cause. Running `caddy validate` against a throwaway `caddy:2` container first costs one container start against an image that's already local, and turns that outcome into a clear, actionable message instead.

**The stale-bind-mount half of `083f0ee`.** Caddy has no `build:` step in `docker-compose.yml` — its container only differs by a bind-mounted config file — so `docker compose up -d --build` never recreates it on its own; Compose reports it "Running", not "Recreate". The obvious fix, `caddy reload`, still wasn't enough: rsync replaces files via atomic rename, which swaps in a *new inode* at the same path, but a long-running container's bind mount keeps referencing the *old* inode. `caddy reload` faithfully reloaded that same stale content every time — the incident writeup says this was confirmed directly, not guessed, via `caddy adapt` showing the compiled routes missing `/health` entirely, then confirming the file *inside* the running container was still the pre-fix version. Only a real container recreate re-resolves a bind mount against the file that currently exists at that path, hence the explicit `--force-recreate caddy` as a second, separate `up` after the general one.

## `backend/data` — every SQLite database in it

Bind-mounted read-write into `api` at `/app/data` (`deploy/docker-compose.yml:22-24`), owned by uid `10001`, `.gitignore`d, excluded from rsync. Five files, each opened by its own module with its own `DB_PATH`:

| File | Owning module | Holds | Perms tightened? |
|---|---|---|---|
| `tesla_tokens.db` | `backend/app/auth/oauth.py:20` | Tesla OAuth access/refresh tokens, in cleartext | yes, `_restrict()` after `init_db()` (`oauth.py:60`) |
| `passkeys.db` | `backend/app/auth/passkey.py:36` | WebAuthn passkey credentials for the app gate | yes, `os.chmod(DB_PATH, 0o600)` (`passkey.py:85`) |
| `prefs.db` | `backend/app/prefs_store.py:30` | per-user preferences | yes (`prefs_store.py:62`) |
| `personas.db` | `backend/app/persona_store.py:34` | custom personas | yes (`persona_store.py:68`) |
| `scheduled_actions.db` | `backend/app/scheduler.py:27` | the background job queue the scheduler runs from FastAPI's lifespan | yes (`scheduler.py:64`) |

Plus `tts-cache/`, written by `backend/app/tts.py`, holding cached synthesized speech audio — not a database, but it lives in the same directory and is subject to the same mount/ownership rules.

The Tesla-token file is called out in `oauth.py`'s own comment as the most sensitive thing in this directory, more sensitive than the app's own session secret: *"That token drives the car through Tesla's own API, bypassing this app's gate, passcode, passkey and rate limits entirely."* SQLite creates new files with the process umask, measured at `0644` in practice — world-readable on a multi-user box — which is why every one of these stores explicitly `chmod`s itself down to `0600` (or, for the whole directory, `deploy.sh` does `chmod 700`) right after creation rather than trusting the umask.

## Certificates and keys

Two independent PKI concerns live under `deploy/` and `backend/`, easy to conflate because both involve "Tesla" and "keys":

**1. The signing proxy's TLS certificate** (`deploy/certs/proxy-cert.pem`, `deploy/certs/proxy-key.pem`) — a self-signed cert/key pair, `CN=tesla-proxy`, generated once when standing up the proxy. It secures the loopback-only HTTPS hop between `api` and `tesla-proxy` inside the `signing` network. `fleet.py` pins its `httpx` client to exactly this cert (`PROXY_CA = os.getenv("TESLA_PROXY_CA", "/certs/proxy-cert.pem")`, `fleet.py:113`) rather than passing `verify=False`. The comment at the call site (`fleet.py:405-410`) is explicit about the alternative it rejected: plain verification could never pass against a self-signed cert anyway, but disabling verification entirely would mean a live Tesla bearer token gets handed to *whatever* answers at `TESLA_PROXY_URL` — silently, if that setting is ever misconfigured. Pinning to the specific cert closes that.

**2. The virtual key pair** (`backend/keys/public-key.pem`, `deploy/keys/private-key.pem`) — the actual command-signing keypair Tesla's vehicle-command protocol uses. The private half is mounted read-only into `tesla-proxy` (`deploy/docker-compose.yml:76`, `./keys:/keys:ro`) and never touches the `api` container. The public half is served by the backend itself at a fixed, Tesla-mandated path:

```
GET /.well-known/appspecific/com.tesla.3p.public-key.pem
```

(`backend/app/main.py:842-850`, reading `keys/public-key.pem` relative to the backend's working directory). This route is in `PUBLIC_PREFIXES` (`main.py:75-77`) — reachable with no session cookie — because Tesla's own servers fetch it directly when a driver goes through the in-car/app virtual-key pairing flow; there is no session to attach. It returns `404 "public key not generated yet; see README"` if the file is missing (`main.py:848-850`, unverified whether a README with that content currently exists in the repo — treat that string as a stale pointer to write the file at `backend/keys/public-key.pem` before going live, not as a promise of further docs).

`deploy/Caddyfile` proxies `/.well-known/*` straight to `api:8000` with the same reasoning stated inline: *"Tesla itself fetches the virtual-key public key from here itself, so this one path must stay reachable without credentials."*

Neither key pair is in this repo (`backend/keys/`, `deploy/keys/`, `deploy/certs/` are all `.gitignore`d) — they're generated per-deployment and belong only on the server and in your local working copy if you're testing the fleet adapter.

## Environment variables

Read once at import time by `backend/app/config.py` via `load_dotenv()` (dev) or the container's `env_file: ../backend/.env` (`deploy/docker-compose.yml:13`, production). `backend/.env.example` is the template to copy; some variables `config.py` reads are deliberately **not** in that template because they're never meant to be typed by hand — see the note after the table.

| Variable | Default | What breaks without it |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | n/a — picks `GeminiOrchestrator` vs `AnthropicOrchestrator` in `llm/__init__.py` |
| `GEMINI_API_KEY` | `""` | Gemini chat fails; **also breaks voice transcription even when `LLM_PROVIDER=anthropic`** — see below |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | wrong value can 404 outright (older retired models still appear in `models.list()` but reject requests) |
| `GEMINI_TRANSCRIBE_MODEL` | unset → falls back to `GEMINI_MODEL` | only needed if the main chat model ever stops accepting audio |
| `GEMINI_LIVE_MODEL` | unset → falls back to `live.py`'s `DEFAULT_MODEL` (`gemini-3.1-flash-live-preview`, with `gemini-2.5-flash-native-audio-latest` as an automatic in-process fallback if the preview model refuses) | not in `.env.example`; only needed to pin the realtime voice session to a specific model — read directly in `backend/app/live.py`, not through `config.py` |
| `GOOGLE_TTS_API_KEY` | `""` | spoken replies fail; a different Google Cloud product/project than the Gemini key above, despite looking similar |
| `GOOGLE_PLACES_API_KEY` | `""` | "find somewhere to eat/park/shop" tool calls fail; a third, separately-scoped Google key |
| `ANTHROPIC_API_KEY` | `""` | required only if `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-opus-5` | — |
| `AMP_VOICE_CONFIRM` | `1` (on) | set to `0`/`false`/`no` to disable letting a *spoken* word settle a confirmation card server-side, independent of the in-app toggle — see `actions.VOICE_CONFIRMABLE`, never covers `unlock` |
| `TESLA_ADAPTER` | `mock` | `mock` = in-memory fake car, no Tesla account needed; `fleet` = real Fleet API + signing proxy |
| `AMP_MOCK_WAKE_S` | `0` (never asleep) | not in `.env.example`, read directly by `backend/app/tesla/mock.py`, and a **development-only** knob — makes the mock car start asleep and take this many seconds to wake, which is the only way to exercise the two-phase `/chat` reply (`app/turns.py`) without a real car. Meaningless under `TESLA_ADAPTER=fleet` |
| `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET` | `""` | fleet OAuth fails to even start |
| `TESLA_APP_DOMAIN` | `""` | the public origin registered with Tesla's developer portal, e.g. `https://tesla-amp.duckdns.org` |
| `TESLA_REDIRECT_URI` | `""` | must match the developer portal entry exactly, or the OAuth callback is rejected by Tesla |
| `TESLA_PROXY_URL` | `https://tesla-proxy:4443` | where `fleet.py` sends commands to be signed; the in-cluster DNS name only resolves inside Compose |
| `TESLA_PROXY_CA` | `/certs/proxy-cert.pem` | not in `.env.example`; if the mounted cert isn't at this path, `PROXY_CA` silently becomes `False` (`fleet.py:113-115`) and `httpx` falls back to normal CA verification, which will fail against the proxy's self-signed cert |
| `TESLA_FLEET_BASE` | `https://fleet-api.prd.eu.vn.cloud.tesla.com` | wrong region host means every Fleet API call 404s/hits the wrong regional cluster; `na` region is `https://fleet-api.prd.na.vn.cloud.tesla.com` |
| `OCM_API_KEY` | `""` | charger lookups fall back to the patchier OpenStreetMap source instead of Open Charge Map (`chargers.py`) |
| `AMP_SHORTCUT_TOKEN` | unset | Siri Shortcut integration (`POST /voice/ask` only) is off entirely with no value set — no token is accepted at all; generate with `openssl rand -hex 32`, anything under 32 chars is ignored with a log warning |
| `AMP_ORIGIN` | `https://tesla-amp.duckdns.org` | **not in `.env.example`, and read directly by `backend/app/auth/passkey.py` rather than through `config.py`.** Sets the WebAuthn relying-party id/origin (`passkey.py`'s `relying_party()`). Deploying under any other hostname without setting this leaves passkey registration/login checking against the wrong origin, so it fails — set it to match `TESLA_APP_DOMAIN`/the Caddyfile hostname whenever those change |
| `CORS_ORIGINS` | `*` | comma-separated allowed origins; tighten in production |
| `AMP_PASSCODE_HASH` | — (`NotConfigured` raised) | **not in `.env.example` at all** — written only by `backend/set-passcode.sh`, never typed by hand. Without it the app gate can't be enforced (`gate.py:214-220`) |
| `AMP_SESSION_SECRET` | — (`NotConfigured` raised) | also written only by `set-passcode.sh`; rotating it invalidates every outstanding session — the "log out all devices" lever (`gate.py:225-227`, `set-passcode.sh` comment) |
| `AMP_TOTP_SECRET` | unset (optional) | written only by `set-passcode.sh` when you opt into a second factor; unset means TOTP is simply not offered (`gate.py:233`) |

**The three Google keys that look interchangeable and are not.** `config.py`'s own comments make this explicit at each declaration: `GEMINI_API_KEY` is the LLM; `GOOGLE_TTS_API_KEY` is Cloud Text-to-Speech, *"a different product from the Gemini key above and a different project"*; `GOOGLE_PLACES_API_KEY` is Places, and *"this may be the same string as the TTS one — but only if that key's restrictions were widened to include Places, which is a deliberate act rather than something to assume."* Treat all three as separate secrets from separate Cloud Console projects unless you've deliberately widened one key's API restrictions to cover more than one of these roles.

**Why voice transcription needs `GEMINI_API_KEY` even under `LLM_PROVIDER=anthropic`.** `.env.example`'s own comment states it plainly: *"Speech-to-text runs on Gemini regardless of `LLM_PROVIDER` (Anthropic takes no audio), so `GEMINI_API_KEY` above must be set for the microphone to work even when the assistant itself runs on Claude."*

**Passcode/session secrets are never hand-typed into `.env`.** They're absent from `backend/.env.example` by design. `backend/set-passcode.sh` prompts interactively for a passcode (min. 10 characters, Polish-language prompts), hashes it with `hash_passcode()` from `gate.py` immediately, and writes only the hash to `backend/.env`. `AMP_SESSION_SECRET` is generated once (`secrets.token_urlsafe(48)`) and left alone on subsequent runs, so re-running the script to change the passcode doesn't also sign every device out. `AMP_TOTP_SECRET` is only ever created if you opt in and printed once for you to add to an authenticator app.

One more thing the script's own comment records: `hash_passcode()` joins its fields with `:` instead of the conventional `$` specifically because *"Docker Compose interpolates `$` inside `env_file` values, which silently truncates any secret containing one — that exact bug produced a Caddy hash that rejected every password, owner included."*

## The Caddyfile contract, and how to add a route safely

`deploy/Caddyfile` is a single site block for `tesla-amp.duckdns.org`. Every backend route needs a `handle` block routing it to `reverse_proxy api:8000` — the whole file is essentially: enumerate every FastAPI path prefix once, and let a final unconditional `handle { reverse_proxy frontend:80 }` at the bottom catch everything else and serve the static PWA.

Current handled prefixes: `/gate/*`, `/actions/*`, `/chat*`, `/voice/*`, `/live/*`, `/vehicle/*`, `/auth/*`, `/.well-known/*`, `/health*`, `/jobs*`, `/personas*`. `/voice/*` additionally caps request size (`request_body { max_size 2MB }`) — the Caddyfile comment explains why that check has to exist here as well as in the app: *"the API checks the size only after Starlette has read the request, so without this a large upload is buffered in a container that has ~1 GB to lose."*

**To add a new backend route:** add its FastAPI path in `backend/app/main.py` (or wherever routes live), then add a matching `handle /prefix* { reverse_proxy api:8000 }` block to `deploy/Caddyfile` **in the same change**. `deploy/check-routes.py` (stage 1 of `deploy.sh`, above) will refuse to deploy otherwise, but don't rely on the check catching it late — the two files should read as a matched pair from the start. `deploy/check-routes.py`'s `covered()` function does prefix matching on any pattern ending in `*` and exact matching otherwise (`deploy/check-routes.py:26-32`), so a route like `/foo/{id}` needs a `handle /foo*` (or more specific) block, not a literal, unmatchable `/foo/{id}` pattern.

The file also carries a caching policy worth knowing about if a deploy ever "doesn't show up" for a user with the PWA already installed: hashed asset paths (`/_expo/static/*`, `/assets/*`) get `Cache-Control: public, max-age=31536000, immutable` because their filenames already embed a content hash, so a changed file is a different URL and the old one is simply never requested again. Everything reached by a fixed name (`/`, `/index.html`, `/manifest.json`, `/favicon.ico`, `/apple-touch-icon.png`, `/icons/*`) gets `no-cache` — not `no-store` — so the browser still keeps a local copy but must revalidate it every time, which the Caddyfile comment notes usually costs "a few hundred bytes" (a 304) rather than a fresh download. Before this policy existed, browsers fell back to heuristic freshness (commonly a fraction of the file's age) and a longer-deployed build was correspondingly *more* entitled to be served stale — the comment states this was the actual, verified cause of a deploy not reaching an installed PWA, not a hypothetical.

One historical note visible in the file's own comments: this site briefly carried HTTP Basic Auth in front of everything, added the moment it was realized anyone with the URL could unlock the car before the passcode gate existed. It was removed once the in-app gate (`backend/app/auth/gate.py`) was verified working, on the reasoning that two prompts for one person is friction without benefit — the gate is enforced by the API itself regardless of what reaches it through Caddy, "verified from inside the compose network."

## First-time server setup and DuckDNS

Unverified beyond what the repo's own comments state (there is no standalone setup script or README covering this end-to-end — treat the following as assembled from `deploy/docker-compose.yml`, `deploy.sh`, and `deploy/Caddyfile`):

1. **Provision a VM.** The compose file's own header comment says this is built for "your Oracle Cloud Always-Free VM" — a free-tier ARM or AMD instance is enough to run four small containers. The deploy scripts assume an `ubuntu` user (`ssh ... "ubuntu@$IP"`, `deploy.sh:33`) with passwordless `sudo`.
2. **Point a domain at it.** `deploy/docker-compose.yml:7-8`: *"For a $0 setup, point a free DuckDNS subdomain (e.g. `amp.duckdns.org`) at the VM's public IP, then set DOMAIN below. Caddy gets a real cert automatically."* In the current `deploy/Caddyfile`, the hostname is a literal at the top of the file (`tesla-amp.duckdns.org {`), **not** an interpolated `DOMAIN` variable — so despite the compose comment's wording, there is nothing to "set below"; the way to point this stack at a different hostname today is to edit that literal directly in `deploy/Caddyfile` (and update `TESLA_APP_DOMAIN`/`TESLA_REDIRECT_URI` in `.env` and the Tesla developer portal to match). Treat the compose comment as slightly stale on this specific point. Also set `AMP_ORIGIN` to the new hostname (see the environment variable table below) — `backend/app/auth/passkey.py` defaults it to `https://tesla-amp.duckdns.org` and uses it as the WebAuthn relying-party origin, so passkey registration/login silently fails on any other domain until it's updated to match.
3. **Open ports 80 and 443** in the VM's security list/firewall — Caddy needs both for the ACME HTTP-01/TLS-ALPN challenge and to actually serve traffic.
4. **Get an SSH key onto the box** and note its local path; `deploy.sh` needs that path as its second argument every time.
5. **First deploy.** Run `./deploy.sh <IP> <SSH_KEY_PATH>` once with `TESLA_ADAPTER=mock` (the default) to get the app up without needing any Tesla credentials yet — this is enough to confirm the domain, TLS, and gate are all working.
6. **Set the app passcode.** SSH in (or run locally against the same `backend/.env` before the first sync) and run `backend/set-passcode.sh`; without `AMP_PASSCODE_HASH`/`AMP_SESSION_SECRET` set, `gate.py` raises `NotConfigured` and the app gate cannot be enforced at all.
7. **Only if you want the real car:** register an app in Tesla's developer portal with `TESLA_APP_DOMAIN` matching your domain and `TESLA_REDIRECT_URI` pointing at `.../auth/callback`; generate the virtual-key pair and place the public half at `backend/keys/public-key.pem` (served automatically at `/.well-known/appspecific/com.tesla.3p.public-key.pem`) and the private half at `deploy/keys/private-key.pem` (mounted into `tesla-proxy`); set `TESLA_ADAPTER=fleet` plus the `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`/etc. variables; uncomment/bring up the `tesla-proxy` service; redeploy; visit `/auth/login` while signed into the app to complete OAuth; then pair the virtual key from the Tesla app — see the troubleshooting entry below for the exact in-app path.

## Troubleshooting

Each entry below is drawn from an incident the repo's own comments or commit history record — not a hypothetical failure mode.

### Forced Tesla re-login after every deploy

**Cause:** `backend/data` (holding `tesla_tokens.db`) is owned by something other than uid `10001` on the host, so the `amp` user inside the `api` container can't write to it. The container recreate that happens on every deploy wipes anything the process couldn't persist to the bind mount, so the token silently fails to save and the app looks like it forgot the Tesla connection.

**Check:** `ls -ln ~/tesla-agent/backend/data` on the server — the owning uid should read `10001`.

**Fix:** `sudo chown -R 10001:10001 ~/tesla-agent/backend/data && sudo chmod 700 ~/tesla-agent/backend/data` — the same two lines `deploy.sh` already runs on every deploy (`deploy.sh:41-45`); running them by hand is the fix if something external (a manual `mkdir`, a snapshot restore) put the directory back to root or another uid.

### Black screen / app stuck on its loading state after a deploy

**Cause, historically:** the rsync exclude-list bug described above (`--exclude 'node_modules'` matching the font-mirroring path inside `mobile/dist/assets/`), which 404'd every font file and left Expo's `useFonts()` promise unresolved forever.

**How it was actually diagnosed** (per the `083f0ee` commit message): direct network requests against the deployed assets (confirming 404s on font files), SSH into the box to inspect what actually landed under `mobile/dist`, and comparing against what rsync's exclude patterns would match at any depth — not guessed from the symptom alone.

**Fix if it recurs with a *different* file class:** check whether any `--exclude` pattern in `deploy.sh`'s rsync invocation is unanchored (no leading path segment) and therefore matches a same-named directory nested somewhere under `mobile/dist/` as part of the *built* output, not just the real source tree it was meant to exclude.

### `/health` (or any other route) 404s through Caddy even after fixing `deploy/Caddyfile`

**Cause:** Caddy's container was never recreated, so its bind-mounted `Caddyfile` is still resolving to the inode rsync's atomic rename left behind *before* your fix, not the new file's inode. A `caddy reload` — even one that runs without error — reloads that same stale content, because as far as the running process can tell, nothing changed.

**Check:** exec into the caddy container and read the file it actually sees (`docker compose exec caddy cat /etc/caddy/Caddyfile`), or use `caddy adapt`/Caddy's admin API to inspect the compiled routes and confirm the missing route is really absent from what's running, not just failing for some other reason.

**Fix:** `deploy.sh` now runs `sudo docker compose up -d --force-recreate caddy` as a dedicated second step specifically because a plain `docker compose up -d --build` never touches Caddy on its own (no `build:` step means no image change means no recreate trigger). If you're debugging this manually rather than via a full deploy, `sudo docker compose up -d --force-recreate caddy` alone is the fix.

### Caddyfile is invalid and a deploy aborts on "Caddyfile is invalid"

This is `deploy.sh` working as intended, not a bug: the validate-before-recreate step (`deploy.sh:58-64`) caught a config error before it could take down the currently-running, working Caddy container. Fix the syntax error the validator reported, then re-run `./deploy.sh`. Nothing about the previous deploy was touched — the whole point of validating first is that the old proxy is left serving traffic exactly as it was.

### Connection refused from the signing proxy

**Cause, historically:** `tesla-proxy` defaulting to binding `localhost` inside its own container, which is not reachable from `api`'s separate network namespace even though both are on the `signing` Docker network.

**Fix already applied:** the compose command line pins `-host 0.0.0.0` explicitly (`deploy/docker-compose.yml:59-66`). If you see this again after changing the proxy's command/image, check that flag is still present — Tesla's upstream proxy defaults away from it.

**A related but distinct proxy error:** *"Amp's virtual key isn't paired with the car yet, so it rejects remote commands"* (`backend/app/tesla/fleet.py:418-429`) is not a connectivity problem — the proxy is reachable and responding, but the car itself has never accepted the enrolled virtual key. The fix is a one-time, user-side action: open `https://tesla.com/_ak/tesla-amp.duckdns.org` in the Tesla app to add the key. Per the same error message, the vehicle owner's account can do this from anywhere; a driver/co-owner account has to be physically near the car, in Bluetooth range, with the physical key card.

### nginx-style 404 on a route you just added

**Cause:** almost always a missing `handle` block in `deploy/Caddyfile` for the new FastAPI route — Caddy's catch-all silently hands anything unmatched to the `frontend` service, which answers with its own 404 page. This is precisely what `deploy/check-routes.py` exists to catch before it ships; if you're seeing it in production, either the deploy bypassed `deploy.sh` (e.g. a manual `docker compose up`) or the route was added after the last successful check ran.

**Fix:** add the corresponding `handle /your-prefix* { reverse_proxy api:8000 }` block to `deploy/Caddyfile`, then redeploy through `deploy.sh` so the check would catch this class of mistake next time too.

## Running the deploy

```bash
./deploy.sh <SERVER_IP> <SSH_KEY_PATH>
```

Both the server's IP address and the local path to its SSH private key are required positional arguments — the script prints a usage error and exits if either is missing.

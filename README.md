# tesla-agent

An AI chat assistant that controls a Tesla Model 3 (2021, Intel — no Grok) via
natural language: climate, media, locks, charging, and state. The AI layer maps
speech to tool calls; a thin **Tesla adapter** actually talks to the car, so you
can build and test everything against a mock and only wire up the real Tesla
Fleet API at the end.

```
React Native app  ──HTTPS──▶  FastAPI backend  ──▶  TeslaAdapter
  (chat UI)                    - Claude tool-calling      ├─ MockImpl   (dev, no car)
                               - runs the tool loop       ├─ FleetImpl  (prod, signed cmds)
                               - secrets stay here         └─ (broker impl, optional)
                                                                    │
                                                          vehicle-command proxy ─▶ Tesla Fleet API ─▶ car
```

## Quick start (mock — no car, no Tesla account)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then put your GEMINI_API_KEY in .env
uvicorn app.main:app --reload
```

Get a free Gemini key at <https://aistudio.google.com/apikey>. To use Claude
instead, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`.

Talk to it:

```bash
curl -s localhost:8000/chat -H 'content-type: application/json' \
  -d '{"message":"make it 22 degrees and warm up the car"}' | python -m json.tool
```

The mock car's state changes as you issue commands, so multi-turn requests like
"what temperature did I set?" work end-to-end.

## What's here

| Path | Role |
|---|---|
| `backend/app/main.py` | FastAPI: `/chat`, `/health`, Tesla's `/.well-known/...` and `/auth/*` |
| `backend/app/llm/` | LLM provider seam: `gemini_llm.py` (default), `anthropic_llm.py` (fallback) |
| `backend/app/tools.py` | Provider-agnostic tool schemas + dispatch to the adapter |
| `backend/app/tesla/adapter.py` | `TeslaAdapter` interface + factory (the swap seam) |
| `backend/app/tesla/mock.py` | In-memory fake car (default) |
| `backend/app/tesla/fleet.py` | Real Fleet API impl — **stub**, finish last |
| `backend/app/auth/oauth.py` | Tesla OAuth token handling — **stub** |
| `deploy/` | docker-compose + Caddy for the Oracle Cloud VM |

## Going live on the real car (the one-time hard part)

Do this only after the mock-backed chat loop works. Full, detailed
step-by-step handoff plan: **[TESLA_GO_LIVE.md](TESLA_GO_LIVE.md)**. Rough
order:

1. **Register** a Fleet API app at <https://developer.tesla.com> (done — app
   `tesla-agent`). Note the client id/secret and your redirect URI.
2. **Domain + TLS.** Point a free DuckDNS subdomain at your Oracle VM and let
   Caddy get a Let's Encrypt cert (see `deploy/`).
3. **Generate a key pair** and host the public key at
   `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
   (drop the PEM at `backend/keys/public-key.pem`).
4. **Register the partner account** and **enroll the virtual key** in the car
   (approved on the car's screen) — a 2021 Model 3 rejects unsigned commands.
5. **Run the signing proxy** ([teslamotors/vehicle-command](https://github.com/teslamotors/vehicle-command)) —
   uncomment the `tesla-proxy` service in `deploy/docker-compose.yml`.
6. **Finish** `app/auth/oauth.py` (token exchange + refresh + storage) and the
   normalization TODO in `app/tesla/fleet.py`.
7. Flip `TESLA_ADAPTER=fleet` in `.env`.

Cost control: cache reads, and only wake the car on an actual command — a wake
costs ~20× a command. With one car this keeps you inside Tesla's free API credit.

## Deploy (Oracle Cloud Always-Free)

```bash
# on the VM, with Docker + compose installed and DOMAIN set in deploy/Caddyfile
cd deploy
cp ../backend/.env.example ../backend/.env   # fill it in
docker compose up -d --build
```

## Mobile app — Volt

`mobile/` is an Expo (React Native + TypeScript) chat client. Design language:
an instrument cluster, not a messenger — a live telemetry strip up top
(battery, lock, climate), and every tool call the backend executes renders as
a colored instrument-log line in the conversation (`● CLIMATE → 22°C`), not
hidden system chrome.

```bash
# with the backend running (see Quick start above)
cd mobile
npm install
npm start        # press i for iOS Simulator, w for web, a for Android
```

Networking defaults: iOS Simulator reaches `localhost:8000` directly (it
shares the host Mac's network). Android emulator needs `10.0.2.2` instead —
already handled in `src/api.ts`. A physical device needs your Mac's LAN IP;
set `EXPO_PUBLIC_API_URL` to override.

| Path | Role |
|---|---|
| `mobile/App.tsx` | Loads fonts (Space Grotesk / Manrope / JetBrains Mono), renders the app |
| `mobile/src/theme.ts` | Design tokens — colors, type, spacing |
| `mobile/src/screens/ChatScreen.tsx` | Message list + input, talks to the backend |
| `mobile/src/components/InstrumentStrip.tsx` | Live telemetry readout |
| `mobile/src/components/ToolLogLine.tsx` | Renders one tool call as a log entry |
| `mobile/src/toolMeta.ts` | Maps each backend tool to its vehicle system + color — keep in sync with `backend/app/tools.py` |

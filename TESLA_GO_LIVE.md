# Next phase: go live on the real car

**Handoff document.** Written so a fresh Claude session (or the user, or
another human dev) with zero memory of prior conversations can pick this up
and execute it correctly. If you're that fresh session: read this whole file
before touching code, then work the checklist in order — later steps depend
on earlier ones.

## 1. What this project is

`tesla-agent` — an AI chat assistant that controls a **2021 Tesla Model 3**
(Intel MCU, no Grok integration) via natural language: climate, seat heaters,
media, locks, charging, and state reads. Two apps:

- **`backend/`** — FastAPI. An LLM (Gemini by default) runs a tool-calling
  loop; tool calls dispatch to a swappable `TeslaAdapter`. The LLM never talks
  to Tesla directly — only the adapter does.
- **`mobile/`** — Expo/React Native chat client ("Volt"). Talks to the
  backend over HTTP (`/chat`, `/vehicle/state`).

**Everything currently runs against a mock car** (`TESLA_ADAPTER=mock` in
`backend/.env`, implemented in `backend/app/tesla/mock.py`) and has been
verified end-to-end: LLM → tool calls → mock state changes → UI reflects it.
Nothing has touched a real Tesla account or a real car yet.

## 2. Goal of this phase

Flip `TESLA_ADAPTER` from `mock` to `fleet` so the exact same chat loop
controls the real car, by finishing the two files that are currently stubs:

| File | Status | What's missing |
|---|---|---|
| `backend/app/auth/oauth.py` | Stub | OAuth authorize URL construction (PKCE), token exchange, refresh, durable storage |
| `backend/app/tesla/fleet.py` | Stub | Response normalization to match `MockImpl`'s state shape (marked `TODO` in the file) |

`fleet.py`'s command/read plumbing (signed commands via proxy, direct reads)
is already written — read it before starting, it documents the split.

## 3. What's already decided — don't re-litigate these

- **Host:** Oracle Cloud **Always Free** tier. Chosen specifically because it
  needs **zero ongoing cost** (Fly.io was ruled out — it requires a card on
  file and bills per-second, even though usage would be pennies/month).
  Oracle asks for a card too, but only for identity verification — Always
  Free resources aren't billed.
- **Domain:** a free **DuckDNS** subdomain pointed at the Oracle VM's public
  IP (e.g. `volt.duckdns.org` — used as the placeholder throughout the repo).
  **Verify whether this has actually been set up yet** — it may not have
  been. If not, that's step 1 below.
- **TLS:** Caddy (already configured in `deploy/docker-compose.yml` +
  `deploy/Caddyfile`), automatic Let's Encrypt cert. No manual cert work.
- **Tesla developer app:** already registered at developer.tesla.com under
  the name `tesla-agent`, OAuth grant type **"Authorization Code and
  Machine-to-Machine"** (the correct choice — not the fleet-only M2M-only
  option). **Verify the origin and redirect URI fields were actually
  completed and saved** — this was mid-registration in an earlier session
  and may not be finished. They must exactly match `TESLA_APP_DOMAIN` /
  `TESLA_REDIRECT_URI` below, byte-for-byte (scheme, no trailing slash
  mismatches).
- **Scopes:** minimal — `openid offline_access vehicle_device_data
  vehicle_cmds vehicle_charging_cmds` (already set as `SCOPES` in
  `backend/app/auth/oauth.py`). Do not add `user_data` or energy/Powerwall
  scopes — not needed, and broader scope is a needless liability on
  something that controls a physical vehicle.
- **Region:** `TESLA_FLEET_BASE` defaults to the **EU** endpoint
  (`fleet-api.prd.eu.vn.cloud.tesla.com`) in both `config.py` and
  `.env.example`. Confirm this is actually the right region for the car's
  home market before relying on it — switch to the `na` host in the comment
  if not.
- **Signing proxy:** Tesla's official
  [`teslamotors/vehicle-command`](https://github.com/teslamotors/vehicle-command)
  (the `tesla-http-proxy` binary). Non-negotiable for this car — **a 2021
  Model 3 rejects unsigned commands**, full stop. Reads don't need signing;
  every command does. Already stubbed as a commented-out `tesla-proxy`
  service in `deploy/docker-compose.yml` — uncomment and configure when you
  get there.
- **Product/app name:** "Volt" (mobile client branding only — unrelated to
  the Tesla developer-portal app name `tesla-agent`, which is just an
  internal OAuth client label Tesla shows nobody but you).

## 4. Ordered checklist

Work top to bottom. Each step names its file(s) and how to verify it before
moving on — don't batch steps, a mistake early (wrong redirect URI, wrong
key) is much more annoying to debug once several steps deep.

### 4.1 — Confirm/provision the VM + domain

- [ ] Confirm an Oracle Cloud Always Free VM exists and is reachable (SSH).
      If not: create one (ARM Ampere shape, Always Free eligible — up to 4
      OCPU / 24GB RAM), install Docker + Docker Compose.
- [ ] Confirm a DuckDNS subdomain is registered and pointed at the VM's
      public IP. If not: sign up at duckdns.org, create the subdomain, note
      it (this is `TESLA_APP_DOMAIN` without the scheme, e.g.
      `volt.duckdns.org`).
- [ ] Point `deploy/Caddyfile`'s domain line at the real subdomain (it
      currently says `volt.duckdns.org` as a placeholder — update if
      different).
- [ ] Open ports 80 + 443 in the Oracle VM's security list / firewall (this
      trips people up — Oracle's default network security list blocks
      inbound by default, separate from the OS firewall).

**Verify:** `curl -I http://<your-subdomain>` from your laptop resolves to
the VM (even a connection-refused is fine at this point — DNS resolution is
what you're confirming).

### 4.2 — Finish registering the Tesla developer app

- [ ] Log into developer.tesla.com, open the `tesla-agent` app.
- [ ] Confirm/set the **Allowed Origin(s)** to `https://<your-subdomain>`
      (bare origin, no path, no trailing slash).
- [ ] Confirm/set the **Allowed Redirect URI(s)** to
      `https://<your-subdomain>/auth/callback` — must match
      `backend/app/main.py`'s `/auth/callback` route exactly.
- [ ] Note the **Client ID** and **Client Secret** shown — you'll need both.

**Verify:** the portal shows both fields saved without a validation error
(Tesla validates the origin is a syntactically real HTTPS URL).

### 4.3 — Generate the signing keypair, host the public key

Follow the exact key-generation steps in
[`teslamotors/vehicle-command`'s README](https://github.com/teslamotors/vehicle-command)
— it ships a `tesla-keygen` tool that produces the correct EC keypair format
(Tesla requires a specific curve/format; don't hand-roll this with plain
OpenSSL flags without checking their README first).

- [ ] Generate `private-key.pem` + `public-key.pem`.
- [ ] Place `public-key.pem` at `backend/keys/public-key.pem` — this path is
      already wired up in `backend/app/main.py`'s
      `/.well-known/appspecific/com.tesla.3p.public-key.pem` route (returns
      404 with a clear message until the file exists — that 404 is expected
      and correct pre-this-step).
- [ ] Keep `private-key.pem` **out of git** (already covered by
      `.gitignore`'s `backend/keys/` entry — don't move it elsewhere) and
      copy it to wherever `deploy/docker-compose.yml`'s commented
      `tesla-proxy` service volume-mounts keys from (`./keys/` relative to
      `deploy/`, per the commented config — create that directory on the VM).

**Verify:** once deployed (step 4.6), `curl
https://<your-subdomain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
returns the PEM content, not a 404.

### 4.4 — Register the partner account (the step people forget)

Hosting the public key is necessary but **not sufficient** — Tesla also
requires one explicit API call to register your app for your domain before
virtual-key enrollment will work. Rough shape (verify exact request/response
schema against developer.tesla.com's Fleet API docs before executing — don't
trust this from memory for the exact JSON field names):

1. Get a **partner token** (`client_credentials` grant, not user OAuth):
   `POST https://auth.tesla.com/oauth2/v3/token` with `grant_type=client_credentials`,
   your `client_id`/`client_secret`, the scopes from §3, and `audience=<TESLA_FLEET_BASE>`.
2. `POST {TESLA_FLEET_BASE}/api/1/partner_accounts` with `Authorization:
   Bearer <partner token>` and a body identifying your domain. Tesla fetches
   your public key from the `.well-known` path at this point to verify it.

- [ ] Run this once (a scratch `curl`/Python script is fine — this isn't
      app code, it's a one-time registration action).

**Verify:** the call returns success (not 4xx). If it 404s/403s on fetching
your public key, step 4.3 or 4.1 isn't actually live yet — fix those first.

### 4.5 — Enroll the virtual key in the car

- [ ] On a phone logged into the Tesla account that owns the car, visit:
      `https://tesla.com/_ak/<your-subdomain>` (bare domain, no scheme
      prefix in the path segment). This sends an enrollment request to the
      car.
- [ ] In the car (or via the Tesla app if it surfaces the prompt), approve
      adding the key — on this MCU generation it's confirmed on the car's
      touchscreen under Locks/security settings.

**Verify:** the virtual key appears in the car's list of enrolled keys.
Until this is done, every signed command will be rejected regardless of how
correct the rest of the setup is — this is the step that actually grants
command authority, not the OAuth login.

### 4.6 — Deploy, uncomment the proxy

- [ ] Fill in `backend/.env` on the VM (copy from `.env.example`): set
      `TESLA_ADAPTER=fleet`, `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`,
      `TESLA_APP_DOMAIN`, `TESLA_REDIRECT_URI`, confirm `TESLA_FLEET_BASE`
      region. Keep `GEMINI_API_KEY` etc. as already configured.
- [ ] Uncomment the `tesla-proxy` service block in
      `deploy/docker-compose.yml`. Build/pull the `tesla-http-proxy` image
      per the `vehicle-command` repo's instructions (the placeholder
      `image: tesla-http-proxy:latest` in the compose file is not a real
      published tag — replace with however you choose to build it: a
      `Dockerfile` next to `deploy/`, or a real published image if one
      exists that you trust).
- [ ] The proxy needs its own TLS cert (self-signed is fine — it's only
      reached from the `api` container over the Docker network, not the
      public internet). `fleet.py`'s `_command()` already sets `verify=False`
      for that reason.
- [ ] `docker compose up -d --build` from `deploy/`.

**Verify:** `curl https://<your-subdomain>/health` returns
`{"status":"ok","adapter":"fleet",...}`.

### 4.7 — Finish `oauth.py`

`backend/app/auth/oauth.py` currently has the constants (`AUTHORIZE_URL`,
`TOKEN_URL`, `SCOPES`) and an in-memory `TokenStore` stub. Needed:

- [ ] `/auth/login` (in `backend/app/main.py`, currently a TODO stub):
      build the authorize URL with PKCE (`code_challenge` /
      `code_challenge_method=S256`), `redirect_uri`, `scope`, `state` (store
      the PKCE verifier + state server-side, keyed to something you can
      recover in the callback — a signed cookie or short-lived server-side
      map is enough for a single-user app), redirect the browser there.
- [ ] `/auth/callback` (also a TODO stub): verify `state`, exchange `code` +
      the PKCE verifier for tokens at `TOKEN_URL`, call
      `TokenStore.save_tokens(access_token, refresh_token)`.
- [ ] `TokenStore`: replace the in-memory fields with real persistence
      (SQLite is plenty for one user/one car — don't reach for Postgres
      here) so tokens survive a container restart. Add expiry tracking and
      an actual refresh call in `get_access_token()` (currently a TODO that
      just returns the cached token unconditionally).

**Verify:** visit `https://<your-subdomain>/auth/login` in a browser, log in
with the Tesla account, land back on `/auth/callback` without error, then
confirm `GET /vehicle/state` (already implemented, calls `adapter.get_state()`)
returns real car data instead of erroring.

### 4.8 — Finish `fleet.py`'s normalization TODO

`get_state()` currently returns Tesla's raw `vehicle_data` response
untouched. The mobile app's `InstrumentStrip` component
(`mobile/src/components/InstrumentStrip.tsx`) and the LLM's system prompt
both expect the **same shape `MockImpl` returns** — `battery_percent`,
`locked`, `climate_on`, `target_temp_c`, etc. (see
`backend/app/tesla/mock.py` for the exact field names, and
`mobile/src/types.ts`'s `VehicleState` interface for what the client reads).

- [ ] Write the mapping from Tesla's raw response (nested under
      `charge_state`, `climate_state`, `vehicle_state` in their API) to the
      flat shape the rest of the app already expects. Don't change the flat
      shape's field names — everything downstream depends on them.

**Verify:** the mobile app's instrument strip shows real numbers that match
what the Tesla app shows for the same car at the same moment.

### 4.9 — Test order (read the whole section before running anything)

This controls a physical vehicle. Test in this order, and **be physically
near the car** for the first pass so you can visually confirm each result
and abort if something's wrong — don't trust the API response alone yet.

1. **Reads only** first: `get_vehicle_state` via the chat, repeatedly, across
   a few minutes. Confirm numbers are sane and match the real car (check
   against the Tesla app).
2. **Cheapest, most visible commands next**: `honk`, `flash_lights` — instant
   physical confirmation, nothing that changes vehicle state.
3. **Reversible state changes**: `lock`/`unlock` (watch the door handles),
   `start_climate`/`stop_climate`, `set_climate_temp`.
4. **Charging commands last**, and only if the car is actually plugged in:
   `start_charging`, `stop_charging`, `set_charge_limit`.
5. Only after all of the above pass, consider it done — don't skip straight
   to charging/lock commands to save time.

Throughout: watch for the car needing to **wake up** (it sleeps to save
battery) — the first command after idle will be slow and costs ~20× a normal
command against your API credit. That's expected, not a bug.

### 4.10 — Security pass before calling this done

Real OAuth tokens and a real private signing key are now in play. Run the
`security-review` skill (or `/security-review`) against the diff before
considering this phase complete — specifically check:

- The private key never gets logged, committed, or returned in any API
  response.
- `TokenStore`'s persistence doesn't write tokens in plaintext somewhere
  world-readable on the VM.
- `/auth/callback` actually validates `state` (CSRF) rather than trusting
  whatever `code` shows up.
- `.env` on the VM has restrictive file permissions.

## 5. Cost expectations

With the $10/month Fleet API credit and one car used by one person: reads
are cheap, commands are cheap ($2.50 per 2,000), wakes are the one thing to
watch (20× a command). As long as the mobile app doesn't poll
`/vehicle/state` aggressively (it currently fetches once on load and once
after each chat turn — fine) and nothing polls faster than every ~30–60s,
this should stay inside the free credit indefinitely for personal use.

## 6. Recommended tooling for this phase

Pull in the community
[`scald/tesla-mcp`](https://github.com/scald/tesla-mcp) MCP server for
interactive debugging against the real Fleet API — lets whoever's doing this
phase poke the API directly from a Claude session while diagnosing auth or
signing issues, separate from the app's own code. Not required, but saves a
lot of `curl`-and-guess cycles. **Do not** use
`robcerda/tesla-mcp-server` — it targets the deprecated Owner API and won't
work with signed commands on this car.

## 7. Definition of done

- [ ] `TESLA_ADAPTER=fleet` in production `.env`, backend deployed on the VM
- [ ] `/health` reports `adapter: fleet`
- [ ] All of §4.9's test order passes against the real 2021 Model 3
- [ ] Mobile app (Volt) shows live real telemetry and successfully issues at
      least one command end-to-end from a phone, not just `curl`
- [ ] `security-review` pass complete with no unresolved findings
- [ ] `backend/app/tesla/fleet.py`'s normalization TODO is gone, replaced
      with real code
- [ ] This file's checklist is fully checked, or superseded by a note
      explaining what changed

## 8. Reference links

- Tesla Fleet API docs: <https://developer.tesla.com/docs/fleet-api>
- Signing proxy + keygen: <https://github.com/teslamotors/vehicle-command>
- Community debugging MCP: <https://github.com/scald/tesla-mcp>
- DuckDNS: <https://www.duckdns.org>
- Oracle Cloud Always Free: <https://www.oracle.com/cloud/free/>

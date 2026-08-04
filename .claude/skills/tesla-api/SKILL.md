---
name: tesla-api
description: Tesla Fleet API reference so work on backend/app/tesla/fleet.py (the real FleetImpl, as opposed to the dev-time MockImpl) is grounded in the documented API rather than guessed at. Trigger on any Fleet API work — adding or changing a vehicle command, an endpoint returning an unexpected shape, a signing-proxy error (including "not been paired"), OAuth scopes, the virtual key / tesla.com/_ak/ pairing flow, or a question about which Fleet API endpoint backs a given TeslaAdapter method. Do NOT trigger for MockImpl-only changes (backend/app/tesla/mock.py) with no real API involved, for the confirmation-gate/CONFIRM_REQUIRED logic in backend/app/actions.py (that's app-level policy, not Fleet API shape), or for LLM tool-schema work in backend/app/tools.py that doesn't touch what fleet.py actually sends.
---

# Tesla Fleet API reference for tesla-agent

`backend/app/tesla/fleet.py` is the only file in this repo that talks to Tesla's
real API. It does so through two different doors — the signed vehicle-command
proxy (`TESLA_PROXY_URL`, default `https://tesla-proxy:4443`) and the plain
Fleet API (`TESLA_FLEET_BASE`, default the EU prod host) — and picking the
wrong door for a new command is the most likely mistake. `reference/endpoints.md`
in this same directory is the endpoint table; read it before writing code, and
add a row to it if you confirm a new endpoint.

## 1. Confirm an endpoint before using it

Tesla's own docs at developer.tesla.com return HTTP 403 to a plain fetch (measured
during this skill's research — Cloudflare bot-blocking, not a dead link). Do not
conclude "the docs don't cover this" from a 403. Work around it:

1. Try `WebFetch` on `https://r.jina.ai/<the developer.tesla.com URL>` — a reader
   proxy that got through cleanly every time during research (used for
   `vehicle-commands`, `vehicle-endpoints`, `charging-endpoints`, the
   authentication overview page).
2. Cross-check against `github.com/teslamotors/vehicle-command` — the signing
   proxy's own source (`pkg/proxy/command.go`) is the authoritative list of what
   it will and won't sign, and its README documents the virtual-key pairing flow.
3. Community docs (`tesla-api.timdorr.com`, TeslaMotorsClub, the `timdorr/tesla-api`
   and `teslamotors/vehicle-command` GitHub Discussions/Issues) are useful for
   filling gaps Tesla's own docs leave undocumented — the `408`-on-asleep
   behavior of `vehicle_data` and the current `share` command shape were both
   confirmed this way, not from the official page. Mark anything sourced only
   from community docs as community-confirmed, not officially documented, when
   you record it.
4. If you cannot confirm a claim through any of the above, write it into
   `reference/endpoints.md` as **UNVERIFIED** rather than as fact. A short
   accurate table beats a complete invented one — this reference will be loaded
   as authoritative in future sessions.

## 2. Decide signed vs. unsigned before adding a command

Every command in `TeslaAdapter` (`backend/app/tesla/adapter.py`) reaches the car
through `FleetImpl._command()`, which picks one of two paths:

- **Signed** (`signed=True`, the default) — POSTs to
  `{TESLA_PROXY_URL}/api/1/vehicles/{VIN}/command/{name}`, addressed by the
  17-character VIN (the proxy 404s on the numeric Fleet API id — see
  `_resolve_vehicle`'s docstring). This is required for anything a 2021 Model 3
  treats as a real vehicle command: locks, climate, charging, trunk, sentry,
  schedules, software update. `_send_signed` in `fleet.py`.
- **Unsigned / direct** (`signed=False`) — POSTs straight to
  `{TESLA_FLEET_BASE}/api/1/vehicles/{id}/command/{name}`, addressed by the
  numeric Fleet API id. `_send_direct` in `fleet.py`. Only for the handful of
  commands the proxy's own dispatch table refuses to sign because they need
  server-side geocoding it can't authenticate end-to-end. Checked directly
  against `pkg/proxy/command.go`'s `ExtractCommandAction` switch (fetched raw,
  Aug 2026): `navigation_request` has an explicit `case` there returning
  `ErrCommandUseRESTAPI`. `share` and `navigation_gps_request` — the command
  family `fleet.py` actually uses for `set_navigation_destination`/`set_route`
  — have **no case at all** in that switch, so the proxy would hit its
  `default` branch (a plain `invalid_command` HTTP 400) rather than
  `ErrCommandUseRESTAPI` if either were ever sent through it signed. Net effect
  is the same — none of the three can go through the proxy — but the error
  each would produce is not identical; don't say all three "return
  ErrCommandUseRESTAPI" as a single fact.

Before adding a new command to `TeslaAdapter`/`fleet.py`: check
`reference/endpoints.md` — Part 1 for whether Tesla documents the endpoint at
all, Part 2 for whether it's signed. If it's not in Part 2's tables yet,
check `pkg/proxy/command.go`'s dispatch table (via WebFetch on the raw GitHub
URL, or WebSearch) — if the command name appears there under a real handler
(not `ErrCommandUseRESTAPI`/`ErrCommandNotImplemented`), it's signed; otherwise
route it through `_send_direct` like `set_route` and
`set_navigation_destination` do.

## 3. Scopes

The app requests (`backend/app/auth/oauth.py`, `SCOPES`):
`openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds`.

Tesla's authentication-overview docs describe scopes at this granularity —
`vehicle_cmds` covers general commands (lock/unlock, wake, remote start,
software updates, climate, sentry, media, navigation), `vehicle_charging_cmds`
covers charging-specific commands and charging history, `vehicle_device_data`
covers `vehicle_data`/alerts/release notes, `vehicle_location` covers
coordinates. Tesla does **not** publish a per-command scope table (confirmed:
the vehicle-commands doc page doesn't list one) — so when a Fleet API call
403s with a scope-looking message, check which of those four buckets the
command falls into rather than searching for a table that doesn't exist. The
project already requests all four vehicle-scoped buckets it uses; a real scope
gap here means the OAuth grant needs re-authorizing (`/auth/login` again), not
a code fix.

## 4. Reading a Fleet API error

`fleet.py`'s `_raise_for_status` deliberately keeps the response body (capped,
printable-only) because httpx's own `raise_for_status()` drops it — a real
debugging session mistook a body-carried "expected 17-character VIN in path"
for a generic outage. When an unfamiliar error surfaces:

1. Read the kept body first, not just the status code.
2. `408` from either `vehicle_data` or a signed command means "asleep/
   unreachable," not a real HTTP timeout — confirmed both in Tesla's own error
   text ("vehicle unavailable: vehicle is offline or asleep") and in
   `VehicleAsleepError`'s usage throughout `fleet.py`. It is handled, not an
   error to chase.
3. A signed command whose body contains "not been paired" means the virtual key
   isn't in the car's keychain yet — `fleet.py` already turns this into the
   `tesla.com/_ak/<domain>` pairing instructions. Two separate sources, kept
   separate on purpose: the deep link format `https://tesla.com/_ak/<domain>`
   is confirmed against `vehicle-command`'s own README ("provide vehicle
   owners with a link to `https://tesla.com/_ak/<your_domain_name>`"; the
   `?vin=...` query param fleet.py's message doesn't even add is a plausible
   extension, not something the README states — don't cite the README for
   it). The public key hosting path,
   `/.well-known/appspecific/com.tesla.3p.public-key.pem`, is **not** in that
   README — it's confirmed against Tesla's own
   `developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide` instead
   (verified via WebFetch, Aug 2026). Don't re-derive either — check
   `TESLA_APP_DOMAIN` matches what's actually paired before assuming the
   proxy is broken.
4. A command that returns HTTP 200 with `{"result": false, "reason": "..."}` is
   Tesla's other failure shape — no exception, just a falsy result with a human
   reason string. `set_seat_heater` already special-cases one instance of this
   ("cabin comfort remote settings not enabled" → start climate, retry once).
   If you hit a new one, check `result`/`reason` explicitly rather than trusting
   a 200 to mean success.

## 5. Standing deprecation warning

Tesla deprecates vehicle commands without much notice. The one already recorded
in this codebase: `set_scheduled_charging` and `set_scheduled_departure` are
documented "not recommended beginning with firmware version 2024.26," in favor
of `add_charge_schedule` / `add_precondition_schedule` / `remove_charge_schedule`
/ `remove_precondition_schedule` (see `fleet.py`'s comment above
`list_schedules`, and `adapter.py`'s comment above the schedule methods) — this
project already uses only the new trio. Before adding any new command, check
whether the vehicle-commands doc page marks it deprecated/not-recommended and
say so in the code comment if it does, the same way the existing schedule
methods do. Don't assume a command's absence from Tesla's examples means it's
new — it may mean it was just removed.

## 6. Verifying a change

There's no automated check that exercises `FleetImpl` against a real car — the
`backend/dev/check_*.py` scripts all run against `MockImpl`
(`TESLA_ADAPTER=mock`, e.g. `check_wake.py`'s wake-wiring test). The only way to
validate a `fleet.py` change against the real API is `npm run api:fleet`
against the owner's actual car, or asking the owner to confirm on `localhost`
per the standing memory note. Say so explicitly rather than implying a fleet.py
change was "tested."

Cross-check any new fleet.py code against `reference/endpoints.md`'s "project
notes" column, which records where fleet.py already matches or diverges from
documented behavior — this skill documents fleet.py, it does not edit it.

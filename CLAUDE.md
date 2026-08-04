# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Amp" — a voice/chat AI assistant for one owner's Tesla Model 3. An Expo (React Native + web PWA) frontend talks to a FastAPI backend, which turns natural language into Tesla Fleet API calls via an LLM (Gemini default, Anthropic alternative) doing tool-calling. Self-hosted on a small VM behind Caddy. Bilingual Polish/English throughout.

## Documentation map

CLAUDE.md is a router. Read the deep-dive before working in a subsystem — each one is written from the source and records the incidents that shaped the design.

| Doc | Read it before |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Touching the backend at all. Request lifecycle, both provider seams, tools/dispatch, scheduler, the two voice paths, full route table. |
| [docs/security.md](docs/security.md) | Touching `actions.py`, `confirm_phrase.py`, `auth/`, `tools.py`, or anything that reaches the car. The trust model and every invariant a reviewer can check. |
| [docs/deployment.md](docs/deployment.md) | Deploying, changing containers/Caddy/certs, or adding an env var. |
| [docs/frontend.md](docs/frontend.md) | Working in `mobile/`. Screens, session lifecycle, the voice stack, i18n, PWA build. |

## Commands

From the repo root:

```bash
npm run api          # backend :8123, TESLA_ADAPTER=mock (no real car needed)
npm run api:fleet    # backend :8123, against the real Tesla Fleet API
npm run web          # Expo web :8090, pointed at localhost:8123
```

First-time backend setup:

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cp .env.example .env
```

Deploy (both arguments required):

```bash
./deploy.sh <IP_ADDRESS> <SSH_KEY_PATH>
```

### Tests

There is no pytest/jest suite, no runner, and no CI. The tests are standalone adversarial-case scripts whose case lists record *measured* failures rather than hypotheses. Each script's docstring states its own invocation — check it, because the working directory matters and differs between the two trees.

```bash
cd backend && ./.venv/bin/python dev/check_confirm_phrase.py
cd backend && TESLA_ADAPTER=mock ./.venv/bin/python dev/check_voice_confirm.py
cd mobile  && node dev/check_spoken_turn.js
```

`backend/dev/` covers confirm-phrase, voice-confirm, persona, persona/prefs stores, live tools, named places, wake and history. `mobile/dev/` covers live-session end and spoken-turn length. Running these from the repo root does **not** work: the mobile scripts resolve `node_modules/typescript` from `process.cwd()`, and `deploy/check-routes.py` needs the venv's `fastapi` — under a system `python3` it prints "route check skipped" and exits 0, which reads as a pass while checking nothing.

When you change logic a script covers, run it and add cases to its `CASES` list. Do not write a parallel ad hoc check.

## The seams

Two abstractions carry the design; everything else follows from them.

**`TeslaAdapter`** ([backend/app/tesla/adapter.py](backend/app/tesla/adapter.py)) — the boundary between provider-agnostic assistant logic and actually talking to a car. `MockImpl` (in-memory, all local dev) and `FleetImpl` (real API through a self-hosted signing proxy); `build_adapter()` picks one from `TESLA_ADAPTER`. Nothing above this interface knows which is live.

**`build_orchestrator()`** ([backend/app/llm/\_\_init\_\_.py](backend/app/llm/__init__.py)) — the same pattern for the LLM. Both orchestrators expose one method, `chat(user_text, history) -> {reply, history, tool_trace}`, with provider-native but JSON-serializable history the client persists and replays. History must not cross providers.

[backend/app/tools.py](backend/app/tools.py) holds the LLM-facing schemas, each mapping ~1:1 to an adapter method — it is effectively the Fleet API scope surface, so keep it small. Anything composing several adapter calls or needing the scheduler belongs in [backend/app/actions.py](backend/app/actions.py) instead, so `tools.py` stays a flat name→adapter mapping.

## Invariants that must not be broken

These are load-bearing. Several look like over-engineering and are not; see [docs/security.md](docs/security.md) for the reasoning behind each.

- **The model may propose a physical command, never execute one.** Everything in `actions.CONFIRM_REQUIRED` is parked server-side and executed only by a separate endpoint a human taps. Charger and place lookups return attacker-editable free text (OSM/Nominatim) into the model's context, so a system-prompt instruction is guidance, not a control.
- **`confirm_phrase.classify()` stays a pure function with no imports beyond `re`.** There is no `confirm` tool and there must never be one — the moment a model can decide consent happened, injected text can decide it too. Whole-utterance match only, both languages always accepted.
- **Accepted confirmation words must match the visible button labels** (`confirmYes` in [mobile/src/i18n.ts](mobile/src/i18n.ts)). The rule is "the word you say is the word you can see" — no magic phrases, and no command words in the confirm list.
- **`unlock` stays out of `VOICE_CONFIRMABLE`.** Voice carries further than a finger.
- **Climate and charging stay ungated.** They are reversible and cost only energy; gating them trains the owner to tap "confirm" without reading, which is how the habit stops being a safeguard.
- **`main.py` gates by allowlist, not blocklist**, keyed on `(method, path)` rather than path alone — so a route added later is protected by default.
- **A new backend route needs a `handle` block in [deploy/Caddyfile](deploy/Caddyfile)** in the same change. Caddy's catch-all sends unlisted paths to the static frontend, so a missing block ships as a 404 that looks like a broken app. This shipped twice before `deploy/check-routes.py` existed.
- **`backend/data/` stays owned by uid 10001** to match the container's unprivileged user. A mismatch fails silently as a forced Tesla re-login after every deploy, not as a visible error.

## Conventions

- Comments explain **why**, and usually cite a specific past incident or measured failure. Match that. Do not add comments that restate what the code does, and do not trim the long ones — they are the design record.
- Polish and English are both first-class (prompts, confirmation words, UI strings). The app's language setting says what to *reply* in, not what the driver will *say*.
- Adding a `TeslaAdapter` method means implementing it in **both** `MockImpl` and `FleetImpl`, plus a tool schema and dispatch entry in `tools.py` if the model should be able to call it.
- Tool descriptions must be precise enough that the model does not fill gaps from general knowledge. It once reported a charger's power as "up to 250 kW" — a figure the Fleet API never returns.

## Project skills

Invoke with `/<name>`; each one reads the source before it reports.

| Skill | Use for |
|---|---|
| `code-review` | Reviewing a diff against this repo's subsystem invariants, running the matching check scripts. |
| `tech-debt` | A ranked, evidence-backed debt list — and what only *looks* like debt but is deliberate. |
| `new-feature` | Gap analysis against the adapter/tool surface. Returns "No useful feature found" when nothing clears the bar. |
| `tesla-api` | Confirming a Fleet API endpoint, scope, or signing requirement before writing it. Has a verified endpoint table in `reference/endpoints.md`. |

## Automated guards

[.claude/settings.json](.claude/settings.json) installs three hooks: editing `confirm_phrase.py` or `actions.py` re-runs both confirm-phrase check scripts and blocks on failure; editing `main.py` runs `deploy/check-routes.py`; a `Stop` hook fires a desktop notification.

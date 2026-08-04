---
name: tech-debt
description: Surveys and ranks technical debt in the tesla-agent repository (backend FastAPI + Expo/React Native frontend). Trigger when the user asks about tech debt, cleanup, refactoring opportunities, "what should we fix", code health, or wants a prioritized list of things to pay down. Produces a ranked, evidence-backed report with file:line citations, not general advice. Do NOT use this for a single-file code review of a diff (use code-review instead), for a security audit (use claude-security:scan), or when the user just wants one specific bug fixed — this skill is for standing-back structural assessment across the repo.
---

# Tech debt survey for tesla-agent

This repo is small, self-hosted, and single-owner. Debt here is not "this file is
long" in the abstract — it's "this specific thing will bite on the next touch, and
here is the touch that will do it." Every item you report must be re-verified
against current source, because this repo changes fast (main.py alone has 21
commits in recent history) and a stale line number or a "fixed already" item makes
the whole report untrustworthy.

## Step 0 — protect what looks like debt but isn't

Before surveying, internalize the deliberate design choices so you never recommend
"cleaning up" a safeguard. If your survey produces any of these as findings, drop
them, don't just downrank them:

- **`backend/app/confirm_phrase.py` being a tiny (~63 line) standalone module with
  exactly one import site** (`main.py` imports it for the voice-confirmation route).
  It is a pure regex classifier with no LLM in the loop, by design — the transcriber
  has been measured hallucinating full sentences out of engine noise, so the
  confirm/cancel decision must not go through the model. Small + single-caller here
  means "load-bearing and easy to audit," not "should be merged into main.py" or
  "under-used."
- **The long WHY-comments throughout** (e.g. `actions.py`'s block on why climate/
  charging are excluded from `CONFIRM_REQUIRED`, why `unlock` is excluded from
  `VOICE_CONFIRMABLE`) are house style, not verbosity to trim. They cite specific
  past incidents/decisions. Never propose shortening them.
- **The allowlist-not-blocklist in `main.py`** (paths reachable without a session)
  is deliberately a tiny allowlist rather than a blocklist — the comment there
  explains a `DELETE /gate/passkey/{credential_id:path}` incident that a
  path-only blocklist would have missed. Don't propose "simplifying" it into a
  blocklist or a decorator-based path-only check.
- **`TeslaAdapter`'s breadth** (`backend/app/tesla/adapter.py`, currently ~225
  lines, ~41 abstract methods) mirrors the Fleet API's own surface. A "narrower
  interface" refactor would just push the same breadth into call sites.
- **`MockImpl` existing at all** is not dead code — `npm run api` runs against it
  by default for dev, and the `dev/check_*.py` scripts exercise it. Don't flag it
  as unused just because `TESLA_ADAPTER=mock` isn't the production setting.
- **Never** propose any refactor whose effect is that the LLM (or the scheduler,
  or any code path other than the human-tapped confirm endpoint) could execute a
  `CONFIRM_REQUIRED` command without going through the confirm/tap gate. This
  includes seemingly-innocent DRY refactors that collapse `dispatch` and
  `dispatch_unguarded` in `tools.py`, or that let the scheduler call
  `dispatch_unguarded` directly. `tools.py` states only two callers may use
  `dispatch_unguarded`; keep it that way.

## Step 1 — re-verify each known signal, don't assume it still holds

Run these checks fresh. Report a signal only if the check still confirms it; note
explicitly when a previously-known signal has been fixed since (that's useful
information too — say so, don't silently drop it).

```bash
# route/schema concentration
wc -l backend/app/main.py backend/app/tools.py

# no test runner / no CI / no linter or formatter config, either language
ls backend/dev/check_*.py mobile/dev/check_*.js 2>/dev/null
find . -iname ".github" -maxdepth 2 -not -path "*/node_modules/*"
find . -maxdepth 1 -iname "*.yml" -path "*workflows*"
find . -maxdepth 3 \( -iname ".eslintrc*" -o -iname "eslint.config*" -o -iname ".prettierrc*" \
  -o -iname "pyproject.toml" -o -iname ".flake8" -o -iname "ruff.toml" \) -not -path "*/node_modules/*"

# duplicated state-normalization between the two adapters
grep -n "_normalize\|^    def " backend/app/tesla/mock.py backend/app/tesla/fleet.py

# two voice paths
wc -l backend/app/voice.py backend/app/live.py

# duplicate tts-cache directories (one at repo root, one under backend/)
# maxdepth must be 3 here: backend/data/tts-cache is 3 levels down from ".",
# and maxdepth 2 silently stops one level short and misses it.
find . -maxdepth 3 -iname "tts-cache" -not -path "*/node_modules/*"

# committed secrets/keys — check with git ls-files, NOT just `find`, since a
# directory can carry its own nested .gitignore that hides it from `git status`
# (this happened with CLAUDE-SECURITY-*/ once — verified 2026-08 it hides itself
# via CLAUDE-SECURITY-*/.gitignore, so also `find . -iname "CLAUDE-SECURITY*"`
# to see it still sits in the tree even though git doesn't track it)
git ls-files backend/.env deploy/certs deploy/keys 2>&1
find . -iname "CLAUDE-SECURITY*" -maxdepth 1 -not -path "*/node_modules/*"
cat .gitignore
```

As of the last verified pass (2026-08-04): `backend/.env`, `deploy/certs/`, and
`deploy/keys/` are all gitignored and NOT tracked by git — only
`backend/.env.example` is tracked, which is correct and not a debt item. Do not
report "committed secrets" unless `git ls-files` actually shows them tracked at
the time you run it. The `CLAUDE-SECURITY-<timestamp>/` report directory does
still sit in the working tree on disk (confirmed via `find`) even though it's
invisible to `git status` because it ships its own `.gitignore` — that's worth
flagging as clutter regardless of git-tracking status, since it's still taking
up space in the tree the owner sees.

## Step 2 — rank

For each surviving item, score:

```
priority = (blast radius if it bites) x (how often that area is touched) / (cost to fix)
```

Get "how often touched" from real churn, not guesswork:

```bash
git log --format=format: --name-only | grep -v '^$' | sort | uniq -c | sort -rn | head -20
```

Write the reasoning per item inline — e.g. "`main.py` is the single most-modified
backend file (21 commits) and holds every route; a new route is one more line in
an 886-line file with no test to catch a missed Caddy handle block or a missed
allowlist entry — high blast radius, high touch frequency, moderate cost to fix
(split by resource, keep the allowlist and lifespan wiring central) → high
priority."

## Step 3 — report format

For each ranked item, give exactly these fields:

1. **Evidence** — file:line (verified this run, not remembered from a prior one).
2. **Failure it invites** — a concrete scenario, not "poor maintainability."
   E.g. for the missing CI/linters: "a change to `tools.py`'s tool schema list
   ships with a typo'd JSON key and nothing catches it until the LLM call fails
   at runtime against the real Fleet API."
3. **Smallest useful fix** — the minimal change, not a rewrite. E.g. for
   `dev/check_*.py` having no runner: "add one `dev/run_checks.sh` that loops
   `backend/.venv/bin/python dev/check_*.py` and exits nonzero on first failure —
   not a pytest migration."
4. **Honest cost estimate** — hours, and say what makes it more/less than that
   (e.g. "20 min if it's just a shell loop; longer if any check script has
   hidden shared state that makes order matter").

Order the final list by priority score, highest first. Do not pad the list —
if a formerly-known signal (e.g. committed secrets) no longer holds, say so in
one line and omit it from the ranking rather than working around the fact that
it's gone.

## Known signals as of the last verified pass (2026-08-04) — re-check, don't trust

- `backend/app/main.py`: 886 lines, every route + gate allowlist + lifespan.
- `backend/app/tools.py`: 767 lines, 42 tool schemas + the `dispatch`/
  `dispatch_unguarded` split.
- No CI workflow directory, no `.eslintrc*`/`eslint.config*`/`.prettierrc*` for
  the mobile TS side, no `pyproject.toml`/`.flake8`/`ruff.toml` for the backend.
- `backend/dev/check_*.py` (9 scripts) and `mobile/dev/check_*.js` (2 scripts)
  each have no shared runner — each is invoked by hand,
  `./.venv/bin/python dev/check_confirm_phrase.py` style.
- `backend/app/tesla/mock.py` and `backend/app/tesla/fleet.py` both carry their
  own state-normalization logic (`fleet.py` has `_normalize`, `_normalize_chargers`,
  `_summarise_schedules`, `_clean_label`, `_coords`; `mock.py` has its own
  `_add_schedule` and inline shaping) with no shared normalizer module between
  them — a field-shape fix made in one does not propagate to the other.
- `backend/app/voice.py` (451 lines, turn-based) and `backend/app/live.py`
  (371 lines, realtime) are two independent implementations of "the user talks
  to the car," each with their own tool-routing and transcription handling.
- Two `tts-cache` directories exist side by side: `./data/tts-cache` (repo root,
  gitignored via `/data/`) and `./backend/data/tts-cache` (gitignored via
  `backend/data/`) — which one gets used depends on the cwd the backend was
  started from; confirm which is live before assuming either is genuinely stale.
- `CLAUDE-SECURITY-20260729-113757/` sits in the repo root on disk; not tracked
  by git (it ships a nested `.gitignore` that hides itself).

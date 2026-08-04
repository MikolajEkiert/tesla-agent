---
name: code-review
description: Reviews changes, a diff, or a branch in the tesla-agent repository (the
  Tesla Model 3 voice/chat assistant — Expo frontend, FastAPI backend, Gemini/Anthropic
  tool-calling, Fleet API through a signing proxy). Trigger when the user asks to review
  a diff, PR, branch, or "what I just changed" in this repo. Runs subsystem-specific
  invariant checklists (adapter parity, Caddy route coverage, the confirmation gate,
  confirm_phrase purity, tool-schema honesty, prompt/persona boundaries, auth allowlist
  direction, mobile i18n and credentials, deploy uid/network isolation) and the relevant
  dev/check_*.py and mobile/dev/*.js scripts, then reports findings most-severe-first.
  This is a project-specific supplement, not a replacement for the built-in /code-review —
  run both when doing a full review; this one exists because the built-in one does not
  know this repo's invariants. Do not use it for generic style review with no diff, or
  for reviewing code in a different repository.
---

# tesla-agent code review

This repo moves a real car. Its safety property is not "the code compiles" — it is
"the model can never single-handedly unlock the door, open the trunk, or fire
HomeLink," enforced by a server-side gate that a prompt cannot talk its way around
(see `backend/app/actions.py`). A finding that weakens that gate outranks every
style or efficiency finding in this review, always, no exceptions — say so in the
report if such a finding exists.

This skill supplements, and does not replace, the built-in `/code-review`. Run both
for a full review; this one encodes invariants specific to this codebase that a
generic reviewer has no way to know.

## Procedure

### 1. Establish the diff and classify touched files

```
git status
git diff master...HEAD    # or git diff master if reviewing the working tree
```

Bucket every changed file into the subsystems below. A file can land in more than
one bucket (e.g. `main.py` touches both "new route" and, if it imports actions,
"confirmation gate").

### 2. Run the subsystem checklist for every bucket that has a changed file

**`backend/app/tesla/adapter.py` (the `TeslaAdapter` ABC) changed, or a new
adapter method appears anywhere**
- Is the new abstract method implemented in *both* `backend/app/tesla/mock.py` and
  `backend/app/tesla/fleet.py`? A method on the ABC with only one implementation
  breaks the "nothing above the seam knows which provider it's talking to" promise
  and will explode at runtime on whichever backend didn't get it.
- If the model should be able to call it: is there a matching entry in `TOOLS` in
  `backend/app/tools.py`, *and* a dispatch-table line in `dispatch_unguarded`
  (same file, ~line 677)? A tool schema with no dispatch entry is a call the model
  can make that raises; a dispatch entry with no schema is dead code the model can
  never reach.
- If the new command is physically consequential (locks, trunk, windows, HomeLink,
  sentry, software update): does `backend/app/actions.py` `CONFIRM_REQUIRED` gate
  it? (see checklist below — this is the single most important line item in the
  whole review.)

**A new `@app.<verb>` route in `backend/app/main.py`**
- Does `deploy/Caddyfile` have a `handle` block that covers it? Caddy's catch-all
  sends anything unlisted to the static frontend, which answers with an nginx 404
  that looks like a broken app, not a routing gap — this has shipped twice before
  (`/jobs`, then `/gate/*`). Verify by running the checker, not by eyeballing:
  ```
  cd /Users/mikolajekiert/Desktop/tesla-agent
  backend/.venv/bin/python deploy/check-routes.py
  ```
  Use `backend/.venv/bin/python`, not a bare `python3` — the script needs
  `fastapi` importable to actually check anything, and silently no-ops (exit 0,
  prints "route check skipped") without it. The system `python3` on the dev
  machine used to write this skill has no `fastapi` on its path, so this is
  not a hypothetical — it would look like a clean pass while checking nothing.
- Is the route's presence in (or deliberate absence from) `PUBLIC_ROUTES` in
  `main.py` (~line 63) intentional? `PUBLIC_ROUTES` is a tiny allowlist keyed on
  `(method, path)`, not a blocklist and not path-only — a route silently missing
  from it is protected by default (correct), but a route that *should* be public
  (e.g. something Tesla itself fetches, like `/.well-known/`) and isn't listed
  will break in production in a way mock/dev testing won't show.
- Does it need `TOKEN_ROUTES` (the Apple Shortcut bearer-token allowance, ~line
  79)? That set currently holds exactly one route, `POST /voice/ask`, on purpose —
  Siri can ask questions and start reversible things, but never reach
  `/actions/confirm`. Adding a second route to `TOKEN_ROUTES`, or adding
  `/actions/confirm`-adjacent routes to it, is a red flag: flag it explicitly and
  ask why voice/Shortcut access needs to reach further than a question.

**`backend/app/actions.py` — `CONFIRM_REQUIRED` / `VOICE_CONFIRMABLE` changed**
This is the file whose whole job is stopping prompt injection (via attacker-editable
OSM/Nominatim text in tool results) from opening the car. Treat any diff here as
high severity by default and check:
- Is anything being *removed* from `CONFIRM_REQUIRED`? That's a command the model
  could previously only propose and can now execute unattended — demand a specific
  justification for each one, referencing why it's no longer "physical, immediate,
  and hard to undo."
- Is `unlock` still absent from `VOICE_CONFIRMABLE`? `VOICE_CONFIRMABLE =
  CONFIRM_REQUIRED - {"unlock"}` is the whole reason `unlock` can only be tapped,
  never spoken — voice carries further than a finger, past the driver to anyone
  standing near the car. `unlock` reappearing in that set is a severe finding.
- Has anything *reversible* (climate, charging) been added to `CONFIRM_REQUIRED`?
  The module's own comment explains why this is a real cost, not caution for its
  own sake: gating a reversible action trains the owner to tap "confirm" without
  reading, which erodes the habit for the commands that actually matter. Flag it
  even though it looks "safer" on its face.
- Did `PENDING_TTL_S` (120s) or `VOICE_WINDOW_S` (25s) change? The voice window
  must stay meaningfully shorter than the tap TTL — the spoken path is supposed to
  be strictly weaker (same cookie, shorter window, one attempt, smaller command
  set). Widening it narrows that gap.

**`backend/app/confirm_phrase.py` changed**
- Is `classify()` still a pure function of a string, importing nothing beyond
  `re`? Any new import — especially anything that could reach the LLM, the
  network, or the adapter — breaks the load-bearing property: the confirm/cancel
  decision must be made by code that cannot be talked into anything.
- Is there still no `confirm` tool anywhere in `backend/app/tools.py`? A `confirm`
  tool would let the model itself decide consent happened, which means injected
  text in a tool result could decide it too, and the gate in `actions.py` stops
  meaning anything. This is worth a dedicated grep:
  ```
  grep -n '"confirm"' backend/app/tools.py
  ```
- Is matching still whole-utterance (`re.fullmatch`, not `search`/`match`)? The
  measured failure this guards against is the transcriber hallucinating fluent
  full sentences out of engine noise — a substring match would be a much larger
  target.
- Are both Polish and English still accepted unconditionally, regardless of the
  app's language setting? The owner's spoken language and the UI's language
  setting are unrelated.
- Did the author run and, if word lists changed, add cases to:
  ```
  cd backend && ./.venv/bin/python dev/check_confirm_phrase.py
  ```

**`backend/app/tools.py` changed**
- Does the new/changed tool widen the Fleet API scope surface? The file's own
  header says this list *is* the scope surface — a new tool is a new thing the
  model can ask the real car to do, so it should map cleanly to one adapter
  method and nothing broader.
- Is the tool description precise enough that the model won't guess a value the
  API doesn't return? There is a recorded incident: asked a charger's power, the
  model answered "up to 250 kW" from general Supercharger knowledge because
  Tesla's API returns no power field at all — see the comment in
  `backend/app/llm/prompt.py` around line 27 and the analogous guidance in
  `backend/app/chargers.py` (~line 85) about not collapsing Supercharger and
  destination-charger power ranges. A new tool whose description invites the
  model to fill a gap from "what it knows" instead of "what the tool returned"
  is the same failure mode recurring.
- If the tool takes a numeric argument, is it in `NUMERIC_BOUNDS` (top of the
  dispatch section, ~line 600) so `_validate` actually enforces a range, rather
  than relying on the JSON-schema `minimum`/`maximum` alone (which the model can
  be talked past, unlike server-side validation)?

**`backend/app/llm/prompt.py` or `backend/app/llm/persona.py` changed**
- Is anything being asked of the *prompt* that should be a *control*? Both files
  say this explicitly in their module docstrings: the confirmation gate is not in
  the prompt at all, it's in `actions.py`, on the server, precisely because "the
  prompt is guidance, not a control." A diff that tries to enforce something
  safety-relevant by adding prompt wording instead of code is the failure this
  architecture was built to avoid — flag it even if the wording is well-written.
- If `persona.py` changed: does `_custom_instruction` (owner-supplied persona
  text, attacker-reachable input) still get sanitized/wrapped before being
  concatenated into the system prompt? Does the slur exclusion in `_VULGAR`
  remain hard-coded rather than something the custom-persona path can edit out?
- Does the guard sentence inside `_custom_instruction` still name slurs
  explicitly (not just a generic "ignore earlier rules"), so a custom persona
  that asks the model to use slurs is caught by wording that says so, rather
  than relying on a vaguer instruction to cover it implicitly? Diff the exact
  guard sentence, word for word — a refactor that trims it for length is an
  easy way to silently drop the slur clause specifically while leaving the
  sentence looking intact.

**Anything touching `backend/app/auth/` (`gate.py`, `oauth.py`, `passkey.py`)**
- Allowlist direction: `PUBLIC_ROUTES`/`PUBLIC_PREFIXES` actually live in
  `main.py`, not in this directory — but a change to `gate.py`'s shortcut-token
  or session logic often accompanies a matching route change, so check both
  together. `main.py`'s own comments (just above `PUBLIC_ROUTES`, ~line 55)
  record a past near-miss: a path-only allowlist once let an unauthenticated
  `DELETE /gate/passkey/login/begin` reach the delete handler. Confirm any new
  public entry is `(method, path)`, not path alone.
- Session cookie: does `COOKIE_NAME` / `issue_session` / `session_is_valid` still
  set `credentials`/cookie flags consistent with the existing session flow? Don't
  let a diff loosen cookie scope or drop `HttpOnly`/`Secure`-equivalent behavior
  without it being the explicit point of the change.
- Lockout: does a new failure path (e.g. a new token check) still call
  `gate.record_failure` / `gate.is_locked_out` the way `TOKEN_ROUTES` handling in
  `main.py` does? An unrated-limited guessing oracle is exactly the bug the
  existing lockout-sharing was written to close.
- `auth/gate.py` (who may talk to this server) and `auth/oauth.py` (this server
  authenticating to Tesla) are two unrelated layers — a fix that conflates them
  (e.g. using an OAuth token as a session credential or vice versa) is a
  correctness bug, not just a style issue.

**Mobile changes (`mobile/src/**`)**
- Does every new `fetch()` call in `mobile/src/api.ts` that hits a
  session-protected route pass `CREDENTIALS` (`{ credentials: "include" }`),
  matching the existing pattern? A call that forgets it will look fine in a
  browser tab that still has a live cookie and fail confusingly for a real user.
- Are new user-facing strings added to *both* locales in `mobile/src/i18n.ts`
  (`en` and `pl` objects)? Grep for the new key to confirm both sides exist:
  ```
  grep -n '<newKeyName>' mobile/src/i18n.ts
  ```
- If a new component surfaces a `CONFIRM_REQUIRED` action, does it go through the
  existing `ConfirmCard`/`ConfirmDialog` flow rather than a new bespoke one, so
  it inherits the same tap-to-confirm behavior?

**`deploy/` or `Dockerfile` changes**
- `backend/Dockerfile` runs as uid 10001 (`amp`). Does any new bind mount or data
  directory get chowned to that same uid, matching what `deploy.sh` does for
  `/app/data`? A mismatch surfaces as silent write failures — a forced re-login
  after every deploy — not an obvious error.
- Does `deploy/docker-compose.yml`'s `signing` network still isolate only `api`
  and `tesla-proxy`? That isolation is what makes a `connection refused` (rather
  than a reachable virtual-key endpoint) the failure mode for anything else on
  the compose network trying to reach the proxy directly. A new service joining
  that network, or the proxy gaining a port on the default network, is a
  regression in the isolation boundary — flag it.
- Any new backend route from step 2 also needs the Caddyfile + check-routes.py
  pass above; deploy changes are a natural place for that to be missed.

### 3. Run the dev checks relevant to what changed

Map from changed file to check script, and run every script whose row is hit:

| Changed file | Run |
|---|---|
| `backend/app/confirm_phrase.py` | `cd backend && ./.venv/bin/python dev/check_confirm_phrase.py` |
| `backend/app/actions.py` (voice confirm path) | `cd backend && TESLA_ADAPTER=mock ./.venv/bin/python dev/check_voice_confirm.py` |
| `backend/app/tesla/adapter.py`, `mock.py`, `fleet.py`, or anything wake-related | `cd backend && ./.venv/bin/python dev/check_wake.py` |
| `backend/app/live.py`, or `tools.py` dispatch table | `cd backend && ./.venv/bin/python dev/check_live_tools.py` |
| `backend/app/places.py` | `cd backend && ./.venv/bin/python dev/check_named_places.py` |
| `backend/app/llm/persona.py` | `cd backend && ./.venv/bin/python dev/check_persona.py` |
| `backend/app/persona_store.py` | `cd backend && ./.venv/bin/python dev/check_persona_store.py` |
| `backend/app/prefs_store.py` | `cd backend && ./.venv/bin/python dev/check_prefs_store.py` |
| `backend/app/main.py` chat/history handling | `cd backend && ./.venv/bin/python dev/check_history.py` |
| Any new/changed `@app` route | `cd /Users/mikolajekiert/Desktop/tesla-agent && backend/.venv/bin/python deploy/check-routes.py` |
| `mobile/src/voice/vad.ts` or spoken-turn length/plural logic | `cd mobile && node dev/check_spoken_turn.js` |
| `mobile/src/voice/live.ts` or the live-tool round trip | `cd mobile && node dev/check_live_end.js` |

The mobile checks read `node_modules/typescript` off `process.cwd()`, so they
only find it run from `mobile/` — `node mobile/dev/check_spoken_turn.js` from
the repo root throws `Cannot find module '.../node_modules/typescript'`
instead of running anything; verified by running it both ways.

`deploy/check-routes.py` needs `fastapi` importable to actually check
anything; it is written to *skip itself* rather than block a deploy when the
import fails, printing `route check skipped (ModuleNotFoundError: ...)` and
exiting 0. On a plain `python3` with no `fastapi` on the path (the system
`python3` on at least one dev machine used for this repo), that means `python3
deploy/check-routes.py` looks like a clean pass while never having checked a
single route — always run it with `backend/.venv/bin/python`, and treat a
"skipped" line in the output as a check that did not run, not as a pass.

If a relevant script fails, that is a finding on its own — report the failure
output, don't just note "tests fail."

### 4. Report

Order findings most severe first. For each: state the concrete failure scenario
(what input or sequence of actions produces the wrong outcome — not just "this
looks wrong"), which file/line, and which checklist item it violates. A finding
that touches `CONFIRM_REQUIRED`, `VOICE_CONFIRMABLE`, `confirm_phrase.classify`,
or the `PUBLIC_ROUTES`/`TOKEN_ROUTES` allowlists is reported first regardless of
how many other findings exist, and is called out explicitly as a gate-safety
finding rather than folded in with the rest.

If a subsystem's checklist and its dev check both pass, say so plainly rather
than staying silent — "confirmation gate: unlock still absent from
VOICE_CONFIRMABLE, check_voice_confirm.py passes" is a real, useful line in the
report. If nothing was found across every touched subsystem, say that plainly
too: "no findings" is a valid and expected result of this review, not a sign the
review wasn't thorough enough.

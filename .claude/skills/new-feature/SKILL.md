---
name: new-feature
description: Proposes what to build next in this Tesla-agent repo, grounded in an actual gap analysis of backend/app/tesla/adapter.py, tools.py, actions.py, scheduler.py and mobile/src/screens. Trigger when the user asks what to build next, for feature ideas, for the highest-value thing to add, or "what's missing" / "what should I work on". Do NOT trigger for a specific bug report, a specific feature the user already named, or a request to review/refactor existing code — those go straight to the normal edit flow. This skill's job is to find genuinely new capability gaps and hold them to a high bar; saying "No useful feature found" is a correct and common outcome, not a failure to try harder.
---

# New Feature Proposal

This is a single-owner, single-car hobby project already wired tightly:
`tools.py`'s own docstring says every tool "maps 1:1 to a TeslaAdapter method,"
and as of the last audit every `TeslaAdapter` abstract method has a matching
entry in `tools.py`'s `TOOLS` list and dispatch table, and every tool name in
`tools.py` has a matching entry in `mobile/src/toolMeta.ts`. That means the
easy version of this exercise — "adapter has X, no tool calls it" — usually
comes back empty. Expect that. Do not manufacture a gap to have something to
say; a genuine gap is rarer here than in most codebases, and the whole value
of this skill is refusing to paper over that.

## Procedure

1. **Re-run the gap analysis from source, every time.** The code changes
   between invocations; never rely on the paragraph above without checking it
   still holds.
   - Read `backend/app/tesla/adapter.py`: list every `@abstractmethod` on
     `TeslaAdapter`.
   - Read `backend/app/tools.py`: list every entry in `TOOLS` and every key in
     the `handlers` dict inside `dispatch_unguarded`.
   - Cross-reference the two lists both ways:
     - An adapter method with no tool name calling it = a capability the car
       can do that the model can never invoke. That is the strongest possible
       kind of finding.
     - A tool with no adapter method behind it doesn't happen (dispatch would
       throw `Unknown tool`) — skip this direction.
   - Read `backend/app/actions.py` for `CONFIRM_REQUIRED` and
     `VOICE_CONFIRMABLE`: any gap you found that touches one of those names is
     already reachable-in-principle, just gated — that's a UI/plumbing gap,
     not a missing-capability one.
   - Read `mobile/src/toolMeta.ts`'s `META` map and `mobile/src/screens/*.tsx`
     (`ChatScreen.tsx`, `SettingsScreen.tsx`, `ConnectScreen.tsx`,
     `PasscodeScreen.tsx`) and `mobile/src/components/InstrumentStrip.tsx`.
     There is no per-feature screen in this app — almost everything surfaces
     as a chat log line via `toolMeta` or a structured card
     (`ConfirmCard.tsx`, `InstrumentStrip.tsx`). A real UI gap here looks like:
     a tool exists and dispatches fine, but its result is informational and
     rich (a list, a history, a set of options) and today it can only be
     read back as prose in the chat — e.g. compare how `list_schedules` /
     `list_scheduled_actions` results are shown versus a one-line `lock`
     acknowledgment. Missing `toolMeta` entries are not expected to exist
     (verify), so don't report that as the finding by itself.
   - Read `backend/app/scheduler.py`'s module docstring for what a "group" of
     jobs already is (`schedule_group`, `list_groups`, `cancel_group`) before
     proposing anything time-based — a lot of "notify me when X" ideas are
     already just a new job kind on the existing runner, not a new layer.
   - Skim `backend/app/config.py`'s `Settings` for which Fleet API pieces are
     already wired (`tesla_proxy_url`, OCM key, Google Places/TTS keys) versus
     what a proposal would newly require.

2. **Apply the admission bar. A proposal must clear every item, not most:**
   - **Reachable today.** Implementable against the Fleet API scopes and
     adapter surface that already exist, or against a clearly named small
     addition to `adapter.py` (one or two new methods with a Fleet/mock
     implementation each) — not a new subsystem, not a guess at an
     undocumented endpoint.
   - **Single owner, single car.** No sharing, no multi-user accounts, no
     "analytics at scale," no fleet management. If the pitch reads better for
     a product than for one person's daily car use, reject it.
   - **No new execute authority over a `CONFIRM_REQUIRED` command.** The
     model may gain a new *read* or a new *proposal*, never a new path that
     lets it or a scheduled job execute `unlock`, `actuate_trunk`,
     `trigger_homelink`, `control_windows`, `set_sentry_mode`, or
     `software_update` without the existing human-tap (or the existing,
     already-scoped voice) confirmation. See `actions.py`'s module docstring
     for why: charger/place tool results are attacker-editable free text.
   - **No new architectural layer.** Fits into the seams that exist:
     `TeslaAdapter` method + `tools.py` entry (+ `NUMERIC_BOUNDS` if numeric)
     + dispatch handler, optionally an `actions.py` composition or a
     `scheduler.py` job, optionally a Caddyfile handle block if it needs a new
     backend route. Not a new database, not a new background service outside
     the existing `scheduler.py` runner, not a new auth layer beside
     `auth/gate.py` and `auth/oauth.py`.
   - **Beats just doing it in Tesla's own app.** State explicitly why asking
     the assistant is better than the three-tap path in Tesla's app for this
     specific action — voice while driving, composing several car actions
     with local context (weather, calendar, "I'm about to leave"), or
     surfacing something Tesla's app buries. If the honest answer is "about
     the same," reject it.

3. **For each survivor, report:**
   - **Behaviour**: one sentence, what the owner sees or says and what happens.
   - **Files that change**: exact paths (e.g. `backend/app/tesla/adapter.py`,
     `backend/app/tesla/mock.py`, `backend/app/tesla/fleet.py`,
     `backend/app/tools.py`, `backend/app/actions.py`,
     `mobile/src/toolMeta.ts`, the specific screen/component).
   - **New surface needed**: new adapter method? new tool schema +
     `NUMERIC_BOUNDS` entry? new Caddyfile handle block (check against
     `deploy/check-routes.py`'s expectations)? does it need an entry in
     `CONFIRM_REQUIRED`/`VOICE_CONFIRMABLE`, or is it correctly exempt (like
     climate/charging, which `actions.py` explains are deliberately
     ungated because they're reversible)?
   - **Proof**: name the check script that would prove it, following the
     `backend/dev/check_*.py` pattern — network-free, against `MockImpl`,
     asserting the wiring rather than the Tesla network (see
     `backend/dev/check_wake.py` for the shape: a stub car, a `check()`
     helper, a list of `failures`, one command to run it from `backend/`).
   - **Honest downside**: the real reason this might be a bad idea — battery
     cost, a Fleet scope you're not sure is granted, a case Tesla's own app
     already covers well, a maintenance burden, an ambiguous edge case in the
     confirmation gate.

4. **If fewer than one proposal clears every item in step 2, say exactly
   "No useful feature found."** This is the expected, common outcome for this
   repository — say it plainly, without hedging or softening it into a weak
   proposal instead. Immediately follow it with a short audit list: each
   candidate you actually considered (including "nothing new in adapter.py
   lacks a tool" if that's what you found) and the specific bar item it
   failed. The point of the list is that the "no" is falsifiable by the user,
   not a shrug — so name real files and real reasons, not "nothing seemed
   interesting."

Do not soften a rejected idea into a recommendation because the conversation
expects an answer. A short, well-reasoned "no" is the correct output far more
often than a shipped-sounding "yes" in a codebase this tightly wired.

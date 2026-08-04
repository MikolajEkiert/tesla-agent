# Backend architecture

What this covers: the FastAPI backend in `backend/app/` — the request lifecycle,
the two provider seams (Tesla adapter, LLM orchestrator), the tool-dispatch and
confirmation gate, the supporting modules, the two voice paths, and every
route. Read this if you are changing anything in `backend/app/` or trying to
understand why a piece of it is shaped the way it is before you touch it. It
does not cover the mobile client's UI or the deploy pipeline in detail — see
`mobile/` and `deploy/` for those.

## Seams, at a glance

```mermaid
flowchart TB
    subgraph Client["mobile (Expo RN + PWA)"]
        App["ChatScreen / VoiceButton / api.ts"]
    end

    subgraph API["backend/app/main.py"]
        Gate["require_session middleware<br/>(auth/gate.py)"]
        Chat["POST /chat"]
        Voice["voice.py: transcribe / speak"]
        Live["live.py: mint_token / live_tool"]
        Actions["POST /actions/confirm*<br/>(human tap or voice word)"]
    end

    subgraph LLMSeam["LLM seam (llm/__init__.py)"]
        Orch["GeminiOrchestrator<br/>or AnthropicOrchestrator"]
    end

    subgraph ToolLayer["tools.py"]
        Dispatch["dispatch()<br/>_validate + confirmation gate"]
        Unguarded["dispatch_unguarded()"]
    end

    subgraph ActionsMod["actions.py"]
        Propose["propose() → parks CONFIRM_REQUIRED calls"]
        Confirm["confirm() → dispatch_unguarded"]
        Sched["schedule_climate() → scheduler.py"]
    end

    subgraph AdapterSeam["TeslaAdapter seam (tesla/adapter.py)"]
        Mock["MockImpl<br/>in-memory fake car"]
        Fleet["FleetImpl<br/>signing proxy + Fleet API"]
    end

    App -->|cookie or shortcut token| Gate
    Gate --> Chat
    Gate --> Voice
    Gate --> Live
    Gate --> Actions

    Chat --> Orch
    Live -->|/live/tool| Dispatch
    Orch -->|tool call| Dispatch
    Dispatch -->|sensitive| Propose
    Dispatch -->|ordinary| Unguarded
    Actions --> Confirm
    Confirm --> Unguarded
    Propose -.parked, human must tap.-> Actions

    Unguarded --> Mock
    Unguarded --> Fleet
    Sched -.scheduler.runner_loop shares the SAME adapter.-> Unguarded

    Fleet -->|signed commands| Proxy["tesla-proxy<br/>(signing proxy, isolated network)"]
    Fleet -->|reads, wake_up, OAuth refresh| TeslaCloud["Tesla Fleet API"]
```

---

## (a) Request lifecycle: `POST /chat`

### Process startup, once

`backend/app/main.py:25-32` builds exactly one adapter and one orchestrator
for the whole process, at import time, before the `FastAPI` app object even
exists:

```python
adapter = build_adapter()
orchestrator = build_orchestrator(adapter)
```

The comment on `main.py:27-30` explains why this has to happen before the
`lifespan` context manager is defined: the scheduler's background runner
(`scheduler.runner_loop`, started in `lifespan`) is handed this same `adapter`
instance, not a fresh one. That sharing is load-bearing — see §(e). If a
request handler and the scheduler each held their own adapter, `MockImpl`'s
in-memory state (charge on/off, locked, etc.) would silently fork into two
incoherent copies, and `FleetImpl`'s awake-cache (`AWAKE_CACHE_TTL_S` in
`tesla/fleet.py:42`) would stop doing its job.

### One request, `main.py:385-398`

```python
@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    result = await orchestrator.chat(
        req.message, req.history, req.language, req.persona, await _persona_style(req)
    )
    return ChatResponse(**result)
```

Before this handler ever runs, the `require_session` middleware
(`main.py:89-127`) has already gated the request — `/chat` is not in
`PUBLIC_ROUTES` or `TOKEN_ROUTES`, so it needs a valid session cookie. See
§(g) for the full route table.

Five things happen inside `chat()`:

1. **`_persona_style` resolution** (`main.py:356-367`). The manner text comes
   from `persona_store.style_for(req.persona)` first — the server-side SQLite
   table the settings screen writes to through a gated route — and falls back
   to `req.persona_style` only for "a browser still running the build that
   kept manners in its own storage." That fallback client no longer exists in
   the current build; it survives in the code as a documented compatibility
   path, not a live feature.
2. **`orchestrator.chat(...)`** — the LLM seam, detailed in §(c). This is
   where the whole tool-calling loop happens: it can make several HTTP calls
   to Gemini/Anthropic and several calls into `tools.dispatch`, in series,
   before it returns.
3. **Exception → 502** (`main.py:391-397`). Any exception from the
   orchestrator — an LLM SDK error, a tool that raised — becomes an
   `HTTPException(502, detail=str(e))` rather than FastAPI's bare 500. The
   comment names the reason directly: without this, "any downstream failure
   ... surfaces as FastAPI's generic, bodyless 500 — indistinguishable from
   the backend actually being down." `str(e)` is judged safe to relay because
   it is "the LLM SDK's own message ... specific enough to act on without
   leaking secrets" — worth re-checking if a new tool starts raising
   exceptions that embed something sensitive.
4. **Response shape.** `ChatResponse` is `{reply: str, history: list[dict],
   tool_trace: list[dict]}` — the exact shape `llm/__init__.py`'s docstring
   promises every orchestrator returns — plus a nullable `pending_id`, below.

### When the turn has to wake the car first

`orchestrator.chat(...)` is no longer awaited directly; it is handed to
`turns.run` (`app/turns.py`), which watches it and returns as soon as *either*
the turn finishes *or* `adapter.waking_since()` reports a wake genuinely under
way. Waking measures ten to twenty seconds (`WAKE_TIMEOUT_S` allows forty) and
all of it used to happen inside one POST, so the app showed "Myślę…" and
nothing else for the duration.

In the second case `/chat` answers immediately with `pending_id` set, `reply`
holding a canned bilingual "the car's asleep, waking it now" line, `history`
echoed back unchanged and `tool_trace` empty; the turn keeps running and the
client collects the real one from `GET /chat/pending/{id}`. Nothing about the
first case changed, exception-to-502 included.

Three properties worth keeping in mind if you touch this:

- The split is tied to an **observed** wake, never to a slow turn. `waking_since`
  is set only inside `FleetImpl._wake_and_wait`, which is the only place the
  seconds come from — so the interim sentence obeys the same rule the system
  prompt puts on the model ("never say you are waking something unless a tool
  you actually called did it").
- The confirmation gate is untouched. The backgrounded turn is the same
  coroutine calling the same `tools.dispatch`, so a sensitive command is still
  parked by `actions.propose` and still needs `/actions/confirm`. Its
  `confirm_token` reaches the client in the collected `tool_trace` — the same
  place and shape as synchronously, later by the length of the wake and never
  sooner. The parked command's own 120s clock starts when it was parked, so
  waiting can only narrow the window a card is tappable for.
- `/voice/ask` deliberately still blocks: a Shortcut cannot poll and has
  nowhere to put a second answer, so an interim there would be the only thing
  Siri ever said.

`MockImpl` simulates a sleeping car when `AMP_MOCK_WAKE_S` is set (default `0`,
i.e. the always-awake behaviour it has always had), which is what makes this
path exercisable on the desk — see `dev/check_wake_reply.py`.

### How history round-trips to the client

The backend is stateless across requests for chat history: nothing server-side
remembers a conversation. The mobile client (`mobile/src/api.ts`,
`mobile/src/chats.ts`) stores the `history` array from each `ChatResponse` and
posts the same array back as `req.history` on the next turn. `main.py` never
inspects it beyond passing it through — the orchestrator does the real work,
via `llm/prompt.py`'s `sanitize_history` (see §(c)).

This is deliberate and it is also why the history format matters: it is
provider-native (Gemini's `{role, parts}` shape, or Anthropic's `{role,
content}` shape — see §(c) for why one process only ever runs one provider) but
always JSON-serializable, so a dumb client can hold it without understanding
it.

### `tool_trace`

`ChatResponse.tool_trace` is a redacted echo of what the tool-calling loop did
this turn: `{tool, input, ok, result}` per call, where `result` is
`confirmation_payload(result)` from `llm/prompt.py:211-223` — `None` for an
ordinary result, or `{confirmation_required: True, confirm_token: ...}` for a
gated one. The comment there is explicit about why the full result never
travels to the browser this way: "tool_trace travels to the browser, so it
carries the confirmation token and nothing else — not whole results, which
would put vehicle state and third-party text on the wire for every call." The
mobile app uses `tool_trace` to render `ConfirmCard` when a `confirm_token` is
present.

---

## (b) The TeslaAdapter seam

`backend/app/tesla/adapter.py` is, in the file's own first line, "the one seam
that matters: everything above this interface is provider-agnostic." It is an
`ABC` with one method per capability, grouped by area in the source
(`tesla/adapter.py:20-210`):

| Group | Methods |
|---|---|
| reads | `get_state`, `wake` |
| climate | `set_temperature`, `start_climate`, `stop_climate`, `set_seat_heater` |
| media | `media_control`, `set_volume`, `media_favorite` |
| security / charging | `lock`, `unlock`, `set_charge_limit`, `start_charging`, `stop_charging` |
| signals | `honk`, `flash_lights` |
| navigation | `set_route`, `set_navigation_destination`, `nearby_chargers`, `get_location` |
| native scheduling / comfort | `list_schedules`, `add_charge_schedule`, `add_precondition_schedule`, `remove_schedule`, `set_cabin_overheat_protection`, `set_climate_keeper_mode` |
| everyday odds and ends | `set_sentry_mode`, `control_windows`, `actuate_trunk`, `charge_port`, `trigger_homelink` |
| charging detail | `set_charging_amps` |
| comfort | `set_preconditioning_max`, `set_cop_temp` |
| diagnostics | `recent_alerts`, `release_notes`, `charging_history` |
| software | `schedule_software_update`, `cancel_software_update` |
| hardware-dependent | `set_steering_wheel_heater` |

The interface docstring (`adapter.py:13-18`) states the contract every
implementation must honour: "Reads should be cheap and cache-friendly;
commands may wake the car (expensive). Each method maps 1:1 to one or a few
Fleet API endpoints — keep it that way so failures are easy to trace."

`wake()` gets its own long comment (`adapter.py:26-40`) explaining why it is a
first-class method rather than a side effect of sending a command: without it,
the assistant could be asked "is the car asleep?", answer truthfully, be told
"then wake it," and have no tool to call — so it used to claim it was waking
the car and do nothing. `wake()` returns state with `woke: true/false`, and "a
car that will not wake is an answer, not an error."

### `build_adapter()` — how the choice is made

`adapter.py:213-225`:

```python
def build_adapter() -> TeslaAdapter:
    settings = get_settings()
    if settings.tesla_adapter == "fleet":
        from app.tesla.fleet import FleetImpl
        return FleetImpl()
    from app.tesla.mock import MockImpl
    return MockImpl()
```

Driven by `TESLA_ADAPTER` (`config.py:52`, default `"mock"`). The imports are
inside the branches specifically "so the mock path never needs the Fleet
dependencies (and vice versa)" — `npm run api` never touches `httpx` calls to
Tesla or the signing proxy.

### `MockImpl` — what it fakes

`backend/app/tesla/mock.py` is "an in-memory fake car" — one `dict` of state
(`_state`) mutated in place by every command method, with no persistence, no
network calls, and no concept of sleep: `get_state()`'s docstring notes `mock
is always "live" — no real sleep/staleness concept`. It mirrors the shape
`FleetImpl._normalize` produces (`range_km`, `range_estimated_km`,
`outside_temp_c`, etc. — `mock.py:24-32`) specifically so "the assistant can be
developed against questions about range and charging without one."

One nuance worth knowing if you touch `places.py`: `find_places` calls
`adapter._coordinates()` (`places.py:251`) as a private, non-ABC helper.
`FleetImpl` defines it (`fleet.py:611`); `MockImpl` does not, so on the mock
adapter that call raises `AttributeError`, which `find_places` catches and
falls back to `near=None` — "the missing distance_km says so by its absence."
Worth knowing rather than a bug: it means place search against the mock
adapter degrades gracefully rather than mocking a coordinate.

### `FleetImpl` — waking, retries, the signing proxy hop, token refresh

`backend/app/tesla/fleet.py` is substantially larger (944 lines) because it
carries the real network behaviour the mock skips entirely.

**Reads never wake the car, and never fail** (`fleet.py:1-20`, `481-494`).
`get_state()` calls `_fetch_vehicle_data()`, which is a plain `GET
vehicle_data` — "confirmed Tesla doesn't treat this as a wake trigger." Two
separate signals are checked, not just the HTTP status: a `408` means asleep
(`VehicleAsleepError`), but the module also checks the JSON body's `state`
field explicitly, because of a production incident documented at
`fleet.py:233-239` — a car that had just gone idle returned a plain `200`
whose `charge_state`/`climate_state` still held hours-stale cached values, and
"trusting any 200 as 'live' served that stale snapshot as current." On either
signal of sleep, `get_state()` serves the last successful in-process snapshot
(`self._last_state`), marked `awake: False` plus `stale_seconds` — the same
*effect* as Tesla's own app showing a last-known status, replicated because
`vehicle_data` itself exposes no such cache through the public Fleet API.

**Commands go through the signing proxy and wake-and-retry once**
(`_command`, `fleet.py:454-479`). The car is a 2021 Model 3 that "rejects
unsigned commands" (module docstring, `fleet.py:15`), so every state-changing
call is POSTed to the local `tesla-proxy` container
(`self.settings.tesla_proxy_url`), addressed by **VIN**, not the numeric Fleet
API `vehicle_tag` — the proxy 404s on the latter with its own error ("expected
17-character VIN in path"), which is why `_resolve_vehicle()`
(`fleet.py:193-215`) caches both identifiers from one `GET vehicles` call
rather than treating them as interchangeable.

The wake dance itself (`_wake_and_wait`, `fleet.py:374-397`): `POST wake_up`
(a plain, unsigned Fleet API call), then poll `vehicle_data` every
`WAKE_POLL_INTERVAL_S` (3s) up to `WAKE_TIMEOUT_S` (40s), with one extra nudge
`POST wake_up` halfway through if there is still no answer. `_command` first
checks an in-process "recently awake" cache (`AWAKE_CACHE_TTL_S = 90s`) so
that "several commands land in the same chat turn (e.g. 'set 22 and unlock')"
don't each pay the wake round trip. If the signed send still comes back
`VehicleAsleepError` — the car fell back asleep between the check and the
send, or the cache was stale — it wakes once more and retries exactly once;
if that fails too, the error surfaces rather than looping.

**The signing proxy's TLS is pinned, not disabled** (`fleet.py:109-115,
399-410`). `PROXY_CA` points at `/certs/proxy-cert.pem` by default and is only
set to `verify=False` if that file is genuinely absent (fresh dev deploy). The
comment is direct about the stakes: the proxy's cert is self-signed and can
never pass ordinary verification, but disabling verification outright "meant a
live Tesla bearer token would be handed to whatever answered at
TESLA_PROXY_URL, silently, if that setting were ever wrong."

**A handful of commands bypass the proxy entirely**
(`_send_direct`/`signed=False`, `fleet.py:434-452`). `navigation_request` and
`share` go straight to the Fleet API, because the proxy's own source
(`pkg/proxy/command.go`) refuses to sign them — `ErrCommandUseRESTAPI` —
"since these need server-side geocoding that can't be end-to-end
authenticated with the vehicle key."

**Token refresh** lives in `auth/oauth.py`'s `TokenStore.get_access_token()`
(`oauth.py:152-192`), used by `FleetImpl._access_token()`. It reads the single
stored token row, and if it expires within 5 minutes, does a `grant_type:
refresh_token` call to Tesla's token endpoint and overwrites the stored row
with the new access+refresh token pair before returning. `FleetImpl` never
manages this itself — it just calls `self.tokens.get_access_token()` before
every Fleet/proxy call.

**One method the ABC does not declare**: `_coordinates()` (`fleet.py:611`),
a private helper other `FleetImpl` methods (`get_location`, `nearby_chargers`,
etc.) and `places.py`'s `find_places` reach into directly (see the mock note
above).

---

## (c) The LLM seam

### The identical `chat()` contract

`llm/__init__.py` states the whole contract in its docstring:

```
async def chat(user_text: str, history: list[dict] | None) -> dict
```

returning `{"reply": str, "history": list[dict], "tool_trace": list[dict]}`,
with the explicit warning that "Provider is fixed per deployment (don't mix
providers within one conversation's history)." `build_orchestrator(adapter)`
picks `AnthropicOrchestrator` when `LLM_PROVIDER=anthropic`, else
`GeminiOrchestrator` (the default) — mirroring `build_adapter()`'s shape
exactly, lazy-imported for the same reason.

**Why history cannot be mixed across providers**: the two providers use
genuinely different wire shapes for a turn. Gemini's `contents` list uses
`{"role": "model"/"user", "parts": [...]}` with `function_call`/
`function_response` parts (`gemini_llm.py:56-117`); Anthropic's `messages`
list uses `{"role": "assistant"/"user", "content": [...]}` with `tool_use`/
`tool_result` blocks (`anthropic_llm.py:38-120`). `llm/prompt.py`'s
`_holds_tool_calls`/`_blocks`/`_is_plain_user_turn` helpers
(`prompt.py:132-160`) branch on both shapes to stay provider-agnostic when
trimming history, but nothing converts one shape into the other — a history
array built under Gemini and replayed against the Anthropic orchestrator would
simply fail to parse as a turn, or worse, silently misinterpret roles. Since
`LLM_PROVIDER` is one process-wide setting (`config.py:14`), this is a
deployment-time decision, not a per-request one, and switching providers loses
in-flight conversation history by design.

### Both orchestrators' loop, side by side

`GeminiOrchestrator.chat` (`llm/gemini_llm.py:48-134`) and
`AnthropicOrchestrator.chat` (`llm/anthropic_llm.py:30-135`) run the same
shape of loop:

1. Append the user turn to the sanitized history.
2. Call the model with the system prompt (`build_system_prompt`, §e below),
   the tool schemas, and the growing conversation.
3. If the model asks for tools, run them **sequentially** — both files carry
   near-identical comments explaining this is a deliberate choice, not a
   missed optimisation: `FleetImpl` shares one awake-cache and one
   wake-and-retry state across calls, and `actions._pending` is one shared
   dict, so "two concurrent commands would race to wake one car ... The
   latency saved is not worth the class of bug bought" (`gemini_llm.py:88-94`,
   echoed at `anthropic_llm.py:86-87`).
4. Feed the tool results back as the next turn and loop, up to
   `MAX_TOOL_ROUNDS` (8, `prompt.py:129`) — bounded because "the loop is
   driven by model output, so `while True` meant a single question could
   spend LLM quota and Fleet API wake-ups without limit."
5. Return once the model responds with no further tool calls.

Both also handle their provider's specific failure shapes explicitly rather
than letting them propagate as opaque crashes: Gemini can return a candidate
with no `content` at all on a safety block or token ceiling
(`gemini_llm.py:70-79`, previously an unhandled `IndexError` that surfaced as
a bare 502); Anthropic can hit `stop_reason == "max_tokens"` mid-tool-call,
which is deliberately *not* appended to history because "whatever tool_use
blocks it holds were never answered and must not travel into history"
(`anthropic_llm.py:63-77`) — the comment there also flags that Claude's
extended thinking must stay on with tools ("do NOT disable it on Opus 5 —
with tools it can emit tool calls as plain text").

### Tool schema translation

`tools.py` defines `TOOLS` as a list of canonical JSON-schema dicts —
`{name, description, input_schema}` — used directly by
`AnthropicOrchestrator` (`anthropic_llm.py:19,59`, passed as `tools=TOOLS`
essentially natively; Anthropic's tool format is close enough to this
canonical shape that no translation layer exists for it).

Gemini needs an actual conversion, done in `llm/gemini_tools.py`:
`to_gemini_schema` (`gemini_tools.py:19-34`) recursively rewrites the
canonical schema into "Gemini's OpenAPI subset": it drops
`additionalProperties` (unsupported there) and uppercases every `type` value
(`"object"` → `"OBJECT"`), recursing into `properties` and `items`.
`function_declarations()` wraps each `TOOLS` entry as a
`types.FunctionDeclaration`, and `declarations_as_json()` produces the same
list as plain JSON for a caller that cannot hold SDK types — specifically the
browser's live-session `setup` message (see §f). The module docstring
explains why this file exists on its own rather than living inside the
orchestrator: "two very different callers need the same list": the text
orchestrator and `app/live.py`'s realtime session, and they "must reach
exactly the same tools, or the assistant would be able to do things by voice
it cannot do by typing, and the other way round."

### Where the system prompt comes from

`llm/prompt.py`'s `build_system_prompt(language, persona, custom_style)`
(`prompt.py:94-117`) concatenates: `BASE_SYSTEM_PROMPT` (the substance
rules — see §e for how personas layer onto this) + a language instruction
derived from the app's language setting + `resolve_persona(persona,
custom_style)`. Both orchestrators rebuild this fresh per request
(`GeminiOrchestrator._config`, `AnthropicOrchestrator.chat`'s inline `system=`
argument) — cheap, and necessary because it depends on per-request language
and persona.

---

## (d) `tools.py`: the capability surface

### `TOOLS` is also your Fleet API scope surface

The module docstring is explicit: `TOOLS` "is also, in effect, your Fleet API
scope surface — keep it small and explicit." Each entry is a JSON-schema tool
declaration the model sees; each has a 1:1 (or near-1:1) counterpart in
`dispatch_unguarded`'s handler table.

### How a tool name reaches an adapter coroutine

`dispatch()` (`tools.py:622-634`) is the only entry point either orchestrator
calls:

```python
async def dispatch(adapter, name, args):
    _validate(name, args)
    if actions.needs_confirmation(name):
        return actions.propose(name, args)
    return await dispatch_unguarded(adapter, name, args)
```

`_validate` (`tools.py:610-619`) re-checks numeric arguments against
`NUMERIC_BOUNDS` (`tools.py:592-607`) — temperature 15–28°C, charge limit
50–100%, seat heater 0–3, charging amps 5–48A, volume 0–11, software-update
delay capped at a day, and so on — **server-side**, regardless of what the
JSON schema advertised to the model claims to constrain. The comment is blunt
about why: "the model may emit anything, and after an injected instruction it
may do so deliberately."

`dispatch_unguarded` (`tools.py:677-767`) is "the raw routing table": a
`dict[str, Callable]` of lambdas, one per tool name, each calling exactly one
(or a small composed handful of) adapter coroutine. Two tools compose more
than a single call: `_read_state` (`tools.py:637-658`, wakes the car if the
cached read reports asleep, so a person's question gets answered from live
data in the same turn rather than a flat "it's asleep, I don't know") and
`_send_route` (`tools.py:661-674`, resolves waypoints via `navigation.py`
before handing them to `adapter.set_route`).

### Who may call `dispatch_unguarded` directly

Exactly two callers, per the docstring at `tools.py:680-683`: `dispatch`
itself (for tools that don't need confirmation) and `actions.confirm` (after a
human has tapped the card). This matters because it is what keeps the
scheduler safe by construction: `scheduler.run_due_jobs` (`scheduler.py:257`)
calls `dispatch`, **not** `dispatch_unguarded` — "so a queued job can never
smuggle in a sensitive command either." A scheduled action that happened to
carry `"unlock"` as its action name would still be parked for confirmation,
not executed.

### The confirmation gate

Anything composing several adapter calls — or requiring the
scheduler/confirmation machinery — belongs in `actions.py`, not `tools.py`;
that module's docstring states this as the rule: "Kept out of tools.py so
that module stays a flat name → adapter mapping."

`actions.py`'s docstring lays out the threat model directly: charger and
place lookups "pull free text straight out of OpenStreetMap and Nominatim,
which anyone may edit anonymously, and that text is handed back to the model
as a tool result. A model that treats such text as an instruction could reach
`unlock`, `actuate_trunk` or `trigger_homelink` — the garage door." The system
prompt asks the model to confirm first, but "a prompt is guidance, not a
control." So the authority to *execute* is removed from the model entirely:

```python
CONFIRM_REQUIRED = {
    "unlock", "actuate_trunk", "trigger_homelink",
    "control_windows", "set_sentry_mode", "software_update",
}
```

Climate and charging are deliberately absent — "reversible, cost only energy,
and gating them would train the owner to tap 'confirm' without reading."
`software_update` is included for a different reason than physical risk: "the
least reversible thing here — once an install starts the car is out of use
until it finishes and there is no calling it back."

`propose()` (`actions.py:141-162`) parks the call in an in-process dict
(`_pending`, keyed by a `secrets.token_urlsafe(16)` token) with a
`PENDING_TTL_S` of 120 seconds, and returns a payload telling the model to
relay it and stop — "do not retry or call other tools to achieve the same
effect." `confirm()` (`actions.py:179-189`) is the sole path that actually
runs the command, single-use (`_pending.pop`), calling `dispatch_unguarded`
directly.

**Voice confirmation is a strictly weaker second path**, added later — see the
long comment at `actions.py:47-63`. `VOICE_CONFIRMABLE = CONFIRM_REQUIRED -
{"unlock"}` (unlock stays out because "voice carries further than a finger" —
a passenger is inside the trust boundary for the trunk in a way they are not
for the doors, and this exclusion is enforced here, server-side, "so a bug in
our own front end cannot widen it"). The spoken path gets a much shorter
window (`VOICE_WINDOW_S = 25s` vs. 120s for the tap), exactly one attempt per
proposal (`burn_voice_attempt`), and refuses outright when more than one
proposal is simultaneously eligible — "Ambiguity resolves to the tap, never to
a guess." Settling it is `confirm_phrase.classify()`
(`backend/app/confirm_phrase.py`) — a **pure regex function**, no model in the
loop, matching the *whole* utterance against confirm/cancel word lists in both
languages. The module docstring states the invariant plainly: "There is no
`confirm` tool, and there must never be one — the moment a model can decide
that consent happened, injected text in a tool result can decide it too, and
the gate in actions.py stops meaning anything." The whole-utterance
requirement traces to a measured failure, not a hypothetical: "the transcriber
invents fluent commands out of engine noise, and the ones it invented were
whole sentences." `MAX_UTTERANCE_CHARS = 32` keeps a fabricated sentence from
being trimmed into a match.

---

## (e) Supporting modules

### `scheduler.py` — lifespan ownership, shared adapter, resume-after-redeploy

A generic persistent queue: a **group** is one thing the user asked for ("run
climate for 10 minutes"), made of one or more **jobs** (start now, stop at
T+10). Storage is SQLite (`aiosqlite`, `data/scheduled_actions.db`), and the
module docstring explains why not an in-process `asyncio` timer: "this deploys
several times a day, and every deploy recreates the api container. An
in-memory timer would silently vanish mid-flight — and the job that vanishes
is the one that turns climate *off*." Overdue jobs fire immediately on startup
rather than being skipped (`runner_loop`, `scheduler.py:268-282`), which is
the resume-after-redeploy behaviour: `main.py`'s `lifespan` starts
`scheduler.runner_loop(adapter)` as a background `asyncio.Task` the moment the
app boots (`main.py:41`), owned by the same `adapter` instance module-level
`chat()` uses — see §(a).

Claim-then-execute (`_claim_due_jobs`, `scheduler.py:186-215`) marks rows
`running` in the same transaction that selects them, closing a race the
comment there documents precisely: without it, `cancel_group` could flip a row
to `cancelled` and report success while the runner executed it anyway — "for a
queued climate start, exactly the outcome the cancel was meant to prevent."
Failed jobs retry up to `MAX_ATTEMPTS` (4) with a fixed backoff, because "a
failed stop_climate is the expensive failure (battery drain)." Every job
action, when it fires, goes through `tools.dispatch` (imported inside the
function to dodge a circular import) — never `dispatch_unguarded` — see §(d).

### `places.py`, `chargers.py`, `geo.py`, `navigation.py`

**`geo.py`** wraps OpenStreetMap's Nominatim — free, keyless, used for
`geocode()` (place name → coordinates) and `reverse_geocode()` (coordinates →
address, used only for explicit "where is my car" requests, never background
polling — stated as a privacy note in the module docstring). It also owns
`clean_text()`, the one shared sanitiser for untrusted third-party text
(control-character stripping, length capping) that `chargers.py` and
`places.py` both import rather than reimplementing, "because the threat is
identical and two copies drift."

**`chargers.py`** layers three sources, in a specific order for a specific
reason. Tesla's own `nearby_charging_sites` is the default and is "never
replaced: it's the only source anywhere with live free-stall counts" — but it
only answers "around the car, right now." For anything else — other networks,
or a place away from the car — it tries **Open Charge Map** first (needs
`OCM_API_KEY`, curated, richer fields) and falls back to **OpenStreetMap /
Overpass** (no key, patchier). The docstring is explicit that this fallback is
not belt-and-braces caution: "OCM's site was fully unreachable while this
feature was being built, and Overpass returned 504 from the server the same
day. Either one alone would leave the feature dead for hours at a time." Two
Overpass endpoints are tried in sequence for the same reason (public
instances throttle). `_classify_site` distinguishes `supercharger` from
`tesla_destination` by text matching plus power (≥50kW), after "a 22 kW spa
charger was announced as 'a Supercharger 14 km away'" in testing.

**`places.py`** is Google Places (Text Search New) behind a `PlaceProvider`
protocol, gated on `GOOGLE_PLACES_API_KEY`. The module docstring gives two
reasons it is a structured API call rather than "ask a model what it knows":
the anti-confabulation rule already broken once by an invented "up to 250 kW"
figure, and the need for real coordinates to hand to `set_route`/
`set_navigation_destination` — "a search that returns prose would have to be
geocoded by name afterwards ... the same step that lands a Supercharger
search in the middle of a town." `_explain()` (`places.py:136-180`) turns
provider error responses into specific, actionable one-liners rather than
"200 characters of raw JSON" that once caused the model to confabulate a
wrong root cause ("place search is not enabled in the car's system"). Results
are cached in-process for `CACHE_TTL_S` (300s), keyed on the rounded
coordinates + query + language + `open_now`.

**`navigation.py`** turns a mixed list of stops (some with `coordinates`,
some with only an `address`) into what `adapter.set_route` needs.
`parse_coordinates()` (`navigation.py:24-44`) is deliberately strict — "a
crafted `navigate_to` stops" here: a `"lat,lon"` string with both values in
valid range, or `None`. `resolve_stops` raises, naming the offending stop,
rather than silently dropping one it cannot resolve, "the failure nobody
notices until they are driving past the turning." `MAX_STOPS = 5` is
explicitly labelled a guess, not a measured car limit.

### `tts.py` — cache

Google Cloud Text-to-Speech (Chirp 3: HD), chosen over the same voices through
the AI Studio API after hitting AI Studio's ten-requests-a-day free tier "the
hard way." Two caching layers matter:

- An **on-disk sample cache** (`data/tts-cache/`, keyed by
  `sha256(locale|voice|text)`) exists specifically for the settings screen's
  "tap a voice, hear a sample" flow — 30 voices × 2 languages = 60 possible
  samples, and without this "flicking through them used to bill Google once
  per tap, every time, forever." `CACHE_MAX_FILES = 96` is sized to hold the
  whole matrix at once, deliberately not the smaller number ("64") that used
  to cause the cache to evict samples the owner was still listening through.
  `CACHE_MAX_CHARS = 200` keeps ordinary conversational replies — "said once
  and not worth keeping" — out of the cache entirely.
- `VOICES` (`tts.py:92-123`) is a hard **allow-list**, not a pass-through,
  "because the name arrives in a request body and ends up in a URL to a paid
  API." `resolve_voice()` silently falls back to `DEFAULT_VOICE` ("Charon")
  for anything not on the list.

### `persona_store.py` / `prefs_store.py` — server-side, not per-device

Both are small SQLite tables (`data/personas.db`, `data/prefs.db`) that exist
for the identical reason, stated near-verbatim in both docstrings: a value
that used to live in one browser's local storage meant the laptop and the
phone disagreed, a cleared browser store silently reset it, and a fresh
install showed a default the assistant wasn't actually using. Both note there
is exactly one owner (`USER_ID` in `auth/passkey.py` — a passkey identifies a
*device*, not a person), so neither table has an owner column: "everything
behind the gate is theirs."

`persona_store.py` holds the owner's own hand-written personas (`id, name,
style`), capped at `MAX_PERSONAS = 12` and `MAX_NAME_CHARS = 24`, reachable
only through the gated `/personas/custom` routes. It notes an added security
property over the old client-side design: previously the *style text itself*
travelled with every chat request, "which meant an endpoint that accepted
arbitrary prompt text from whoever held a session." Now a request only ever
names a `persona` id; `main.py`'s `_persona_style` looks the words up
server-side.

`prefs_store.py` currently holds one key (`voice`), validated against `tts.VOICES`
at write time so "a rejected value should be a message in the settings screen
at the moment of the tap, not a setting that appears to have taken and then
speaks in a different voice forever." It also documents a subtlety in
`get_voice()`: it returns `None` (not the default) when nothing has ever been
chosen, specifically to let a legacy client that still holds its own
locally-stored choice "hand it over exactly once, instead of a fresh server's
default quietly overwriting it."

---

## (f) The two voice paths

| | Turn-based (`voice.py`) | Realtime (`live.py` + `mobile/src/voice/live.ts`) |
|---|---|---|
| Shape | record → upload → transcribe → `/chat` → speak → play | one open WebSocket, audio streamed both ways |
| Who talks to the model | this server (Gemini transcription call), then the orchestrator | the phone talks **directly** to Google |
| Tool access | via the ordinary `/chat` → `dispatch` path | via `/live/tool` → `dispatch`, same gate |
| Used for | typed-equivalent voice input on any client, and the Shortcut's `/voice/ask` | the in-app microphone button, held-open conversation |

### Turn-based: `voice.py`

`POST /voice/transcribe` (`main.py:401-435`) takes the raw recording as the
whole request body (checked against `MAX_AUDIO_BYTES` before it's even read,
via `content-length`), and calls `voice.transcribe()`. The module docstring
states the design choice directly: "The audio is turned into a string here and
then travels the ordinary /chat path — same tools, same confirmation gate,
same trace in the log, same queue. Voice is another way of typing, not a
second route to the car." A bidirectional live model was considered and
rejected for the turn-based case specifically because it "runs its own
conversation loop with its own tool calling, which means a second path that
does not pass through actions.propose."

`transcribe()` runs a Gemini call (always Gemini, "regardless of
LLM_PROVIDER, because the Anthropic fallback takes no audio input") with:

- A **voice-activity gate** computed locally first (`_wav_speech_evidence`,
  `voice.py:225-270`) — energy and spectral-tilt heuristics over the raw PCM,
  mirroring thresholds duplicated from the client's own VAD
  (`mobile/src/voice/vad.ts`) "deliberately duplicated rather than trusted
  from the client: the check is what stands between road noise and a command
  executed on the car." Audio that doesn't clear it returns `""` without
  spending a model call.
- A **domain-vocabulary hint** (`DOMAIN_VOCABULARY`, shared with `live.py`
  from `llm/prompt.py`) — a spelling guide, explicitly "never a set of words
  to choose between," after a measured failure where a live-session
  correction bent a correctly-heard "Orlenu" into "Superchargera."
- An optional **draft clause** (`_draft_clause`) folding in what the live
  session's own weaker recogniser heard, treated as "evidence... never an
  answer" — measured to fix a 6/6 → 0/6 failure rate on a specific phrase.
- An explicit `NO_SPEECH` sentinel the model is told to emit rather than
  guessing — because even asked politely not to invent text, "three calls in
  twelve came back with a fully-formed Polish command" on synthesized noise.

`transcribe_confirmation()` (`voice.py:411-451`) is a second, deliberately
*ignorant* transcription path used only by `POST /actions/confirm/voice` — it
shares the VAD gate but never sees `DOMAIN_VOCABULARY`, because that list is
"what measurably drove the invention" in the general case, and here "there is
no domain to fill in with." Its output feeds `confirm_phrase.classify()` (a
pure function, §d), never the model.

`POST /voice/speak` (`main.py:444-471`) is the mirror image: text in, WAV out,
via `tts.synthesize`. Deliberately kept out of `TOKEN_ROUTES` — "giving a
token holder a route that spends API quota per call would hand a stranger
standing next to your phone a way to run up the bill."

### Realtime: `live.py` + `mobile/src/voice/live.ts`

`POST /voice/live-token` (`main.py:488-513`) mints a short-lived, single-use
Gemini Live API token via `live.mint_token()`. The real API key never leaves
the server; what does is a token that "starts a session within one minute and
then stops working," is single-use, and is "locked to one model and one
configuration" (`live.py:11-17`). The phone then opens a WebSocket
**directly to Google** — `mobile/src/voice/live.ts` connects to
`BidiGenerateContentConstrained` (not the documented `BidiGenerateContent`
endpoint, which rejects an ephemeral token) — so the free-tier Oracle VM never
carries the continuous audio stream in either direction.

The live session used to be a pure relay with no tools — a design the
docstring says failed structurally, not just in degree: closing a turn forces
a Live model to generate *something*, so a tool-less relay always invented an
answer ("the battery is at 85%" from a model with no car connection), and the
client could not reliably suppress that audio because "the discarded reply
and the wanted one arrive on the same socket." The fix was to give the live
session the *same tools* as the typed assistant. When it decides to call one,
the phone posts to `POST /live/tool` (`main.py:520-556`), which calls
`tools.dispatch(adapter, req.name, args)` — the identical function the chat
orchestrator uses. The confirmation gate therefore applies identically: a
sensitive call comes back with `confirmation_required` instead of running,
and `/live/tool` strips the `confirm_token` out of what it hands back to the
model ("The token never goes to the model... a confirmation token is the one
value there that would be worth something to anybody who read it back out" —
`main.py:543-546`) while still returning it to the phone for `ConfirmDialog`.

The live session's own tool list is bound to the minted token server-side
(`live.py:340`, `live_connect_constraints`) — "so a browser cannot widen its
own reach" — and echoed to the client redundantly as plain JSON
(`declarations_as_json()`) as defence in depth against a future SDK merging
constraints differently. One extra tool exists only for the live session and
is declared outside `tools.py` on purpose: `end_conversation`
(`live.py:191-205`) — "a capability of the conversation rather than of the
car," handled client-side without a round trip, because `/live/tool` "must
never be asked to run it."

`/voice/live-token` and `/live/tool` are both behind the session gate and
deliberately absent from `TOKEN_ROUTES`, for the same reasoning as
`/voice/speak`: a token holder shouldn't be able to open a metered stream, or
reach the car, without the app's own session.

---

## (g) Every backend route

Reachability column: **public** = no session needed (in `PUBLIC_ROUTES` or
under a `PUBLIC_PREFIXES` prefix); **gated** = needs the session cookie
(`require_session` middleware, `main.py:89-127`); **token** = gated route that
*additionally* accepts the Shortcut bearer token as a fallback authentication
method (`TOKEN_ROUTES`, exactly one entry).

| Method & path | What it does | Reachability |
|---|---|---|
| `GET /health` | Liveness + which adapter/LLM provider is configured | public |
| `GET /gate/status` | Which unlock screen to show, whether passkeys exist | public |
| `POST /gate/unlock` | Verify passcode (+ optional TOTP), issue session cookie | public |
| `POST /gate/lock` | Clear the session cookie | gated |
| `POST /gate/passkey/register/begin` | Start WebAuthn registration; re-checks the passcode even though a session already exists | gated |
| `POST /gate/passkey/register/finish` | Complete WebAuthn registration | gated |
| `GET /gate/passkey/list` | List enrolled passkeys | gated |
| `DELETE /gate/passkey/{credential_id:path}` | Remove a passkey | gated |
| `POST /gate/passkey/login/begin` | Start WebAuthn login (no session exists yet) | public |
| `POST /gate/passkey/login/finish` | Complete WebAuthn login, issue session cookie | public |
| `POST /chat` | The main text/voice-transcript conversation turn | gated |
| `GET /chat/pending/{pending_id}` | Collect a turn that had to wake the car and was handed off to finish in the background (`app/turns.py`) | gated |
| `POST /voice/transcribe` | Audio → text (does not touch the car or the model's tools) | gated |
| `POST /voice/speak` | Text → synthesized WAV | gated |
| `POST /voice/live-token` | Mint a one-use Gemini Live session credential | gated |
| `POST /live/tool` | Run one tool call the live audio session requested | gated |
| `GET /voice/voices` | List speakable voices + the owner's stored choice | gated |
| `POST /voice/voices/selected` | Store the chosen voice, server-side | gated |
| `GET /personas` | List built-in + the owner's custom personas | gated |
| `POST /personas/custom` | Save/overwrite one of the owner's personas | gated |
| `DELETE /personas/custom/{persona_id}` | Delete a custom persona | gated |
| `POST /personas/preview` | Show what sentences a custom style note would add, without a model call | gated |
| `POST /voice/ask` | Single-turn Q&A for the Apple Shortcut — no history, no tool_trace, so nothing gated can be confirmed from it | **token** (also gated) |
| `DELETE /actions/pending/{token}` | Discard a parked (unconfirmed) proposal | gated |
| `POST /actions/confirm/voice` | Settle a parked proposal with a spoken word, via `confirm_phrase.classify` | gated |
| `POST /actions/confirm` | Execute a parked proposal — the sole path to unlock/trunk/HomeLink etc. | gated |
| `GET /vehicle/state` | Direct adapter read for the live status strip; never wakes the car | gated |
| `GET /jobs` | List scheduled-action groups for the sidebar | gated |
| `DELETE /jobs/{group_id}` | Cancel a pending scheduled-action group | gated |
| `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` | Serves the virtual-key public key; Tesla itself fetches this | public (prefix) |
| `GET /auth/status` | Whether Fleet OAuth is required/connected | gated |
| `POST /auth/disconnect` | Forget stored Tesla OAuth tokens | gated |
| `GET /auth/login` | Redirect into Tesla's OAuth consent screen | gated |
| `GET /auth/callback` | Tesla's OAuth redirect target; exchanges the code, redirects back into the PWA | gated (samesite=lax cookie survives Tesla's redirect back) |

Every one of these prefixes has a corresponding `handle` block in
`deploy/Caddyfile` (`/gate/*`, `/actions/*`, `/chat*`, `/voice/*`, `/live/*`,
`/vehicle/*`, `/auth/*`, `/.well-known/*`, `/health*`, `/jobs*`,
`/personas*`) — `deploy/check-routes.py` fails the deploy if a new backend
route has no matching entry, because Caddy's catch-all otherwise answers an
unlisted path with the static frontend's 404, which "looks like a broken app"
rather than an access-control decision.

The allowlist in `main.py` is keyed on **`(method, path)`**, not path alone —
`main.py:57-62` documents exactly why: the passkey routes include a greedy
`DELETE /gate/passkey/{credential_id:path}`, and a path-only allowlist let an
unauthenticated `DELETE /gate/passkey/login/begin` reach the delete handler
(measured as a 404, not a 401 — harmless today only because no real
credential id happens to equal `"login/begin"`).

"""Chat turns that outlive their request, for the one reason they have to.

Waking a sleeping Model 3 measures ten to twenty seconds (`WAKE_TIMEOUT_S` in
tesla/fleet.py allows forty), and reads never wake it — only the command path
does, plus `tools._read_state`, which wakes on purpose so a question about the
battery gets a live answer instead of a lecture about caching. All of that
happens *inside* one `orchestrator.chat`, so from the app's side the entire
turn was a single POST that took a quarter of a minute and showed "Myślę…" the
whole way. The owner's words: fifteen seconds of silence, and then an answer.

So a turn that hits a wake is split in two. /chat returns immediately with a
sentence saying the car is coming online and an id; the turn keeps running here;
the app polls GET /chat/pending/{id} and shows the real answer when it lands.

Three things this deliberately is not:

*Not speculative.* The split fires when `adapter.waking_since()` reports a wake
that has actually started — never because the car might be asleep, and never
because the question looked slow. The prompt has forbidden the model from
announcing a wake it did not perform since the day the assistant said "I'll wake
it up" four times to a car that stayed asleep; a canned sentence minted on a
guess would be the same lie with the model taken out of it.

*Not a second way to reach the car.* The backgrounded turn is the same
coroutine, running the same `tools.dispatch`, so a physically consequential
command is still parked by `actions.propose` and still executed only by
/actions/confirm. The confirm_token travels to the app in the collected
tool_trace, which is the same place and the same shape it travels in
synchronously — later by however long the wake took, never sooner, and with no
step in between that could act on it. A parked command's own two-minute clock
started when it was parked, so waiting here can only ever shorten the window a
card is tappable for, never extend it.

*Not durable.* This is an in-process dict with a TTL, in the same shape as
actions._pending, because it holds the same kind of thing: something worth a
couple of minutes and worthless after. The scheduler's SQLite queue is the other
pattern available and it is the wrong one — it exists because a climate stop
must survive a redeploy, and a chat reply nobody is waiting for any more must
not.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from typing import Any, Awaitable

from app.tesla.adapter import TeslaAdapter

# How often the request handler looks up from the turn to ask whether a wake
# has started. A quarter second is imperceptible against the fifteen this is
# about, and the check is a field read, not I/O.
WAKE_PROBE_INTERVAL_S = 0.25

# How long a finished turn stays collectable. Generous on purpose: the phone
# doing the polling is in a car, and a tunnel or a dead spot is the ordinary
# case, not the exception. Well past the 120s an `actions._pending` proposal
# lives, so a card collected at the very end of this window is already dead
# server-side and fails closed on the tap — the right direction for that to
# fail in.
PENDING_TTL_S = 300

# There is one owner and one car. This is not a capacity plan, it is a ceiling
# on what a stuck turn can accumulate: past it, /chat simply goes back to
# blocking until the turn finishes, which is what it did before any of this
# existed. Refusing the hand-off degrades to slow; dropping the turn would lose
# an answer, and the work may already have moved a car.
MAX_PENDING = 8

_pending: dict[str, dict[str, Any]] = {}


def interim_reply(language: str | None) -> str:
    """What the app shows while the car comes online.

    Written here rather than in mobile/src/i18n.ts, where the app's own copy
    lives, for two reasons. The server is the only party that knows a wake
    started — it happens several layers down, inside FleetImpl, halfway through
    a turn — so the sentence has to be minted where that is observed or it is
    minted on a guess. And it arrives in `reply`, the field every client already
    reads: an installed PWA running the build from before this shipped
    (mobile/src/update.ts means there is always one) shows an honest sentence and
    stops, instead of an empty bubble it has no key for.

    Bilingual off the same `language` that sets the reply language everywhere
    else, and phrased as the two things the owner asked to be told: the car is
    waking, and an answer is coming without them asking again.
    """
    if (language or "").lower() == "pl":
        return "Auto śpi — już je budzę. Odezwę się, jak tylko się wybudzi."
    return "The car's asleep — waking it now. I'll answer as soon as it's up."


def _prune(now: float) -> None:
    """Drop what nobody can still be waiting for.

    Only finished turns are removed. A turn still running is left alone even
    past its TTL: cancelling it would abandon a coroutine that may sit between
    two commands to a real car, and the work is already bounded without our
    help — MAX_TOOL_ROUNDS caps the rounds and every Fleet call carries its own
    timeout. What is bounded here is how long an answer is *kept*, not how long
    it may take.
    """
    for pending_id, entry in list(_pending.items()):
        if now - entry["created_at"] > PENDING_TTL_S and entry["task"].done():
            del _pending[pending_id]


def _drain(task: "asyncio.Task[dict[str, Any]]") -> None:
    """Read the outcome the moment it exists, whether or not anyone collects it.

    An asyncio task whose exception is never retrieved is reported at garbage
    collection, out of context and long after the request it belonged to — and
    a backgrounded turn that nobody polls (the app was closed) is the ordinary
    case here, not a bug. Retrieving it once keeps the log about real failures.
    """
    if not task.cancelled():
        task.exception()


def _park(task: "asyncio.Task[dict[str, Any]]") -> str | None:
    """Keep a running turn collectable, or None when the store is full."""
    now = time.time()
    _prune(now)
    if len(_pending) >= MAX_PENDING:
        return None
    pending_id = secrets.token_urlsafe(16)
    _pending[pending_id] = {"task": task, "created_at": now}
    return pending_id


async def run(
    adapter: TeslaAdapter,
    turn: Awaitable[dict[str, Any]],
    language: str | None,
    history: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Run one chat turn, handing it off to the background if it starts a wake.

    Returns the body /chat answers with, either way. `pending_id` is None for
    the ordinary turn — nothing about an awake car changes, including the fact
    that an orchestrator failure is raised here for the caller to turn into a
    502 exactly as it always did.

    The interim body carries the history the caller sent, unchanged, and an
    empty tool_trace. Not the turn's history, which does not exist yet, and not
    an empty list, which would tell a client to forget the conversation it is
    in. Nothing that happened this turn is in it, because nothing has happened
    yet — the finished turn is the only thing that produces history, and there
    is exactly one of it.
    """
    task = asyncio.create_task(turn)
    task.add_done_callback(_drain)
    asked = False
    while True:
        done, _ = await asyncio.wait({task}, timeout=WAKE_PROBE_INTERVAL_S)
        if done:
            return {**task.result(), "pending_id": None}
        if asked or adapter.waking_since() is None:
            continue
        # One attempt: a refused hand-off means the store is full, and asking
        # again every quarter second for the rest of a wake would just be the
        # same refusal forty times.
        asked = True
        pending_id = _park(task)
        if pending_id is not None:
            return {
                "reply": interim_reply(language),
                "history": list(history or []),
                "tool_trace": [],
                "pending_id": pending_id,
            }


def collect(pending_id: str) -> dict[str, Any]:
    """What became of a backgrounded turn.

    `working` is not an answer yet; `done` carries exactly the three fields a
    synchronous turn returns; `failed` carries the orchestrator's own message,
    the same string the synchronous path puts in a 502 detail; `unknown` means
    expired, or never existed.

    An unknown id is an outcome rather than a 404, in the vocabulary
    /voice/transcribe and /actions/confirm/voice already use: the client's job
    is to say something and stop waiting, and an HTTP error would read to it as
    the backend falling over — which is the failure this whole file exists to
    stop the app from sitting silently inside.

    Collecting does not consume. A phone that polls, loses signal mid-response
    and polls again must get the same answer rather than discover it spent it;
    the TTL above is what ends the entry's life, not the first successful read.
    """
    _prune(time.time())
    entry = _pending.get(pending_id)
    if entry is None:
        return {"status": "unknown"}

    task: "asyncio.Task[dict[str, Any]]" = entry["task"]
    if not task.done():
        return {"status": "working"}
    if task.cancelled():
        return {"status": "failed", "detail": "That answer was interrupted."}
    error = task.exception()
    if error is not None:
        return {"status": "failed", "detail": str(error)}
    return {"status": "done", **task.result()}

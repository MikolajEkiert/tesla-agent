#!/usr/bin/env python3
"""Does a turn that has to wake the car say so, and then answer by itself?

Written from the owner's report: ask anything while the car is asleep and the
app sat on "Myślę…" for ten to twenty seconds before a single reply appeared.
The wake was working the whole time — `WAKE_TIMEOUT_S` in tesla/fleet.py allows
forty seconds and the measured wake is well inside it. What was missing was any
way to say so while it happened, because the whole turn was one POST.

So /chat now hands a turn off to the background the moment the adapter reports
a wake genuinely under way, answers with a sentence and an id, and the app
collects the real reply from GET /chat/pending/{id} (app/turns.py).

Four things could go wrong with that, and each is worth more than a hypothesis:

  * the split fires when no wake started, so the app is told the car is waking
    when it is not — the same untruth the prompt has banned since the day the
    assistant announced four wakes it never performed (see dev/check_wake.py);
  * a turn against an awake car changes at all, which would mean every ordinary
    question now pays for a feature about sleeping ones;
  * a backgrounded turn becomes a way for a physically consequential command to
    happen without the tap, or to hand its confirm_token over sooner or by some
    other route than the synchronous turn does;
  * a poll that finds nothing leaves the app hanging, which is the original bug
    wearing a different hat.

Network-free and model-free: the car is MockImpl with its sleep simulation
switched on, and the "turn" is a coroutine doing what an orchestrator does —
call tools.dispatch and return {reply, history, tool_trace}. What is under test
is app/turns.py and the seam it reads, not an LLM.

Run from backend/:  TESLA_ADAPTER=mock ./.venv/bin/python dev/check_wake_reply.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

sys.path.insert(0, ".")

os.environ.setdefault("TESLA_ADAPTER", "mock")
os.environ.setdefault("GEMINI_API_KEY", "dummy-key-for-the-probe")
# Set, not setdefault. Every car here is put to sleep — or deliberately left
# awake — by hand, so that the "already awake" cases mean something. Inheriting
# AMP_MOCK_WAKE_S from a shell running `npm run api` with the simulation on
# would make the control cases start asleep and the probe pass or fail on the
# environment instead of the code.
os.environ["AMP_MOCK_WAKE_S"] = "0"

from app import actions, tools, turns  # noqa: E402
from app.llm.prompt import confirmation_payload  # noqa: E402
from app.tesla.mock import MockImpl  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'}  {name}{'' if condition else f'  <- {detail}'}")
    if not condition:
        failures.append(name)


# A wake short enough that the probe finishes in a couple of seconds, long
# enough that turns.run's quarter-second probe interval sees it in progress
# several times over. The real car takes ten to twenty.
WAKE_S = 1.0

# What the client sent us, echoed into every interim reply. Deliberately not
# empty: the bug worth catching is an interim body that tells the app to forget
# the conversation it is in.
SENT_HISTORY = [{"role": "user", "parts": [{"text": "ile mam baterii?"}]}]

REPLY = "Bateria jest na 72%."


def sleeping_car() -> MockImpl:
    car = MockImpl()
    car.sleep_now(WAKE_S)
    return car


async def reading_turn(car: MockImpl) -> dict:
    """A turn shaped like the real thing: one tool call, then an answer.

    get_vehicle_state is the path the owner's fifteen seconds actually arrived
    through — tools._read_state reads, sees `awake: false`, and wakes the car in
    the same turn so the question gets a live answer.
    """
    result = await tools.dispatch(car, "get_vehicle_state", {})
    return {
        "reply": REPLY,
        "history": SENT_HISTORY + [{"role": "model", "parts": [{"text": REPLY}]}],
        "tool_trace": [
            {
                "tool": "get_vehicle_state",
                "input": {},
                "ok": True,
                "result": confirmation_payload(result),
            }
        ],
    }


async def unlocking_turn(car: MockImpl) -> dict:
    """Reads the sleeping car — which wakes it, so this turn goes two-phase —
    and then proposes unlock, which must not happen."""
    await tools.dispatch(car, "get_vehicle_state", {})
    parked = await tools.dispatch(car, "unlock", {})
    return {
        "reply": "Mogę otworzyć — potwierdź w aplikacji.",
        "history": SENT_HISTORY,
        "tool_trace": [
            {"tool": "unlock", "input": {}, "ok": True, "result": confirmation_payload(parked)}
        ],
    }


async def collect_until_settled(pending_id: str, limit_s: float = 10.0) -> dict:
    """Poll the way the app does, and never longer than the probe can wait."""
    deadline = time.monotonic() + limit_s
    while time.monotonic() < deadline:
        out = turns.collect(pending_id)
        if out["status"] != "working":
            return out
        await asyncio.sleep(0.05)
    return {"status": "never settled"}


async def main() -> None:
    print("a question asked of a sleeping car")
    car = sleeping_car()
    first = await turns.run(car, reading_turn(car), "pl", SENT_HISTORY)
    check("comes back before the wake finishes", first.get("pending_id") is not None, str(first))
    check(
        "with a sentence saying the car is waking",
        first["reply"] == turns.interim_reply("pl"),
        first["reply"],
    )
    check("and no tool calls yet", first["tool_trace"] == [], str(first["tool_trace"]))
    check(
        "leaving the conversation it was asked in intact",
        first["history"] == SENT_HISTORY,
        str(first["history"]),
    )
    check(
        "while the turn is still running",
        turns.collect(first["pending_id"])["status"] == "working",
        str(turns.collect(first["pending_id"])),
    )

    print("\nand then answers by itself")
    settled = await collect_until_settled(first["pending_id"])
    check("the poll settles", settled["status"] == "done", str(settled.get("status")))
    check("with the real reply", settled.get("reply") == REPLY, str(settled.get("reply")))
    check(
        "the car having actually woken",
        car._state.get("awake") is True and car.waking_since() is None,
        f"awake={car._state.get('awake')} waking_since={car.waking_since()}",
    )
    check(
        "in the same three fields a synchronous turn returns",
        {"reply", "history", "tool_trace"} <= set(settled),
        str(sorted(settled)),
    )
    check(
        "carrying the turn's own history, not the one we sent",
        len(settled["history"]) == len(SENT_HISTORY) + 1,
        str(settled["history"]),
    )
    check(
        "and the tool call it made",
        [c["tool"] for c in settled["tool_trace"]] == ["get_vehicle_state"],
        str(settled["tool_trace"]),
    )

    print("\nthe same question asked of a car that is already awake")
    awake = MockImpl()
    check("is not asleep to begin with", awake.waking_since() is None)
    plain = await turns.run(awake, reading_turn(awake), "pl", SENT_HISTORY)
    check("answers in one phase", plain.get("pending_id") is None, str(plain.get("pending_id")))
    check("with the real reply straight away", plain["reply"] == REPLY, plain["reply"])
    check(
        "and the same body as ever",
        [c["tool"] for c in plain["tool_trace"]] == ["get_vehicle_state"],
        str(plain["tool_trace"]),
    )
    check(
        "matching what the backgrounded turn eventually produced",
        plain["reply"] == settled["reply"] and plain["history"] == settled["history"],
        f"{plain['history']} vs {settled['history']}",
    )

    print("\na turn that is slow for some other reason")

    async def slow_but_awake() -> dict:
        # No adapter call at all. The split must be tied to an observed wake,
        # not to a turn taking a while — a long model call, a charger lookup on
        # a slow Overpass mirror, anything.
        await asyncio.sleep(WAKE_S)
        return {"reply": REPLY, "history": SENT_HISTORY, "tool_trace": []}

    out = await turns.run(MockImpl(), slow_but_awake(), "pl", SENT_HISTORY)
    check("is never announced as a wake", out.get("pending_id") is None, str(out.get("pending_id")))
    check("and simply answers", out["reply"] == REPLY, out["reply"])

    print("\na command that needs confirming, on a sleeping car")
    car = sleeping_car()
    first = await turns.run(car, unlocking_turn(car), "en", SENT_HISTORY)
    check("still goes two-phase", first.get("pending_id") is not None, str(first))
    check(
        "and the interim carries no token",
        "confirm_token" not in str(first),
        str(first),
    )
    settled = await collect_until_settled(first["pending_id"])
    check("the poll settles", settled["status"] == "done", str(settled.get("status")))
    token = settled["tool_trace"][0]["result"]["confirm_token"]
    check("handing over the confirm token, as the synchronous turn would", bool(token))
    check(
        "the command having NOT run in the background",
        car._state["locked"] is True,
        "the car unlocked itself without a tap",
    )
    check("the proposal still parked, waiting", actions.peek_exists(token))
    await actions.confirm(car, token)
    check("only the tap opens it", car._state["locked"] is False, "confirm did not execute")
    check("and burns the token", not actions.peek_exists(token))

    print("\na poll that finds nothing")
    check(
        "an id this server never issued is a clean outcome",
        turns.collect("no-such-id") == {"status": "unknown"},
        str(turns.collect("no-such-id")),
    )
    car = sleeping_car()
    first = await turns.run(car, reading_turn(car), "en", SENT_HISTORY)
    stale = first["pending_id"]
    await collect_until_settled(stale)
    turns._pending[stale]["created_at"] -= turns.PENDING_TTL_S + 1
    check(
        "and so is one that expired before the app came back",
        turns.collect(stale) == {"status": "unknown"},
        str(turns.collect(stale)),
    )
    check("the entry being gone rather than merely hidden", stale not in turns._pending)

    print("\na backgrounded turn that fails")
    car = sleeping_car()

    async def fails_after_waking() -> dict:
        await tools.dispatch(car, "get_vehicle_state", {})
        raise RuntimeError("Gemini said no")

    first = await turns.run(car, fails_after_waking(), "en", SENT_HISTORY)
    settled = await collect_until_settled(first["pending_id"])
    check("is reported, not swallowed", settled["status"] == "failed", str(settled))
    check(
        "with the reason the synchronous path would have 502'd with",
        settled.get("detail") == "Gemini said no",
        str(settled.get("detail")),
    )

    print("\na turn that fails before any wake")

    async def fails_at_once() -> dict:
        raise RuntimeError("Gemini said no")

    raised = ""
    try:
        await turns.run(MockImpl(), fails_at_once(), "en", SENT_HISTORY)
    except RuntimeError as e:
        raised = str(e)
    check("still raises to the caller, for main.py to turn into a 502", raised == "Gemini said no", raised)

    print("\nthe store does not grow without limit")
    turns._pending.clear()
    cars = [sleeping_car() for _ in range(turns.MAX_PENDING + 2)]
    results = await asyncio.gather(*(turns.run(c, reading_turn(c), "en", SENT_HISTORY) for c in cars))
    parked = [r for r in results if r.get("pending_id")]
    check(
        f"at most {turns.MAX_PENDING} turns are ever parked",
        len(turns._pending) <= turns.MAX_PENDING,
        f"{len(turns._pending)} parked",
    )
    check(
        "and the ones refused answered in full rather than being lost",
        all(r["reply"] == REPLY for r in results if not r.get("pending_id")),
        str([r["reply"] for r in results if not r.get("pending_id")]),
    )
    for result in parked:
        await collect_until_settled(result["pending_id"])

    print("\nboth languages, and both adapters")
    check(
        "Polish and English say different things",
        turns.interim_reply("pl") != turns.interim_reply("en"),
        turns.interim_reply("pl"),
    )
    check(
        "and an unset language still says something",
        bool(turns.interim_reply(None).strip()),
        turns.interim_reply(None),
    )
    from app.tesla.adapter import TeslaAdapter
    from app.tesla.fleet import FleetImpl

    for impl in (MockImpl, FleetImpl):
        check(
            f"{impl.__name__} reports whether it is waking",
            callable(getattr(impl, "waking_since", None)),
        )
    check("and the interface demands it", "waking_since" in TeslaAdapter.__abstractmethods__)

    print()
    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")
        raise SystemExit(1)
    print("all good")


asyncio.run(main())

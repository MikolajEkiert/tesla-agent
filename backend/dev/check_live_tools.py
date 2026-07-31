#!/usr/bin/env python3
"""Does the live audio session reach the same tools — and the same gate?

The live conversation happens between the phone and Google. The only place it
touches the car is /live/tool, and the whole claim of that design is that it is
not a second door: same tool list as the typed assistant, same dispatch, same
confirmation gate. This checks that claim rather than trusting it, because the
failure it guards against is silent — a live session that quietly ends up with
fewer tools does not raise an error, it makes something up.

Network-free: the mock adapter answers, and no model is involved. What is being
proved is the wiring, not the talking.

Run from backend/:  ./.venv/bin/python dev/check_live_tools.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, ".")

os.environ.setdefault("TESLA_ADAPTER", "mock")
os.environ.setdefault("GEMINI_API_KEY", "dummy-key-for-the-probe")
os.environ.setdefault("AMP_SESSION_SECRET", "probe-secret")
os.environ.setdefault("AMP_PASSCODE_HASH", "probe-hash")

from fastapi.testclient import TestClient  # noqa: E402

from app import tools  # noqa: E402
from app.actions import CONFIRM_REQUIRED  # noqa: E402
from app.auth import gate  # noqa: E402
from app.llm.gemini_tools import declarations_as_json  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'}  {name}{'' if condition else f'  <- {detail}'}")
    if not condition:
        failures.append(name)


client = TestClient(app)
client.cookies.set(gate.COOKIE_NAME, gate.issue_session(gate.session_secret()))


def call(name: str, args: dict | None = None) -> dict:
    res = client.post("/live/tool", json={"name": name, "args": args or {}})
    assert res.status_code == 200, res.text
    return res.json()


print("declared tools")
declared = {d["name"] for d in declarations_as_json()}
implemented = {t["name"] for t in tools.TOOLS}
check("live session declares every tool the assistant has", declared == implemented,
      f"missing {sorted(implemented - declared)}, extra {sorted(declared - implemented)}")

print("\nthe gate")
res = call("unlock")
check("a sensitive command is parked, not run",
      res["ok"] and res["result"].get("confirmation_required") is True, str(res))
check("the confirmation token never reaches the model",
      "confirm_token" not in res["result"], str(res["result"]))
check("but does reach the app, so a card can be raised",
      bool(res.get("confirm", {}).get("token")), str(res.get("confirm")))

token = res["confirm"]["token"]
before = client.get("/vehicle/state").json()["locked"]
check("and the car has not moved on the model's word alone", before is True, str(before))

confirmed = client.post("/actions/confirm", json={"token": token})
check("the parked command is the one a tap executes", confirmed.status_code == 200,
      confirmed.text)
check("which does move the car", client.get("/vehicle/state").json()["locked"] is False)

print("\nevery gated command, not just unlock")
for tool in sorted(CONFIRM_REQUIRED):
    args = {
        "actuate_trunk": {"which": "rear"},
        "control_windows": {"command": "vent"},
        "set_sentry_mode": {"on": True},
        "software_update": {"action": "install", "delay_minutes": 0},
    }.get(tool, {})
    out = call(tool, args)
    check(f"{tool} is parked", out["ok"] and out["result"].get("confirmation_required") is True,
          str(out))

print("\nordinary tools")
state = call("get_vehicle_state")
check("a read goes straight through", state["ok"] and "battery_percent" in state["result"],
      str(state)[:120])
check("and raises no card", state["confirm"] is None, str(state["confirm"]))

climate = call("set_climate_temp", {"celsius": 21})
check("a reversible command runs without confirmation",
      climate["ok"] and climate["confirm"] is None, str(climate))

print("\nfailures the model has to hear about")
unknown = call("open_the_pod_bay_doors")
check("an unknown tool is an answer, not a 500", unknown["ok"] is False and unknown["error"],
      str(unknown))
out_of_range = call("set_climate_temp", {"celsius": 99})
check("an out-of-range argument is refused with a reason",
      out_of_range["ok"] is False and "between" in out_of_range["error"], str(out_of_range))

print("\nthe gate applies to the session, too")
anonymous = TestClient(app).post("/live/tool", json={"name": "get_vehicle_state"})
check("no session, no tools", anonymous.status_code == 401, str(anonymous.status_code))

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    raise SystemExit(1)
print("all good")

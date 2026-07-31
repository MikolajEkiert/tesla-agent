#!/usr/bin/env python3
"""Does the history cap ever hand a provider a tool call nobody answered?

Worth a committed probe rather than a one-off check, because the failure it
guards is invisible until it isn't: the cap only bites on a long conversation,
so a regression here would surface as the app breaking for a heavy user after
forty exchanges and working perfectly in every quick test.

Run from backend/:  ./.venv/bin/python dev/check_history.py
"""
from __future__ import annotations

import sys

sys.path.insert(0, ".")

from app.llm.prompt import (  # noqa: E402  (path set above)
    MAX_HISTORY_TURNS,
    _holds_tool_calls,
    _is_plain_user_turn,
    sanitize_history,
)

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'}  {name}{'' if condition else f'  ({detail})'}")
    if not condition:
        failures.append(name)


def gemini_exchange(i: int) -> list[dict]:
    """One full Gemini round: question, tool call, tool answer, reply."""
    return [
        {"role": "user", "parts": [{"text": f"pytanie {i}"}]},
        {"role": "model", "parts": [{"function_call": {"name": "get_vehicle_state", "args": {}}}]},
        {"role": "user", "parts": [{"function_response": {"name": "get_vehicle_state",
                                                          "response": {"result": {}}}}]},
        {"role": "model", "parts": [{"text": f"odpowiedź {i}"}]},
    ]


def anthropic_exchange(i: int) -> list[dict]:
    return [
        {"role": "user", "content": f"pytanie {i}"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": f"t{i}",
                                           "name": "get_vehicle_state", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}",
                                      "content": "{}"}]},
        {"role": "assistant", "content": [{"type": "text", "text": f"odpowiedź {i}"}]},
    ]


def gemini_double_call(i: int) -> list[dict]:
    """A round that asks for two tools at once — five turns, not four."""
    return [
        {"role": "user", "parts": [{"text": f"złożone pytanie {i}"}]},
        {"role": "model", "parts": [
            {"function_call": {"name": "find_chargers", "args": {}}},
            {"function_call": {"name": "set_climate_temp", "args": {"celsius": 21}}},
        ]},
        {"role": "user", "parts": [
            {"function_response": {"name": "find_chargers", "response": {"result": {}}}},
            {"function_response": {"name": "set_climate_temp", "response": {"result": {}}}},
        ]},
        {"role": "model", "parts": [{"function_call": {"name": "get_vehicle_state", "args": {}}}]},
        {"role": "user", "parts": [{"function_response": {"name": "get_vehicle_state",
                                                          "response": {"result": {}}}}]},
        {"role": "model", "parts": [{"text": f"odpowiedź {i}"}]},
    ]


def naive_slice(history: list[dict]) -> list[dict]:
    """What the code did before — a plain slice at a fixed index."""
    return history[-MAX_HISTORY_TURNS:]


print("Czy ten test w ogóle łapie usterkę?")
# The boundary is placed by construction rather than hoped for. Uniform
# four-turn exchanges make a useless test — 60 divides by 4, so the old slice
# always landed cleanly and would have passed. Here the 61st entry from the end
# is deliberately the model turn that asks for a tool, so a plain slice starts
# the history with a call whose answer was left behind.
head = [
    {"role": "user", "parts": [{"text": "stare pytanie"}]},
    {"role": "model", "parts": [{"text": "stara odpowiedź"}]},
    {"role": "user", "parts": [{"text": "jeszcze starsze"}]},
    {"role": "model", "parts": [{"text": "i odpowiedź"}]},
]
straddling_pair = [
    {"role": "model", "parts": [{"function_call": {"name": "find_chargers", "args": {}}}]},
    {"role": "user", "parts": [{"function_response": {"name": "find_chargers",
                                                      "response": {"result": {}}}}]},
]
tail = [t for i in range(10) for t in gemini_double_call(i)][:58]
mixed = head + straddling_pair + tail
assert len(mixed) - MAX_HISTORY_TURNS == len(head), "granica nie wypadła tam, gdzie chciałem"

old = naive_slice(mixed)
check("stary sposób faktycznie zaczynał od osieroconego wywołania",
      _holds_tool_calls(old[0]),
      "gdyby zaczynał czysto, test nie sprawdzałby niczego")

print("Gemini — długa historia z rundami wielonarzędziowymi")
history = mixed
result = sanitize_history(history)
check("zaczyna się zwykłą turą użytkownika", bool(result) and _is_plain_user_turn(result[0]),
      f"pierwszy wpis: {result[0] if result else 'pusto'}")
check("nie kończy się wiszącym wywołaniem", bool(result) and not _holds_tool_calls(result[-1]))
check("nie jest dłuższa niż limit", len(result) <= MAX_HISTORY_TURNS, str(len(result)))
check("nie jest pusta", len(result) > 0, str(len(result)))

print("Anthropic — to samo w drugim kształcie")
history = [turn for i in range(20) for turn in anthropic_exchange(i)]
result = sanitize_history(history)
check("zaczyna się zwykłą turą użytkownika", bool(result) and _is_plain_user_turn(result[0]),
      f"pierwszy wpis: {result[0] if result else 'pusto'}")
check("nie kończy się wiszącym wywołaniem", bool(result) and not _holds_tool_calls(result[-1]))

print("Krótka historia zostaje nietknięta")
short = gemini_exchange(0)
check("nic nie ucięte", sanitize_history(short) == short)

print("Wisząca prośba o narzędzia na końcu jest obcinana")
dangling = gemini_exchange(0) + [
    {"role": "user", "parts": [{"text": "kolejne"}]},
    {"role": "model", "parts": [{"function_call": {"name": "lock", "args": {}}}]},
]
result = sanitize_history(dangling)
check("ostatnia tura nie prosi o narzędzie", not _holds_tool_calls(result[-1]))

print("Nieznane role dalej odpadają")
check("rola 'system' odrzucona",
      sanitize_history([{"role": "system", "parts": [{"text": "x"}]}]) == [])

print()
if failures:
    print(f"NIEPOWODZENIA: {len(failures)} — {', '.join(failures)}")
    raise SystemExit(1)
print("wszystko zgodne")

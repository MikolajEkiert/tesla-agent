"""The AI layer: natural language -> tool calls -> natural-language reply.

The LLM never talks to Tesla directly. It only emits tool calls to our adapter;
this module runs the tool-use loop and calls the adapter. Secrets and the car's
tokens stay server-side.
"""
from __future__ import annotations

import json
from typing import Any

from anthropic import AsyncAnthropic

from app.config import get_settings
from app.tesla.adapter import TeslaAdapter
from app.tools import TOOLS, dispatch

SYSTEM_PROMPT = (
    "You are the in-car voice assistant for the owner's Tesla Model 3. "
    "Translate natural-language requests into the provided tools to control "
    "climate, media, locks, and charging, and to read vehicle state. "
    "Keep spoken replies short and natural — one sentence is usually enough. "
    "Read state with get_vehicle_state before answering questions about the car; "
    "don't guess. If a request is ambiguous or could be unintended (e.g. "
    "unlocking), ask a brief clarifying question instead of acting. "
    "If a command may be slow because the car is asleep, say so briefly."
)

# Anthropic message history is a list of {role, content} dicts.
Message = dict[str, Any]


class Orchestrator:
    def __init__(self, adapter: TeslaAdapter) -> None:
        self.adapter = adapter
        self.settings = get_settings()
        self.client = AsyncAnthropic(api_key=self.settings.anthropic_api_key)

    async def chat(self, user_text: str, history: list[Message] | None = None) -> dict[str, Any]:
        """Run one user turn to completion. Returns the reply text plus the updated
        history so the client can keep context across turns."""
        messages: list[Message] = list(history or [])
        messages.append({"role": "user", "content": user_text})

        tool_trace: list[dict[str, Any]] = []

        while True:
            resp = await self.client.messages.create(
                model=self.settings.anthropic_model,
                max_tokens=1024,
                # Low effort keeps latency down for a snappy voice UX. Thinking stays
                # on by default (do NOT disable it on Opus 5 — with tools it can emit
                # tool calls as plain text).
                output_config={"effort": "low"},
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
            )

            if resp.stop_reason != "tool_use":
                # Final natural-language answer.
                text = "".join(b.text for b in resp.content if b.type == "text")
                messages.append({"role": "assistant", "content": resp.content})
                return {"reply": text, "history": messages, "tool_trace": tool_trace}

            # Echo the assistant turn (including tool_use blocks) back into history.
            messages.append({"role": "assistant", "content": resp.content})

            # Execute every requested tool, collect results into a single user turn.
            tool_results: list[dict[str, Any]] = []
            for block in resp.content:
                if block.type != "tool_use":
                    continue
                try:
                    result = await dispatch(self.adapter, block.name, dict(block.input))
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(result),
                        }
                    )
                    tool_trace.append({"tool": block.name, "input": block.input, "ok": True})
                except Exception as e:  # surface the failure to the model so it can recover
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"Error: {e}",
                            "is_error": True,
                        }
                    )
                    tool_trace.append({"tool": block.name, "input": block.input, "ok": False})

            messages.append({"role": "user", "content": tool_results})

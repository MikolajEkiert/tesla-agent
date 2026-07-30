"""Anthropic (Claude) implementation of the AI layer — kept as a fallback
provider. Set LLM_PROVIDER=anthropic to use it.
"""
from __future__ import annotations

import json
from typing import Any

from anthropic import AsyncAnthropic

from app.config import get_settings
from app.llm.prompt import build_system_prompt, confirmation_payload, sanitize_history
from app.tesla.adapter import TeslaAdapter
from app.tools import TOOLS, dispatch

Message = dict[str, Any]


class AnthropicOrchestrator:
    def __init__(self, adapter: TeslaAdapter) -> None:
        self.adapter = adapter
        self.settings = get_settings()
        self.client = AsyncAnthropic(api_key=self.settings.anthropic_api_key)

    async def chat(
        self,
        user_text: str,
        history: list[Message] | None = None,
        language: str | None = None,
    ) -> dict[str, Any]:
        messages: list[Message] = sanitize_history(history)
        messages.append({"role": "user", "content": user_text})
        tool_trace: list[dict[str, Any]] = []

        while True:
            resp = await self.client.messages.create(
                model=self.settings.anthropic_model,
                max_tokens=1024,
                # Low effort keeps latency down for voice. Thinking stays on by
                # default (do NOT disable it on Opus 5 — with tools it can emit
                # tool calls as plain text).
                output_config={"effort": "low"},
                system=build_system_prompt(language),
                tools=TOOLS,
                messages=messages,
            )

            if resp.stop_reason != "tool_use":
                text = "".join(b.text for b in resp.content if b.type == "text")
                messages.append({"role": "assistant", "content": resp.content})
                return {"reply": text, "history": messages, "tool_trace": tool_trace}

            messages.append({"role": "assistant", "content": resp.content})

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
                    tool_trace.append(
                        {
                            "tool": block.name,
                            "input": block.input,
                            "ok": True,
                            "result": confirmation_payload(result),
                        }
                    )
                except Exception as e:
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

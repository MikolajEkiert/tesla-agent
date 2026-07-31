"""Google Gemini implementation of the AI layer (default provider).

Uses the google-genai SDK's manual function-calling loop: automatic function
calling is disabled so we run tools through our own TeslaAdapter, keeping the
LLM away from Tesla and secrets server-side — same design as the Anthropic path.
"""
from __future__ import annotations

from typing import Any

from google import genai
from google.genai import types

from app.config import get_settings
from app.llm.gemini_tools import function_declarations
from app.llm.prompt import (
    MAX_TOOL_ROUNDS,
    build_system_prompt,
    confirmation_payload,
    sanitize_history,
)
from app.tesla.adapter import TeslaAdapter
from app.tools import dispatch


class GeminiOrchestrator:
    def __init__(self, adapter: TeslaAdapter) -> None:
        self.adapter = adapter
        self.settings = get_settings()
        self.client = genai.Client(api_key=self.settings.gemini_api_key)
        self._tools = [types.Tool(function_declarations=function_declarations())]

    def _config(
        self,
        language: str | None,
        persona: str | None = None,
        persona_style: str | None = None,
    ) -> types.GenerateContentConfig:
        # Built fresh per request (cheap) since the system instruction
        # depends on the caller's language and persona settings, not just the
        # adapter.
        return types.GenerateContentConfig(
            system_instruction=build_system_prompt(language, persona, persona_style),
            tools=self._tools,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

    async def chat(
        self,
        user_text: str,
        history: list[dict[str, Any]] | None = None,
        language: str | None = None,
        persona: str | None = None,
        persona_style: str | None = None,
    ) -> dict[str, Any]:
        contents: list[dict[str, Any]] = sanitize_history(history)
        contents.append({"role": "user", "parts": [{"text": user_text}]})
        tool_trace: list[dict[str, Any]] = []
        config = self._config(language, persona, persona_style)

        # Bounded rather than `while True`: the number of rounds is decided by
        # model output, so an unbounded loop is an unbounded spend of quota and
        # of car wake-ups, reachable from one question.
        for _ in range(MAX_TOOL_ROUNDS):
            resp = await self.client.aio.models.generate_content(
                model=self.settings.gemini_model,
                contents=contents,
                config=config,
            )
            # A safety block or a hit token ceiling comes back well-formed with
            # no candidates at all. Indexing it raised IndexError, which reached
            # the user as a bodyless 502 — indistinguishable from the backend
            # being down, when in fact the model answered and we discarded it.
            candidate = (resp.candidates or [None])[0]
            if candidate is None or candidate.content is None:
                reason = getattr(candidate, "finish_reason", None) or getattr(
                    resp, "prompt_feedback", None
                )
                raise RuntimeError(f"The model returned no answer ({reason or 'no reason given'}).")
            model_content = candidate.content
            # Echo the model turn (incl. any function_call parts) into history.
            contents.append(model_content.model_dump(mode="json", exclude_none=True))

            calls = resp.function_calls or []
            if not calls:
                return {"reply": resp.text or "", "history": contents, "tool_trace": tool_trace}

            # Execute every requested tool; return all responses in one user turn.
            #
            # Sequentially, and that is a decision rather than an oversight:
            # FleetImpl shares an "awake" cache and a wake-and-retry across
            # calls, so two concurrent commands would race to wake one car, and
            # actions._pending is a shared dict. The latency saved is not worth
            # the class of bug bought.
            parts: list[dict[str, Any]] = []
            for fc in calls:
                args = dict(fc.args or {})
                try:
                    result = await dispatch(self.adapter, fc.name, args)
                    parts.append(
                        {"function_response": {"name": fc.name, "response": {"result": result}}}
                    )
                    tool_trace.append(
                        {
                            "tool": fc.name,
                            "input": args,
                            "ok": True,
                            "result": confirmation_payload(result),
                        }
                    )
                except Exception as e:  # surface failure so the model can recover
                    parts.append(
                        {"function_response": {"name": fc.name, "response": {"error": str(e)}}}
                    )
                    tool_trace.append({"tool": fc.name, "input": args, "ok": False})

            contents.append({"role": "user", "parts": parts})

        # Out of rounds. The tools that did run have already run, so say what
        # happened rather than pretending the turn produced nothing — and drop
        # the unanswered call, which would otherwise poison the next turn.
        while contents and contents[-1].get("role") == "model":
            contents.pop()
        return {
            "reply": (
                "Zatrzymałem się po kilku krokach, żeby nie kręcić się w kółko. "
                "Powiedz, co dokładnie mam zrobić."
                if (language or "").lower() == "pl"
                else "I stopped after several steps to avoid going in circles. "
                "Tell me exactly what you'd like me to do."
            ),
            "history": contents,
            "tool_trace": tool_trace,
        }

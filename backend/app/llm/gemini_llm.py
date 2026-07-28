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
from app.llm.prompt import SYSTEM_PROMPT
from app.tesla.adapter import TeslaAdapter
from app.tools import TOOLS, dispatch


def _to_gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Convert our canonical JSON-schema dicts to Gemini's OpenAPI subset:
    drop `additionalProperties` (unsupported) and uppercase `type` values."""
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "additionalProperties":
            continue
        if key == "type" and isinstance(value, str):
            out[key] = value.upper()
        elif key == "properties" and isinstance(value, dict):
            out[key] = {k: _to_gemini_schema(v) for k, v in value.items()}
        elif key == "items" and isinstance(value, dict):
            out[key] = _to_gemini_schema(value)
        else:
            out[key] = value
    return out


def _function_declarations() -> list[types.FunctionDeclaration]:
    decls = []
    for tool in TOOLS:
        schema = tool["input_schema"]
        params = _to_gemini_schema(schema) if schema.get("properties") else None
        decls.append(
            types.FunctionDeclaration(
                name=tool["name"],
                description=tool["description"],
                parameters=params,
            )
        )
    return decls


class GeminiOrchestrator:
    def __init__(self, adapter: TeslaAdapter) -> None:
        self.adapter = adapter
        self.settings = get_settings()
        self.client = genai.Client(api_key=self.settings.gemini_api_key)
        self.config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            tools=[types.Tool(function_declarations=_function_declarations())],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

    async def chat(
        self, user_text: str, history: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        contents: list[dict[str, Any]] = list(history or [])
        contents.append({"role": "user", "parts": [{"text": user_text}]})
        tool_trace: list[dict[str, Any]] = []

        while True:
            resp = await self.client.aio.models.generate_content(
                model=self.settings.gemini_model,
                contents=contents,
                config=self.config,
            )
            model_content = resp.candidates[0].content
            # Echo the model turn (incl. any function_call parts) into history.
            contents.append(model_content.model_dump(mode="json", exclude_none=True))

            calls = resp.function_calls or []
            if not calls:
                return {"reply": resp.text or "", "history": contents, "tool_trace": tool_trace}

            # Execute every requested tool; return all responses in one user turn.
            parts: list[dict[str, Any]] = []
            for fc in calls:
                args = dict(fc.args or {})
                try:
                    result = await dispatch(self.adapter, fc.name, args)
                    parts.append(
                        {"function_response": {"name": fc.name, "response": {"result": result}}}
                    )
                    tool_trace.append({"tool": fc.name, "input": args, "ok": True})
                except Exception as e:  # surface failure so the model can recover
                    parts.append(
                        {"function_response": {"name": fc.name, "response": {"error": str(e)}}}
                    )
                    tool_trace.append({"tool": fc.name, "input": args, "ok": False})

            contents.append({"role": "user", "parts": parts})

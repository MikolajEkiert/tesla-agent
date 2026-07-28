"""LLM provider seam — mirrors the Tesla adapter pattern.

Every orchestrator exposes the same coroutine:
    async def chat(user_text: str, history: list[dict] | None) -> dict
returning {"reply": str, "history": list[dict], "tool_trace": list[dict]}.

`history` is provider-native but always JSON-serializable, so the mobile client
can store it and pass it back for multi-turn context. Provider is fixed per
deployment (don't mix providers within one conversation's history).
"""
from __future__ import annotations

from app.config import get_settings
from app.tesla.adapter import TeslaAdapter


def build_orchestrator(adapter: TeslaAdapter):
    settings = get_settings()
    if settings.llm_provider == "anthropic":
        from app.llm.anthropic_llm import AnthropicOrchestrator

        return AnthropicOrchestrator(adapter)
    from app.llm.gemini_llm import GeminiOrchestrator

    return GeminiOrchestrator(adapter)

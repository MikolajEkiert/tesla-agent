"""FastAPI entrypoint: the chat endpoint your mobile app calls, plus the routes
Tesla needs (public key at /.well-known/..., and the OAuth callback).
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from app.config import get_settings
from app.llm import build_orchestrator
from app.tesla.adapter import build_adapter
from app.auth.oauth import get_authorize_url, exchange_code

settings = get_settings()
app = FastAPI(title="tesla-agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# One adapter + orchestrator for the process. The mock adapter holds state in
# memory; the fleet adapter is stateless per request beyond cached tokens.
adapter = build_adapter()
orchestrator = build_orchestrator(adapter)


class ChatRequest(BaseModel):
    message: str
    history: list[dict[str, Any]] | None = None


class ChatResponse(BaseModel):
    reply: str
    history: list[dict[str, Any]]
    tool_trace: list[dict[str, Any]]


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "adapter": settings.tesla_adapter,
        "llm": settings.llm_provider,
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    result = await orchestrator.chat(req.message, req.history)
    return ChatResponse(**result)


@app.get("/vehicle/state")
async def vehicle_state() -> dict[str, Any]:
    """Direct read, no LLM involved — cheap enough to poll for a live UI strip."""
    return await adapter.get_state()


# --- Tesla-required routes (only relevant once you go live on the fleet adapter) ---

@app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem")
async def tesla_public_key() -> PlainTextResponse:
    """Tesla fetches your virtual-key public key from exactly this path.
    Put your generated PEM at backend/keys/public-key.pem before going live."""
    try:
        with open("keys/public-key.pem", "r") as f:
            return PlainTextResponse(f.read(), media_type="application/x-pem-file")
    except FileNotFoundError:
        return PlainTextResponse(
            "public key not generated yet; see README", status_code=404
        )


@app.get("/auth/login")
async def auth_login() -> RedirectResponse:
    url, _ = get_authorize_url()
    return RedirectResponse(url)


@app.get("/auth/callback")
async def auth_callback(code: str, state: str) -> dict[str, str]:
    try:
        await exchange_code(code, state)
        return {"status": "success", "message": "Tesla account linked successfully. You can close this window."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

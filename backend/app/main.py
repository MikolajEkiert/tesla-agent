"""FastAPI entrypoint: the chat endpoint your mobile app calls, plus the routes
Tesla needs (public key at /.well-known/..., and the OAuth callback).
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from app.config import get_settings
from app.llm import build_orchestrator
from app.tesla.adapter import build_adapter
from app.auth.oauth import disconnect, exchange_code, get_authorize_url, has_tokens

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
    try:
        result = await orchestrator.chat(req.message, req.history)
    except Exception as e:
        # Without this, any downstream failure (LLM rate limit, LLM outage,
        # a bad tool call) surfaces as FastAPI's generic, bodyless 500 —
        # indistinguishable from the backend actually being down. str(e) is
        # the LLM SDK's own message (e.g. Gemini's quota-exceeded text),
        # which is specific enough to act on without leaking secrets.
        raise HTTPException(status_code=502, detail=str(e))
    return ChatResponse(**result)


@app.get("/vehicle/state")
async def vehicle_state() -> dict[str, Any]:
    """Direct read, no LLM involved — cheap enough to poll for a live UI
    strip. Never wakes the car (see FleetImpl.get_state) — a sleeping
    vehicle is a normal response (awake: false + a cached snapshot), not an
    error. This only catches genuine failures (auth, network)."""
    try:
        return await adapter.get_state()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


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


@app.get("/auth/status")
async def auth_status() -> dict[str, bool]:
    """Powers the mobile app's connect-to-Tesla gate. `required` is false on
    the mock adapter, which needs no Tesla login at all."""
    return {
        "required": settings.tesla_adapter == "fleet",
        "connected": await has_tokens(),
    }


@app.post("/auth/disconnect")
async def auth_disconnect() -> dict[str, bool]:
    await disconnect()
    return {"connected": False}


@app.get("/auth/login")
async def auth_login() -> RedirectResponse:
    url, _ = get_authorize_url()
    return RedirectResponse(url)


@app.get("/auth/callback")
async def auth_callback(code: str, state: str) -> RedirectResponse:
    """Redirects back into the PWA (same domain) instead of showing raw JSON
    in what's otherwise a dead-end OAuth tab. The app reads ?tesla_auth=...
    on load to show a success/error message."""
    try:
        await exchange_code(code, state)
        return RedirectResponse("/?tesla_auth=success")
    except Exception as e:
        return RedirectResponse(f"/?tesla_auth=error&message={quote(str(e))}")

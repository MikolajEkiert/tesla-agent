"""FastAPI entrypoint: the chat endpoint your mobile app calls, plus the routes
Tesla needs (public key at /.well-known/..., and the OAuth callback).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from app import actions, confirm_phrase, live, scheduler, tools, tts, voice
from app.auth import gate, passkey
from app.config import get_settings
from app.llm import build_orchestrator
from app.llm import persona
from app.tesla.adapter import build_adapter
from app.auth.oauth import disconnect, exchange_code, get_authorize_url, has_tokens

settings = get_settings()

# One adapter + orchestrator for the process. The mock adapter holds state in
# memory; the fleet adapter is stateless per request beyond cached tokens.
# Built before the app so the lifespan runner below can take the same adapter
# instance — the scheduler must act on the very same car state the API does.
adapter = build_adapter()
orchestrator = build_orchestrator(adapter)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Owns the scheduler's background runner. Starting it here (rather than
    lazily on first use) is what makes a job survive a redeploy: on boot the
    runner picks up everything still pending, including jobs whose run_at has
    already passed while the container was down."""
    task = asyncio.create_task(scheduler.runner_loop(adapter))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="tesla-agent", lifespan=lifespan)

# Paths reachable without a session. Deliberately a tiny allowlist rather than
# a blocklist: a new endpoint added later is protected by default, which is the
# failure direction we want when every other route can move a real car.
# (method, path) rather than path alone. The passkey routes include a greedy
# DELETE /gate/passkey/{credential_id:path}, so a path-only allowlist let an
# unauthenticated DELETE /gate/passkey/login/begin reach the delete handler —
# measured as a 404 rather than a 401. Harmless today, because no real
# credential id can equal "login/begin", but it is one added public path away
# from being a real hole.
PUBLIC_ROUTES = {
    ("GET", "/health"),
    ("GET", "/gate/status"),
    ("POST", "/gate/unlock"),
    # Logging in with a passkey has to work *before* a session exists. Only
    # the login pair is public — enrolling a new passkey stays behind the
    # gate, so a stranger cannot add their own key to the car.
    ("POST", "/gate/passkey/login/begin"),
    ("POST", "/gate/passkey/login/finish"),
}
PUBLIC_PREFIXES = (
    # Tesla itself fetches the virtual-key public key from here.
    "/.well-known/",
)

# Routes that additionally accept the Shortcut bearer token (see
# gate.shortcut_token). Exactly one, and deliberately not /actions/confirm:
# Siri can ask questions and start reversible things, but opening the car still
# needs a tap in the app on a real session. Keeping the list here — next to
# PUBLIC_ROUTES rather than as a decorator on the endpoint — means the whole
# access model is readable in one place.
TOKEN_ROUTES = {
    ("POST", "/voice/ask"),
}


@app.middleware("http")
async def require_session(request: Request, call_next):
    path = request.url.path
    if (
        (request.method, path) in PUBLIC_ROUTES
        or path.startswith(PUBLIC_PREFIXES)
        # CORS preflight carries no cookies. It is answered by CORSMiddleware
        # (registered outside this one) and no route declares OPTIONS, so a
        # non-preflight OPTIONS gets a 405 rather than reaching anything.
        or request.method == "OPTIONS"
    ):
        return await call_next(request)

    try:
        secret = gate.session_secret()
    except gate.NotConfigured as e:
        # Fail closed. An unconfigured gate must never mean "let everyone in".
        return JSONResponse({"detail": str(e)}, status_code=503)

    if gate.session_is_valid(request.cookies.get(gate.COOKIE_NAME), secret):
        return await call_next(request)

    # Checked only after the session, so a browser always authenticates the
    # strong way and the token is a fallback for clients that cannot hold a
    # cookie. A wrong token counts against the same lockout as a wrong
    # passcode — otherwise it would be the one unrate-limited guessing oracle
    # on the server.
    if (request.method, path) in TOKEN_ROUTES:
        client = gate.client_key(
            request.client.host if request.client else None,
            request.headers.get("x-forwarded-for"),
        )
        if gate.is_locked_out(client):
            return JSONResponse({"detail": "Too many attempts."}, status_code=429)
        if gate.shortcut_token_valid(request.headers.get("authorization")):
            return await call_next(request)
        gate.record_failure(client)

    return JSONResponse({"detail": "Not unlocked"}, status_code=401)


# Added last so it ends up OUTERMOST: Starlette applies middleware in reverse
# registration order, and the session gate above returns 401 by itself. If CORS
# sat inside the gate, that 401 would go out without CORS headers and a browser
# would report an opaque network failure instead of "locked" — which is exactly
# the difference between showing the passcode screen and showing an error.
#
# The session lives in a cookie, and a browser will not send one to a wildcard
# origin. That is the whole difficulty, and the default used to lose to it: with
# CORS_ORIGINS unset the middleware answered "*" with credentials switched off,
# which every request this app makes is refused by — api.ts sends
# `credentials: "include"` on all of them, because the cookie is the session.
#
# The refusal happens in the browser, before any response is delivered, so
# `fetch` rejects with a bare TypeError and the app cannot tell it from the
# server being down. What the driver saw, every time, was "couldn't reach Amp's
# backend — is it running?" while the backend sat there answering curl perfectly.
#
# It only ever bit locally, and that is not a coincidence: in production Caddy
# serves the app and proxies the API on one domain, so nothing is cross-origin
# and this middleware is never exercised at all. A default that fails in the one
# situation it exists for is not a default worth keeping.
#
# So: an explicit CORS_ORIGINS is honoured as before, and the unset case means
# local development — the loopback origins a dev server can be on, with
# credentials allowed. Narrower than the "*" it replaces, not wider.
_LOCAL_ORIGIN_RE = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
_wildcard = settings.cors_origins == ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if _wildcard else settings.cors_origins,
    allow_origin_regex=_LOCAL_ORIGIN_RE if _wildcard else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class UnlockRequest(BaseModel):
    passcode: str
    totp: str | None = None


@app.get("/gate/status")
async def gate_status() -> dict[str, Any]:
    """Lets the app show the right screen, and whether to offer Face ID,
    before asking for anything."""
    return {**gate.gate_status(), "passkey_available": await passkey.has_passkeys()}


@app.post("/gate/unlock")
async def gate_unlock(req: UnlockRequest, request: Request, response: Response) -> dict[str, Any]:
    client = gate.client_key(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )
    if gate.is_locked_out(client):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Wait 15 minutes and try again.",
        )
    try:
        stored, secret = gate.passcode_hash(), gate.session_secret()
    except gate.NotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))

    ok = gate.verify_passcode(req.passcode, stored)
    totp = gate.totp_secret()
    if ok and totp:
        ok = gate.verify_totp(req.totp or "", totp)
    if not ok:
        gate.record_failure(client)
        # One message for a wrong passcode and a wrong code alike — saying
        # which was wrong would tell an attacker they had the passcode right.
        raise HTTPException(status_code=401, detail="Incorrect passcode")

    gate.clear_failures(client)
    response.set_cookie(
        gate.COOKIE_NAME,
        gate.issue_session(secret),
        max_age=gate.SESSION_MAX_AGE_S,
        httponly=True,
        secure=True,
        samesite="lax",  # still sent when Tesla redirects back to /auth/callback
        path="/",
    )
    return {"ok": True}


@app.post("/gate/lock")
async def gate_lock(response: Response) -> dict[str, bool]:
    response.delete_cookie(gate.COOKIE_NAME, path="/")
    return {"ok": True}


# --- passkeys ---------------------------------------------------------------
# Registration sits behind the session gate on purpose: only someone who has
# already proved they know the passcode may enrol a new device. Login is
# necessarily public, but proves possession of a private key the server has
# never seen.

class RegisterBeginRequest(BaseModel):
    passcode: str
    totp: str | None = None


@app.post("/gate/passkey/register/begin")
async def passkey_register_begin(
    req: RegisterBeginRequest, request: Request
) -> Response:
    """Enrolling a new passkey re-checks the passcode even though the caller
    already holds a session.

    A session alone was enough before, which meant one borrowed unlocked phone
    (or one stolen cookie) could be converted into a permanent credential of
    the attacker's own — surviving a passcode change, because passkeys do not
    depend on it. Re-authentication turns a momentary compromise back into a
    momentary one.
    """
    client = gate.client_key(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )
    if gate.is_locked_out(client):
        raise HTTPException(status_code=429, detail="Too many attempts. Wait 15 minutes.")
    try:
        stored = gate.passcode_hash()
    except gate.NotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))

    ok = gate.verify_passcode(req.passcode, stored)
    totp = gate.totp_secret()
    if ok and totp:
        ok = gate.verify_totp(req.totp or "", totp)
    if not ok:
        gate.record_failure(client)
        raise HTTPException(status_code=401, detail="Incorrect passcode")
    gate.clear_failures(client)
    return Response(await passkey.registration_options(), media_type="application/json")


@app.post("/gate/passkey/register/finish")
async def passkey_register_finish(body: dict[str, Any]) -> dict[str, bool]:
    try:
        await passkey.verify_registration(body.get("credential", {}), body.get("label"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.get("/gate/passkey/list")
async def passkey_list() -> dict[str, Any]:
    return {"passkeys": await passkey.list_passkeys()}


@app.delete("/gate/passkey/{credential_id:path}")
async def passkey_delete(credential_id: str) -> dict[str, bool]:
    if not await passkey.delete_passkey(credential_id):
        raise HTTPException(status_code=404, detail="No such passkey")
    return {"ok": True}


@app.post("/gate/passkey/login/begin")
async def passkey_login_begin(request: Request) -> Response:
    client = gate.client_key(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )
    if gate.is_locked_out(client):
        raise HTTPException(status_code=429, detail="Too many attempts. Wait 15 minutes.")
    return Response(await passkey.authentication_options(), media_type="application/json")


@app.post("/gate/passkey/login/finish")
async def passkey_login_finish(
    body: dict[str, Any], request: Request, response: Response
) -> dict[str, bool]:
    client = gate.client_key(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )
    if gate.is_locked_out(client):
        raise HTTPException(status_code=429, detail="Too many attempts. Wait 15 minutes.")
    try:
        secret = gate.session_secret()
    except gate.NotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    try:
        await passkey.verify_authentication(body.get("credential", {}))
    except Exception as e:
        gate.record_failure(client)
        raise HTTPException(status_code=401, detail=str(e))

    gate.clear_failures(client)
    response.set_cookie(
        gate.COOKIE_NAME,
        gate.issue_session(secret),
        max_age=gate.SESSION_MAX_AGE_S,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    return {"ok": True}


class ChatRequest(BaseModel):
    message: str
    history: list[dict[str, Any]] | None = None
    # "en" | "pl" — mirrors the app's language setting (mobile/src/i18n.ts).
    # Sets the assistant's *default* reply language; unrecognized/omitted
    # values fall back to English in build_system_prompt.
    language: str | None = None
    # How the assistant should sound: a built-in id from app/llm/persona.py, or
    # the id of one the owner defined on their phone. An id this server does
    # not know is normal rather than an error — a custom persona lives on the
    # device, so its meaning arrives in persona_style below.
    persona: str | None = None
    # The owner's own words for a custom persona. Ignored outright when
    # `persona` names a built-in, capped and flattened before it goes anywhere
    # near a prompt (persona.sanitize_custom), and framed as a quotation when
    # it gets there. It changes tone and nothing else; the gate that decides
    # what may actually happen to the car is in app/actions.py, where no
    # wording can reach it.
    persona_style: str | None = None


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
        result = await orchestrator.chat(
            req.message, req.history, req.language, req.persona, req.persona_style
        )
    except Exception as e:
        # Without this, any downstream failure (LLM rate limit, LLM outage,
        # a bad tool call) surfaces as FastAPI's generic, bodyless 500 —
        # indistinguishable from the backend actually being down. str(e) is
        # the LLM SDK's own message (e.g. Gemini's quota-exceeded text),
        # which is specific enough to act on without leaking secrets.
        raise HTTPException(status_code=502, detail=str(e))
    return ChatResponse(**result)


@app.post("/voice/transcribe")
async def voice_transcribe(request: Request, language: str | None = None) -> dict[str, str]:
    """Audio in, text out. Nothing else.

    The transcript goes back to the app, which sends it through /chat like any
    typed message — so voice reuses the whole existing pipeline (tools,
    confirmation gate, trace, queue) instead of paralleling it. It also means
    you see what was heard before it acts, in the chat, and can correct it.

    Takes the raw recording as the request body rather than multipart form
    data: the client posts one blob with one content type, which needs no
    parser dependency and lets the size be checked before anything is read.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > voice.MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too long")

    audio = await request.body()
    try:
        text = await voice.transcribe(
            audio, request.headers.get("content-type", ""), language
        )
    except voice.TranscriptionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"text": text}


class VoiceSpeakRequest(BaseModel):
    text: str
    language: str | None = None
    voice: str | None = None


@app.post("/voice/speak")
async def voice_speak(req: VoiceSpeakRequest) -> Response:
    """Text in, a WAV out. The reply the app just received, made audible.

    Behind the session gate and deliberately *not* in TOKEN_ROUTES: the
    Shortcut speaks with the phone's own voice, and giving a token holder a
    route that spends API quota per call would hand a stranger standing next to
    your phone a way to run up the bill.

    Every failure is a 503, including a rate limit, because the client's
    response to all of them is the same — read the reply with the built-in
    voice instead. The distinction that matters here is "did you get audio",
    not why not.
    """
    try:
        audio = await tts.synthesize(req.text, req.language, req.voice)
    except tts.SpeechError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    return Response(
        content=audio,
        media_type=tts.MEDIA_TYPE,
        # The same reply is often spoken twice (asked again, or replayed), and
        # a reply is derived entirely from its text, so letting the browser
        # keep it briefly saves a quota slot on the free tier.
        headers={"cache-control": "private, max-age=300"},
    )


class LiveTokenRequest(BaseModel):
    voice: str | None = None
    language: str | None = None
    # A model that minted a token and then refused the session. The phone is
    # the only party that sees that happen — from here the mint succeeded — so
    # it has to say which one, or the retry asks for the same refusal.
    avoid: str | None = None
    # The same two fields as ChatRequest, and for the same reason: the live
    # session is the assistant while it is open, so a manner that applied only
    # to typed replies would drop away the moment the driver spoke.
    persona: str | None = None
    persona_style: str | None = None


@app.post("/voice/live-token")
async def live_token(req: LiveTokenRequest) -> dict[str, Any]:
    """A one-use credential letting the phone hold its own audio session.

    Behind the session gate and deliberately not in TOKEN_ROUTES, for the same
    reason /voice/speak isn't: a token holder standing next to a locked phone
    should not be able to open a metered stream on the owner's project.

    The credential is bound to one model, one configuration and one tool list
    server-side, so what reaches the browser cannot be turned into anything
    else. The session it opens can act, but only through /live/tool below —
    which is the same gate everything else goes through.
    """
    try:
        return await live.mint_token(
            tts.resolve_voice(req.voice),
            req.language,
            req.avoid,
            req.persona,
            req.persona_style,
        )
    except live.LiveUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


class LiveToolRequest(BaseModel):
    name: str
    args: dict[str, Any] | None = None


@app.post("/live/tool")
async def live_tool(req: LiveToolRequest) -> dict[str, Any]:
    """Run one tool the live audio session asked for.

    The live conversation happens between the phone and Google; this is the
    only place it touches the car, and it touches it through `tools.dispatch` —
    the same function the typed assistant calls. That is the whole point of
    routing it here rather than letting the browser hold Tesla credentials:
    voice and text get identical authority, including the part where a
    physically consequential command is parked instead of executed.

    A failure comes back as ok:false with a 200 rather than an error status.
    The caller's job is to hand the model what happened so it can say so or try
    something else — exactly as the chat loop feeds a failed tool call back —
    and an HTTP error would instead look to the client like the backend falling
    over mid-conversation.
    """
    args = req.args or {}
    try:
        result = await tools.dispatch(adapter, req.name, args)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # The token never goes to the model. It has no way to spend one — it cannot
    # make an HTTP request — but the model's context is the one place in this
    # system that carries third-party text, and a confirmation token is the one
    # value there that would be worth something to anybody who read it back out.
    confirm: dict[str, Any] | None = None
    if isinstance(result, dict) and result.get("confirmation_required"):
        confirm = {
            "token": result.get("confirm_token"),
            "tool": req.name,
            "args": args,
        }
        result = {k: v for k, v in result.items() if k != "confirm_token"}
    return {"ok": True, "result": result, "confirm": confirm}


@app.get("/voice/voices")
async def voice_voices() -> dict[str, Any]:
    """What the settings screen offers. Served rather than hardcoded in the app
    so the allow-list has exactly one home — the one the synthesiser checks."""
    return {"voices": sorted(tts.VOICES), "default": tts.DEFAULT_VOICE}


@app.get("/personas")
async def personas() -> dict[str, Any]:
    """Which built-in manners exist, for the same reason /voice/voices is
    served rather than listed in the app: one home for the ids, so a persona
    the settings screen offers is always one the prompt builder honours. The
    labels stay in the app — they are translated, and this server has no
    business holding UI copy.

    Says nothing about the owner's own personas: those live on the phone and
    the server only ever sees them one request at a time.
    """
    return {
        "personas": persona.known(),
        "default": persona.DEFAULT_PERSONA,
        "max_style_chars": persona.MAX_CUSTOM_CHARS,
    }


class VoiceAskRequest(BaseModel):
    text: str
    language: str | None = None


# Long enough for any spoken sentence; short enough that a token holder cannot
# post an essay and bill the LLM quota for it.
MAX_ASK_CHARS = 1000


@app.post("/voice/ask")
async def voice_ask(req: VoiceAskRequest) -> dict[str, str]:
    """One question, one spoken answer — the endpoint an Apple Shortcut calls.

    Single-turn by design: a Shortcut has nowhere to keep a transcript, and a
    caller-supplied history would be an invitation to forge one. It returns the
    reply text alone, with no tool_trace and therefore no confirmation token,
    so a command that needs confirming ends as "confirm it in the app" and
    stops there. This is the only route the bearer token can reach; see
    TOKEN_ROUTES above.
    """
    text = req.text.strip()[:MAX_ASK_CHARS]
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to ask")
    try:
        result = await orchestrator.chat(text, None, req.language)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"reply": result.get("reply", "")}


class ConfirmRequest(BaseModel):
    token: str


@app.delete("/actions/pending/{token}")
async def discard_action(token: str) -> dict[str, bool]:
    """Throw away a proposal the owner declined.

    Until this existed, "Cancel" on the card was a purely visual act: the card
    said nothing was sent, which was true, but the proposal stayed parked and
    tappable for the rest of its two minutes. Declining should mean the thing
    is gone, not hidden.

    Returns ok either way — a token already expired or already used is the
    outcome the caller wanted anyway, and reporting the difference would only
    tell an attacker which tokens exist.
    """
    actions.discard(token)
    return {"ok": True}


@app.post("/actions/confirm/voice")
async def confirm_action_by_voice(
    request: Request, token: str, language: str | None = None
) -> dict[str, Any]:
    """Settle a parked command with a spoken word instead of a tap.

    Takes audio rather than text, and that is the point. The word never travels
    the /chat path, so the model neither sees it nor decides what it meant: the
    transcript is matched by confirm_phrase.classify, in code, on a route the
    model has no way to call. There is no `confirm` tool and there must not be
    one.

    Session cookie only, and deliberately absent from TOKEN_ROUTES — the
    Shortcut can ask questions, and opening the trunk still needs the app. That
    boundary is unchanged by this route; /voice/ask returns no tool_trace, so a
    token holder never has a confirm_token to submit here in the first place.

    Every refusal is a plain outcome rather than an error, because the client's
    response to all of them is the same: say so and let the owner tap.
    """
    if not get_settings().voice_confirm_enabled:
        raise HTTPException(status_code=404, detail="Voice confirmation is switched off.")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > voice.MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too long")

    # Eligibility first, before spending a transcription on audio that could
    # not have settled anything anyway.
    try:
        entry = actions.voice_eligible(token)
    except actions.VoiceConfirmRefused as e:
        raise HTTPException(status_code=409, detail=str(e))

    audio = await request.body()
    try:
        spoken = await voice.transcribe_confirmation(
            audio, request.headers.get("content-type", "")
        )
    except voice.TranscriptionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    if not spoken:
        # Nothing was clearly said. Costs no attempt: a noisy cabin must not be
        # able to lock the owner out of his own card.
        return {"ok": False, "outcome": "no_speech"}

    verdict = confirm_phrase.classify(spoken)
    if verdict == "cancel":
        actions.discard(token)
        return {"ok": False, "outcome": "cancelled"}
    if verdict != "confirm":
        # Heard, understood, and it was something else. This is the case worth
        # spending the single attempt on.
        actions.burn_voice_attempt(token)
        return {"ok": False, "outcome": "no_match"}

    try:
        result = await actions.confirm(adapter, token)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "tool": entry["tool"], "result": result}


@app.post("/actions/confirm")
async def confirm_action(req: ConfirmRequest) -> dict[str, Any]:
    """Executes a command the assistant only proposed.

    This is the sole path to unlock/trunk/HomeLink, and it is reachable only by
    a request the owner's tap originates — never by the model, which cannot
    call HTTP endpoints. That is the whole point: a poisoned tool result can
    make a card appear, but it cannot tap it.
    """
    try:
        return await actions.confirm(adapter, req.token)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


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


@app.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    """Backs the sidebar's queue. Returns groups (one per thing the user
    asked for), not raw jobs — and structured `meta` rather than rendered
    text, so the app can label them in the user's chosen language."""
    try:
        return {"actions": await scheduler.list_groups(include_finished=True)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.delete("/jobs/{group_id}")
async def cancel_job(group_id: str) -> dict[str, Any]:
    try:
        cancelled = await scheduler.cancel_group(group_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    if not cancelled:
        raise HTTPException(status_code=404, detail="Nothing pending with that id")
    return {"ok": True, "cancelled": group_id}


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

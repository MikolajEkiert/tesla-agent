"""Short-lived credentials for the phone's live audio session.

The Live API is a WebSocket the browser holds open for the length of a
conversation. Two ways to reach it: proxy the whole stream through this server,
or let the phone connect straight to Google with a credential this server
mints. The second is what Google designed ephemeral tokens for, and it is the
right one here — the free Oracle box has no business carrying a continuous
audio stream in both directions, and every hop is latency in a moving car.

The real API key never leaves the server. What leaves is a token that:

  * starts a session within one minute and then stops working,
  * can be used exactly once,
  * is locked to one model and one configuration, so it cannot be repurposed
    into, say, a text model on someone else's project budget.

What this does *not* change is the confirmation gate. The Live session is
given no tools at all — it hears and it speaks, and the decisions still travel
/chat -> dispatch -> actions.propose like every other word typed into the app.
A session that cannot call a function cannot open a car.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from google import genai
from google.genai import types

from app.config import get_settings

# The native-audio family carries the largest token-per-minute allowance of the
# Live models and unlimited requests per day, which is the whole reason this
# route exists.
#
# The id is not what the rate-limit dashboard shows. That screen prints display
# names — "Gemini 2.5 Flash Native Audio Dialog" — and a session opened with
# one is refused as a model that does not exist. The ids come from listing the
# models that advertise bidiGenerateContent, which is the only trustworthy
# source for them.
DEFAULT_MODEL = "gemini-2.5-flash-native-audio-latest"

# Long enough to open a session on a slow mobile connection, short enough that
# a token found in a log is already dead.
START_WINDOW_S = 60

# The conversation itself may run this long on one token. Renewing means asking
# the server again, which costs a request and proves the session is still ours.
SESSION_LIFETIME_MIN = 15

# The session speaks and listens; it never decides. Written as an instruction
# because there is no configuration flag for "do not think" — and backed by the
# fact that no tools are declared, so the worst a talkative model can do is say
# something, not do something.
RELAY_INSTRUCTION = (
    "You are the voice of an assistant, not the assistant. Two jobs, nothing "
    "else.\n"
    "1. Listen. Everything the driver says is transcribed for the assistant. "
    "Never answer them yourself, never comment, never ask a question of your "
    "own.\n"
    "2. Speak. When you are given text, read it aloud exactly as written, in "
    "the language it is written in. Do not translate it, summarise it, "
    "rephrase it, correct it, or add a single word — not a greeting, not an "
    "acknowledgement, not an offer to help. The words you are given are the "
    "assistant's words and the driver must hear them unchanged."
)


class LiveUnavailable(RuntimeError):
    pass


def _model() -> str:
    import os

    return os.getenv("GEMINI_LIVE_MODEL") or DEFAULT_MODEL


async def mint_token(voice: str) -> dict[str, Any]:
    """A credential for one session, locked to how that session may be used."""
    settings = get_settings()
    if not settings.gemini_api_key:
        raise LiveUnavailable("GEMINI_API_KEY is not set — live voice needs it.")

    now = dt.datetime.now(dt.timezone.utc)
    client = genai.Client(api_key=settings.gemini_api_key)

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        # The transcript of what the driver said is the entire point of the
        # listening half: it is what gets posted to /chat.
        input_audio_transcription=types.AudioTranscriptionConfig(),
        # And of what was spoken, so the chat log can show the assistant's own
        # words rather than a silence where the audio was.
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        system_instruction=RELAY_INSTRUCTION,
    )

    try:
        token = await client.aio.auth_tokens.create(
            config=types.CreateAuthTokenConfig(
                uses=1,
                expire_time=now + dt.timedelta(minutes=SESSION_LIFETIME_MIN),
                new_session_expire_time=now + dt.timedelta(seconds=START_WINDOW_S),
                # Binding the configuration to the token is what makes handing
                # it to a browser reasonable: it can start the session we
                # described and no other.
                live_connect_constraints=types.LiveConnectConstraints(
                    model=_model(), config=config
                ),
                lock_additional_fields=[],
            )
        )
    except Exception as e:  # SDK raises a family of provider errors
        raise LiveUnavailable(f"Couldn't mint a live session token: {e}")

    return {
        "token": token.name,
        "model": _model(),
        "expires_in_seconds": START_WINDOW_S,
    }

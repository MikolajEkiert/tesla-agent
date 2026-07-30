"""Text to speech.

The mirror image of voice.py, and just as deliberately narrow: text in, audio
out, no tools, no system prompt, nothing that can reach the car. The reply this
speaks has already been through /chat and the confirmation gate; by the time it
arrives here it is a finished string.

Why a cloud voice at all: the phone offers exactly one Polish voice and it is a
concatenative synthesiser that sounds a decade old. No amount of work in the
app raises that ceiling, because the ceiling is the voice.

Why Chirp 3: HD on Cloud Text-to-Speech rather than the same voices through the
AI Studio API, which is what this module used first: the free tier there is
**ten requests per day**, measured the hard way — the quota message named it
only after a client threw the server's reason away and the assistant appeared
to be stuck on the phone's voice. Ten a day is a demo, not an assistant. Cloud
bills the same voices per character against a monthly free allowance that a
personal assistant does not come close to spending.

What that trade costs: Chirp 3 does not take a natural-language style note, so
delivery can no longer be directed in words — only pace, pauses and SSML. The
assistant's *manner* is unaffected, because that was never here: it lives in
llm/prompt.py, which chooses the words. This module only reads them.
"""
from __future__ import annotations

import base64

import httpx

from app.config import get_settings

# The reply is a sentence or two by design (see llm/prompt.py). This cap is a
# backstop against synthesising — and paying for — something pathological. Well
# under the API's own 4000-byte limit on the input field.
MAX_SPEAK_CHARS = 1200

ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"

# MP3 rather than the default LINEAR16: a ten-second reply is about 40 KB
# instead of half a megabyte, and this is fetched over mobile data in a moving
# car, where the difference is the wait before the answer starts.
AUDIO_ENCODING = "MP3"
MEDIA_TYPE = "audio/mpeg"

# Chosen by ear by the owner — three male, three female. Which one speaks costs
# the same: the meter runs on characters, not on the voice.
#
# Allow-listed rather than passed through, because the name arrives in a
# request body and ends up in a URL to a paid API. An unknown value falls back
# to the default instead of travelling onward.
VOICES = {
    "Puck",
    "Rasalgethi",
    "Zubenelgenubi",
    "Leda",
    "Sulafat",
    "Vindemiatrix",
}

DEFAULT_VOICE = "Puck"

# Chirp 3 voices are named <locale>-Chirp3-HD-<voice>, so the locale is part of
# the identity: the same voice speaks Polish or English depending on it.
_LOCALES = {"pl": "pl-PL", "en": "en-US"}
DEFAULT_LOCALE = "pl-PL"

# Left at natural speed on purpose. The 1.15 the phone's voice needs is a
# correction for a synthesiser that reads slower than a person; applying it
# here would rush a voice that already has a human cadence.
SPEAKING_RATE = 1.0

# Long enough for a slow first response from a cold API, short enough that a
# stalled request falls back to the phone's voice while the answer is still
# worth hearing.
TIMEOUT_SECONDS = 20.0


class SpeechError(RuntimeError):
    pass


def resolve_voice(name: str | None) -> str:
    return name if name in VOICES else DEFAULT_VOICE


def _locale(language: str | None) -> str:
    return _LOCALES.get((language or "").lower(), DEFAULT_LOCALE)


def _api_key() -> str:
    """Separate from GEMINI_API_KEY: a different Google product, a different
    project, and one that stops working the moment they are confused."""
    return get_settings().google_tts_api_key


async def synthesize(text: str, language: str | None = None, voice: str | None = None) -> bytes:
    if not _api_key():
        raise SpeechError("GOOGLE_TTS_API_KEY is not set — spoken replies need it.")

    spoken = (text or "").strip()[:MAX_SPEAK_CHARS]
    if not spoken:
        raise SpeechError("Nothing to speak")

    locale = _locale(language)
    body = {
        # Plain text, never SSML: a reply is model output, and handing model
        # output to a markup parser lets a stray "<" decide how the rest is
        # read — or fail the request outright.
        "input": {"text": spoken},
        "voice": {"languageCode": locale, "name": f"{locale}-Chirp3-HD-{resolve_voice(voice)}"},
        "audioConfig": {"audioEncoding": AUDIO_ENCODING, "speakingRate": SPEAKING_RATE},
    }

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        try:
            resp = await client.post(
                ENDPOINT,
                json=body,
                # In the header, not the query string: a key in a URL ends up
                # in logs and proxies.
                headers={"x-goog-api-key": _api_key()},
            )
        except httpx.HTTPError as e:
            raise SpeechError(f"Speech service unreachable: {e}")

    if resp.status_code != 200:
        # The body carries the real explanation — a disabled API, a quota, a
        # key restricted to the wrong referrer. Passed through, because the
        # settings screen shows it and that is how a silent fallback stops
        # being a mystery. Truncated: some of these run to pages.
        raise SpeechError(f"Speech service said {resp.status_code}: {resp.text[:300]}")

    audio = base64.b64decode(resp.json().get("audioContent", "") or "")
    if not audio:
        raise SpeechError("Speech service returned no audio")
    return audio

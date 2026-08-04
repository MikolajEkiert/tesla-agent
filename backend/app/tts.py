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
import hashlib
import os
import time

import httpx

from app.config import get_settings

# --- the short things that get said over and over --------------------------
#
# The settings screen speaks a sample every time a voice is tapped, because a
# list of names like "Iapetus" and "Umbriel" tells you nothing until you hear
# it. Thirty voices in two languages is sixty possible samples, and flicking
# through them used to bill Google once per tap, every time, forever.
#
# The endpoint already sends `cache-control: private, max-age=300`, which does
# nothing at all here: it is a POST, and browsers do not cache POST responses.
# The header has been reassuring and inert since it was written.
#
# So the cache lives on disk instead, which also makes it shared — the sample
# is synthesised once for every device that will ever ask, rather than once per
# device per five minutes. Only short texts, so a conversation's replies never
# land here: they are said once and are not worth keeping, and the free box has
# a small disk.
CACHE_DIR = os.path.join("data", "tts-cache")
CACHE_MAX_CHARS = 200
# Sixty samples plus room for whatever else is short and repeated. Sized to the
# whole matrix on purpose: at 64 — the number from when there were six voices —
# hearing every voice once would evict the samples while the owner was still
# listening to them, and the next tap would pay for one it had already bought.
# A sample is a few tens of kilobytes, so the whole set is a couple of
# megabytes on a disk that has room for it.
CACHE_MAX_FILES = 96

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

# Every voice Gemini offers, rather than the six the owner first picked by ear.
# Which one speaks costs the same — the meter runs on characters, not on the
# voice — so a shortlist only ever meant the other twenty-four could not be
# tried without a redeploy.
#
# One list for both halves on purpose. These names are Chirp 3: HD's
# (<locale>-Chirp3-HD-<name>, synthesised below) *and* the Live API's prebuilt
# voices (app/live.py hands one straight to Gemini), which is what lets the
# spoken reply and the live conversation sound like the same assistant.
#
# Taken from the API rather than the documentation: `GET /v1/voices` on Cloud
# Text-to-Speech returns exactly these thirty for both pl-PL and en-US, so
# nothing here is available in one language and missing in the other.
#
# Still an allow-list rather than a pass-through, because the name arrives in a
# request body and ends up in a URL to a paid API. An unknown value falls back
# to the default instead of travelling onward.
VOICES = {
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
}

# The app has named this one as its default since the picker was written, while
# this file said Puck — and because "Charon" was not in the six above, every
# reply came back in Puck's voice with the picker showing nothing selected. It
# is a real voice now, so the two halves agree on it rather than on the name
# that only won by being the fallback.
DEFAULT_VOICE = "Charon"

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


def _cache_key(spoken: str, locale: str, voice: str) -> str:
    """Everything that changes the bytes, and nothing that doesn't."""
    raw = f"{locale}|{voice}|{spoken}".encode()
    return hashlib.sha256(raw).hexdigest()[:32]


def _cache_read(key: str) -> bytes | None:
    try:
        path = os.path.join(CACHE_DIR, key)
        with open(path, "rb") as f:
            audio = f.read()
        # Touched on read so eviction drops what nobody asks for rather than
        # whatever happens to be oldest — the voice samples stay, a one-off
        # phrase ages out.
        os.utime(path, None)
        return audio or None
    except OSError:
        return None


def _cache_write(key: str, audio: bytes) -> None:
    """Best-effort: a cache that cannot be written must not break speech."""
    try:
        os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
        entries = [
            (os.path.getatime(os.path.join(CACHE_DIR, n)), n) for n in os.listdir(CACHE_DIR)
        ]
        for _, name in sorted(entries)[: max(0, len(entries) - CACHE_MAX_FILES + 1)]:
            os.unlink(os.path.join(CACHE_DIR, name))
        # Written beside and renamed, so a reader never sees a half-written
        # file — a truncated MP3 would be cached forever and play as silence.
        tmp = os.path.join(CACHE_DIR, f".{key}.{os.getpid()}.{int(time.time())}")
        with open(tmp, "wb") as f:
            f.write(audio)
        os.replace(tmp, os.path.join(CACHE_DIR, key))
    except OSError:
        pass


async def synthesize(text: str, language: str | None = None, voice: str | None = None) -> bytes:
    if not _api_key():
        raise SpeechError("GOOGLE_TTS_API_KEY is not set — spoken replies need it.")

    spoken = (text or "").strip()[:MAX_SPEAK_CHARS]
    if not spoken:
        raise SpeechError("Nothing to speak")

    locale = _locale(language)
    cacheable = len(spoken) <= CACHE_MAX_CHARS
    key = _cache_key(spoken, locale, resolve_voice(voice)) if cacheable else ""
    if cacheable:
        cached = _cache_read(key)
        if cached:
            return cached
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
    if cacheable:
        _cache_write(key, audio)
    return audio

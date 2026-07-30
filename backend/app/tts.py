"""Text to speech.

The mirror image of voice.py, and just as deliberately narrow: text in, audio
out, no tools, no system prompt, no reach into the car. The reply this speaks
has already been through /chat and the confirmation gate; by the time it gets
here it is a finished string, and this module's only job is to make it audible.

Why this exists at all: the phone's built-in Polish voice is the only one iOS
offers, and it is a concatenative synthesiser that sounds a decade old. The
speech models return something a person would mistake for a person, and — the
part that makes them usable rather than merely nicer — the delivery is steered
in words, so the assistant can sound calm and unhurried in a car instead of
like a station announcement.

The catch, measured rather than assumed: the free tier limits requests per
minute. Ask several questions in quick succession and one of them comes back
429. That is why every failure here is reported as a 503 and the app quietly
falls back to the built-in voice. A slightly worse voice is a small loss; an
assistant that goes silent mid-drive is not.
"""
from __future__ import annotations

import os
import struct

from google import genai
from google.genai import types

from app.config import get_settings

# The reply is a sentence or two by design (see llm/prompt.py). This cap is a
# backstop against synthesising — and paying for — something pathological.
MAX_SPEAK_CHARS = 1200

# The model returns headerless PCM at this rate; the WAV header below has to
# agree with it, so the two constants live together.
SAMPLE_RATE = 24000

# Prebuilt voices, allow-listed rather than passed through. The name reaches a
# paid API from a request body, so it is validated here and an unknown value
# falls back to the default instead of travelling onward.
#
# The set is deliberately small. The full catalogue has thirty, and a list that
# long is a chore to audition when the difference between neighbours is slight
# and only audible on a real sentence.
VOICES = {
    # Chosen by ear by the owner.
    "Puck",            # upbeat
    "Rasalgethi",      # informative
    "Zubenelgenubi",   # casual
    # Female counterparts, so the choice is not one-sided. They cost exactly
    # the same: price here follows seconds of audio, not which voice said it.
    "Leda",            # youthful, light
    "Sulafat",         # warm
    "Vindemiatrix",    # gentle
}

DEFAULT_VOICE = "Puck"

# The delivery note. This is the whole reason a cloud voice is worth the
# round trip: without it the model reads a list of numbers like a newsreader,
# which is exactly the register that grates when it is the fifth time today.
_STYLE = (
    "Mów jak spokojny, opanowany asystent w samochodzie. Ciepły ton, tempo "
    "swobodnej rozmowy, lekko przygaszona energia — jakbyś siedział obok "
    "kierowcy i po prostu podawał fakty. Bez entuzjazmu, bez lektorskiego "
    "zaśpiewu. Liczby czytaj naturalnie, nie wyliczankowo."
)

_STYLE_EN = (
    "Speak like a calm, composed in-car assistant. Warm tone, conversational "
    "pace, slightly dialled-down energy — as if sitting beside the driver and "
    "simply stating facts. No enthusiasm, no announcer sing-song. Read numbers "
    "naturally, not as a list."
)


class SpeechError(RuntimeError):
    pass


def _model() -> str:
    """Separate from GEMINI_MODEL: the chat model cannot synthesise speech, so
    unlike transcription this cannot fall back to it."""
    return os.getenv("GEMINI_TTS_MODEL") or "gemini-2.5-flash-preview-tts"


def resolve_voice(name: str | None) -> str:
    return name if name in VOICES else DEFAULT_VOICE


def _wav(pcm: bytes) -> bytes:
    """Wrap raw PCM in a WAV header.

    The model returns 16-bit mono samples with no container at all, and a
    browser will not play a bare byte stream. Forty-four bytes of header is
    cheaper than asking the client to assemble this, and keeps the audio a
    plain file that any <audio> element accepts.
    """
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm))
        + pcm
    )


async def synthesize(text: str, language: str | None = None, voice: str | None = None) -> bytes:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise SpeechError("GEMINI_API_KEY is not set — spoken replies need it.")

    spoken = (text or "").strip()[:MAX_SPEAK_CHARS]
    if not spoken:
        raise SpeechError("Nothing to speak")

    style = _STYLE_EN if (language or "").lower() == "en" else _STYLE

    client = genai.Client(api_key=settings.gemini_api_key)
    resp = await client.aio.models.generate_content(
        model=_model(),
        # The style note and the line are one prompt: the model treats the
        # leading instruction as direction and the rest as the words to say.
        contents=f"{style}\n\n{spoken}",
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=resolve_voice(voice)
                    )
                )
            ),
        ),
    )

    try:
        pcm = resp.candidates[0].content.parts[0].inline_data.data
    except (AttributeError, IndexError, TypeError):
        # A refusal or a safety block arrives as a well-formed response with no
        # audio in it, which would otherwise surface as an AttributeError deep
        # in the route and read as a server bug.
        raise SpeechError("Model returned no audio")
    if not pcm:
        raise SpeechError("Model returned empty audio")
    return _wav(pcm)

"""Short-lived credentials for the phone's live audio session — and the tools
that session is allowed to reach.

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

The live session is a second assistant, not a microphone
--------------------------------------------------------
It used to be a relay: no tools, a system instruction telling it never to
answer, and the transcript posted to /chat so the *text* assistant could think.
That design failed in the way it was always going to fail. Closing a turn makes
a Live model generate whether anyone wants it to or not, and what it generated
was invention — "the battery is at 85%" from a model with no connection to any
car. The client tried to swallow that audio and could not do it reliably: the
discarded reply and the wanted one arrive on the same socket, and a flag
flipped between them plays the tail of a hallucination in the assistant's own
voice.

So the session now holds the same tools every other path holds. It hears, it
decides, it calls a tool through /live/tool on this server, and it speaks the
answer it got. Nothing is invented because nothing has to be.

What that does *not* change is the confirmation gate. /live/tool goes through
`app.tools.dispatch` exactly like the chat orchestrator does, so a physically
consequential command comes back parked rather than executed, and only the
owner's tap on the card runs it. A model with tools still cannot open the car.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from google import genai
from google.genai import types

from app.config import get_settings
from app.llm.gemini_tools import declarations_as_json, function_declarations
from app.llm.prompt import DOMAIN_VOCABULARY, build_system_prompt

# The native-audio family carries the largest token-per-minute allowance of the
# Live models and unlimited requests per day, which is the whole reason this
# route exists.
#
# The id is not what the rate-limit dashboard shows. That screen prints display
# names — "Gemini 2.5 Flash Native Audio Dialog" — and a session opened with
# one is refused as a model that does not exist. The ids come from listing the
# models that advertise bidiGenerateContent, which is the only trustworthy
# source for them.
DEFAULT_MODEL = "gemini-3.1-flash-live-preview"

# What to fall back to when the model above cannot be had.
#
# It is the model this ran on until 2026-07-31 and it is not a downgrade in
# kind: same audio-to-audio architecture, larger token-per-minute allowance,
# and the one whose id is an alias rather than a preview. The reason the
# preview is preferred is latency and numeric precision — measured as better,
# but preview models are withdrawn without notice, and a car assistant that
# stops speaking because Google retired an id is a worse failure than one
# speaking through last year's model.
#
# Order matters and only this order: never fall *forward* onto a preview.
FALLBACK_MODEL = "gemini-2.5-flash-native-audio-latest"

# Long enough to open a session on a slow mobile connection, short enough that
# a token found in a log is already dead.
START_WINDOW_S = 60

# The conversation itself may run this long on one token. Renewing means asking
# the server again, which costs a request and proves the session is still ours.
SESSION_LIFETIME_MIN = 15

# What being spoken aloud in a car adds to the assistant's ordinary brief. The
# rest — read state before answering, never invent a figure a tool did not
# return — is the same prompt the typed assistant runs on, deliberately: two
# conversations, one set of rules about what may be said.
SPOKEN_INSTRUCTION = (
    " You are speaking out loud to someone driving. One or two short sentences, "
    "no lists, no markdown, no emoji, no spelling things out. "
    "Call a tool whenever the answer depends on the car — never answer from "
    "memory of an earlier turn if the value could have changed. "
    # The same priming that measurably fixed the transcription path, given to
    # the model that now does the listening itself. A general speech model gets
    # these words wrong because in ordinary Polish they are rare and their
    # neighbours are common; naming them is the cheapest correction there is.
    "You are listening over road noise in a moving car, and the words that "
    f"matter most are these: {DOMAIN_VOCABULARY}. Prefer them over "
    "similar-sounding words. "
    # And the other half, which matters more: a model that mishears is not the
    # problem, a model that acts on a mishearing is. Numbers especially — "na
    # sto" and "sto procent" are one slurred syllable apart, and one of them is
    # a charge limit.
    "If you are not certain what was said — above all a number, a temperature "
    "or a percentage — ask a one-line question instead of acting on a guess. "
    "Never answer a question you only half heard: say what you thought you "
    "heard and let the driver correct you. "
    "Some commands you are not allowed to execute: the tool will answer that a "
    "confirmation is required. When it does, say in one short sentence what is "
    "waiting and that it has to be confirmed in the app, then stop. Do not call "
    "that tool again and do not reach for another tool to get the same effect. "
    # The conversation is held with the microphone open, so it has to be able
    # to end. Left to the driver alone it ends by being abandoned, and an
    # abandoned conversation is one still listening.
    #
    # Two earlier versions failed in opposite directions, and the rule below is
    # shaped by both. The first said to end when "the exchange is over", and the
    # model read a completed answer as an exchange being over — it closed after
    # every single reply, which made the conversation a one-shot question box.
    # The second over-corrected into "if they answer 'nie' to a question you
    # asked, that is the end", which hung up on the far more common 'nie': the
    # one that declines an *offer*. "Najbliższa ładowarka jest 5 km stąd.
    # Ustawić nawigację?" — "Nie" — and the session closed, when what the driver
    # declined was the navigation, not the conversation.
    #
    # So the distinction the model has to make is named explicitly, because it
    # is the whole difficulty: the same word ends the conversation after one
    # question and means nothing of the kind after another. A keyword list
    # cannot tell them apart. Something following the conversation can.
    "The conversation ends in two steps, and running them together is the "
    "mistake to avoid. There are two kinds of question you can ask, and 'nie' "
    "means something different after each. "
    "One is an offer to do something — 'Ustawić nawigację?', 'Włączyć "
    "klimatyzację?'. 'Nie' to that declines the task, not the conversation: "
    "acknowledge it in a few words and then ask, once, whether they need "
    "anything else. "
    "The other is that closing question itself — 'Czy mogę pomóc w czymś "
    "jeszcze?'. 'Nie' to that does end the conversation: say one short line of "
    "farewell and call end_conversation in the same turn. "
    "Ask the closing question when what you were doing is finished and nothing "
    "is outstanding — not after every sentence, and never twice in a row. If "
    "they answer it with another request, deal with the request and do not ask "
    "again until the next lull. "
    "A plain goodbye needs no closing question at all: 'to wszystko', 'dzięki, "
    "koniec', 'pa', 'nara' — say the farewell and call end_conversation "
    "straight away. "
    "Having answered a question is never itself a reason to end. After you "
    "have given the range, found a charger or set the navigation, stay "
    "listening, because what usually comes next is a follow-up about the same "
    "thing. Never end while anything is still waiting, including a command "
    "that has to be confirmed in the app. If you are unsure, stay listening."
)


class LiveUnavailable(RuntimeError):
    pass


# --- ending the conversation ------------------------------------------------
#
# A capability of the conversation rather than of the car, which is why it is
# declared here and not in app/tools.py: the typed assistant has no
# conversation to end, and /live/tool must never be asked to run it — the phone
# answers it itself, without a round trip.
#
# It exists because the alternative is a keyword list, and a keyword list is
# always wrong somewhere. "Nie" ends the exchange after "czy mogę zrobić coś
# jeszcze?" and means the opposite after "czy ustawić nawigację?". Only
# something following the conversation can tell those apart, and the model is
# already following it.
END_CONVERSATION = {
    "name": "end_conversation",
    "description": (
        "Close the voice conversation and stop listening. Call this only once "
        "the driver has said goodbye, or has answered 'no' to your closing "
        "question about whether they need anything else — never because they "
        "turned down something you offered to do, such as setting the "
        "navigation; that declines the task and the conversation carries on. "
        "Call it together with your closing line, not instead of it: say the "
        "short farewell in the same turn. Do not call it while anything is "
        "still waiting, including a command that needs confirming in the app, "
        "and never as a way out of a question you would rather not answer. If "
        "in doubt, stay listening; the driver can always close it themselves."
    ),
}


def _live_declarations() -> list[types.FunctionDeclaration]:
    """The car's tools, plus the one that belongs to the conversation."""
    return [
        *function_declarations(),
        types.FunctionDeclaration(
            name=END_CONVERSATION["name"], description=END_CONVERSATION["description"]
        ),
    ]


def _live_declarations_json() -> list[dict[str, Any]]:
    return [*declarations_as_json(), dict(END_CONVERSATION)]


def _model() -> str:
    import os

    return os.getenv("GEMINI_LIVE_MODEL") or DEFAULT_MODEL


def _candidates(avoid: str | None = None) -> list[str]:
    """Which models to try, best first.

    `avoid` is how the phone reports a model that minted a token and then
    refused the session — a failure this server cannot see, because from here
    the mint succeeded. Without it the retry would ask for the same model and
    get the same refusal.

    Never returns empty: if avoiding leaves nothing, the caller is better off
    trying the ordinary order and failing with a real error than being told
    there are no models at all.
    """
    ordered = [_model()]
    if FALLBACK_MODEL not in ordered:
        ordered.append(FALLBACK_MODEL)
    return [m for m in ordered if m != avoid] or ordered


# The app has two languages (mobile/src/i18n.ts); the Live API wants a BCP-47
# tag. Anything unrecognised falls to Polish rather than to "let it guess",
# because guessing is the failure this exists to remove.
_LOCALES = {"pl": "pl-PL", "en": "en-US"}
DEFAULT_LOCALE = "pl-PL"


def _locale(language: str | None) -> str:
    return _LOCALES.get((language or "").lower(), DEFAULT_LOCALE)


def system_instruction(
    language: str | None,
    persona: str | None = None,
    persona_style: str | None = None,
) -> str:
    """The typed assistant's brief, plus what speaking aloud adds, plus the
    manner the owner chose.

    The persona is threaded through here rather than left to the chat path
    alone because the live session *is* the assistant for the length of a
    conversation — it hears, decides and speaks without /chat being involved.
    A persona that only applied to typing would switch itself off the moment
    the driver pressed the microphone, which is the one place they are most
    likely to notice it.
    """
    return build_system_prompt(language, persona, persona_style) + SPOKEN_INSTRUCTION


async def mint_token(
    voice: str,
    language: str | None = None,
    avoid: str | None = None,
    persona: str | None = None,
    persona_style: str | None = None,
) -> dict[str, Any]:
    """A credential for one session, locked to how that session may be used.

    Tries each candidate model in turn, so a withdrawn preview degrades to the
    older model instead of to no voice at all.
    """
    settings = get_settings()
    if not settings.gemini_api_key:
        raise LiveUnavailable("GEMINI_API_KEY is not set — live voice needs it.")

    last: Exception | None = None
    for model in _candidates(avoid):
        try:
            return await _mint_on(settings, model, voice, language, persona, persona_style)
        except Exception as e:  # SDK raises a family of provider errors
            last = e
            print(f"live: {model} refused a token ({e}); trying the next one")
    raise LiveUnavailable(f"Couldn't mint a live session token: {last}")


async def _mint_on(
    settings: Any,
    model: str,
    voice: str,
    language: str | None,
    persona: str | None = None,
    persona_style: str | None = None,
) -> dict[str, Any]:
    now = dt.datetime.now(dt.timezone.utc)
    client = genai.Client(api_key=settings.gemini_api_key)

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        # What the driver said, so the chat log can show the question and the
        # app can tell a spoken turn from a typed one.
        input_audio_transcription=types.AudioTranscriptionConfig(),
        # And what was spoken back, so the log shows the assistant's own words
        # rather than a silence where the audio was.
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            # Say which language this is, rather than letting the session guess
            # from the audio.
            #
            # Left unset, a Polish sentence came back transcribed as German and
            # Italian — "Macht's", "rivolce", "Ja, hier ist dann Batterie." — and
            # the session answered the language it thought it had heard. Guessing
            # per utterance is a coin toss in a noisy cabin, and losing it costs
            # the whole turn: the driver repeats himself and it guesses again.
            #
            # Accepted by both candidate models; measured by opening a session
            # with it on each, rather than trusted from the documentation.
            language_code=_locale(language),
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            ),
        ),
        system_instruction=system_instruction(language, persona, persona_style),
        # The same tools the typed assistant has. Bound to the token rather
        # than left to the client, so a browser cannot widen its own reach.
        tools=[types.Tool(function_declarations=_live_declarations())],
    )

    # Errors travel up to mint_token, which decides whether another model is
    # worth trying. Catching here would turn a retryable refusal into a dead end.
    token = await client.aio.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            expire_time=now + dt.timedelta(minutes=SESSION_LIFETIME_MIN),
            new_session_expire_time=now + dt.timedelta(seconds=START_WINDOW_S),
            # Binding the configuration to the token is what makes handing
            # it to a browser reasonable: it can start the session we
            # described and no other.
            live_connect_constraints=types.LiveConnectConstraints(
                model=model, config=config
            ),
            lock_additional_fields=[],
        )
    )

    return {
        "token": token.name,
        "model": model,
        "expires_in_seconds": START_WINDOW_S,
        # Echoed by the client in its own `setup` message. Belt and braces:
        # the constraints above already bind the tools, and a client that sends
        # the identical list changes nothing — but if a future SDK merges
        # constraints differently, the failure would be a session that silently
        # has no tools and starts inventing again. That is the one failure this
        # feature exists to make impossible, so it is worth sending twice.
        "tools": [{"functionDeclarations": _live_declarations_json()}],
    }

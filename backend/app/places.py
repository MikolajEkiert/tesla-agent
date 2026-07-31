"""Finding places that are not chargers.

The assistant could already find somewhere to charge and nowhere to eat. This
adds the general case — restaurants, shops, pharmacies, parking — and it is
deliberately a *structured* search rather than asking a model what it knows.

Two reasons for that, and the second is the one that decided it:

The system prompt forbids filling gaps from general knowledge, after a
regression where the model invented "up to 250 kW" for a charger. A rating
that arrives as a number in a field can be repeated; a rating that arrives
inside a paragraph the model wrote is indistinguishable from one it made up.

And routes need coordinates. Adding a restaurant as a stop means handing the
car a latitude and longitude, so a search that returns prose would have to be
geocoded by name afterwards — the same step that lands a Supercharger search
in the middle of a town (see fleet.py's _coords). Here the coordinates come
back with the rating, from the same record.

The provider sits behind a seam because which one is right is a live question:
Places bills per call and needs its own key, where a model with search
grounding needs neither but returns text. Swapping is a matter of one class.
"""
from __future__ import annotations

import time
from typing import Any, Protocol

import httpx

from app.config import get_settings
from app.geo import clean_text, geocode
from app.tesla.adapter import TeslaAdapter

MAX_RESULTS = 8
SEARCH_RADIUS_M = 15000
TIMEOUT_S = 15

# Two field lengths, both borrowed from chargers.py rather than invented: names
# are short, addresses are not.
MAX_NAME_LEN = 120
MAX_ADDRESS_LEN = 160

# Repeat questions inside one conversation are ordinary — the model may look
# twice in a single round while composing an answer — and every call is billed.
# Short enough that "open now" does not go stale within it.
CACHE_TTL_S = 300
_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}


class PlaceSearchUnavailable(RuntimeError):
    """No provider configured, or the provider refused. The message reaches the
    model, so it says what is missing rather than looking like an outage."""


class PlaceProvider(Protocol):
    name: str

    async def search(
        self,
        query: str,
        near: tuple[float, float] | None,
        language: str,
        open_now: bool,
    ) -> list[dict[str, Any]]: ...


class GooglePlaces:
    """Text Search (New).

    The field mask is not optional — the API errors without one — and it also
    decides the price, since asking for ratings moves the call to a dearer SKU.
    That makes the mask a cost decision written as a header, so it stays
    explicit and commented rather than assembled somewhere clever.
    """

    name = "google_places"
    URL = "https://places.googleapis.com/v1/places:searchText"
    FIELDS = ",".join(
        (
            "places.displayName",
            "places.formattedAddress",
            "places.location",
            "places.rating",
            "places.userRatingCount",
            "places.currentOpeningHours.openNow",
        )
    )

    async def search(
        self,
        query: str,
        near: tuple[float, float] | None,
        language: str,
        open_now: bool,
    ) -> list[dict[str, Any]]:
        key = get_settings().google_places_api_key
        if not key:
            raise PlaceSearchUnavailable(
                "Place search isn't configured — GOOGLE_PLACES_API_KEY is not set."
            )

        body: dict[str, Any] = {
            "textQuery": query,
            "languageCode": language or "en",
            "pageSize": MAX_RESULTS,
        }
        if open_now:
            body["openNow"] = True
        if near is not None:
            latitude, longitude = near
            body["locationBias"] = {
                "circle": {
                    "center": {"latitude": latitude, "longitude": longitude},
                    "radius": SEARCH_RADIUS_M,
                }
            }

        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(
                self.URL,
                json=body,
                headers={
                    # In a header, not the query string. Unlike Open Charge Map
                    # (see chargers.py's note on raise_for_status) there is no
                    # key here for an error message to leak into model context.
                    "X-Goog-Api-Key": key,
                    "X-Goog-FieldMask": self.FIELDS,
                },
            )
        if response.status_code != 200:
            raise PlaceSearchUnavailable(_explain(response))
        return response.json().get("places", []) or []


def _explain(response: httpx.Response) -> str:
    """Turn a provider refusal into one sentence the assistant can repeat.

    This used to hand over 200 characters of raw JSON, and what came out the
    other end was the assistant telling the owner that "place search is not
    enabled in the car's system" — a sentence with nothing true in it. The car
    has no idea this feature exists. The model was not lying so much as
    summarising a wall of text it had no way to read, and picking the wrong
    noun.

    A short, specific message is the fix, because the model repeats what it is
    given. Each case here says who has to do what: the ones the owner can act
    on name the action, the rest say plainly that it is the provider's end.
    """
    try:
        error = response.json().get("error", {}) or {}
    except ValueError:
        error = {}

    reasons = {
        detail.get("reason")
        for detail in error.get("details", [])
        if isinstance(detail, dict)
    }
    status = error.get("status", "")

    if "SERVICE_DISABLED" in reasons:
        # The exact case hit in production: a valid key on a project where the
        # API was never switched on. Not a fault of the key, the car, or the
        # app, and not something that fixes itself.
        return (
            "Place search is switched off at the provider: the Places API is not "
            "enabled for this Google Cloud project. Tell the owner it has to be "
            "enabled in the Google Cloud console — nothing is wrong with the car "
            "or with the app, and trying again will not help until it is."
        )
    if response.status_code == 429 or status == "RESOURCE_EXHAUSTED":
        return "Place search has used up its quota for now — it should work again later."
    if response.status_code in (401, 403):
        return (
            "Place search was refused by the provider — the API key is rejected or "
            "restricted. It needs looking at outside the app; retrying will not help."
        )
    detail = " ".join(str(error.get("message", "")).split())[:160]
    return f"Place search failed (HTTP {response.status_code}){f': {detail}' if detail else ''}."


def _provider() -> PlaceProvider:
    return GooglePlaces()


def _normalise(raw: dict[str, Any], near: tuple[float, float] | None) -> dict[str, Any] | None:
    """One record, in the same vocabulary find_chargers speaks.

    Absent fields are left out rather than set to None, matching the rule
    get_vehicle_state follows: the model is told to say what it does not have,
    which it can only do if "no rating" and "rated zero" stay distinguishable.
    """
    location = raw.get("location") or {}
    latitude, longitude = location.get("latitude"), location.get("longitude")
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        # No coordinates means it cannot be navigated to, which is most of the
        # point. Dropping it beats offering a place the car cannot be sent to.
        return None

    place: dict[str, Any] = {
        "name": clean_text((raw.get("displayName") or {}).get("text"), MAX_NAME_LEN),
        "navigate_to": f"{latitude},{longitude}",
    }
    address = clean_text(raw.get("formattedAddress"), MAX_ADDRESS_LEN)
    if address:
        place["address"] = address
    if isinstance(raw.get("rating"), (int, float)):
        place["rating"] = raw["rating"]
    if isinstance(raw.get("userRatingCount"), int):
        place["rating_count"] = raw["userRatingCount"]
    open_now = (raw.get("currentOpeningHours") or {}).get("openNow")
    if isinstance(open_now, bool):
        place["open_now"] = open_now
    if near is not None:
        place["distance_km"] = round(_haversine_km(near, (latitude, longitude)), 1)
    return place if place["name"] else None


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt

    lat1, lon1 = radians(a[0]), radians(a[1])
    lat2, lon2 = radians(b[0]), radians(b[1])
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * asin(sqrt(h))


async def find_places(
    adapter: TeslaAdapter,
    query: str,
    place: str | None = None,
    open_now: bool = False,
    language: str = "en",
) -> dict[str, Any]:
    """Search near the car, or near a named place when one is given."""
    query = (query or "").strip()
    if not query:
        raise ValueError("Say what to look for.")

    near: tuple[float, float] | None = None
    near_label: str | None = None
    if place:
        located = await geocode(place, language)
        if not located:
            raise ValueError(f"Couldn't find a place called '{place}'.")
        near = (located["latitude"], located["longitude"])
        near_label = located["name"]
    else:
        try:
            near = await adapter._coordinates()  # type: ignore[attr-defined]
        except Exception:
            # Without a position the query still works — it just cannot be
            # biased or measured. Better a wider answer than a refusal, and the
            # missing distance_km says so by its absence.
            near = None

    # Rounded so that two questions asked a few metres apart share an answer;
    # three decimals is about a hundred metres, well inside the search radius.
    cache_key = (
        query.lower(),
        None if near is None else (round(near[0], 3), round(near[1], 3)),
        language,
        open_now,
    )
    cached = _cache.get(cache_key)
    now = time.monotonic()
    if cached and now - cached[0] < CACHE_TTL_S:
        return cached[1]

    raw = await _provider().search(query, near, language, open_now)
    places = [p for p in (_normalise(r, near) for r in raw) if p]
    if near is not None:
        places.sort(key=lambda p: p.get("distance_km", 1e9))

    result = {
        "places": places[:MAX_RESULTS],
        "source": _provider().name,
        **({"near": near_label} if near_label else {}),
    }
    _cache[cache_key] = (now, result)
    return result

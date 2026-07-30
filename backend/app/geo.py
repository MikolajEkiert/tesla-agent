"""Reverse geocoding via OpenStreetMap's Nominatim.

Free and keyless, which is why it's here rather than Google Places. Its usage
policy requires an identifying User-Agent and light traffic, both of which a
single-user assistant satisfies.

Privacy note: this is the one place the car's coordinates leave our own
infrastructure, so it's only ever called for an explicit "where is my car"
style request — never from background polling.
"""
from __future__ import annotations

from typing import Any

import httpx

# Nominatim serves OpenStreetMap data, which anyone may edit anonymously, and
# these strings reach the model as tool results. Same treatment as chargers.py.
MAX_LABEL_LEN = 160


def _clean(text: Any) -> str | None:
    if text is None:
        return None
    flat = " ".join(str(text).split())
    flat = "".join(ch for ch in flat if ch.isprintable())
    return flat[:MAX_LABEL_LEN] or None


NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "Amp-TeslaAssistant/1.0 (personal use)"


async def geocode(place: str, language: str = "en") -> dict[str, Any] | None:
    """Turn a place name into coordinates. None when nothing matches, so the
    caller can say "I couldn't find that place" rather than silently
    searching somewhere wrong."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                NOMINATIM_SEARCH_URL,
                params={"q": place, "format": "jsonv2", "limit": 1},
                headers={"User-Agent": USER_AGENT, "Accept-Language": language},
            )
            if r.status_code != 200:
                return None
            results = r.json()
    except Exception:
        return None
    if not results:
        return None
    top = results[0]
    return {
        "latitude": float(top["lat"]),
        "longitude": float(top["lon"]),
        "name": _clean(top.get("display_name")) or _clean(place) or place,
    }


async def reverse_geocode(lat: float, lon: float, language: str = "en") -> str | None:
    """Best-effort street address. Returns None rather than raising — a
    missing label should degrade the answer to bare coordinates, not fail the
    whole request."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                NOMINATIM_REVERSE_URL,
                params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18},
                headers={"User-Agent": USER_AGENT, "Accept-Language": language},
            )
            if r.status_code != 200:
                return None
            return _clean(r.json().get("display_name"))
    except Exception:
        return None

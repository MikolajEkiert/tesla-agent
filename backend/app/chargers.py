"""Charger lookup across sources with deliberately different roles.

Tesla's own `nearby_charging_sites` is the default and is never replaced: it's
the only source anywhere with live free-stall counts. It just can't answer
anything except "around the car, right now".

For the two gaps it leaves — other networks, and places away from the car —
there are two community databases, tried in order:

  1. Open Charge Map: curated, richer (operator, power, whether a site is
     actually operational). Needs a free API key.
  2. OpenStreetMap via Overpass: no key, no account, same data family as the
     geocoding this app already uses. Patchier, and public instances are
     volunteer-run — measured 504s and unreachable mirrors from the
     production host.

Neither has live availability, so results carry their source and the
assistant is told not to present them as equivalent to Tesla's numbers.

The fallback is not belt-and-braces: OCM's site was fully unreachable while
this feature was being built, and Overpass returned 504 from the server the
same day. Either one alone would leave the feature dead for hours at a time.
"""
from __future__ import annotations

import math
from typing import Any

import httpx

from app.config import get_settings
from app.geo import USER_AGENT, geocode
from app.tesla.adapter import TeslaAdapter

OCM_URL = "https://api.openchargemap.io/v3/poi/"
OCM_TIMEOUT_S = 20

# Tried in order; public instances throttle under load, so a single endpoint
# would make this look broken whenever one is busy.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_TIMEOUT_S = 40

# Both are Tesla's own network: "tesla_only" means either, and when
# merging with Tesla's live results both are dropped as duplicates.
TESLA_TYPES = ("supercharger", "tesla_destination")

SEARCH_RADIUS_KM = 15
MAX_RESULTS = 40


class ChargerSourceUnavailable(RuntimeError):
    """Raised only when every non-Tesla source failed."""


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _classify_site(power_kw: float | None, *labels: Any) -> str:
    """supercharger | tesla_destination | public.

    Tesla runs two very different things and the community databases tag both
    with operator=Tesla: DC Superchargers (150-250 kW) and AC destination
    chargers bolted to hotel walls (11-22 kW). Collapsing them cost a real
    wrong answer in testing — a 22 kW spa charger was announced as "a
    Supercharger 14 km away", which would have meant driving there expecting
    a fast charge.

    Matching is on text rather than a database id: Tesla appears under
    several ids in OCM and those carry no stability guarantee.
    """
    text = " ".join(str(v or "") for v in labels).lower()
    if "supercharger" in text:
        return "supercharger"
    if "tesla" in text:
        # Tesla hardware without the Supercharger label: a fast one would be
        # branded, and DC power corroborates it either way.
        return "supercharger" if power_kw and power_kw >= 50 else "tesla_destination"
    return "public"


# --- Open Charge Map -------------------------------------------------------

def _normalize_ocm(poi: dict[str, Any], origin: tuple[float, float]) -> dict[str, Any] | None:
    address = poi.get("AddressInfo") or {}
    lat, lon = address.get("Latitude"), address.get("Longitude")
    if lat is None or lon is None:
        return None
    operator = (poi.get("OperatorInfo") or {}).get("Title")
    connections = poi.get("Connections") or []
    powers = [c.get("PowerKW") for c in connections if c.get("PowerKW")]
    max_power = max(powers) if powers else None
    distance = address.get("Distance")
    return {
        "name": address.get("Title") or operator or "Charging point",
        "operator": operator,
        "address": ", ".join(
            p for p in (address.get("AddressLine1"), address.get("Town")) if p
        )
        or None,
        "type": _classify_site(max_power, operator, address.get("Title")),
        "distance_km": round(
            distance if distance is not None else _haversine_km(*origin, lat, lon), 1
        ),
        "total_stalls": poi.get("NumberOfPoints"),
        # No live data in any community database — state it rather than let
        # the model infer availability from a missing field.
        "available_stalls": None,
        "max_power_kw": max_power,
        "navigate_to": f"{lat},{lon}",
    }


async def _ocm_search(
    latitude: float, longitude: float, tesla_only: bool
) -> list[dict[str, Any]]:
    key = get_settings().ocm_api_key
    if not key:
        raise ChargerSourceUnavailable("no Open Charge Map API key configured")
    async with httpx.AsyncClient(timeout=OCM_TIMEOUT_S) as c:
        r = await c.get(
            OCM_URL,
            params={
                "output": "json",
                "latitude": latitude,
                "longitude": longitude,
                "distance": SEARCH_RADIUS_KM,
                "distanceunit": "KM",
                "maxresults": MAX_RESULTS,
                # Drop sites the database knows are dead — the one thing OSM
                # can't reliably tell us.
                "statustypeid": "0,50,75",
                "key": key,
            },
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
        pois = r.json()
    if not isinstance(pois, list):
        raise ChargerSourceUnavailable("unexpected Open Charge Map response")
    sites = [
        s
        for s in (_normalize_ocm(p, (latitude, longitude)) for p in pois)
        if s is not None
    ]
    if tesla_only:
        sites = [s for s in sites if s["type"] in TESLA_TYPES]
    sites.sort(key=lambda s: s["distance_km"])
    return sites


# --- OpenStreetMap / Overpass (fallback) -----------------------------------

def _max_power_kw(tags: dict[str, str]) -> float | None:
    """Power hides under several socket-specific keys (socket:type2:output,
    charging_station:output, ...), so scan any '*output*' tag."""
    best: float | None = None
    for key, value in tags.items():
        if "output" not in key:
            continue
        digits = "".join(ch for ch in str(value) if ch.isdigit() or ch == ".")
        try:
            kw = float(digits)
        except ValueError:
            continue
        if kw and (best is None or kw > best):
            best = kw
    return best


def _normalize_osm(element: dict[str, Any], origin: tuple[float, float]) -> dict[str, Any] | None:
    tags = element.get("tags", {}) or {}
    # Ways/relations report their position under `center` (see "out center").
    lat = element.get("lat") or (element.get("center") or {}).get("lat")
    lon = element.get("lon") or (element.get("center") or {}).get("lon")
    if lat is None or lon is None:
        return None
    capacity = tags.get("capacity")
    operator = tags.get("operator") or tags.get("brand")
    power = _max_power_kw(tags)
    return {
        "name": tags.get("name") or operator or "Charging point",
        "operator": operator,
        "address": None,
        "type": _classify_site(
            power, operator, tags.get("brand"), tags.get("network"), tags.get("name")
        ),
        "distance_km": round(_haversine_km(*origin, lat, lon), 1),
        "total_stalls": int(capacity) if capacity and capacity.isdigit() else None,
        "available_stalls": None,
        "max_power_kw": power,
        "navigate_to": f"{lat},{lon}",
    }


async def _osm_search(
    latitude: float, longitude: float, tesla_only: bool
) -> list[dict[str, Any]]:
    query = (
        f"[out:json][timeout:25];"
        f"nwr(around:{SEARCH_RADIUS_KM * 1000},{latitude},{longitude})[amenity=charging_station];"
        f"out center tags {MAX_RESULTS};"
    )
    last_error: Exception | None = None
    elements: list[dict[str, Any]] | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            # The User-Agent is not optional: Overpass answers 406 Not
            # Acceptable to clients that send a default library one.
            async with httpx.AsyncClient(
                timeout=OVERPASS_TIMEOUT_S, headers={"User-Agent": USER_AGENT}
            ) as c:
                r = await c.post(endpoint, data={"data": query})
                r.raise_for_status()
                elements = r.json().get("elements", [])
                break
        except Exception as e:
            last_error = e
            continue
    if elements is None:
        # str() on httpx timeout/transport errors is often empty, which would
        # turn a rate-limit into an unreadable "(...)"; keep the type.
        raise ChargerSourceUnavailable(
            f"OpenStreetMap lookup failed ({type(last_error).__name__}: {last_error}".strip(": ")
            + ")"
        )
    sites = [
        s for s in (_normalize_osm(e, (latitude, longitude)) for e in elements) if s is not None
    ]
    if tesla_only:
        sites = [s for s in sites if s["type"] in TESLA_TYPES]
    sites.sort(key=lambda s: s["distance_km"])
    return sites


async def _search_area(
    latitude: float, longitude: float, tesla_only: bool
) -> tuple[list[dict[str, Any]], str]:
    """Open Charge Map first, OpenStreetMap if it can't answer. Returns the
    sites plus which source actually produced them, so the reply can be
    honest about where the numbers came from."""
    ocm_error: Exception | None = None
    try:
        sites = await _ocm_search(latitude, longitude, tesla_only)
        if sites:
            return sites, "openchargemap"
        # Empty is not the same as authoritative: the two databases have
        # genuinely different coverage (measured 4 sites from OCM vs 10 from
        # OSM around Zakopane). Reporting "there are none" off a thin result
        # would be a false negative, so cross-check before saying that.
    except Exception as e:
        ocm_error = e

    try:
        return await _osm_search(latitude, longitude, tesla_only), "openstreetmap"
    except Exception as osm_error:
        if ocm_error is None:
            # OCM answered fine, just with nothing — that's a real answer.
            return [], "openchargemap"
        raise ChargerSourceUnavailable(
            "Both charger databases are unreachable right now "
            f"(Open Charge Map: {ocm_error}; OpenStreetMap: {osm_error}). "
            "Tesla's own chargers near the car are unaffected."
        )


async def find_chargers(
    adapter: TeslaAdapter,
    place: str | None = None,
    include_other_networks: bool = False,
) -> dict[str, Any]:
    """Tesla-only around the car by default; widen by network or by place."""
    if place:
        located = await geocode(place)
        if not located:
            raise ValueError(f"Couldn't find a place called '{place}'.")
        sites, source = await _search_area(
            located["latitude"], located["longitude"], tesla_only=not include_other_networks
        )
        return {
            "sites": sites,
            "source": source,
            "near": located["name"],
            "live_availability": False,
        }

    tesla = await adapter.nearby_chargers()
    if not include_other_networks:
        return {**tesla, "live_availability": True}

    location = await adapter.get_location()
    others, source = await _search_area(
        location["latitude"], location["longitude"], tesla_only=False
    )
    # Tesla's own results already carry live stall counts, so drop the
    # database's copies of the same sites rather than showing one charger
    # twice with conflicting information.
    others = [s for s in others if s["type"] not in TESLA_TYPES]
    sites = [*tesla["sites"], *others]
    sites.sort(key=lambda s: (s.get("distance_km") is None, s.get("distance_km") or 0))
    return {
        "sites": sites,
        "source": f"tesla+{source}",
        "live_availability": "tesla only",
    }

"""Turning "stop for a charge, then dinner, then home" into something the car
can be sent.

Lives above the adapter because the two are different shapes: the car's
waypoint command takes numbers, while the free-text destination command takes
a string and lets Tesla geocode it. Deciding which of those a request is takes
knowing what the model actually passed, and that decision does not belong in
the Fleet implementation.
"""
from __future__ import annotations

from typing import Any

from app.geo import clean_text, geocode

# Conservative, and labelled as a guess: the car's real waypoint limit is not
# documented and has not been measured on this vehicle. Better to refuse a
# sixth stop than to send five and silently drop one.
MAX_STOPS = 5

MAX_LABEL_LEN = 60


def parse_coordinates(value: Any) -> tuple[float, float] | None:
    """A "lat,lon" string as emitted by find_chargers and find_places, or None.

    Strict on purpose. This is also where a crafted `navigate_to` stops: place
    names and addresses come from anonymously-editable sources, travel through
    the model's context, and can come back as anything. Two floats in range or
    nothing — a value carrying text fails to parse rather than reaching the
    car.
    """
    if not isinstance(value, str):
        return None
    parts = value.split(",")
    if len(parts) != 2:
        return None
    try:
        latitude, longitude = float(parts[0].strip()), float(parts[1].strip())
    except ValueError:
        return None
    if not (-90.0 <= latitude <= 90.0) or not (-180.0 <= longitude <= 180.0):
        return None
    return latitude, longitude


async def resolve_stops(stops: list[dict[str, Any]], language: str = "en") -> list[dict[str, Any]]:
    """Every stop as coordinates, in visit order.

    Coordinates win over an address when both are given: they came from a
    search result and name one specific place, where the address is a label
    that has to be looked up again.

    A stop that cannot be resolved raises, naming it. Dropping it silently
    would hand back a route that looks complete and is missing its middle —
    the failure nobody notices until they are driving past the turning.
    """
    if not stops:
        raise ValueError("No stops given.")
    if len(stops) > MAX_STOPS:
        raise ValueError(f"Too many stops — at most {MAX_STOPS}.")

    resolved: list[dict[str, Any]] = []
    for index, stop in enumerate(stops, start=1):
        if not isinstance(stop, dict):
            raise ValueError(f"Stop {index} is not a place.")
        label = clean_text(stop.get("label"), MAX_LABEL_LEN)

        point = parse_coordinates(stop.get("coordinates"))
        if point is None:
            address = (stop.get("address") or "").strip()
            if not address:
                raise ValueError(
                    f"Stop {index} ({label or 'unnamed'}) has neither usable "
                    "coordinates nor an address."
                )
            located = await geocode(address, language)
            if not located:
                raise ValueError(f"Couldn't find '{address}' (stop {index}).")
            point = (located["latitude"], located["longitude"])
            label = label or located["name"]

        resolved.append(
            {"latitude": point[0], "longitude": point[1], **({"label": label} if label else {})}
        )
    return resolved

"""Google Routes API walking geometry, with a quiet offline fallback.

The accessibility scoring engine remains deterministic and offline-first. This
module only enriches drawable geometry: if the API key is absent or a request
fails, callers receive ``None`` and keep the original waypoint line.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import dotenv_values

from ..models import LatLngPoint

_COMPUTE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
_FIELD_MASK = "routes.polyline.geoJsonLinestring"
logger = logging.getLogger("uvicorn.error")
_API_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def _lat_lng(point: tuple[float, float]) -> dict[str, object]:
    lat, lng = point
    return {"location": {"latLng": {"latitude": lat, "longitude": lng}}}


@lru_cache(maxsize=128)
def _fetch_walking_path(
    api_key: str,
    points: tuple[tuple[float, float], ...],
) -> tuple[tuple[float, float], ...] | None:
    """Return (lat, lng) points. Failures are cached to avoid retry storms."""
    if len(points) < 2:
        return None

    payload: dict[str, object] = {
        "origin": _lat_lng(points[0]),
        "destination": _lat_lng(points[-1]),
        "travelMode": "WALK",
        "polylineQuality": "HIGH_QUALITY",
        "polylineEncoding": "GEO_JSON_LINESTRING",
        "languageCode": "zh-TW",
        "units": "METRIC",
    }
    if len(points) > 2:
        payload["intermediates"] = [_lat_lng(point) for point in points[1:-1]]

    request = Request(
        _COMPUTE_ROUTES_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": _FIELD_MASK,
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=5) as response:
            body = json.load(response)
        coordinates = body["routes"][0]["polyline"]["geoJsonLinestring"]["coordinates"]
        # GeoJSON is [longitude, latitude], while Maps 3D expects lat/lng objects.
        path = tuple((float(lat), float(lng)) for lng, lat in coordinates)
        return path if len(path) >= 2 else None
    except (HTTPError, URLError, TimeoutError, KeyError, IndexError, TypeError, ValueError) as error:
        # Do not include the request headers here: they contain the API key.
        logger.warning(
            "walking route unavailable; using waypoint fallback: %s",
            error,
        )
        return None


class WalkingRouteGeometry:
    """Small synchronous client shared by all legs in one planning request."""

    def __init__(self, api_key: str | None = None) -> None:
        # In local development .env is often edited while Uvicorn is already
        # running. Read the current file value here so a newly pasted key takes
        # effect without relying on the process environment captured at startup.
        file_key = dotenv_values(_API_ENV_FILE).get("GOOGLE_ROUTES_API_KEY")
        self._api_key = (
            api_key
            if api_key is not None
            else os.getenv("GOOGLE_ROUTES_API_KEY")
            or file_key
            or os.getenv("GOOGLE_MAPS_API_KEY")
            or ""
        ).strip()

    @property
    def enabled(self) -> bool:
        return bool(self._api_key)

    def route(self, points: list[LatLngPoint]) -> list[LatLngPoint] | None:
        if not self.enabled or len(points) < 2:
            return None
        key = tuple((point.lat, point.lng) for point in points)
        path = _fetch_walking_path(self._api_key, key)
        if path is None:
            return None
        return [LatLngPoint(lat=lat, lng=lng) for lat, lng in path]

    def prefetch(self, paths: Iterable[list[LatLngPoint]]) -> None:
        """Warm distinct walking routes concurrently to keep first response fast."""
        if not self.enabled:
            return
        unique: dict[tuple[tuple[float, float], ...], list[LatLngPoint]] = {}
        for path in paths:
            key = tuple((point.lat, point.lng) for point in path)
            if len(key) >= 2:
                unique.setdefault(key, path)
        with ThreadPoolExecutor(max_workers=min(6, len(unique) or 1)) as pool:
            list(pool.map(self.route, unique.values()))

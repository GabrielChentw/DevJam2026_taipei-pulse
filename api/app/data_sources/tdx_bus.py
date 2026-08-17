"""TDX bus route shapes, clipped to the boarding and alighting stops.

TDX currently returns bus geometry as WKT (usually ``LINESTRING``), not as
GeoJSON.  This adapter keeps authentication, transport quirks and WKT parsing
out of the route-scoring engine.  It is an optional enrichment: missing
credentials or a transient TDX failure returns ``None`` so callers can fall
back to Google Routes or the offline waypoint line.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from dotenv import dotenv_values

from ..models import LatLngPoint


TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
SHAPE_URL = "https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taipei/{route_name}?%24format=JSON"
_API_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
_CACHE_TTL_SECONDS = 30 * 60
_MAX_COMBINED_ENDPOINT_ERROR_METERS = 500
_NUMBER_PAIR = re.compile(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)")
logger = logging.getLogger("uvicorn.error")

_token_lock = threading.Lock()
_token_cache: dict[str, tuple[str, float]] = {}
_shape_lock = threading.Lock()
_shape_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}


def _ssl_context() -> ssl.SSLContext:
    """Keep certificate verification while tolerating TDX's legacy chain.

    Python 3.14 enables X509 strict mode, while the current TDX certificate
    chain omits a Subject Key Identifier on a legacy certificate.  Clearing
    only STRICT preserves hostname and CA verification.
    """

    context = ssl.create_default_context()
    strict = getattr(ssl, "VERIFY_X509_STRICT", 0)
    if strict:
        context.verify_flags &= ~strict
    return context


def _credentials() -> tuple[str, str]:
    file_values = dotenv_values(_API_ENV_FILE)
    client_id = (os.getenv("TDX_CLIENT_ID") or file_values.get("TDX_CLIENT_ID") or "").strip()
    client_secret = (
        os.getenv("TDX_CLIENT_SECRET") or file_values.get("TDX_CLIENT_SECRET") or ""
    ).strip()
    return client_id, client_secret


def _access_token(client_id: str, client_secret: str) -> str:
    now = time.monotonic()
    with _token_lock:
        cached = _token_cache.get(client_id)
        if cached and cached[1] > now + 30:
            return cached[0]

        payload = urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            }
        ).encode("utf-8")
        request = Request(
            TOKEN_URL,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urlopen(request, timeout=8, context=_ssl_context()) as response:
            body = json.load(response)

        token = str(body["access_token"])
        expires_in = max(60, int(body.get("expires_in", 300)))
        _token_cache[client_id] = (token, now + expires_in)
        return token


def _fetch_shapes(client_id: str, client_secret: str, route_name: str) -> list[dict[str, Any]]:
    now = time.monotonic()
    with _shape_lock:
        cached = _shape_cache.get(route_name)
        if cached and cached[1] > now:
            return cached[0]

    token = _access_token(client_id, client_secret)
    request = Request(
        SHAPE_URL.format(route_name=quote(route_name, safe="")),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "TaipeiPulse/0.1 TDX-shape-adapter",
        },
    )
    with urlopen(request, timeout=10, context=_ssl_context()) as response:
        body = json.load(response)
    if not isinstance(body, list):
        raise ValueError("TDX Shape response is not a list")

    records = [item for item in body if isinstance(item, dict)]
    with _shape_lock:
        # Cache an empty response too, preventing retry storms for a bad name.
        _shape_cache[route_name] = (records, now + _CACHE_TTL_SECONDS)
    return records


def _coordinate_line(value: str) -> list[LatLngPoint]:
    # WKT order is longitude latitude; the rest of the app uses lat/lng.
    return [LatLngPoint(lat=float(lat), lng=float(lng)) for lng, lat in _NUMBER_PAIR.findall(value)]


def parse_wkt_lines(value: Any) -> list[list[LatLngPoint]]:
    """Parse TDX WKT into independent line components.

    ``MULTILINESTRING`` components remain separate so the selector never draws
    a straight connector between disconnected pieces.
    """

    if not isinstance(value, str):
        return []
    text = value.strip()
    if ";" in text and text.upper().startswith("SRID="):
        text = text.split(";", 1)[1].strip()
    upper = text.upper()

    if upper.startswith("LINESTRING"):
        line = _coordinate_line(text)
        return [line] if len(line) >= 2 else []
    if not upper.startswith("MULTILINESTRING"):
        return []

    start = text.find("(")
    if start < 0:
        return []
    components: list[list[LatLngPoint]] = []
    depth = 0
    component_start: int | None = None
    for index, char in enumerate(text[start:], start=start):
        if char == "(":
            depth += 1
            if depth == 2:
                component_start = index + 1
        elif char == ")":
            if depth == 2 and component_start is not None:
                line = _coordinate_line(text[component_start:index])
                if len(line) >= 2:
                    components.append(line)
                component_start = None
            depth -= 1
    return components


def _distance_meters(a: LatLngPoint, b: LatLngPoint) -> float:
    mean_lat = math.radians((a.lat + b.lat) / 2)
    dy = (a.lat - b.lat) * 110_540
    dx = (a.lng - b.lng) * 111_320 * math.cos(mean_lat)
    return math.hypot(dx, dy)


def _clip_line(
    line: list[LatLngPoint],
    start: LatLngPoint,
    end: LatLngPoint,
) -> tuple[list[LatLngPoint], float] | None:
    if len(line) < 2:
        return None
    start_index = min(range(len(line)), key=lambda index: _distance_meters(line[index], start))
    end_index = min(range(len(line)), key=lambda index: _distance_meters(line[index], end))
    if start_index == end_index:
        return None

    if start_index < end_index:
        clipped = line[start_index : end_index + 1]
    else:
        clipped = list(reversed(line[end_index : start_index + 1]))
    score = _distance_meters(clipped[0], start) + _distance_meters(clipped[-1], end)
    return clipped, score


def select_shape_path(
    records: list[dict[str, Any]],
    start: LatLngPoint,
    end: LatLngPoint,
    route_uid: str | None = None,
    direction: int | None = None,
) -> tuple[list[LatLngPoint], dict[str, Any]] | None:
    """Select and orient the route component closest to both requested stops."""

    matches = records
    if route_uid:
        matches = [item for item in matches if item.get("RouteUID") == route_uid]
    if direction is not None:
        matches = [item for item in matches if item.get("Direction") == direction]

    best: tuple[list[LatLngPoint], dict[str, Any], float] | None = None
    for record in matches:
        for line in parse_wkt_lines(record.get("Geometry")):
            clipped = _clip_line(line, start, end)
            if clipped is None:
                continue
            path, score = clipped
            if best is None or score < best[2]:
                best = (path, record, score)
    if best is None:
        return None

    path, record, score = best
    # A same-named route can represent a different service pattern. Refuse to
    # draw it when the official shape does not actually pass near both stops.
    if score > _MAX_COMBINED_ENDPOINT_ERROR_METERS:
        return None
    metadata = {
        "route_uid": record.get("RouteUID"),
        "direction": record.get("Direction"),
        "endpoint_error_m": round(score),
    }
    return path, metadata


class TDXBusShapeGeometry:
    """Synchronous TDX shape client used by the route annotator."""

    def __init__(self, client_id: str | None = None, client_secret: str | None = None) -> None:
        file_client_id, file_client_secret = _credentials()
        self._client_id = client_id if client_id is not None else file_client_id
        self._client_secret = client_secret if client_secret is not None else file_client_secret

    @property
    def enabled(self) -> bool:
        return bool(self._client_id and self._client_secret)

    def route(
        self,
        route_name: str,
        points: list[LatLngPoint],
        route_uid: str | None = None,
        direction: int | None = None,
    ) -> list[LatLngPoint] | None:
        if not self.enabled or not route_name or len(points) < 2:
            return None
        try:
            records = _fetch_shapes(self._client_id, self._client_secret, route_name)
            selected = select_shape_path(records, points[0], points[-1], route_uid, direction)
            if selected is None:
                return None
            path, metadata = selected
            logger.info(
                "TDX bus shape selected route=%s uid=%s direction=%s points=%d endpoint_error_m=%s",
                route_name,
                metadata["route_uid"],
                metadata["direction"],
                len(path),
                metadata["endpoint_error_m"],
            )
            return path
        except (HTTPError, URLError, TimeoutError, OSError, KeyError, TypeError, ValueError) as error:
            # Never log request headers or token response; they contain secrets.
            logger.warning("TDX bus shape unavailable for route=%s: %s", route_name, error)
            return None

    def prefetch(self, routes: Iterable[tuple[str, list[LatLngPoint], str | None, int | None]]) -> None:
        if not self.enabled:
            return
        unique: dict[tuple[str, str | None, int | None], tuple[str, list[LatLngPoint], str | None, int | None]] = {}
        for route in routes:
            name, points, uid, direction = route
            if name and len(points) >= 2:
                unique.setdefault((name, uid, direction), route)

        def warm(item: tuple[str, list[LatLngPoint], str | None, int | None]) -> None:
            name, points, uid, direction = item
            self.route(name, points, uid, direction)

        with ThreadPoolExecutor(max_workers=min(4, len(unique) or 1)) as pool:
            list(pool.map(warm, unique.values()))

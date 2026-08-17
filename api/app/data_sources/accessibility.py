"""Taipei accessibility public-data snapshot with an offline fallback.

The live sources use two different formats and encodings. WheelRoute returns
JSON, while Taipei Open Data currently serves the MRT CSV files as CP950.
Keeping all parsing here prevents transport quirks from leaking into routing
rules and gives the demo one stable, provenance-rich contract.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


WHEELROUTE_URL = "https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/{facility_type}"
METRO_ELEVATOR_URL = (
    "https://data.taipei/api/frontstage/tpeod/dataset/resource.download"
    "?rid=61792c82-6609-41b2-9775-3a346934826d"
)
METRO_OUTAGE_URL = (
    "https://data.taipei/api/frontstage/tpeod/dataset/resource.download"
    "?rid=649c44eb-60b5-4746-a353-cbdc6651fc09"
)
SOURCE_PAGES = {
    "wheelroute": "https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7",
    "metro_elevator": "https://data.taipei/dataset/detail?id=0a3bb422-9eb5-459b-a9d4-138456516183",
    "metro_outage": "https://data.taipei/dataset/detail?id=d884a9c6-f86c-4854-8da7-e6516ddbe612",
}

CORRIDOR_BBOX = {"south": 25.03, "west": 121.50, "north": 25.06, "east": 121.58}
CORRIDOR_MAX_DISTANCE_METERS = 220
CORRIDOR_ANCHORS = (
    (25.0478, 121.5170),
    (25.0446, 121.5252),
    (25.0424, 121.5330),
    (25.0416, 121.5434),
    (25.0416, 121.5497),
    (25.0413, 121.5576),
    (25.0410, 121.5679),
)
CORRIDOR_STATIONS = (
    "台北車站",
    "善導寺站",
    "忠孝新生站",
    "忠孝復興站",
    "忠孝敦化站",
    "國父紀念館站",
    "市政府站",
)
FALLBACK_PATH = Path(__file__).resolve().parents[1] / "data" / "accessibility_snapshot.json"
CACHE_TTL_SECONDS = 15 * 60

_cache_lock = threading.Lock()
_cached_at = 0.0
_cached_snapshot: dict[str, Any] | None = None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _fetch_bytes(url: str, timeout_seconds: float = 8.0) -> bytes:
    request = Request(url, headers={"User-Agent": "TaipeiPulse/0.1 public-data-adapter"})
    with urlopen(request, timeout=timeout_seconds) as response:
        return response.read()


def _decode_csv(payload: bytes) -> str:
    """Taipei Open Data CSVs are currently CP950, but accept UTF-8 too."""
    for encoding in ("utf-8-sig", "cp950"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="replace")


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result


def _inside_corridor(lat: float | None, lng: float | None) -> bool:
    if (
        lat is None
        or lng is None
        or not CORRIDOR_BBOX["south"] <= lat <= CORRIDOR_BBOX["north"]
        or not CORRIDOR_BBOX["west"] <= lng <= CORRIDOR_BBOX["east"]
    ):
        return False
    return _corridor_distance_meters(lat, lng) <= CORRIDOR_MAX_DISTANCE_METERS


def _corridor_distance_meters(lat: float, lng: float) -> float:
    """Approximate point-to-polyline distance over this small Taipei area."""
    meters_per_lat = 110_540
    meters_per_lng = 101_300
    px = lng * meters_per_lng
    py = lat * meters_per_lat
    nearest = float("inf")
    for (lat_a, lng_a), (lat_b, lng_b) in zip(CORRIDOR_ANCHORS, CORRIDOR_ANCHORS[1:]):
        ax, ay = lng_a * meters_per_lng, lat_a * meters_per_lat
        bx, by = lng_b * meters_per_lng, lat_b * meters_per_lat
        dx, dy = bx - ax, by - ay
        length_squared = dx * dx + dy * dy
        progress = 0.0 if length_squared == 0 else ((px - ax) * dx + (py - ay) * dy) / length_squared
        progress = min(1.0, max(0.0, progress))
        closest_x = ax + progress * dx
        closest_y = ay + progress * dy
        nearest = min(nearest, ((px - closest_x) ** 2 + (py - closest_y) ** 2) ** 0.5)
    return nearest


def _stable_id(prefix: str, *values: Any) -> str:
    digest = hashlib.sha1("|".join(str(value) for value in values).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def parse_wheelroute(payload: bytes, facility_type: int) -> list[dict[str, Any]]:
    rows = json.loads(payload.decode("utf-8-sig"))
    kind = "ramp" if facility_type == 1 else "accessible_entrance"
    facilities: list[dict[str, Any]] = []
    for row in rows:
        lat = _number(row.get("lat"))
        lng = _number(row.get("lon"))
        if not _inside_corridor(lat, lng):
            continue
        width = _number(row.get("width"))
        slope = _number(row.get("slope"))
        facilities.append(
            {
                "id": _stable_id(f"wheelroute-{facility_type}", row.get("kname"), lat, lng),
                "kind": kind,
                "name": str(row.get("kname") or "未命名設施"),
                "position": {"lat": lat, "lng": lng},
                "width_cm": width if width is not None and width > 0 else None,
                "slope_percent": slope if slope is not None and slope > 0 else None,
                "confidence": "verified",
                "source_id": f"wheelroute-{facility_type}",
            }
        )
    return facilities


def parse_metro_elevators(payload: bytes) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(_decode_csv(payload)))
    facilities: list[dict[str, Any]] = []
    for row in reader:
        lat = _number(row.get("緯度"))
        lng = _number(row.get("經度"))
        if not _inside_corridor(lat, lng):
            continue
        name = (row.get("出入口電梯/無障礙坡道名稱") or "未命名捷運設施").strip()
        facilities.append(
            {
                "id": f"metro-elevator-{(row.get('項次') or len(facilities) + 1).strip()}",
                "kind": "metro_ramp" if "坡道" in name else "metro_elevator",
                "name": name,
                "exit": (row.get("出入口編號") or "").strip() or None,
                "position": {"lat": lat, "lng": lng},
                "confidence": "verified",
                "source_id": "metro-elevator-gps",
            }
        )
    return facilities


def parse_metro_outages(payload: bytes) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(_decode_csv(payload)))
    notices: list[dict[str, Any]] = []
    for row in reader:
        station = (row.get("車站") or "").strip()
        if station and not any(name in station or station in name for name in CORRIDOR_STATIONS):
            continue
        message = (row.get("說明") or "").strip()
        if "已開放使用" in message or "恢復" in message:
            status = "resolved"
        elif any(keyword in message for keyword in ("暫停使用", "故障", "檢修")):
            status = "outage"
        else:
            status = "notice"
        notices.append(
            {
                "id": f"metro-outage-{(row.get('項次') or len(notices) + 1).strip()}",
                "timestamp": (row.get("日期時間") or "").strip() or None,
                "line": (row.get("路線") or "").strip() or None,
                "station": station or None,
                "message": message,
                "status": status,
                "source_id": "metro-accessibility-outage",
            }
        )
    return notices


def _load_fallback() -> dict[str, Any]:
    return json.loads(FALLBACK_PATH.read_text(encoding="utf-8"))


def _source_status(source_id: str, label: str, page_url: str, mode: str, count: int, error: str | None = None) -> dict[str, Any]:
    return {
        "id": source_id,
        "label": label,
        "page_url": page_url,
        "mode": mode,
        "record_count": count,
        "error": error,
    }


def _build_live_snapshot() -> dict[str, Any]:
    jobs = {
        "wheelroute-1": (WHEELROUTE_URL.format(facility_type=1), lambda data: parse_wheelroute(data, 1)),
        "wheelroute-7": (WHEELROUTE_URL.format(facility_type=7), lambda data: parse_wheelroute(data, 7)),
        "metro-elevator-gps": (METRO_ELEVATOR_URL, parse_metro_elevators),
        "metro-accessibility-outage": (METRO_OUTAGE_URL, parse_metro_outages),
    }
    labels = {
        "wheelroute-1": "輪行臺北：無障礙斜坡道",
        "wheelroute-7": "輪行臺北：無障礙出入口",
        "metro-elevator-gps": "臺北捷運出入口電梯／坡道 GPS",
        "metro-accessibility-outage": "臺北捷運無障礙設施異常公告",
    }
    pages = {
        "wheelroute-1": SOURCE_PAGES["wheelroute"],
        "wheelroute-7": SOURCE_PAGES["wheelroute"],
        "metro-elevator-gps": SOURCE_PAGES["metro_elevator"],
        "metro-accessibility-outage": SOURCE_PAGES["metro_outage"],
    }

    facilities: list[dict[str, Any]] = []
    outages: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {pool.submit(_fetch_bytes, url): source_id for source_id, (url, _) in jobs.items()}
        for future in as_completed(futures):
            source_id = futures[future]
            parser = jobs[source_id][1]
            try:
                records = parser(future.result())
                if source_id == "metro-accessibility-outage":
                    outages.extend(records)
                else:
                    facilities.extend(records)
                sources.append(_source_status(source_id, labels[source_id], pages[source_id], "live", len(records)))
            except Exception as error:  # network/encoding errors must not break the demo
                message = f"{type(error).__name__}: {error}"
                errors.append(f"{source_id}: {message}")
                sources.append(_source_status(source_id, labels[source_id], pages[source_id], "unavailable", 0, message))

    if errors:
        raise RuntimeError("; ".join(errors))
    return {"facilities": facilities, "outages": outages, "sources": sources}


def load_accessibility_snapshot(force_refresh: bool = False) -> dict[str, Any]:
    global _cached_at, _cached_snapshot
    now = time.monotonic()
    with _cache_lock:
        if not force_refresh and _cached_snapshot is not None and now - _cached_at < CACHE_TTL_SECONDS:
            return _cached_snapshot

    fallback = _load_fallback()
    try:
        live = _build_live_snapshot()
        snapshot = {
            "generated_at": _now_iso(),
            "data_mode": "live",
            "corridor_bbox": CORRIDOR_BBOX,
            **live,
        }
    except Exception as error:
        snapshot = {
            **fallback,
            "generated_at": _now_iso(),
            "data_mode": "fallback",
            "fallback_reason": f"{type(error).__name__}: {error}",
        }

    with _cache_lock:
        _cached_at = time.monotonic()
        _cached_snapshot = snapshot
    return snapshot

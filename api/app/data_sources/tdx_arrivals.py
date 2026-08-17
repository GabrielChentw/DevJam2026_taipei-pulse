"""Live TDX bus arrivals with an explicit accessibility simulation layer.

TDX A2 provides a plate number and current stop; ETA provides seconds to a
stop. Neither response contains low-floor/ramp attributes. The adapter keeps
those facts separate: timing/position may be live while accessibility is
labelled ``demo_simulation`` until an operator vehicle registry is available.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

from .tdx_bus import _access_token, _credentials, _ssl_context


BASE_URL = "https://tdx.transportdata.tw/api/basic/v2/Bus/{endpoint}/City/Taipei/{route_name}?%24format=JSON"
DEMO_PATH = Path(__file__).resolve().parents[1] / "data" / "transit_demo.json"
CACHE_TTL_SECONDS = 15
logger = logging.getLogger("uvicorn.error")

_cache_lock = threading.Lock()
_cache: dict[tuple[str, str, int, str], tuple[dict[str, Any], float]] = {}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _request_records(endpoint: str, route_name: str, client_id: str, client_secret: str) -> list[dict[str, Any]]:
    token = _access_token(client_id, client_secret)
    request = Request(
        BASE_URL.format(endpoint=endpoint, route_name=quote(route_name, safe="")),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "TaipeiPulse/0.1 TDX-arrival-adapter",
        },
    )
    with urlopen(request, timeout=10, context=_ssl_context()) as response:
        body = json.load(response)
    return [item for item in body if isinstance(item, dict)] if isinstance(body, list) else []


def _demo_route(route_name: str, route_uid: str, direction: int, boarding_stop_uid: str) -> dict[str, Any] | None:
    body = json.loads(DEMO_PATH.read_text(encoding="utf-8"))
    for route in body.get("routes", []):
        if (
            route.get("route_name") == route_name
            and route.get("route_uid") == route_uid
            and route.get("direction") == direction
            and route.get("boarding_stop_uid") == boarding_stop_uid
        ):
            return route
    return None


def _stop_name(record: dict[str, Any]) -> str | None:
    name = record.get("StopName")
    if isinstance(name, dict):
        return name.get("Zh_tw") or name.get("En")
    return str(name) if name else None


def _stop_position(record: dict[str, Any]) -> dict[str, float] | None:
    position = record.get("StopPosition")
    if not isinstance(position, dict):
        return None
    lat = position.get("PositionLat")
    lng = position.get("PositionLon")
    if lat is None or lng is None:
        return None
    return {"lat": float(lat), "lng": float(lng)}


def _matching_stop_route(
    records: list[dict[str, Any]], route_uid: str, direction: int
) -> dict[str, Any] | None:
    return next(
        (
            record
            for record in records
            if record.get("RouteUID") == route_uid and record.get("Direction") == direction
        ),
        None,
    )


def _build_snapshot(
    route_name: str,
    route_uid: str,
    direction: int,
    boarding_stop_uid: str,
) -> dict[str, Any]:
    demo = _demo_route(route_name, route_uid, direction, boarding_stop_uid)
    if demo is None:
        raise ValueError("這條路線尚未設定 demo 上車站與低地板回退資料")

    client_id, client_secret = _credentials()
    eta_records: list[dict[str, Any]] = []
    realtime_records: list[dict[str, Any]] = []
    stop_route_records: list[dict[str, Any]] = []
    live_error: str | None = None
    if client_id and client_secret:
        try:
            eta_records = _request_records("EstimatedTimeOfArrival", route_name, client_id, client_secret)
            realtime_records = _request_records("RealTimeNearStop", route_name, client_id, client_secret)
            stop_route_records = _request_records("StopOfRoute", route_name, client_id, client_secret)
        except Exception as error:  # the demo must survive TDX downtime
            live_error = f"{type(error).__name__}: {error}"
            logger.warning("TDX arrival data unavailable for route=%s: %s", route_name, error)

    eta = next(
        (
            record
            for record in eta_records
            if record.get("RouteUID") == route_uid
            and record.get("Direction") == direction
            and record.get("StopUID") == boarding_stop_uid
        ),
        None,
    )
    estimate_seconds = eta.get("EstimateTime") if eta else None
    eta_is_live = isinstance(estimate_seconds, (int, float)) and (eta or {}).get("StopStatus") == 0

    stop_route = _matching_stop_route(stop_route_records, route_uid, direction)
    stops = stop_route.get("Stops", []) if stop_route else []
    stop_by_uid = {
        stop.get("StopUID"): stop
        for stop in stops
        if isinstance(stop, dict) and stop.get("StopUID")
    }
    boarding_stop = stop_by_uid.get(boarding_stop_uid)
    boarding_sequence = boarding_stop.get("StopSequence") if boarding_stop else None

    approaching = [
        record
        for record in realtime_records
        if record.get("RouteUID") == route_uid
        and record.get("Direction") == direction
        and isinstance(record.get("PlateNumb"), str)
    ]
    if isinstance(boarding_sequence, int):
        before_boarding = [
            record
            for record in approaching
            if isinstance(record.get("StopSequence"), int)
            and record["StopSequence"] <= boarding_sequence
        ]
        if before_boarding:
            approaching = sorted(before_boarding, key=lambda record: boarding_sequence - record["StopSequence"])

    vehicle = approaching[0] if approaching else None
    vehicle_stop = stop_by_uid.get(vehicle.get("StopUID")) if vehicle else None
    position = _stop_position(vehicle_stop or {})
    if position is None:
        position = _stop_position(boarding_stop or {}) or demo["boarding_position"]

    demo_vehicle = demo["demo_vehicle"]
    plate_number = vehicle.get("PlateNumb") if vehicle else demo_vehicle["plate_number"]
    eta_seconds = int(estimate_seconds) if eta_is_live else int(demo_vehicle["eta_seconds"])
    timing_source = "tdx_live" if eta_is_live else "demo_simulation"
    position_source = "tdx_a2" if vehicle and vehicle_stop else "demo_simulation"
    data_mode = "tdx_live_with_accessibility_simulation" if eta_is_live or vehicle else "demo_fallback"

    notices = [
        "TDX 未提供低地板與輪椅斜坡板車輛欄位；此兩項為 MVP 模擬登錄。"
    ]
    if not eta_is_live:
        notices.append("目前上車站沒有可用的 TDX 即時 ETA，顯示示範倒數。")
    if live_error:
        notices.append("TDX 暫時無法連線，已使用離線示範資料。")

    return {
        "route_name": route_name,
        "route_uid": route_uid,
        "direction": direction,
        "boarding_stop_uid": boarding_stop_uid,
        "boarding_stop_name": _stop_name(boarding_stop or {}) or demo["boarding_stop_name"],
        "generated_at": _now_iso(),
        "data_mode": data_mode,
        "notices": notices,
        "arrivals": [
            {
                "vehicle_id": f"{route_uid}-{plate_number}",
                "plate_number": plate_number,
                "eta_seconds": eta_seconds,
                "position": position,
                "current_stop_uid": vehicle.get("StopUID") if vehicle else None,
                "current_stop_name": _stop_name(vehicle or {}),
                "is_low_floor": bool(demo_vehicle["is_low_floor"]),
                "has_ramp": bool(demo_vehicle["has_ramp"]),
                "suitable_for_wheelchair": bool(
                    demo_vehicle["is_low_floor"] and demo_vehicle["has_ramp"]
                ),
                "timing_source": timing_source,
                "position_source": position_source,
                "accessibility_source": "demo_simulation",
                "gps_time": vehicle.get("GPSTime") if vehicle else None,
            }
        ],
    }


def load_transit_arrivals(
    route_name: str,
    route_uid: str,
    direction: int,
    boarding_stop_uid: str,
    force_refresh: bool = False,
) -> dict[str, Any]:
    key = (route_name, route_uid, direction, boarding_stop_uid)
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(key)
        if not force_refresh and cached and cached[1] > now:
            return cached[0]

    snapshot = _build_snapshot(route_name, route_uid, direction, boarding_stop_uid)
    with _cache_lock:
        _cache[key] = (snapshot, now + CACHE_TTL_SECONDS)
    return snapshot

"""Small timetable-driven traffic scene inspired by mini-tokyo-3d.

The reference project separates timetable objects, a simulation clock and the
rendering layer.  This module does the same at MVP scale and returns a compact
scene contract for Google Maps 3D:

* Metro vehicles are interpolated between BL12--BL18 using official TDX
  station departure timetables.
* Bus vehicles use TDX A2 stop positions when available; otherwise official
  TDX headways drive interpolation over the official route shape.
* One upcoming vehicle can be marked as the route's target.

The scene contains provenance per object.  Schedule interpolation is never
labelled as a real-time vehicle position.
"""

from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from ..engine.plan import load_corridor
from ..models import LatLngPoint
from .tdx_arrivals import _request_records, load_transit_arrivals
from .tdx_bus import TDXBusShapeGeometry, _access_token, _credentials, _ssl_context


METRO_TIMETABLE_URL = (
    "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC"
    "?%24filter=LineID%20eq%20%27BL%27&%24format=JSON"
)
DEMO_PATH = Path(__file__).resolve().parents[1] / "data" / "transit_demo.json"
# Taiwan has no daylight-saving time; a fixed offset avoids the optional
# ``tzdata`` package dependency on Windows/Cloud Run slim images.
TAIPEI_TZ = timezone(timedelta(hours=8), name="Asia/Taipei")
SCENE_CACHE_SECONDS = 10
STATIC_CACHE_SECONDS = 30 * 60

_cache_lock = threading.Lock()
_scene_cache: dict[str, tuple[dict[str, Any], float]] = {}
_static_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}


def _now_taipei() -> datetime:
    return datetime.now(TAIPEI_TZ)


def _time_seconds(value: str) -> int:
    hours, minutes = (int(part) for part in value.split(":", 1))
    result = hours * 3600 + minutes * 60
    # Transit service days conventionally continue past midnight.
    return result + (86400 if hours < 3 else 0)


def _clock_seconds(now: datetime) -> int:
    result = now.hour * 3600 + now.minute * 60 + now.second
    return result + (86400 if now.hour < 3 else 0)


def _format_clock(seconds: int) -> str:
    seconds %= 86400
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _day_key(now: datetime) -> str:
    return ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")[
        now.weekday()
    ]


def _service_active(service_day: Any, day_key: str) -> bool:
    return isinstance(service_day, dict) and bool(service_day.get(day_key))


def _fetch_metro_timetables(client_id: str, client_secret: str) -> list[dict[str, Any]]:
    now = time.monotonic()
    with _cache_lock:
        cached = _static_cache.get("metro-BL")
        if cached and cached[1] > now:
            return cached[0]

    token = _access_token(client_id, client_secret)
    request = Request(
        METRO_TIMETABLE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "TaipeiPulse/0.1 traffic-scene",
        },
    )
    with urlopen(request, timeout=12, context=_ssl_context()) as response:
        body = json.load(response)
    records = [record for record in body if isinstance(record, dict)] if isinstance(body, list) else []
    with _cache_lock:
        _static_cache["metro-BL"] = (records, now + STATIC_CACHE_SECONDS)
    return records


def _cached_bus_records(
    endpoint: str,
    route_name: str,
    client_id: str,
    client_secret: str,
    ttl: int,
) -> list[dict[str, Any]]:
    key = f"bus:{endpoint}:{route_name}"
    now = time.monotonic()
    with _cache_lock:
        cached = _static_cache.get(key)
        if cached and cached[1] > now:
            return cached[0]
    records = _request_records(endpoint, route_name, client_id, client_secret)
    with _cache_lock:
        _static_cache[key] = (records, now + ttl)
    return records


def _point_on_path(path: list[LatLngPoint], progress: float) -> LatLngPoint:
    if not path:
        return LatLngPoint(lat=0, lng=0)
    if len(path) == 1:
        return path[0]
    progress = min(1.0, max(0.0, progress))
    lengths: list[float] = []
    total = 0.0
    for left, right in zip(path, path[1:]):
        dy = (right.lat - left.lat) * 110_540
        dx = (right.lng - left.lng) * 101_300
        length = math.hypot(dx, dy)
        lengths.append(length)
        total += length
    target = total * progress
    walked = 0.0
    for index, length in enumerate(lengths):
        if walked + length >= target or index == len(lengths) - 1:
            ratio = 0.0 if length == 0 else (target - walked) / length
            left, right = path[index], path[index + 1]
            return LatLngPoint(
                lat=left.lat + (right.lat - left.lat) * ratio,
                lng=left.lng + (right.lng - left.lng) * ratio,
            )
        walked += length
    return path[-1]


def _bearing(path: list[LatLngPoint], progress: float) -> float:
    here = _point_on_path(path, progress)
    ahead = _point_on_path(path, min(1.0, progress + 0.01))
    lat1, lat2 = math.radians(here.lat), math.radians(ahead.lat)
    delta_lng = math.radians(ahead.lng - here.lng)
    y = math.sin(delta_lng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(delta_lng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _metro_station_positions() -> dict[str, LatLngPoint]:
    corridor = load_corridor()
    return {
        station["id"]: LatLngPoint(**station["position"])
        for station in corridor.get("stations", [])
        if station.get("line") == "BL" and "BL12" <= station.get("id", "") <= "BL18"
    }


def _metro_station_names() -> dict[str, str]:
    corridor = load_corridor()
    return {
        station["id"]: station["name"]
        for station in corridor.get("stations", [])
        if station.get("line") == "BL" and station.get("id") and station.get("name")
    }


def _station_times(
    records: list[dict[str, Any]], day_key: str, direction: int
) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for record in records:
        station_id = record.get("StationID")
        if (
            record.get("LineID") != "BL"
            or record.get("Direction") != direction
            or not isinstance(station_id, str)
            or not "BL12" <= station_id <= "BL18"
            or not _service_active(record.get("ServiceDay"), day_key)
        ):
            continue
        times = [
            _time_seconds(item["DepartureTime"])
            for item in record.get("Timetables", [])
            if isinstance(item, dict) and item.get("DepartureTime")
        ]
        if len(times) > len(result.get(station_id, [])):
            result[station_id] = sorted(times)
    return result


def _build_metro_trips(
    station_times: dict[str, list[int]], order: list[str]
) -> list[tuple[list[str], list[int]]]:
    if not order or not station_times.get(order[0]):
        return []
    trips: list[tuple[list[str], list[int]]] = []
    for departure in station_times[order[0]]:
        times = [departure]
        valid = True
        previous = departure
        for station_id in order[1:]:
            candidates = [
                value
                for value in station_times.get(station_id, [])
                if previous + 45 <= value <= previous + 300
            ]
            if not candidates:
                valid = False
                break
            previous = min(candidates)
            times.append(previous)
        if valid:
            trips.append((order, times))
    return trips


def _metro_vehicles(
    records: list[dict[str, Any]],
    day_key: str,
    clock: int,
    target: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    positions = _metro_station_positions()
    station_names = _metro_station_names()
    vehicles: list[dict[str, Any]] = []
    trips_by_direction: dict[int, list[tuple[list[str], list[int]]]] = {}
    for direction, order in ((0, list(positions)), (1, list(reversed(list(positions))))):
        trips = _build_metro_trips(_station_times(records, day_key, direction), order)
        trips_by_direction[direction] = trips
        for stations, times in trips:
            if not (times[0] <= clock <= times[-1]):
                continue
            for index in range(len(times) - 1):
                if times[index] <= clock <= times[index + 1]:
                    duration = max(1, times[index + 1] - times[index])
                    progress = (clock - times[index]) / duration
                    path = [positions[stations[index]], positions[stations[index + 1]]]
                    vehicle_id = f"metro-BL-{direction}-{times[0]}"
                    vehicles.append(
                        {
                            "vehicle_id": vehicle_id,
                            "mode": "metro",
                            "route_name": "板南線",
                            "route_uid": "BL",
                            "direction": direction,
                            "label": f"板南線 {vehicle_id[-5:]}",
                            "position": _point_on_path(path, progress).model_dump(),
                            "path": [point.model_dump() for point in path],
                            "progress": progress,
                            "segment_duration_seconds": duration,
                            "bearing": _bearing(path, progress),
                            "next_stop_name": station_names.get(stations[index + 1], stations[index + 1]),
                            "destination_name": station_names.get(stations[-1], stations[-1]),
                            "eta_seconds": max(0, times[index + 1] - clock),
                            "scheduled_time": _format_clock(times[index + 1]),
                            "source": "tdx_station_timetable",
                            "is_target": False,
                            "suitable_for_wheelchair": True,
                            "accessibility_source": "metro_policy",
                        }
                    )
                    break

    if target and target.get("mode") == "metro":
        direction = int(target.get("direction", 0))
        boarding = target.get("boarding_stop_uid")
        trips = trips_by_direction.get(direction, [])
        candidates = [trip for trip in trips if boarding in trip[0]]
        future: list[tuple[int, tuple[list[str], list[int]]]] = []
        for trip in candidates:
            index = trip[0].index(boarding)
            departure = trip[1][index]
            if departure >= clock:
                future.append((departure, trip))
        if future:
            departure, trip = min(future, key=lambda item: item[0])
            index = trip[0].index(boarding)
            next_index = min(index + 1, len(trip[0]) - 1)
            path = [positions[boarding], positions[trip[0][next_index]]]
            vehicles.append(
                {
                    "vehicle_id": f"target-metro-BL-{direction}-{departure}",
                    "mode": "metro",
                    "route_name": "板南線",
                    "route_uid": "BL",
                    "direction": direction,
                    "label": "目標捷運 · 板南線",
                    "position": positions[boarding].model_dump(),
                    "path": [point.model_dump() for point in path],
                    "progress": 0.0,
                    "segment_duration_seconds": max(1, departure - clock),
                    "bearing": _bearing(path, 0),
                    "next_stop_name": station_names.get(trip[0][next_index], trip[0][next_index]),
                    "destination_name": station_names.get(trip[0][-1], trip[0][-1]),
                    "eta_seconds": departure - clock,
                    "scheduled_time": _format_clock(departure),
                    "source": "tdx_station_timetable",
                    "is_target": True,
                    "suitable_for_wheelchair": True,
                    "accessibility_source": "metro_policy",
                }
            )
    return vehicles


def _load_route_configs() -> list[dict[str, Any]]:
    return json.loads(DEMO_PATH.read_text(encoding="utf-8")).get("routes", [])


def _frequency_headway(
    schedules: list[dict[str, Any]], config: dict[str, Any], day_key: str, clock: int
) -> tuple[int, int]:
    records = [record for record in schedules if record.get("RouteUID") == config["route_uid"]]
    exact = [record for record in records if record.get("Direction") == config["direction"]]
    record = (exact or records or [{}])[0]
    for frequency in record.get("Frequencys", []):
        if not _service_active(frequency.get("ServiceDay"), day_key):
            continue
        start = _time_seconds(frequency["StartTime"])
        end = _time_seconds(frequency["EndTime"])
        if start <= clock <= end:
            headway = round(
                (float(frequency.get("MinHeadwayMins", 8)) + float(frequency.get("MaxHeadwayMins", 8)))
                / 2
                * 60
            )
            return start, max(180, headway)
    return 6 * 3600, 8 * 60


def _bus_path(config: dict[str, Any]) -> list[LatLngPoint]:
    points = [
        LatLngPoint(**config["boarding_position"]),
        LatLngPoint(**config["alighting_position"]),
    ]
    return (
        TDXBusShapeGeometry().route(
            config["route_name"], points, config["route_uid"], config["direction"]
        )
        or points
    )


def _bus_vehicles(
    client_id: str,
    client_secret: str,
    configs: list[dict[str, Any]],
    day_key: str,
    clock: int,
    target: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    vehicles: list[dict[str, Any]] = []
    for config in configs:
        path = _bus_path(config)
        try:
            schedules = _cached_bus_records(
                "Schedule", config["route_name"], client_id, client_secret, STATIC_CACHE_SECONDS
            )
        except Exception:
            schedules = []
        start, headway = _frequency_headway(schedules, config, day_key, clock)
        duration = int(config["corridor_trip_seconds"])
        latest_slot = math.floor((clock - start) / headway)
        for slot in range(latest_slot, latest_slot - 5, -1):
            departure = start + slot * headway
            if departure < 0 or not departure <= clock <= departure + duration:
                continue
            progress = (clock - departure) / duration
            position = _point_on_path(path, progress)
            vehicles.append(
                {
                    "vehicle_id": f"bus-{config['route_uid']}-{config['direction']}-{departure}",
                    "mode": "bus",
                    "route_name": config["route_name"],
                    "route_uid": config["route_uid"],
                    "direction": config["direction"],
                    "label": config["route_name"],
                    "position": position.model_dump(),
                    "path": [point.model_dump() for point in path],
                    "progress": progress,
                    "segment_duration_seconds": duration,
                    "bearing": _bearing(path, progress),
                    "next_stop_name": config.get("boarding_stop_name"),
                    "destination_name": "路線示範終點",
                    "eta_seconds": round((1 - progress) * duration),
                    "scheduled_time": _format_clock(departure),
                    "source": "tdx_schedule_interpolation" if schedules else "demo_schedule_interpolation",
                    "is_target": False,
                    "plate_number": None,
                    "suitable_for_wheelchair": None,
                    "accessibility_source": "unknown",
                }
            )

    if target and target.get("mode") == "bus":
        matching = next(
            (
                config
                for config in configs
                if config["route_uid"] == target.get("route_uid")
                and config["direction"] == target.get("direction")
            ),
            None,
        )
        if matching:
            snapshot = load_transit_arrivals(
                matching["route_name"],
                matching["route_uid"],
                matching["direction"],
                target.get("boarding_stop_uid") or matching["boarding_stop_uid"],
            )
            arrival = snapshot["arrivals"][0]
            position = LatLngPoint(**arrival["position"])
            vehicles.append(
                {
                    "vehicle_id": f"target-{arrival['vehicle_id']}",
                    "mode": "bus",
                    "route_name": matching["route_name"],
                    "route_uid": matching["route_uid"],
                    "direction": matching["direction"],
                    "label": f"目標公車 · {matching['route_name']}",
                    "position": position.model_dump(),
                    "path": [position.model_dump(), position.model_dump()],
                    "progress": 0.0,
                    "segment_duration_seconds": max(1, arrival["eta_seconds"]),
                    "bearing": 0,
                    "next_stop_name": snapshot["boarding_stop_name"],
                    "destination_name": "你的上車站",
                    "eta_seconds": arrival["eta_seconds"],
                    "scheduled_time": _format_clock(clock + arrival["eta_seconds"]),
                    "source": arrival["position_source"],
                    "is_target": True,
                    "plate_number": arrival["plate_number"],
                    "suitable_for_wheelchair": arrival["suitable_for_wheelchair"],
                    "accessibility_source": arrival["accessibility_source"],
                }
            )
    return vehicles


def _scene_key(target: dict[str, Any] | None) -> str:
    return json.dumps(target or {}, sort_keys=True, ensure_ascii=True)


def load_traffic_scene(target: dict[str, Any] | None = None, force_refresh: bool = False) -> dict[str, Any]:
    key = _scene_key(target)
    now_monotonic = time.monotonic()
    with _cache_lock:
        cached = _scene_cache.get(key)
        if not force_refresh and cached and cached[1] > now_monotonic:
            return cached[0]

    now = _now_taipei()
    day_key = _day_key(now)
    real_clock = _clock_seconds(now)
    client_id, client_secret = _credentials()
    notices: list[str] = []
    metro_records: list[dict[str, Any]] = []
    if client_id and client_secret:
        try:
            metro_records = _fetch_metro_timetables(client_id, client_secret)
        except Exception:
            notices.append("TDX 捷運時刻表暫時不可用，捷運物件已隱藏。")

    clock = real_clock
    metro = _metro_vehicles(metro_records, day_key, clock, target)
    clock_mode = "realtime"
    if not metro_records or not metro:
        # Like mini-tokyo-3d playback mode: keep the scheduled scene useful
        # outside service hours without pretending the clock is live.
        clock = 14 * 3600 + 10 * 60 + now.second
        metro = _metro_vehicles(metro_records, day_key, clock, target)
        clock_mode = "schedule_playback"
        notices.append("目前不在可呈現班次區間，交通物件使用 14:10 時刻表回放。")

    # The renderer stays demonstrable without credentials. In that case the
    # bus builder falls back to the checked-in corridor endpoints and labels
    # every object as demo_schedule_interpolation.
    buses = _bus_vehicles(
        client_id, client_secret, _load_route_configs(), day_key, clock, target
    )
    if not (client_id and client_secret):
        notices.append("TDX 憑證未設定，公車物件使用 Demo 時刻表與示意路徑。")

    # Never truncate the vehicle the user is meant to board. Background
    # traffic is deliberately capped to keep Google Maps 3D readable.
    targets = [vehicle for vehicle in metro + buses if vehicle["is_target"]]
    metro_background = [vehicle for vehicle in metro if not vehicle["is_target"]][:6]
    bus_background = [vehicle for vehicle in buses if not vehicle["is_target"]][:8]

    scene = {
        "generated_at": now.isoformat(),
        "clock_time": _format_clock(clock),
        "clock_mode": clock_mode,
        "timezone": "Asia/Taipei",
        "notices": notices,
        "vehicles": targets + metro_background + bus_background,
    }
    with _cache_lock:
        _scene_cache[key] = (scene, now_monotonic + SCENE_CACHE_SECONDS)
    return scene

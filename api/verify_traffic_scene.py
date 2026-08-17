"""Deterministic checks for the timetable-driven traffic scene (no network)."""

from datetime import datetime
from unittest.mock import patch

from app.data_sources.tdx_traffic_scene import (
    TAIPEI_TZ,
    _bus_vehicles,
    _load_route_configs,
    _metro_vehicles,
)
from app.models import TrafficSceneSnapshot


def hhmm(seconds: int) -> str:
    seconds %= 86400
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"


clock = 14 * 3600 + 10 * 60
stations = [f"BL{number}" for number in range(12, 19)]
records = []
for index, station in enumerate(stations):
    records.append(
        {
            "LineID": "BL",
            "StationID": station,
            "Direction": 0,
            "ServiceDay": {"Tuesday": True},
            "Timetables": [
                {"DepartureTime": hhmm(clock - 180 + index * 90)},
                {"DepartureTime": hhmm(clock + 120 + index * 90)},
            ],
        }
    )

metro = _metro_vehicles(
    records,
    "Tuesday",
    clock,
    {"mode": "metro", "direction": 0, "boarding_stop_uid": "BL12"},
)
assert any(vehicle["mode"] == "metro" and not vehicle["is_target"] for vehicle in metro)
target_metro = next(vehicle for vehicle in metro if vehicle["is_target"])
assert target_metro["next_stop_name"] == "善導寺"
assert target_metro["source"] == "tdx_station_timetable"

configs = _load_route_configs()
schedule = [
    {
        "RouteUID": config["route_uid"],
        "Direction": config["direction"],
        "Frequencys": [
            {
                "StartTime": "06:00",
                "EndTime": "23:59",
                "MinHeadwayMins": 8,
                "MaxHeadwayMins": 8,
                "ServiceDay": {"Tuesday": True},
            }
        ],
    }
    for config in configs
]
arrival_snapshot = {
    "boarding_stop_name": "臺北車站（青島）",
    "arrivals": [
        {
            "vehicle_id": "demo-target",
            "plate_number": "EAL-1662",
            "eta_seconds": 240,
            "position": configs[0]["boarding_position"],
            "position_source": "demo_simulation",
            "suitable_for_wheelchair": True,
            "accessibility_source": "demo_vehicle_registry",
        }
    ],
}

with (
    patch(
        "app.data_sources.tdx_traffic_scene.TDXBusShapeGeometry.route",
        side_effect=lambda _name, points, _uid, _direction: points,
    ),
    patch(
        "app.data_sources.tdx_traffic_scene._cached_bus_records",
        return_value=schedule,
    ),
    patch(
        "app.data_sources.tdx_traffic_scene.load_transit_arrivals",
        return_value=arrival_snapshot,
    ),
):
    buses = _bus_vehicles(
        "demo-id",
        "demo-secret",
        configs,
        "Tuesday",
        clock,
        {
            "mode": "bus",
            "route_uid": configs[0]["route_uid"],
            "direction": configs[0]["direction"],
            "boarding_stop_uid": configs[0]["boarding_stop_uid"],
        },
    )

assert any(vehicle["source"] == "tdx_schedule_interpolation" for vehicle in buses)
target_bus = next(vehicle for vehicle in buses if vehicle["is_target"])
assert target_bus["plate_number"] == "EAL-1662"
assert target_bus["suitable_for_wheelchair"] is True

snapshot = TrafficSceneSnapshot.model_validate(
    {
        "generated_at": datetime.now(TAIPEI_TZ).isoformat(),
        "clock_time": "14:10:00",
        "clock_mode": "schedule_playback",
        "timezone": "Asia/Taipei",
        "notices": [],
        "vehicles": metro + buses,
    }
)
assert len(snapshot.vehicles) == len(metro) + len(buses)
print(
    "traffic scene OK:",
    len([vehicle for vehicle in snapshot.vehicles if vehicle.mode == "metro"]),
    "metro,",
    len([vehicle for vehicle in snapshot.vehicles if vehicle.mode == "bus"]),
    "bus, targets preserved",
)

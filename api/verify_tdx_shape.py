"""Verify TDX WKT parsing and, when configured, both demo bus shapes."""

from __future__ import annotations

import json
import math
from pathlib import Path

from app.data_sources.tdx_bus import TDXBusShapeGeometry, parse_wkt_lines
from app.models import LatLngPoint


ROOT = Path(__file__).resolve().parent


def _point(corridor: dict, point_id: str) -> LatLngPoint:
    return LatLngPoint(**corridor["landmarks"][point_id]["position"])


def _distance_meters(a: LatLngPoint, b: LatLngPoint) -> float:
    dy = (a.lat - b.lat) * 110_540
    dx = (a.lng - b.lng) * 111_320 * math.cos(math.radians((a.lat + b.lat) / 2))
    return math.hypot(dx, dy)


def verify_parser() -> None:
    line = parse_wkt_lines("LINESTRING (121.50 25.01, 121.51 25.02)")
    assert len(line) == 1 and len(line[0]) == 2
    assert line[0][0].lat == 25.01 and line[0][0].lng == 121.50

    multi = parse_wkt_lines(
        "MULTILINESTRING ((121.50 25.01, 121.51 25.02),"
        "(121.52 25.03, 121.53 25.04, 121.54 25.05))"
    )
    assert [len(component) for component in multi] == [2, 3]
    print("[OK] WKT LINESTRING / MULTILINESTRING parser")


def verify_live() -> None:
    client = TDXBusShapeGeometry()
    if not client.enabled:
        print("[SKIP] TDX credentials not configured; parser-only verification completed")
        return

    candidates = json.loads((ROOT / "app" / "data" / "candidates.json").read_text(encoding="utf-8"))
    corridor = json.loads((ROOT / "app" / "data" / "corridor.json").read_text(encoding="utf-8"))

    checked = 0
    for query in candidates["queries"]:
        for candidate in query["candidates"]:
            for leg in candidate["legs"]:
                if leg.get("mode") != "bus":
                    continue
                points = [_point(corridor, point_id) for point_id in leg["waypoints"]]
                path = client.route(
                    leg["tdx_route_name"],
                    points,
                    leg.get("tdx_route_uid"),
                    leg.get("tdx_direction"),
                )
                assert path is not None and len(path) >= 10, leg["name"]
                endpoint_error = _distance_meters(points[0], path[0]) + _distance_meters(
                    points[-1], path[-1]
                )
                assert endpoint_error < 500, f"{leg['name']} endpoint error {endpoint_error:.0f}m"
                print(
                    f"[OK] {leg['name']}: route_uid={leg['tdx_route_uid']} "
                    f"direction={leg['tdx_direction']} points={len(path)} "
                    f"endpoint_error={endpoint_error:.0f}m"
                )
                checked += 1
    assert checked == 2, f"expected 2 bus legs, got {checked}"


def main() -> int:
    verify_parser()
    verify_live()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

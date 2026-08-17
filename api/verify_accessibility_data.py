"""Offline regression checks for Taipei accessibility data adapters."""

from __future__ import annotations

import json

from app.data_sources.accessibility import (
    _load_fallback,
    parse_metro_elevators,
    parse_metro_outages,
    parse_wheelroute,
)


def main() -> int:
    wheelroute = json.dumps(
        [
            {"kind": "7", "kname": "台北車站M4-M4", "lon": "121.517345", "lat": "25.046485", "width": -1, "slope": -1},
            {"kind": "7", "kname": "invalid", "lon": "118.7", "lat": "0", "width": 0, "slope": 0},
        ],
        ensure_ascii=False,
    ).encode("utf-8")
    elevators = (
        "項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度\r\n"
        "41,台北車站出口電梯1,M2,121.5186428,25.0482356\r\n"
    ).encode("cp950")
    outages = (
        "項次,日期時間,路線,車站,說明\r\n"
        "2,20260815T060000,板南線,台北車站,出口電梯已開放使用\r\n"
    ).encode("cp950")

    parsed_wheelroute = parse_wheelroute(wheelroute, 7)
    parsed_elevators = parse_metro_elevators(elevators)
    parsed_outages = parse_metro_outages(outages)
    fallback = _load_fallback()

    assert len(parsed_wheelroute) == 1
    assert parsed_wheelroute[0]["name"] == "台北車站M4-M4"
    assert parsed_elevators[0]["exit"] == "M2"
    assert parsed_outages[0]["status"] == "resolved"
    assert fallback["facilities"]
    assert all(facility["source_id"] for facility in fallback["facilities"])
    assert all(source["page_url"].startswith("https://data.taipei/") for source in fallback["sources"])

    print(f"WheelRoute parser: {len(parsed_wheelroute)} corridor record")
    print(f"Metro elevator parser: {len(parsed_elevators)} CP950 record")
    print(f"Metro outage parser: {len(parsed_outages)} resolved notice")
    print(f"Offline fallback: {len(fallback['facilities'])} verified facilities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

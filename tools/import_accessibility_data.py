"""把政府開放資料整理成 Taipei Pulse 可直接使用的輕量資料包。

原始資料刻意不複製進 repository：2-5、2-6 合計超過 30 MB，而且 3D 地圖
不應一次載入全臺北市的數萬個圖徵。本工具只保留板南線示範走廊附近、會參與
畫面或路線評估的資料；輸出同時供 API 與前端離線使用。
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# 台北車站到市政府示範走廊，四周各留約 1 公里供步行繞路。
CORRIDOR_BOUNDS = {
    "west": 121.505,
    "south": 25.028,
    "east": 121.579,
    "north": 25.058,
}


def twd97_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """EPSG:3826 (TWD97 / TM2 zone 121) 轉成 WGS84 經緯度。

    使用 Transverse Mercator 反算式；台北市範圍的輸出足以支援公尺級鄰近查詢。
    """

    a = 6378137.0
    b = 6356752.314245
    lon0 = math.radians(121.0)
    k0 = 0.9999
    dx = 250000.0
    e = math.sqrt(1.0 - (b / a) ** 2)
    e2 = e * e / (1.0 - e * e)
    x -= dx
    m = y / k0
    mu = m / (a * (1 - e**2 / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))
    fp = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )
    sin_fp = math.sin(fp)
    cos_fp = math.cos(fp)
    tan_fp = math.tan(fp)
    c1 = e2 * cos_fp**2
    t1 = tan_fp**2
    r1 = a * (1 - e**2) / (1 - e**2 * sin_fp**2) ** 1.5
    n1 = a / math.sqrt(1 - e**2 * sin_fp**2)
    d = x / (n1 * k0)
    lat = fp - (n1 * tan_fp / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e2 - 3 * c1**2)
        * d**6
        / 720
    )
    lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e2 + 24 * t1**2)
        * d**5
        / 120
    ) / cos_fp
    return math.degrees(lat), math.degrees(lon)


def in_corridor(lat: float, lng: float) -> bool:
    return (
        CORRIDOR_BOUNDS["south"] <= lat <= CORRIDOR_BOUNDS["north"]
        and CORRIDOR_BOUNDS["west"] <= lng <= CORRIDOR_BOUNDS["east"]
    )


def read_csv(source: Path, prefix: str) -> list[dict[str, str]]:
    path = next(source.glob(f"{prefix}_*.csv"))
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def station_key(name: str) -> str:
    return name.replace("臺北", "台北").removesuffix("站").strip()


def build_bundle(source: Path, public_toilets_csv: Path | None = None) -> dict:
    metro_exits = []
    for row in read_csv(source, "2-1"):
        metro_exits.append(
            {
                "id": f"exit-{row['項次']}",
                "kind": "metro_exit",
                "name": row["出入口名稱"],
                "exit": row["出入口編號"],
                "lat": round(float(row["緯度"]), 7),
                "lng": round(float(row["經度"]), 7),
                "accessible": row["是否為無障礙用"].strip() == "是",
            }
        )

    station_rows = read_csv(source, "2-2")
    location_rows = read_csv(source, "2-4")
    locations = {station_key(row["車站名稱"]): row for row in location_rows}

    station_details = []
    for row in station_rows:
        key = station_key(row["Station_Name"])
        location = locations.get(key)
        station_details.append(
            {
                "stationName": row["Station_Name"],
                "stationNumber": row["Station_Number"],
                "line": row["Line"],
                "form": row["Station_Form"],
                "accessibleExits": row["Elevator_and_Wheelchair_Ramps"],
                "accessibleRestrooms": row["Toilet_Facilities_for_Disabled"],
                "tactileGuidePath": row["Tactile_Guide_Paths_quantity"],
                "elevatorLocation": location["電梯位置"] if location else "",
                "updatedAt": location["更新日期"] if location else "",
            }
        )

    detail_by_key = {station_key(row["stationName"]): row for row in station_details}
    metro_access_points = []
    for row in read_csv(source, "2-3"):
        name = row["出入口電梯/無障礙坡道名稱"]
        matching_key = max(
            (key for key in detail_by_key if key in name),
            key=len,
            default="",
        )
        detail = detail_by_key.get(matching_key)
        metro_access_points.append(
            {
                "id": f"metro-{row['項次']}",
                "kind": "metro_access",
                "name": name,
                "exit": row["出入口編號"],
                "lat": round(float(row["緯度"]), 7),
                "lng": round(float(row["經度"]), 7),
                "stationName": detail["stationName"] if detail else "",
                "stationNumber": detail["stationNumber"] if detail else "",
                "accessibleRestrooms": detail["accessibleRestrooms"] if detail else "",
                "elevatorLocation": detail["elevatorLocation"] if detail else "",
            }
        )

    ramp_path = source / "2-5_TP_Ramp.json"
    ramps_raw = json.loads(ramp_path.read_text(encoding="utf-8"))["features"]
    curb_ramps = []
    for feature in ramps_raw:
        # geometry 是逐點實際位置；properties.X/Y 在原始資料尾端有群組重複值。
        x, y = feature["geometry"]["coordinates"]
        lat, lng = twd97_to_wgs84(float(x), float(y))
        if in_corridor(lat, lng):
            curb_ramps.append(
                {
                    "id": f"ramp-{feature['properties']['OBJECTID']}",
                    "kind": "curb_ramp",
                    "name": "路緣無障礙斜坡道",
                    "district": feature["properties"].get("Town_N", ""),
                    "lat": round(lat, 7),
                    "lng": round(lng, 7),
                }
            )

    public_toilets = []
    if public_toilets_csv:
        with public_toilets_csv.open(encoding="utf-8-sig", newline="") as handle:
            for index, row in enumerate(csv.DictReader(handle), start=1):
                try:
                    lat = float(row["緯度"])
                    lng = float(row["經度"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not in_corridor(lat, lng):
                    continue
                accessible_count = int(float(row.get("無障礙廁座數", "0") or 0))
                public_toilets.append(
                    {
                        "id": f"toilet-{index}",
                        "kind": "public_toilet",
                        "name": row.get("公廁名稱", "公共廁所").strip(),
                        "category": row.get("公廁類別", "").strip(),
                        "address": row.get("公廁地址", "").strip(),
                        "lat": round(lat, 7),
                        "lng": round(lng, 7),
                        "accessible": accessible_count > 0,
                        "accessibleCount": accessible_count,
                    }
                )

    return {
        "meta": {
            "generatedFrom": "Taipei City Government open data snapshots",
            "scope": "板南線台北車站至市政府示範走廊",
            "crs": "WGS84 (EPSG:4326)",
            "sourceCounts": {
                "metroExits": len(metro_exits),
                "metroAccessPoints": len(metro_access_points),
                "stationDetails": len(station_details),
                "curbRamps": len(ramps_raw),
                "publicToilets": len(public_toilets),
            },
            "bundledCounts": {
                "metroExits": len(metro_exits),
                "metroAccessPoints": len(metro_access_points),
                "stationDetails": len(station_details),
                "curbRamps": len(curb_ramps),
                "publicToilets": len(public_toilets),
            },
            "notes": [
                "捷運點位使用原始 WGS84 座標。",
                "路緣坡道使用 geometry.coordinates，轉換自 EPSG:3826。",
                "路緣坡道只保留示範走廊附近；其存在僅作加分證據，不作可通行保證。",
                "公廁依無障礙廁座數區分一般公廁與設有無障礙廁位的公廁。",
            ],
        },
        "metroExits": metro_exits,
        "metroAccessPoints": metro_access_points,
        "stationDetails": station_details,
        "curbRamps": curb_ramps,
        "publicToilets": public_toilets,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "source",
        type=Path,
        help="包含原始開放資料的資料夾；請使用本機路徑，不會寫入輸出檔。",
    )
    parser.add_argument("--public-toilets-csv", type=Path)
    args = parser.parse_args()
    bundle = build_bundle(args.source, args.public_toilets_csv)
    encoded = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + "\n"
    targets = [
        ROOT / "api" / "app" / "data" / "accessibility_facilities.json",
        ROOT / "web" / "public" / "data" / "accessibility-facilities.json",
    ]
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(encoded, encoding="utf-8")
        print(f"wrote {target} ({len(encoded):,} bytes)")


if __name__ == "__main__":
    main()

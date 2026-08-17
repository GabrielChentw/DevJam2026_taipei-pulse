"""驗證每個候選路線的每個 leg 都能解析出可畫圖的座標。

前端同事要疊 Polyline3DElement，若有 leg 的 path 是空的，畫面上會出現斷線，
demo 時很容易被看出來。這個腳本把它當回歸測試跑。
"""

from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

from app.engine.plan import load_candidates, plan
from app.models import LatLngPoint, PlanRequest

MAX_JOIN_GAP_METERS = 50


def distance_meters(a: LatLngPoint, b: LatLngPoint) -> float:
    """相鄰 leg 的端點距離；過大代表前端導覽切段時會瞬移。"""
    a_lat = radians(a.lat)
    b_lat = radians(b.lat)
    delta_lat = b_lat - a_lat
    delta_lng = radians(b.lng - a.lng)
    value = sin(delta_lat / 2) ** 2 + cos(a_lat) * cos(b_lat) * sin(delta_lng / 2) ** 2
    return 12_742_000 * asin(sqrt(value))


def main() -> int:
    ok = True

    for query in load_candidates()["queries"]:
        response = plan(
            PlanRequest(
                origin=query["origin"],
                destination=query["destination"],
                profile_id="wheelchair",
                overrides={},
            )
        )
        all_routes = response.feasible + response.excluded

        for route in all_routes:
            for leg in route.legs:
                status = "OK" if leg.path else "MISSING"
                if not leg.path:
                    ok = False
                print(
                    f"[{status:7}] {route.candidate_id:22} leg{leg.index} "
                    f"{leg.mode:5} {leg.name:32} points={len(leg.path)} "
                    f"precision={leg.geometry_precision.value}"
                )

            for previous, current in zip(route.legs, route.legs[1:]):
                if not previous.path or not current.path:
                    continue
                gap = distance_meters(previous.path[-1], current.path[0])
                status = "JOIN" if gap <= MAX_JOIN_GAP_METERS else "GAP"
                if gap > MAX_JOIN_GAP_METERS:
                    ok = False
                print(
                    f"[{status:7}] {route.candidate_id:22} "
                    f"leg{previous.index}->leg{current.index} gap={gap:.1f}m"
                )

    print()
    print(
        "全部 leg 皆有座標，且相鄰路段連續。"
        if ok
        else f"有 leg 缺座標或交界超過 {MAX_JOIN_GAP_METERS}m，前端會畫出斷線或導覽瞬移。"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

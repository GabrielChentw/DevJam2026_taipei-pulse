"""驗證每個候選路線的每個 leg 都能解析出可畫圖的座標。

前端同事要疊 Polyline3DElement，若有 leg 的 path 是空的，畫面上會出現斷線，
demo 時很容易被看出來。這個腳本把它當回歸測試跑。
"""

from __future__ import annotations

from app.engine.plan import load_candidates, plan
from app.models import PlanRequest


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

    print()
    print("全部 leg 皆有座標。" if ok else "有 leg 缺座標，前端會畫出斷線，需修正 corridor.json 的 landmarks 或 waypoints。")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

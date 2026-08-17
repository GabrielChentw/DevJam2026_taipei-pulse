"""驗證評分引擎是否真的產生預期中的差異化結果。

這不是單元測試，是一個看得懂的驗證腳本 —— 它把引擎的判斷攤開印出來，
讓人能確認「輪椅走捷運、視障走公車」是引擎算出來的，不是寫死的。

執行：
    .venv\\Scripts\\python.exe verify_engine.py
"""

from __future__ import annotations

from app.engine.plan import compare, plan
from app.engine.score import label_for
from app.models import PlanRequest

ORIGIN = "台北車站"
DESTINATION = "台北市政府"


def show(profile_id: str) -> None:
    response = plan(PlanRequest(origin=ORIGIN, destination=DESTINATION, profile_id=profile_id))

    print()
    print("=" * 78)
    print(f"  {response.profile_label}  ({profile_id})")
    print("=" * 78)
    print(response.summary)

    print()
    print(f"--- 可行路線 {len(response.feasible)} 條（分數越低越好）---")
    for i, route in enumerate(response.feasible, 1):
        tag = f"[{route.recommendation_tag}] " if route.recommendation_tag else ""
        print(f"\n{i}. {tag}{route.label}")
        print(f"   分數 {route.score:.1f} | {route.duration_min:.0f} 分鐘 | "
              f"步行 {route.total_walk_meters:.0f}m | 轉乘 {route.transfers} 次")
        print(f"   {route.explanation}")
        for item in route.breakdown[:4]:
            print(f"     - {label_for(item.feature):<12} {item.raw_value:>7.1f} × {item.weight:<5g} = {item.contribution:>6.1f}")
        for warning in route.warnings:
            print(f"     ! {warning.message}")

    print()
    print(f"--- 被排除 {len(response.excluded)} 條 ---")
    for route in response.excluded:
        print(f"\n  x {route.label}  ({route.duration_min:.0f} 分鐘)")
        print(f"    {route.explanation}")
        for violation in route.violations:
            flag = " [資料缺漏]" if violation.caused_by_missing_data else ""
            print(f"      · {violation.rule_feature}{flag}")


def main() -> int:
    for profile_id in ("wheelchair", "low_vision", "elderly"):
        show(profile_id)

    result = compare(ORIGIN, DESTINATION, ["wheelchair", "low_vision"])
    print()
    print("=" * 78)
    print("  差異化驗證")
    print("=" * 78)
    print(result.divergence)

    # 這是本專案的核心主張，用斷言把它固定住。
    wheelchair = result.results["wheelchair"]
    low_vision = result.results["low_vision"]

    print()
    checks: list[tuple[str, bool]] = []

    checks.append(("輪椅有可行路線", bool(wheelchair.feasible)))
    checks.append(("視障有可行路線", bool(low_vision.feasible)))

    if wheelchair.feasible and low_vision.feasible:
        top_w = wheelchair.feasible[0].candidate_id
        top_v = low_vision.feasible[0].candidate_id
        print(f"輪椅首選：{top_w}")
        print(f"視障首選：{top_v}")
        checks.append(("兩者首選不同（核心主張）", top_w != top_v))

    stairs_excluded = any(
        r.candidate_id == "metro-direct-exit1" for r in wheelchair.excluded
    )
    checks.append(("輪椅排除了只有樓梯的較快出口", stairs_excluded))

    missing_data_excluded = any(
        v.caused_by_missing_data for r in wheelchair.excluded for v in r.violations
    )
    checks.append(("輪椅因低地板資料缺漏而排除公車（不猜測安全關鍵資訊）", missing_data_excluded))

    print()
    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed

    print()
    print("全部通過。" if ok else "有項目未通過，引擎行為與設計不符。")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

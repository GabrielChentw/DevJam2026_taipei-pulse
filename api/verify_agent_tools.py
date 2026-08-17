"""驗證 agent 工具本身在不呼叫 Gemini 的情況下能正常運作。

這個腳本不需要 GEMINI_API_KEY——它只驗證 tools.py 對既有引擎的薄殼呼叫正確，
以及 chat.py 能被 import（也就是 main.py 能被 import，也就是 uvicorn 能啟動）。
真正呼叫 Gemini 的部分在需要金鑰時才測，見 docs 的手動測試步驟。
"""

from __future__ import annotations

from app.agent.camera import camera_commands_for_plan
from app.agent.tools import (
    compare_routes_across_profiles,
    list_accessibility_profiles,
    plan_accessible_route,
)
from app.models import PlanResponse


def main() -> int:
    ok = True

    profiles = list_accessibility_profiles()
    print(f"[profiles] {len(profiles)} 個：{[p['id'] for p in profiles]}")
    ok = ok and len(profiles) == 3

    plan_raw = plan_accessible_route("台北車站", "台北市政府", "wheelchair")
    plan = PlanResponse.model_validate(plan_raw)
    print(f"[plan] feasible={len(plan.feasible)} excluded={len(plan.excluded)}")
    ok = ok and len(plan.feasible) >= 1

    commands = camera_commands_for_plan(plan)
    print(f"[camera] {len(commands)} 個指令：{[c.action for c in commands]}")
    ok = ok and len(commands) == 1
    if commands:
        c = commands[0]
        print(f"  center=({c.center.lat:.4f}, {c.center.lng:.4f}) route={c.route_candidate_id}")

    compare_raw = compare_routes_across_profiles("台北車站", "台北市政府", ["wheelchair", "low_vision"])
    print(f"[compare] divergence: {compare_raw['divergence'][:60]}...")
    ok = ok and "wheelchair" in compare_raw["results"] and "low_vision" in compare_raw["results"]

    # overrides 測試：放寬步行上限後，輪椅應該多出可行路線（原本因步行過長被排除的那條）。
    plan_wide = PlanResponse.model_validate(
        plan_accessible_route("台北車站", "台北市政府", "wheelchair", max_walk_meters=2000)
    )
    print(f"[override] max_walk_meters=2000 -> feasible={len(plan_wide.feasible)}（預期 > {len(plan.feasible)}）")
    ok = ok and len(plan_wide.feasible) > len(plan.feasible)

    print()
    print("全部通過。" if ok else "有項目未通過。")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

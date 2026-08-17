"""從一份 PlanResponse / CompareResponse 推導相機指令。

Agent 決定「該讓地圖做什麼」，但不直接操作 Map3DElement——它只回傳意圖
（CameraCommand），前端保留呈現方式的最終決定權（動畫時長、緩動曲線）。
這個模組是唯一把「路線規劃結果」翻譯成「相機該飛去哪」的地方，agent 本身
不需要知道座標怎麼算。
"""

from __future__ import annotations

from ..models import CameraCommand, EvaluatedRoute, LatLngPoint, PlanResponse


def _route_center(route: EvaluatedRoute) -> LatLngPoint | None:
    """路線所有 leg 座標點的簡單平均，作為相機注視點。

    一日專案不做真正的 bounding box 相機計算（那要處理地球曲率、長寬比、
    最佳 tilt/heading），先用平均點 + 固定 range 頂上去看得到整條路線的效果。
    這裡明確留一個改進點注記，之後有時間可以換成 LatLngBounds 計算。
    """
    points = [p for leg in route.legs for p in leg.path]
    if not points:
        return None
    lat = sum(p.lat for p in points) / len(points)
    lng = sum(p.lng for p in points) / len(points)
    return LatLngPoint(lat=lat, lng=lng, altitude=40)


def camera_command_for_route(route: EvaluatedRoute) -> CameraCommand | None:
    center = _route_center(route)
    if center is None:
        return None
    return CameraCommand(
        action="fly_to",
        center=center,
        range=1800,
        tilt=60,
        heading=30,
        route_candidate_id=route.candidate_id,
    )


def camera_commands_for_plan(plan: PlanResponse) -> list[CameraCommand]:
    """規劃完成後，預設飛到推薦路線（若有）。"""
    if not plan.feasible:
        return []
    return [c for c in [camera_command_for_route(plan.feasible[0])] if c is not None]

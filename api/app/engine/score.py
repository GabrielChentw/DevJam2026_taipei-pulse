"""加權評分。決定可行路線之間的排序。

分數越低越好，語意是「對這個人的總負擔」。

刻意保留完整的 breakdown 供除錯日誌與內部檢核使用；使用者介面只呈現
影響排序的主要考量，避免把帶有假精確感的算式當成使用者需要理解的資訊。
"""

from __future__ import annotations

from typing import Any

from ..models import Feature, ScoreBreakdown


def score_route(
    profile: dict[str, Any],
    route_features: dict[str, Feature],
) -> tuple[float, list[ScoreBreakdown]]:
    weights: dict[str, float] = profile.get("weights", {})
    breakdown: list[ScoreBreakdown] = []
    total = 0.0

    for feature_name, weight in weights.items():
        feature = route_features.get(feature_name)
        if feature is None or not feature.is_known:
            # 資料缺漏不計分。缺漏的處理責任在 rules.py 的 unknown_policy，
            # 在這裡補一個猜測值只會讓排序看起來精確而實際上是虛構的。
            continue

        try:
            raw = float(feature.value)
        except (TypeError, ValueError):
            continue

        contribution = raw * weight
        total += contribution
        breakdown.append(
            ScoreBreakdown(
                feature=feature_name,
                raw_value=raw,
                weight=weight,
                contribution=contribution,
            )
        )

    breakdown.sort(key=lambda b: abs(b.contribution), reverse=True)
    return total, breakdown


# 人類看得懂的特徵名稱。用於產生解釋文字。
FEATURE_LABELS: dict[str, str] = {
    "duration_min": "行程時間",
    "walk_meters": "步行距離",
    "total_walk_meters": "總步行距離",
    "max_slope_percent": "最大坡度",
    "transfers": "轉乘次數",
    "vehicle_boardings": "搭乘車輛數",
    "platform_gap_cm": "月台縫隙",
    "station_complexity": "車站複雜度",
    "street_crossings": "路口穿越",
    "uncontrolled_crossings": "無號誌路口",
    "step_count": "階梯數",
    "missing_accessible_restroom": "缺少無障礙廁所",
    "missing_tactile_paving": "缺少導盲磚",
    "missing_platform_screen_door": "缺少月台門",
    "has_elevator": "無障礙電梯",
    "has_audio_announcement": "語音報站",
    "has_tactile_paving": "導盲磚",
    "low_floor_ratio": "低地板班次比例",
}


def label_for(feature_name: str) -> str:
    return FEATURE_LABELS.get(feature_name, feature_name)


def dominant_factors(breakdown: list[ScoreBreakdown], limit: int = 3) -> list[str]:
    """取貢獻最大的幾項，用於「為什麼是這個排序」的說明。"""
    out: list[str] = []
    for item in breakdown[:limit]:
        if item.contribution <= 0:
            continue
        out.append(label_for(item.feature))
    return out

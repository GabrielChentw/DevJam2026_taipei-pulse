"""路線規劃的組裝層：標註 → 硬條件過濾 → 加權排序 → 產生解釋。

被排除的路線一律保留並附上原因。多數無障礙工具只是把不可行的路線藏起來，
但「這條理論上快 8 分鐘，但那個出口只有樓梯，所以我不推薦」這種說法
比單純給答案有說服力得多，也是使用者建立信任的關鍵。
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..models import (
    CompareResponse,
    EvaluatedRoute,
    PlanRequest,
    PlanResponse,
    ProfileSummary,
)
from .annotate import Annotator
from .rules import evaluate_hard_rules
from .score import label_for, score_route

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
# 掛在 Uvicorn 的 logger 下，讓 INFO 級評分紀錄會出現在開發伺服器終端。
logger = logging.getLogger("uvicorn.error")


@lru_cache(maxsize=1)
def _load(name: str) -> dict[str, Any]:
    return json.loads((_DATA_DIR / name).read_text(encoding="utf-8"))


def load_corridor() -> dict[str, Any]:
    return _load("corridor.json")


def load_profiles() -> dict[str, Any]:
    return _load("profiles.json")


def load_candidates() -> dict[str, Any]:
    return _load("candidates.json")


def get_profile(profile_id: str) -> dict[str, Any] | None:
    for profile in load_profiles()["profiles"]:
        if profile["id"] == profile_id:
            return profile
    return None


def list_profiles() -> list[ProfileSummary]:
    return [
        ProfileSummary(
            id=p["id"],
            label=p["label"],
            summary=p.get("summary", ""),
            user_overridable=p.get("user_overridable", {}),
        )
        for p in load_profiles()["profiles"]
    ]


def _find_candidates(origin: str, destination: str) -> list[dict[str, Any]]:
    for query in load_candidates()["queries"]:
        if query["origin"] == origin and query["destination"] == destination:
            return query["candidates"]
    return []


def _tag_routes(routes: list[EvaluatedRoute], profile_id: str) -> None:
    """給可行路線貼上種類標籤。

    不要給三條差兩分鐘的路線。要給**種類不同**的選項，讓使用者理解自己在權衡什麼。
    """
    if not routes:
        return

    routes[0].recommendation_tag = "最推薦"

    fastest = min(routes, key=lambda r: r.duration_min)
    if fastest.recommendation_tag is None:
        fastest.recommendation_tag = "最快可行"

    least_walk = min(routes, key=lambda r: r.total_walk_meters)
    if least_walk.recommendation_tag is None:
        least_walk.recommendation_tag = "最少步行"

    if profile_id == "low_vision":
        fewest = min(routes, key=lambda r: (r.transfers, r.duration_min))
        if fewest.recommendation_tag is None:
            fewest.recommendation_tag = "最少轉乘"


def _explain_feasible(route: EvaluatedRoute, best: EvaluatedRoute) -> str:
    """用相對首選的實際取捨說明排序，不向使用者暴露內部評分。"""
    parts: list[str] = []
    if route.candidate_id == best.candidate_id:
        parts.append("在可行路線中，這條整體最符合目前需求，建議優先選擇")
    else:
        advantages: list[str] = []
        tradeoffs: list[str] = []

        duration_delta = route.duration_min - best.duration_min
        if duration_delta < -0.5:
            advantages.append(f"少花 {abs(duration_delta):.0f} 分鐘")
        elif duration_delta > 0.5:
            tradeoffs.append(f"多花 {duration_delta:.0f} 分鐘")

        walk_delta = route.total_walk_meters - best.total_walk_meters
        if walk_delta < -1:
            advantages.append(f"少走 {abs(walk_delta):.0f} 公尺")
        elif walk_delta > 1:
            tradeoffs.append(f"多走 {walk_delta:.0f} 公尺")

        transfer_delta = route.transfers - best.transfers
        if transfer_delta < 0:
            advantages.append(f"少轉乘 {abs(transfer_delta)} 次")
        elif transfer_delta > 0:
            tradeoffs.append(f"多轉乘 {transfer_delta} 次")

        if advantages and tradeoffs:
            parts.append(
                "相較首選可" + "、".join(advantages) + "，但會" + "、".join(tradeoffs)
            )
        elif advantages:
            parts.append(
                "相較首選可" + "、".join(advantages) + "，但其他無障礙條件較不符合目前需求"
            )
        elif tradeoffs:
            parts.append("這條路線同樣可行，但相較首選會" + "、".join(tradeoffs))
        else:
            parts.append("這條路線同樣可行，但綜合其他無障礙條件後列為備選")

    if route.warnings:
        missing = sorted({label_for(w.feature) for w in route.warnings})
        parts.append("資料不足需現場確認：" + "、".join(missing))
    return "；".join(parts) + "。"


def _log_score(profile_id: str, route: EvaluatedRoute) -> None:
    """將技術性評分細節留在後端日誌，不帶到使用者介面。"""
    breakdown = [
        {
            "feature": item.feature,
            "raw_value": item.raw_value,
            "weight": item.weight,
            "contribution": item.contribution,
        }
        for item in route.breakdown
    ]
    logger.info(
        "route_score profile=%s candidate=%s score=%.1f breakdown=%s",
        profile_id,
        route.candidate_id,
        route.score,
        json.dumps(breakdown, ensure_ascii=False, separators=(",", ":")),
    )


def _explain_excluded(route: EvaluatedRoute, best_duration: float | None) -> str:
    reasons = "；".join(v.reason for v in route.violations)
    prefix = ""
    if best_duration is not None and route.duration_min < best_duration:
        saved = best_duration - route.duration_min
        prefix = f"這條路線比推薦路線快 {saved:.0f} 分鐘，但"
    return f"{prefix}{reasons}。"


def plan(request: PlanRequest) -> PlanResponse:
    profile = get_profile(request.profile_id)
    if profile is None:
        raise ValueError(f"未知的 profile：{request.profile_id}")

    candidates = _find_candidates(request.origin, request.destination)
    annotator = Annotator(load_corridor())
    # Routes API is optional. When enabled, warm all distinct walking shapes in
    # parallel; when disabled this is a no-op and planning stays fully offline.
    annotator.prefetch_walking_paths(candidates)

    feasible: list[EvaluatedRoute] = []
    excluded: list[EvaluatedRoute] = []

    for candidate in candidates:
        legs, route_features = annotator.annotate_route(candidate)
        violations, warnings = evaluate_hard_rules(
            profile, legs, route_features, request.overrides
        )

        evaluated = EvaluatedRoute(
            candidate_id=candidate["id"],
            label=candidate["label"],
            feasible=not violations,
            duration_min=float(route_features["duration_min"].value),
            total_walk_meters=float(route_features["total_walk_meters"].value),
            transfers=int(route_features["transfers"].value),
            legs=legs,
            violations=violations,
            warnings=warnings,
        )

        if violations:
            excluded.append(evaluated)
            continue

        evaluated.score, evaluated.breakdown = score_route(profile, route_features)
        _log_score(request.profile_id, evaluated)
        feasible.append(evaluated)

    feasible.sort(key=lambda r: (r.score if r.score is not None else float("inf")))
    _tag_routes(feasible, request.profile_id)

    best_duration = feasible[0].duration_min if feasible else None
    for route in feasible:
        route.explanation = _explain_feasible(route, feasible[0])
    for route in excluded:
        route.explanation = _explain_excluded(route, best_duration)

    if feasible:
        summary = (
            f"{profile['label']}：{len(feasible)} 條可行，"
            f"建議「{feasible[0].label}」（{feasible[0].duration_min:.0f} 分鐘）。"
            f"另有 {len(excluded)} 條因硬性條件被排除。"
        )
    else:
        summary = (
            f"{profile['label']}：{len(candidates)} 條候選路線全部不可行。"
            "這通常代表資料缺口，而不是真的無路可走 —— 請看排除原因。"
        )

    return PlanResponse(
        origin=request.origin,
        destination=request.destination,
        profile_id=profile["id"],
        profile_label=profile["label"],
        applied_overrides=request.overrides,
        feasible=feasible,
        excluded=excluded,
        summary=summary,
    )


def compare(origin: str, destination: str, profile_ids: list[str]) -> CompareResponse:
    """同一組起終點、多個 profile 並列。這是本專案的核心論證。"""
    results = {
        pid: plan(PlanRequest(origin=origin, destination=destination, profile_id=pid))
        for pid in profile_ids
    }

    picks: dict[str, str] = {}
    for pid, response in results.items():
        if response.feasible:
            picks[response.profile_label] = response.feasible[0].label

    distinct = set(picks.values())
    if len(distinct) > 1:
        detail = "、".join(f"{label} 建議「{route}」" for label, route in picks.items())
        divergence = (
            f"同一組起終點產生了不同的建議：{detail}。"
            "這不是演算法的雜訊，而是需求本質上的衝突 —— "
            "站內垂直移動有電梯就能解決，但複雜車站的方向辨識無法靠設施解決。"
        )
    elif picks:
        divergence = f"這組起終點下各 profile 建議相同路線（{next(iter(distinct))}），差異出現在排除的路線與理由。"
    else:
        divergence = "沒有任何 profile 找到可行路線。"

    return CompareResponse(
        origin=origin,
        destination=destination,
        results=results,
        divergence=divergence,
    )

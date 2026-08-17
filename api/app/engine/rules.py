"""硬條件解譯器。

profiles.json 裡的 hard_rules 是資料，這裡是唯一知道怎麼執行它們的地方。
這個間接層就是「新增障礙類型 = 新增一筆資料」得以成立的原因。

處理資料缺漏是本模組的重點。一條規則可能因為三種不同原因不通過：
  1. 值明確違反門檻          -> 排除，理由具體
  2. 值缺漏且政策為 block    -> 排除，並標明是資料缺漏所致
  3. 值缺漏且政策為 warn     -> 通過，但附上警告

第 2 與第 3 的差別是設計決定，不是實作細節。輪椅使用者不能賭「這班公車也許是低地板」，
但視障使用者可以在導盲磚資料不明的情況下自行判斷。
"""

from __future__ import annotations

from typing import Any

from ..models import AnnotatedLeg, Feature, Violation, Warning_

_OPS = {
    "lte": lambda actual, expected: actual <= expected,
    "lt": lambda actual, expected: actual < expected,
    "gte": lambda actual, expected: actual >= expected,
    "gt": lambda actual, expected: actual > expected,
    "eq": lambda actual, expected: actual == expected,
    "neq": lambda actual, expected: actual != expected,
}


def _op_label(op: str, value: Any) -> str:
    return {
        "lte": f"至多 {value}",
        "lt": f"少於 {value}",
        "gte": f"至少 {value}",
        "gt": f"多於 {value}",
        "eq": f"等於 {value}",
        "neq": f"不等於 {value}",
        "is_true": "必須具備",
    }.get(op, f"{op} {value}")


def _matches_when(condition: dict[str, Any] | None, features: dict[str, Feature]) -> bool:
    """規則的適用條件。條件涉及的特徵缺漏時視為不適用 —— 不對不確定的前提套用規則。"""
    if not condition:
        return True

    feature = features.get(condition["feature"])
    if feature is None or not feature.is_known:
        return False

    op = condition["op"]
    if op == "is_true":
        return feature.value is True
    checker = _OPS.get(op)
    if checker is None:
        return False
    try:
        return bool(checker(feature.value, condition.get("value")))
    except TypeError:
        return False


def _format_reason(rule: dict[str, Any], leg_name: str, actual: Any) -> str:
    template = rule.get("reason_template")
    if not template:
        return f"{leg_name} 不符合條件：{rule['feature']} {_op_label(rule['op'], rule.get('value'))}"
    shown = "資料缺漏" if actual is None else actual
    return template.format(leg_name=leg_name, actual=shown, required=rule.get("value"))


def _unknown_policy(profile: dict[str, Any], feature_name: str) -> str:
    policies = profile.get("unknown_policy", {})
    return policies.get(feature_name, policies.get("_default", "warn"))


def _check_one(
    rule: dict[str, Any],
    features: dict[str, Feature],
    profile: dict[str, Any],
    overrides: dict[str, float],
    leg_name: str,
    leg_index: int | None,
) -> tuple[Violation | None, Warning_ | None]:
    feature_name = rule["feature"]

    if not _matches_when(rule.get("when"), features):
        return None, None

    feature = features.get(feature_name)
    threshold = overrides.get(feature_name, rule.get("value"))

    # --- 資料缺漏 ---
    if feature is None or not feature.is_known:
        policy = _unknown_policy(profile, feature_name)
        if policy == "ignore":
            return None, None
        if policy == "block":
            return (
                Violation(
                    rule_feature=feature_name,
                    leg_index=leg_index,
                    leg_name=leg_name,
                    reason=_format_reason(rule, leg_name, None)
                    + "（我們沒有這筆資料，因此無法保證可行，不予推薦）",
                    actual=None,
                    required=threshold,
                    caused_by_missing_data=True,
                ),
                None,
            )
        return None, Warning_(
            feature=feature_name,
            leg_index=leg_index,
            leg_name=leg_name,
            message=f"{leg_name} 的 {feature_name} 資料缺漏，建議到現場確認",
        )

    # --- 值明確 ---
    op = rule["op"]
    if op == "is_true":
        passed = feature.value is True
    else:
        checker = _OPS.get(op)
        if checker is None:
            return None, None
        try:
            passed = bool(checker(feature.value, threshold))
        except TypeError:
            return None, None

    if passed:
        return None, None

    return (
        Violation(
            rule_feature=feature_name,
            leg_index=leg_index,
            leg_name=leg_name,
            reason=_format_reason(rule, leg_name, feature.value),
            actual=feature.value,
            required=threshold,
        ),
        None,
    )


def evaluate_hard_rules(
    profile: dict[str, Any],
    legs: list[AnnotatedLeg],
    route_features: dict[str, Feature],
    overrides: dict[str, float] | None = None,
) -> tuple[list[Violation], list[Warning_]]:
    """回傳 (違反清單, 警告清單)。違反清單為空即代表這條路線對這個人可行。"""
    overrides = overrides or {}
    violations: list[Violation] = []
    warnings: list[Warning_] = []

    for rule in profile.get("hard_rules", []):
        if rule.get("scope") == "route":
            violation, warning = _check_one(
                rule, route_features, profile, overrides, "整段路線", None
            )
            if violation:
                violations.append(violation)
            if warning:
                warnings.append(warning)
            continue

        for leg in legs:
            violation, warning = _check_one(
                rule, leg.features, profile, overrides, leg.name, leg.index
            )
            if violation:
                violations.append(violation)
            if warning:
                warnings.append(warning)

    return violations, warnings

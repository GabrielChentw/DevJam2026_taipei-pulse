"""把候選路線的原始 leg 標註成客觀特徵。

這一層**完全不知道障礙類型的存在**。它只回答「這條路線的客觀事實是什麼」，
例如這段有沒有電梯、幾階階梯、幾個路口、公車低地板比例多少。

「這些事實對某個人來說可不可行」是 rules.py 與 score.py 的責任。
把兩者分開是整個系統的核心設計 —— 新增障礙類型才能只改資料不改程式。
"""

from __future__ import annotations

from typing import Any

from ..data_sources.tdx_bus import TDXBusShapeGeometry
from ..models import AnnotatedLeg, Confidence, Feature, GeometryPrecision, LatLngPoint
from .accessibility_facilities import AccessibilityFacilityIndex, load_accessibility_index
from .routes_geometry import DrivingRouteGeometry, WalkingRouteGeometry

# 車站設施中，會被複製到路段特徵上的欄位。
_STATION_FEATURE_KEYS = (
    "has_elevator",
    "has_tactile_paving",
    "has_audio_announcement",
    "has_platform_screen_door",
    "has_accessible_restroom",
    "has_staff_assistance",
    "platform_gap_cm",
)

_BUS_FEATURE_KEYS = (
    "low_floor_ratio",
    "has_audio_announcement",
    "has_visual_display",
    "has_ramp",
)


def _feature_from_raw(raw: Any) -> Feature:
    """corridor.json 的 {value, confidence, ...} 轉成 Feature。"""
    if isinstance(raw, dict) and "value" in raw:
        return Feature(
            value=raw.get("value"),
            confidence=Confidence(raw.get("confidence", "unknown")),
            source=raw.get("source"),
            detail=raw.get("detail"),
        )
    return Feature(value=raw, confidence=Confidence.ESTIMATED)


def _certain(value: Any) -> Feature:
    """路線資料本身直接給定的值，視為已知。"""
    return Feature(value=value, confidence=Confidence.VERIFIED)


def _worst_confidence(*features: Feature) -> Confidence:
    order = [Confidence.VERIFIED, Confidence.REGULATORY, Confidence.ESTIMATED, Confidence.UNKNOWN]
    worst = Confidence.VERIFIED
    for f in features:
        if order.index(f.confidence) > order.index(worst):
            worst = f.confidence
    return worst


class Annotator:
    def __init__(
        self,
        corridor: dict[str, Any],
        walking_geometry: WalkingRouteGeometry | None = None,
        bus_geometry: TDXBusShapeGeometry | None = None,
        driving_geometry: DrivingRouteGeometry | None = None,
        accessibility_index: AccessibilityFacilityIndex | None = None,
    ) -> None:
        self._stations = {s["id"]: s for s in corridor.get("stations", [])}
        self._bus_routes = {r["id"]: r for r in corridor.get("bus_routes", [])}
        self._landmarks = corridor.get("landmarks", {})
        self._walking_geometry = walking_geometry or WalkingRouteGeometry()
        self._bus_geometry = bus_geometry or TDXBusShapeGeometry()
        self._driving_geometry = driving_geometry or DrivingRouteGeometry()
        self._accessibility_index = accessibility_index or load_accessibility_index()

    # ---------- 幾何 ----------

    def _point_for(self, point_id: str) -> LatLngPoint | None:
        """把 waypoint id（車站 id 或 landmark id）解析成座標。

        車站優先於 landmark，因為兩者的 id 空間目前不重疊（BLxx vs 具名 id），
        但用車站表優先查找可以避免未來重名時的歧義。
        """
        station = self._stations.get(point_id)
        if station:
            return LatLngPoint(**station["position"])
        landmark = self._landmarks.get(point_id)
        if landmark:
            return LatLngPoint(**landmark["position"])
        return None

    def _waypoint_points(self, leg: dict[str, Any]) -> list[LatLngPoint]:
        waypoint_ids: list[str] = leg.get("waypoints", [])
        points = [self._point_for(wid) for wid in waypoint_ids]
        resolved = [p for p in points if p is not None]

        if len(resolved) != len(points):
            missing = [wid for wid, p in zip(waypoint_ids, points) if p is None]
            print(f"[annotate] 警告：waypoint 找不到座標，已忽略：{missing}")
        return resolved

    def prefetch_walking_paths(self, candidates: list[dict[str, Any]]) -> None:
        """Compatibility wrapper retained for existing callers/tests."""
        paths = [
            self._waypoint_points(leg)
            for candidate in candidates
            for leg in candidate.get("legs", [])
            if leg.get("mode") == "walk" and leg.get("road_snapping", True)
        ]
        self._walking_geometry.prefetch(paths)

    def prefetch_paths(self, candidates: list[dict[str, Any]]) -> None:
        """Warm Google walking paths and official TDX bus shapes."""

        self.prefetch_walking_paths(candidates)
        bus_routes = [
            (
                str(leg.get("tdx_route_name") or leg.get("name") or ""),
                self._waypoint_points(leg),
                leg.get("tdx_route_uid"),
                leg.get("tdx_direction"),
            )
            for candidate in candidates
            for leg in candidate.get("legs", [])
            if leg.get("mode") == "bus"
        ]
        self._bus_geometry.prefetch(bus_routes)

        # If TDX is not configured, warm Google's road geometry now. If TDX is
        # configured but a single route later fails, that leg still falls back
        # to Google on demand.
        if not self._bus_geometry.enabled:
            self._driving_geometry.prefetch([points for _, points, _, _ in bus_routes])

    def _resolve_path(self, leg: dict[str, Any]) -> tuple[list[LatLngPoint], GeometryPrecision]:
        """leg 的 waypoints 轉成畫線用的座標陣列。

        步行段優先使用 Routes API 路網幾何；公車段優先使用 TDX 官方 Shape，
        再降級到 Routes API DRIVE。外部服務皆不可用時保留端點示意線。
        """
        if not leg.get("waypoints"):
            return [], GeometryPrecision.MISSING

        resolved = self._waypoint_points(leg)

        if not resolved:
            return [], GeometryPrecision.MISSING

        if leg.get("mode") == "walk" and leg.get("road_snapping", True):
            routed = self._walking_geometry.route(resolved)
            if routed:
                return routed, GeometryPrecision.ROAD_SNAPPED

        if leg.get("mode") == "bus":
            routed = self._bus_geometry.route(
                str(leg.get("tdx_route_name") or leg.get("name") or ""),
                resolved,
                leg.get("tdx_route_uid"),
                leg.get("tdx_direction"),
            )
            if routed:
                return routed, GeometryPrecision.TRANSIT_SHAPE
            road_routed = self._driving_geometry.route(resolved)
            if road_routed:
                return road_routed, GeometryPrecision.ROAD_SNAPPED

        return resolved, GeometryPrecision.APPROXIMATE

    # ---------- 單一路段 ----------

    def annotate_leg(self, index: int, leg: dict[str, Any]) -> AnnotatedLeg:
        mode = leg["mode"]
        features: dict[str, Feature] = {
            "mode": _certain(mode),
            "is_transit": _certain(mode in ("metro", "bus")),
            "is_transfer": _certain(bool(leg.get("is_transfer", False))),
            "level_change": _certain(bool(leg.get("level_change", False))),
            "step_count": _certain(float(leg.get("step_count", 0))),
            "walk_meters": _certain(float(leg.get("walk_meters", 0))),
            "street_crossings": _certain(float(leg.get("street_crossings", 0))),
            "uncontrolled_crossings": _certain(float(leg.get("uncontrolled_crossings", 0))),
        }

        # 坡度只有步行段才有意義。未給定時是「不知道」，不是「零坡度」。
        if "max_slope_percent" in leg:
            features["max_slope_percent"] = _certain(float(leg["max_slope_percent"]))
        elif mode == "walk":
            features["max_slope_percent"] = Feature(value=None, confidence=Confidence.UNKNOWN)
        else:
            features["max_slope_percent"] = _certain(0.0)

        if mode == "metro":
            self._apply_metro(leg, features)
        elif mode == "bus":
            self._apply_bus(leg, features)
        else:
            self._apply_walk(leg, features)

        # 捷運段沒標 waypoints 時，用 from_station/to_station 自動生成 —— 車站座標
        # 已經是資料的一部分，不需要在 candidates.json 重複填一次。
        leg_for_path = leg
        if mode == "metro" and "waypoints" not in leg:
            leg_for_path = {**leg, "waypoints": [leg.get("from_station"), leg.get("to_station")]}

        path, precision = self._resolve_path(leg_for_path)

        if mode == "walk" and path:
            features.update(
                self._accessibility_index.annotate_walk(
                    path,
                    float(features["street_crossings"].value),
                )
            )

        return AnnotatedLeg(
            index=index,
            mode=mode,
            name=leg.get("name", f"路段 {index + 1}"),
            duration_min=float(leg.get("duration_min", 0)),
            features=features,
            path=path,
            geometry_precision=precision,
            transit_route_name=(
                leg.get("tdx_route_name") if mode == "bus" else "板南線" if mode == "metro" else None
            ),
            transit_route_uid=(
                leg.get("tdx_route_uid") if mode == "bus" else "BL" if mode == "metro" else None
            ),
            transit_direction=(
                leg.get("tdx_direction")
                if mode == "bus"
                else (0 if str(leg.get("to_station", "")) > str(leg.get("from_station", "")) else 1)
                if mode == "metro"
                else None
            ),
            boarding_stop_uid=(
                leg.get("boarding_stop_uid") if mode == "bus" else leg.get("from_station") if mode == "metro" else None
            ),
            alighting_stop_uid=(
                leg.get("alighting_stop_uid") if mode == "bus" else leg.get("to_station") if mode == "metro" else None
            ),
        )

    def _apply_metro(self, leg: dict[str, Any], features: dict[str, Feature]) -> None:
        """捷運段：設施取起訖兩站中較差的一方 —— 任一端不可行整段就不可行。"""
        ids = [leg.get("from_station"), leg.get("to_station")]
        stations = [self._stations[i] for i in ids if i in self._stations]
        if not stations:
            return

        for key in _STATION_FEATURE_KEYS:
            candidates = [_feature_from_raw(s["facilities"].get(key)) for s in stations]
            candidates = [c for c in candidates if c is not None]
            if not candidates:
                continue

            known = [c for c in candidates if c.is_known]
            if not known:
                features[key] = Feature(value=None, confidence=Confidence.UNKNOWN)
                continue

            if key == "platform_gap_cm":
                # 縫隙取最大值，那才是實際會遇到的最壞情況。
                worst = max(known, key=lambda c: float(c.value))
            else:
                # 布林設施取「有沒有任一端缺少」。False 比 True 更值得注意。
                falsy = [c for c in known if c.value is False]
                worst = falsy[0] if falsy else known[0]

            features[key] = Feature(
                value=worst.value,
                confidence=_worst_confidence(*known),
                source=worst.source,
                detail=worst.detail,
            )

        features["station_complexity"] = _certain(
            float(sum(s.get("complexity", {}).get("score", 0) for s in stations))
        )
        features["station_names"] = _certain([s["name"] for s in stations])

    def _apply_bus(self, leg: dict[str, Any], features: dict[str, Feature]) -> None:
        route = self._bus_routes.get(leg.get("bus_route", ""))
        if not route:
            return
        for key in _BUS_FEATURE_KEYS:
            raw = route["facilities"].get(key)
            if raw is not None:
                features[key] = _feature_from_raw(raw)
        # 公車沒有站體，複雜度為零。這正是視障 profile 偏好公車的原因。
        features["station_complexity"] = _certain(0.0)

    def _apply_walk(self, leg: dict[str, Any], features: dict[str, Feature]) -> None:
        features["station_complexity"] = _certain(0.0)

        exit_info = leg.get("uses_station_exit")
        if not exit_info:
            return

        # 使用特定出口時，該出口的電梯狀況會覆寫車站層級的資訊。
        # 「車站有電梯」不代表「你要走的那個出口有電梯」—— 這個區別對輪椅使用者是決定性的。
        station = self._stations.get(exit_info.get("station", ""))
        features["has_elevator"] = Feature(
            value=bool(exit_info.get("has_elevator")),
            confidence=Confidence.VERIFIED,
            detail=f"{station['name'] if station else exit_info.get('station')} "
            f"{exit_info.get('exit')} 號出口",
        )
        features["uses_station_exit"] = _certain(exit_info)

    # ---------- 整條路線 ----------

    def annotate_route(self, candidate: dict[str, Any]) -> tuple[list[AnnotatedLeg], dict[str, Feature]]:
        legs = [self.annotate_leg(i, leg) for i, leg in enumerate(candidate["legs"])]
        return legs, self.aggregate(legs)

    @staticmethod
    def aggregate(legs: list[AnnotatedLeg]) -> dict[str, Feature]:
        """把路段特徵聚合成路線層級的特徵，供 scoring 使用。

        聚合方式依語意而異：時間與距離相加，坡度與月台縫隙取最壞值，
        設施缺漏則轉成 missing_* 旗標。
        """

        def leg_value(leg: AnnotatedLeg, key: str, default: float = 0.0) -> float:
            f = leg.features.get(key)
            if f is None or not f.is_known:
                return default
            return float(f.value)

        transit_legs = [l for l in legs if bool(l.features.get("is_transit", Feature()).value)]

        route: dict[str, Feature] = {
            "duration_min": _certain(sum(l.duration_min for l in legs)),
            "total_walk_meters": _certain(sum(leg_value(l, "walk_meters") for l in legs)),
            "walk_meters": _certain(sum(leg_value(l, "walk_meters") for l in legs)),
            "step_count": _certain(sum(leg_value(l, "step_count") for l in legs)),
            "street_crossings": _certain(sum(leg_value(l, "street_crossings") for l in legs)),
            "uncontrolled_crossings": _certain(sum(leg_value(l, "uncontrolled_crossings") for l in legs)),
            "station_complexity": _certain(sum(leg_value(l, "station_complexity") for l in legs)),
            "transfers": _certain(float(sum(1 for l in legs if bool(l.features.get("is_transfer", Feature()).value)))),
            "vehicle_boardings": _certain(float(len(transit_legs))),
        }

        ramp_deficits = [
            l.features["curb_ramp_deficit"]
            for l in legs
            if "curb_ramp_deficit" in l.features
            and float(l.features.get("street_crossings", Feature(value=0)).value or 0) > 0
        ]
        route["curb_ramp_deficit"] = (
            Feature(
                value=max(float(f.value) for f in ramp_deficits),
                confidence=Confidence.ESTIMATED,
                source=ramp_deficits[0].source,
                detail="取各步行段中路緣坡道證據最不足的一段",
            )
            if ramp_deficits
            else Feature(value=None, confidence=Confidence.UNKNOWN)
        )

        route["audible_signal_count"] = _certain(
            sum(leg_value(l, "audible_signal_count") for l in legs)
        )
        audible_deficits = [
            l.features["audible_signal_deficit"]
            for l in legs
            if "audible_signal_deficit" in l.features
            and float(l.features.get("street_crossings", Feature(value=0)).value or 0) > 0
        ]
        route["audible_signal_deficit"] = (
            Feature(
                value=max(float(f.value) for f in audible_deficits),
                confidence=Confidence.ESTIMATED,
                source=audible_deficits[0].source,
                detail="取各步行段中有聲號誌證據最不足的一段",
            )
            if audible_deficits
            else Feature(value=None, confidence=Confidence.UNKNOWN)
        )

        slopes = [leg_value(l, "max_slope_percent", -1.0) for l in legs]
        known_slopes = [s for s in slopes if s >= 0]
        route["max_slope_percent"] = (
            _certain(max(known_slopes)) if known_slopes else Feature(value=None, confidence=Confidence.UNKNOWN)
        )

        gaps = [leg_value(l, "platform_gap_cm", -1.0) for l in legs]
        known_gaps = [g for g in gaps if g >= 0]
        route["platform_gap_cm"] = (
            _certain(max(known_gaps)) if known_gaps else Feature(value=None, confidence=Confidence.UNKNOWN)
        )

        # missing_* 旗標：只有在「確知缺少」時才計分。資料不明不罰分，交由 unknown_policy 處理。
        for key, flag in (
            ("has_accessible_restroom", "missing_accessible_restroom"),
            ("has_tactile_paving", "missing_tactile_paving"),
            ("has_platform_screen_door", "missing_platform_screen_door"),
        ):
            relevant = [l.features.get(key) for l in legs if key in l.features]
            known = [f for f in relevant if f is not None and f.is_known]
            if not known:
                route[flag] = Feature(value=None, confidence=Confidence.UNKNOWN)
            else:
                route[flag] = _certain(1.0 if any(f.value is False for f in known) else 0.0)

        return route

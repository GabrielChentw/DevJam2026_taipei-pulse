"""政府開放資料的輕量空間索引。

目前只把路緣坡道當成「正向證據」參與排序。附近有坡道不代表路口的正確一側
一定可用，因此 confidence 永遠是 estimated，也不拿它當硬性排除條件。
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from ..models import Confidence, Feature, LatLngPoint

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "accessibility_facilities.json"
_AUDIBLE_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "audible_signals.json"
_CELL_DEGREES = 0.00025  # 台北約 25–28 公尺


def _distance_m(a: LatLngPoint, lat: float, lng: float) -> float:
    mean_lat = math.radians((a.lat + lat) / 2)
    dx = (a.lng - lng) * 111_320 * math.cos(mean_lat)
    dy = (a.lat - lat) * 110_574
    return math.hypot(dx, dy)


def _samples(path: list[LatLngPoint], spacing_m: float = 18.0) -> Iterable[LatLngPoint]:
    if not path:
        return
    yield path[0]
    for start, end in zip(path, path[1:]):
        distance = _distance_m(start, end.lat, end.lng)
        pieces = max(1, math.ceil(distance / spacing_m))
        for index in range(1, pieces + 1):
            ratio = index / pieces
            yield LatLngPoint(
                lat=start.lat + (end.lat - start.lat) * ratio,
                lng=start.lng + (end.lng - start.lng) * ratio,
            )


class AccessibilityFacilityIndex:
    def __init__(self, ramps: list[dict], audible_signals: list[dict] | None = None) -> None:
        self._ramps = ramps
        self._audible_signals = audible_signals or []
        self._ramp_grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        self._audible_grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, ramp in enumerate(ramps):
            self._ramp_grid[self._cell(ramp["lat"], ramp["lng"])].append(index)
        for index, signal in enumerate(self._audible_signals):
            self._audible_grid[self._cell(signal["lat"], signal["lng"])].append(index)

    @staticmethod
    def _cell(lat: float, lng: float) -> tuple[int, int]:
        return (math.floor(lat / _CELL_DEGREES), math.floor(lng / _CELL_DEGREES))

    def ramps_near_path(self, path: list[LatLngPoint], radius_m: float = 18.0) -> set[int]:
        found: set[int] = set()
        for point in _samples(path):
            cell_lat, cell_lng = self._cell(point.lat, point.lng)
            for y in range(cell_lat - 1, cell_lat + 2):
                for x in range(cell_lng - 1, cell_lng + 2):
                    for index in self._ramp_grid.get((y, x), []):
                        ramp = self._ramps[index]
                        if _distance_m(point, ramp["lat"], ramp["lng"]) <= radius_m:
                            found.add(index)
        return found

    def audible_signals_near_path(
        self, path: list[LatLngPoint], radius_m: float = 28.0
    ) -> set[int]:
        found: set[int] = set()
        for point in _samples(path):
            cell_lat, cell_lng = self._cell(point.lat, point.lng)
            for y in range(cell_lat - 2, cell_lat + 3):
                for x in range(cell_lng - 2, cell_lng + 3):
                    for index in self._audible_grid.get((y, x), []):
                        signal = self._audible_signals[index]
                        if _distance_m(point, signal["lat"], signal["lng"]) <= radius_m:
                            found.add(index)
        return found

    def annotate_walk(
        self,
        path: list[LatLngPoint],
        street_crossings: float,
    ) -> dict[str, Feature]:
        nearby = self.ramps_near_path(path)
        audible_nearby = self.audible_signals_near_path(path)
        # 每個穿越至少要能上下兩次路緣。這只是保守的證據比例，不冒充完整覆蓋率。
        expected = max(1.0, street_crossings * 2.0)
        support = 1.0 if street_crossings <= 0 else min(1.0, len(nearby) / expected)
        detail = f"步行線附近 18 公尺內找到 {len(nearby)} 個官方路緣坡道點位"
        source = "data.gov.tw dataset 134909（臺北市人行道無障礙斜坡道）"
        audible_support = 1.0 if street_crossings <= 0 else min(1.0, len(audible_nearby) / street_crossings)
        audible_detail = (
            f"步行線附近 28 公尺內找到 {len(audible_nearby)} 個官方有聲號誌；"
            "以鄰近性作為視障友善證據，不代表每次穿越方向皆有語音提示"
        )
        audible_source = "臺北市交通管制工程處有聲號誌設置地點"
        return {
            "curb_ramp_count": Feature(
                value=len(nearby), confidence=Confidence.ESTIMATED, source=source, detail=detail
            ),
            "curb_ramp_support": Feature(
                value=round(support, 3), confidence=Confidence.ESTIMATED, source=source, detail=detail
            ),
            "curb_ramp_deficit": Feature(
                value=round(1.0 - support, 3),
                confidence=Confidence.ESTIMATED,
                source=source,
                detail=detail + "；僅作排序加分，不保證位於正確路口側",
            ),
            "audible_signal_count": Feature(
                value=len(audible_nearby),
                confidence=Confidence.ESTIMATED,
                source=audible_source,
                detail=audible_detail,
            ),
            "audible_signal_support": Feature(
                value=round(audible_support, 3),
                confidence=Confidence.ESTIMATED,
                source=audible_source,
                detail=audible_detail,
            ),
            "audible_signal_deficit": Feature(
                value=round(1.0 - audible_support, 3),
                confidence=Confidence.ESTIMATED,
                source=audible_source,
                detail=audible_detail,
            ),
        }


@lru_cache(maxsize=1)
def load_accessibility_index() -> AccessibilityFacilityIndex:
    if not _DATA_PATH.exists():
        return AccessibilityFacilityIndex([])
    bundle = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    audible_bundle = (
        json.loads(_AUDIBLE_DATA_PATH.read_text(encoding="utf-8"))
        if _AUDIBLE_DATA_PATH.exists()
        else {}
    )
    return AccessibilityFacilityIndex(
        bundle.get("curbRamps", []),
        audible_bundle.get("audibleSignals", []),
    )

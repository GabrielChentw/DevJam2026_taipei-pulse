"""API 的資料模型。

設計要點：Feature 一律帶 confidence。「沒有這筆資料」和「沒有這項設施」對使用者的
意義完全不同，型別上就不允許把兩者混為一談。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Confidence(str, Enum):
    """資料可信度。unknown 代表值必為 None。"""

    VERIFIED = "verified"
    REGULATORY = "regulatory"
    ESTIMATED = "estimated"
    UNKNOWN = "unknown"


class GeometryPrecision(str, Enum):
    """路段幾何的可信度。前端據此決定要不要在畫面上標註『示意路線』。"""

    # Google Routes API WALK mode returned a road/path-network polyline.
    # This is more faithful than endpoint interpolation, but not a guarantee of
    # sidewalk or wheelchair accessibility.
    ROAD_SNAPPED = "road_snapped"
    # 端點錨定在有座標依據的地點（車站、手動標定的站牌/入口），
    # 但點與點之間是直線，不是真實道路或軌道 shape。
    APPROXIMATE = "approximate"
    # 沒有任何座標資料，前端不應嘗試畫線。
    MISSING = "missing"


class LatLngPoint(BaseModel):
    lat: float
    lng: float
    altitude: float | None = None


class Feature(BaseModel):
    """一項客觀特徵。value 為 None 時代表資料缺漏，而非「否」。"""

    value: Any = None
    confidence: Confidence = Confidence.UNKNOWN
    source: str | None = None
    detail: str | None = None

    @property
    def is_known(self) -> bool:
        return self.value is not None


class AnnotatedLeg(BaseModel):
    """標註後的單一路段。features 的內容與障礙類型無關。

    path 一律是 lat/lng 陣列，前端可以直接餵給 Polyline3DElement，不需要自己判斷
    型別或處理特例。point_count == 0 是唯一需要特別處理的情況（完全沒有座標資料），
    這時前端不該畫線，但仍可用 leg 的文字資訊顯示這一段。
    """

    index: int
    mode: Literal["walk", "metro", "bus"]
    name: str
    duration_min: float
    features: dict[str, Feature] = Field(default_factory=dict)
    path: list[LatLngPoint] = Field(default_factory=list)
    geometry_precision: GeometryPrecision = GeometryPrecision.MISSING


class Violation(BaseModel):
    """一條硬條件的違反紀錄。保留足以向使用者解釋的全部資訊。"""

    rule_feature: str
    leg_index: int | None = None
    leg_name: str | None = None
    reason: str
    actual: Any = None
    required: Any = None
    caused_by_missing_data: bool = False


class Warning_(BaseModel):
    """資料缺漏但仍視為可行時的警告。"""

    feature: str
    leg_index: int | None = None
    leg_name: str | None = None
    message: str


class ScoreBreakdown(BaseModel):
    """分數組成。保留供除錯日誌與內部檢核使用。"""

    feature: str
    raw_value: float
    weight: float
    contribution: float


class EvaluatedRoute(BaseModel):
    """單一候選路線針對某個 profile 的評估結果。"""

    candidate_id: str
    label: str
    feasible: bool
    score: float | None = None
    duration_min: float
    total_walk_meters: float
    transfers: int
    legs: list[AnnotatedLeg]
    violations: list[Violation] = Field(default_factory=list)
    warnings: list[Warning_] = Field(default_factory=list)
    breakdown: list[ScoreBreakdown] = Field(default_factory=list)
    recommendation_tag: str | None = None
    explanation: str | None = None


class PlanRequest(BaseModel):
    origin: str = "台北車站"
    destination: str = "台北市政府"
    profile_id: str = "wheelchair"
    overrides: dict[str, float] = Field(
        default_factory=dict,
        description="覆寫 profile 的硬條件門檻，例如 {'total_walk_meters': 300}。"
        "供 agent 在對話中即時調整用。",
    )


class PlanResponse(BaseModel):
    origin: str
    destination: str
    profile_id: str
    profile_label: str
    applied_overrides: dict[str, float] = Field(default_factory=dict)
    feasible: list[EvaluatedRoute] = Field(default_factory=list)
    excluded: list[EvaluatedRoute] = Field(default_factory=list)
    summary: str = ""


class ProfileSummary(BaseModel):
    id: str
    label: str
    summary: str
    user_overridable: dict[str, Any] = Field(default_factory=dict)


class CompareResponse(BaseModel):
    """同一組起終點、不同 profile 的並列結果。這是本專案的核心論證。"""

    origin: str
    destination: str
    results: dict[str, PlanResponse]
    divergence: str = ""


# ---------- Agent 對話 ----------


class CameraCommand(BaseModel):
    """Agent 要求地圖執行的相機動作。前端依 action 決定呼叫哪個 Map3DElement 方法。

    這個型別是前端與 agent 唯一的耦合點：agent 不直接操作地圖，只回傳「意圖」，
    前端保有如何呈現的最終決定權（例如動畫時長、緩動曲線）。
    """

    action: Literal["fly_to", "show_route", "orbit"]
    # fly_to: center 必填。show_route: route_candidate_id 必填。orbit: center 必填。
    center: LatLngPoint | None = None
    range: float | None = None
    tilt: float | None = None
    heading: float | None = None
    route_candidate_id: str | None = None


class ChatMessage(BaseModel):
    role: Literal["user", "agent"]
    text: str


class ChatRequest(BaseModel):
    session_id: str = Field(description="前端產生一個穩定的 id（例如 crypto.randomUUID()），同一次對話全程帶同一個。")
    message: str


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    camera_commands: list[CameraCommand] = Field(default_factory=list)
    # agent 呼叫 plan/compare 工具後的結果，前端可直接拿來畫路線疊圖，
    # 不需要自己再打一次 /api/plan。為 None 代表這輪對話還沒觸發規劃。
    plan: PlanResponse | None = None
    compare: CompareResponse | None = None
    history: list[ChatMessage] = Field(default_factory=list)

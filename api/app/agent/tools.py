"""Agent 可呼叫的工具。

每個函式都是既有引擎（app.engine.plan）的薄殼——agent 不重新實作任何規劃邏輯，
只負責「什麼時候呼叫」和「怎麼把結果講給使用者」。這樣評分引擎的正確性不會因為
接了 agent 而改變：verify_engine.py 驗證過的行為在這裡原樣沿用。

型別註記與 docstring 對 google-genai 的自動 function calling 有實際作用——
SDK 會讀取函式簽名與 docstring 生成 tool schema 餵給模型，所以這裡的文字
不只是給人看的註解，也是模型決定「現在該不該呼叫這個工具」的依據。
寫得含糊，模型就會亂猜參數；寫得精確，效果立竿見影。
"""

from __future__ import annotations

from ..engine import plan as planner
from ..models import PlanRequest


def list_accessibility_profiles() -> list[dict[str, object]]:
    """列出目前支援的障礙類型（profile），例如輪椅使用者、視障者、高齡者。

    在使用者還沒明確說出自己的障礙類型、或想知道系統支援哪些類型時呼叫這個工具。

    Returns:
        每個 profile 的 id、label（顯示名稱）、summary（一句話說明這個 profile
        重視什麼）。
    """
    return [p.model_dump() for p in planner.list_profiles()]


def plan_accessible_route(
    origin: str,
    destination: str,
    profile_id: str,
    max_walk_meters: float | None = None,
    max_slope_percent: float | None = None,
) -> dict[str, object]:
    """針對指定的障礙類型，規劃從起點到終點的無障礙路線。

    這是核心工具。回傳同時包含可行路線（已排序，附推薦理由）與被排除的路線
    （附排除原因，包含因資料缺漏而排除的情況）。跟使用者對話時，被排除的路線
    和原因通常比可行路線更值得講——那是建立信任的地方，不要只報好消息。

    只有台北車站與台北市政府之間目前有候選路線資料。若使用者問其他起終點，
    這個工具會回傳空結果，此時應誠實告知使用者目前資料範圍有限，而不是編造答案。

    Args:
        origin: 起點名稱，例如「台北車站」。
        destination: 終點名稱，例如「台北市政府」。
        profile_id: 障礙類型 id。呼叫 list_accessibility_profiles 取得可用值，
            目前是 wheelchair（輪椅使用者）、low_vision（視障者）、
            elderly（高齡者）。
        max_walk_meters: 使用者可接受的單程總步行距離上限（公尺）。使用者若說
            「我只能走 300 公尺」之類的話，把這個值填進來覆寫預設門檻；
            沒有明確要求時留空，使用 profile 的預設值。
        max_slope_percent: 可接受的最大坡度百分比。電動輪椅通常可接受比手動
            輪椅更陡的坡（例如電動 12%、手動 6%），使用者說明使用哪種輪椅時
            可依此調整；沒有依據時留空。

    Returns:
        含 summary（一句話摘要）、feasible（可行路線清單，每條有 label、
        duration_min、explanation、recommendation_tag、legs 的 path 座標）、
        excluded（被排除路線，附 explanation 說明原因）。
    """
    overrides: dict[str, float] = {}
    if max_walk_meters is not None:
        overrides["total_walk_meters"] = max_walk_meters
    if max_slope_percent is not None:
        overrides["max_slope_percent"] = max_slope_percent

    response = planner.plan(
        PlanRequest(
            origin=origin,
            destination=destination,
            profile_id=profile_id,
            overrides=overrides,
        )
    )
    return response.model_dump()


def compare_routes_across_profiles(
    origin: str,
    destination: str,
    profile_ids: list[str],
) -> dict[str, object]:
    """同一組起終點，並列比較多種障礙類型會得到的不同建議路線。

    當使用者想知道「換成別的障礙類型會不會不一樣」、或想展示系統的差異化能力時
    呼叫這個工具（例如使用者說「那視障者呢」、「跟長輩比起來呢」）。

    回傳的 divergence 欄位是現成的一段話，說明各 profile 的建議是否不同、
    為什麼不同（例如「站內垂直移動有電梯就能解決，但複雜車站的方向辨識無法靠
    設施解決」）——可以直接引用或改寫給使用者，不需要自己重新推理原因。

    Args:
        origin: 起點名稱。
        destination: 終點名稱。
        profile_ids: 要比較的 profile id 清單，例如 ["wheelchair", "low_vision"]。

    Returns:
        含 results（每個 profile id 對應一份完整的 plan 結果）與 divergence
        （比較結論的自然語言說明）。
    """
    response = planner.compare(origin, destination, profile_ids)
    return response.model_dump()


AGENT_TOOLS = [
    list_accessibility_profiles,
    plan_accessible_route,
    compare_routes_across_profiles,
]

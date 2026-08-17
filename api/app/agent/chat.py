"""對話 session 管理與 Gemini 呼叫。

Session 存在記憶體（一個 process 級的 dict），不進 Firestore——一日專案的 demo
不需要跨重啟保存對話，換掉這一層之後的資料庫也不影響 API 契約。

不用完整的 ADK 框架，直接用 google-genai 的自動 function calling
（傳入 Python 函式列表當 tools，SDK 自己讀簽名、自己執行、自己把結果餵回模型）。
理由：
  1. ADK 2.0 剛換過 session schema，一天內踩相容性坑的風險不小
  2. 這個 agent 只需要「維持對話 + 決定呼叫哪個工具 + 把結果講成人話」，
     不需要 ADK 的多 agent 編排、workflow graph、Task API
  3. 「agent 架構」的賣點是我們自己的評分引擎，跟用不用 ADK 框架無關

歷史管理採用最簡單的做法：自己維護一份 ChatMessage 清單，每輪把完整歷史
連同新訊息一起送給 generate_content，不使用 SDK 的 ChatSession 物件
——這樣每一輪都能重新組裝「會把工具回傳值寫進 captured dict」的 tool wrapper，
不需要去解析 SDK 內部不保證穩定的呼叫歷史格式。

刻意不加 `from __future__ import annotations`：見 tools.py 開頭的說明，
這裡動態組裝的 plan_accessible_route / compare_routes_across_profiles
wrapper 一樣要讓 google-genai 讀到真正的型別物件，不能是字串。
"""

import os
from dataclasses import dataclass, field

from google import genai
from google.genai import types

from ..models import CameraCommand, ChatMessage, CompareResponse, EvaluatedRoute, PlanResponse
from .camera import camera_commands_for_plan
from . import tools as _tools_module

_SYSTEM_INSTRUCTION = """\
你是 Taipei Pulse 的無障礙路線助理，服務對象是輪椅使用者與視障者，範圍限於
台北車站與台北市政府之間的板南線走廊。

你的任務不是查詢，是理解需求：
- 使用者不會主動申報「手動輪椅、單程步行上限 300 公尺」這類細節，你要在對話中
  自然地問出來，不要一次列一堆問題轟炸使用者。
- 把模糊語言翻譯成具體參數再呼叫工具。例如「我腳不太方便，走不了太遠」應該
  追問是否使用輔具、大概能走多遠，再決定套用哪個 profile、要不要覆寫預設門檻。
- 只有台北車站到台北市政府這一組起終點有資料。使用者問別的地點時要老實說
  目前只支援這個走廊，不要假裝有資料。

回答的重點：
- 一定要講清楚推薦路線「為什麼」推薦，以及被排除的路線「為什麼」被排除。
  被排除路線的理由往往比推薦路線本身更能建立信任，不要只報好消息。
- 若排除原因是資料缺漏（工具回應裡 caused_by_missing_data 為 true），要明確
  講出來是資料不足而非確定不可行，並建議使用者到現場再確認，不要含糊帶過。
- 若使用者問到另一種障礙類型會如何，主動呼叫 compare_routes_across_profiles，
  引用其中的 divergence 說明兩者為什麼不同。
- 用簡短、口語、繁體中文回答，不要輸出程式碼或 JSON。
- 不要向使用者顯示 profile 的內部數值門檻，例如「可接受坡度上限約 12%」；
  只需說明路線是否適合及實際需要注意的路況。
"""

# gemini-2.5-flash 已對新使用者下架（2026/08 確認，Google 建議改用 Interactions API
# 或新一代模型）。改用目前 GA 的 gemini-3.6-flash。若之後又下架，
# 用 TAIPEI_PULSE_MODEL 環境變數覆寫即可，不需要改程式碼。
_MODEL = os.environ.get("TAIPEI_PULSE_MODEL", "gemini-3.6-flash")


@dataclass
class _Session:
    history: list[ChatMessage] = field(default_factory=list)
    last_plan: PlanResponse | None = None
    last_compare: CompareResponse | None = None


class AgentUnavailableError(RuntimeError):
    """GEMINI_API_KEY 未設定或 client 初始化失敗時拋出。"""


_client: genai.Client | None = None
_sessions: dict[str, _Session] = {}


def _get_client() -> genai.Client:
    global _client
    if _client is not None:
        return _client

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AgentUnavailableError(
            "環境變數 GEMINI_API_KEY 未設定。到 https://aistudio.google.com/app/apikey "
            "取得金鑰，設定 GEMINI_API_KEY 後重啟後端。"
        )

    _client = genai.Client(api_key=api_key)
    return _client


def _get_or_create_session(session_id: str) -> _Session:
    if session_id not in _sessions:
        _sessions[session_id] = _Session()
    return _sessions[session_id]


def _history_to_contents(history: list[ChatMessage]) -> list[dict[str, object]]:
    return [
        {"role": "user" if m.role == "user" else "model", "parts": [{"text": m.text}]}
        for m in history
    ]


def _summarize_route(route: EvaluatedRoute) -> dict[str, object]:
    """把一條 EvaluatedRoute 精簡成模型講話真正需要的欄位。

    完整的 EvaluatedRoute 含每個 leg 的全部特徵字典（value/confidence/source/
    detail 四個子欄位 x 十幾項特徵 x 每條路線 3-5 個 leg）加上完整的分數
    breakdown 和座標 path。這些對前端疊圖是必要的，但塞進模型的 context 只是
    雜訊——實測觀察到：工具呼叫本身完全成功、拿到真實資料，但模型的最終回覆
    卻說「我沒有能力提供路線規劃」，合理推測是完整 JSON 的體積或結構干擾了
    模型收斂出最終文字。explanation 欄位已經是引擎產生的完整人類可讀說明，
    模型不需要重新從原始特徵推理一次，所以摘要後幾乎不損失資訊。
    """
    return {
        "candidate_id": route.candidate_id,
        "label": route.label,
        "feasible": route.feasible,
        "duration_min": route.duration_min,
        "total_walk_meters": route.total_walk_meters,
        "transfers": route.transfers,
        "recommendation_tag": route.recommendation_tag,
        "explanation": route.explanation,
        "excluded_because_missing_data": any(v.caused_by_missing_data for v in route.violations),
    }


def _summarize_plan(plan: PlanResponse) -> dict[str, object]:
    return {
        "origin": plan.origin,
        "destination": plan.destination,
        "profile_label": plan.profile_label,
        "summary": plan.summary,
        "feasible": [_summarize_route(r) for r in plan.feasible],
        "excluded": [_summarize_route(r) for r in plan.excluded],
    }


def _summarize_compare(compare: CompareResponse) -> dict[str, object]:
    return {
        "origin": compare.origin,
        "destination": compare.destination,
        "divergence": compare.divergence,
        "results": {pid: _summarize_plan(p) for pid, p in compare.results.items()},
    }


def _wrap_tools_with_capture(captured: dict[str, object]) -> list[object]:
    """包一層 AGENT_TOOLS，讓回傳值同時滿足兩個不同的消費者。

    - captured 字典拿到完整結果（PlanResponse / CompareResponse），供這輪
      ChatResponse 帶給前端疊圖，不需要前端再打一次 /api/plan。
    - 回傳給模型的是精簡摘要（見 _summarize_plan），避免完整 JSON 干擾模型
      生成最終回覆。
    """

    def plan_accessible_route(
        origin: str,
        destination: str,
        profile_id: str,
        max_walk_meters: float | None = None,
        max_slope_percent: float | None = None,
    ) -> dict[str, object]:
        result = _tools_module.plan_accessible_route(
            origin, destination, profile_id, max_walk_meters, max_slope_percent
        )
        plan = PlanResponse.model_validate(result)
        captured["plan"] = plan
        return _summarize_plan(plan)

    plan_accessible_route.__doc__ = _tools_module.plan_accessible_route.__doc__

    def compare_routes_across_profiles(
        origin: str, destination: str, profile_ids: list[str]
    ) -> dict[str, object]:
        result = _tools_module.compare_routes_across_profiles(origin, destination, profile_ids)
        compare = CompareResponse.model_validate(result)
        captured["compare"] = compare
        return _summarize_compare(compare)

    compare_routes_across_profiles.__doc__ = _tools_module.compare_routes_across_profiles.__doc__

    return [
        _tools_module.list_accessibility_profiles,
        plan_accessible_route,
        compare_routes_across_profiles,
    ]


def send_message(
    session_id: str, message: str
) -> tuple[str, list[CameraCommand], PlanResponse | None, CompareResponse | None, list[ChatMessage]]:
    session = _get_or_create_session(session_id)
    client = _get_client()

    # 可變容器讓 tool wrapper 能把結果寫回這裡，不需要解析 SDK 內部的呼叫歷史
    # （SDK 不保證那個格式穩定，直接包一層自己的 wrapper 比較可靠）。
    captured: dict[str, object] = {}
    tools_with_capture = _wrap_tools_with_capture(captured)

    contents = _history_to_contents(session.history) + [
        {"role": "user", "parts": [{"text": message}]}
    ]

    response = client.models.generate_content(
        model=_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM_INSTRUCTION,
            tools=tools_with_capture,
        ),
    )

    reply = response.text or "（沒有取得回應，請再試一次）"

    # 保留這行日誌：這是唯一能一眼看出「模型有沒有呼叫工具」的地方。
    # 曾經在這裡抓到過型別註記字串化導致每次工具呼叫都失敗（見本檔開頭說明），
    # 若之後又有類似問題，先看 uvicorn 的 log 裡這一行，比逐步除錯快得多。
    afc_history = getattr(response, "automatic_function_calling_history", None)
    tool_calls = [
        part.function_call.name
        for turn in (afc_history or [])
        for part in (getattr(turn, "parts", None) or [])
        if getattr(part, "function_call", None)
    ]
    print(f"[chat] session={session_id} tool_calls={tool_calls}")

    session.history.append(ChatMessage(role="user", text=message))
    session.history.append(ChatMessage(role="agent", text=reply))

    if isinstance(captured.get("plan"), PlanResponse):
        session.last_plan = captured["plan"]  # type: ignore[assignment]
    if isinstance(captured.get("compare"), CompareResponse):
        session.last_compare = captured["compare"]  # type: ignore[assignment]

    camera_commands: list[CameraCommand] = []
    if session.last_plan is not None:
        camera_commands = camera_commands_for_plan(session.last_plan)

    return reply, camera_commands, session.last_plan, session.last_compare, session.history

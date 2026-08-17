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
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from google import genai
from google.genai import types

from ..models import CameraCommand, ChatMessage, CompareResponse, PlanResponse
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
"""

_MODEL = os.environ.get("TAIPEI_PULSE_MODEL", "gemini-2.5-flash")


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


def _wrap_tools_with_capture(captured: dict[str, object]) -> list[object]:
    """AGENT_TOOLS 的函式原樣可呼叫，但額外把回傳值寫進 captured。

    這樣前端不需要自己重新呼叫 /api/plan 才能拿到座標畫圖——agent 一輪對話裡
    呼叫了規劃工具，那次的完整結果會跟著這輪 ChatResponse 一起回去。
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
        captured["plan"] = PlanResponse.model_validate(result)
        return result

    plan_accessible_route.__doc__ = _tools_module.plan_accessible_route.__doc__

    def compare_routes_across_profiles(
        origin: str, destination: str, profile_ids: list[str]
    ) -> dict[str, object]:
        result = _tools_module.compare_routes_across_profiles(origin, destination, profile_ids)
        captured["compare"] = CompareResponse.model_validate(result)
        return result

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

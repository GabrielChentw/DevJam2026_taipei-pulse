"""Taipei Pulse 後端。

無障礙路線評分引擎。同一組候選路線，套用不同的 profile 會得到不同的可行性判定與排序。

安全性說明：這個服務目前**沒有任何身分驗證**。它只讀取 repo 內的靜態種子資料，
不含個人資料、不寫入任何儲存，且僅供本機開發與 demo 使用。若要部署到公開網址，
必須先加上驗證與速率限制 —— 屆時它會開始接收使用者的無障礙需求，那是敏感個人資料。
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .engine import plan as planner
from .models import CompareResponse, PlanRequest, PlanResponse, ProfileSummary

app = FastAPI(
    title="Taipei Pulse API",
    description="無障礙導向的大眾運輸路線評分引擎",
    version="0.1.0",
)

# 前端 dev server 走 Vite 的 /api proxy 時是同源，理論上不需要 CORS。
# 這裡仍放寬到任意 localhost port，因為現在是三人分工：前端同事的 dev server
# port 可能跟 5173 不同（例如 Vite 偵測到 port 被佔用會自動遞增），
# 而且直接用 curl / Postman 打 API 測試時也需要放行。
# 僅限 localhost/127.0.0.1，僅限本機開發 —— 部署到公開網址時必須改回明確白名單。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/profiles", response_model=list[ProfileSummary])
def get_profiles() -> list[ProfileSummary]:
    """可用的障礙 profile。新增一種障礙類型只需在 profiles.json 加一筆。"""
    return planner.list_profiles()


@app.get("/api/corridor")
def get_corridor() -> dict:
    """走廊的無障礙種子資料，含每筆設施的 confidence。"""
    return planner.load_corridor()


@app.post("/api/plan", response_model=PlanResponse)
def post_plan(request: PlanRequest) -> PlanResponse:
    """針對單一 profile 規劃路線。回傳可行路線與**被排除的路線加上原因**。"""
    try:
        return planner.plan(request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/compare", response_model=CompareResponse)
def get_compare(
    origin: str = "台北車站",
    destination: str = "台北市政府",
    profiles: str = "wheelchair,low_vision",
) -> CompareResponse:
    """同一組起終點、多個 profile 並列比較。這是本專案的核心論證。"""
    profile_ids = [p.strip() for p in profiles.split(",") if p.strip()]
    try:
        return planner.compare(origin, destination, profile_ids)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

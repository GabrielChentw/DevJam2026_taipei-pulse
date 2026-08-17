# Taipei Pulse

無障礙導向的台北 3D 大眾運輸路線服務。透過對話式 agent，為**輪椅使用者**與**視障者**
提供差異化的路線建議 —— 同一組起終點，不同障礙類型會得到截然不同的推薦。

> DevJam 2026 · 一日開發專案

## 為什麼是「差異化」

這是整個專案的核心主張：輪椅使用者與視障者的需求**會互相衝突**。

| 情境 | 輪椅使用者 | 視障者 |
| --- | --- | --- |
| 車站有電梯也有樓梯 | 一定要電梯，繞路也認 | 可能寧願走有扶手加導盲磚的樓梯 |
| 轉乘 | 可接受多次，只要每段都無障礙 | 轉乘次數是最大負擔，寧願多坐幾站 |
| 步行段 | 怕坡度、怕路緣高差 | 怕複雜路口、怕無號誌穿越 |
| 公車 | 必須低地板 | 低地板不重要，要有語音報站 |

多數無障礙工具只是把不可行的路線藏起來。本專案會保留被排除的路線**並說明排除原因** ——
「這條理論上快 8 分鐘，但那個出口只有樓梯，所以不推薦」。

## 核心設計

**不為每種障礙寫一套路由演算法。** 把「世界的客觀事實」與「這個人的需求」徹底分離：

- 路段標註中立的客觀特徵（`has_elevator`、`step_count`、`low_floor_ratio`、`crossings`…）
- 每種障礙是一組儲存在 DB 的**硬條件 + 軟權重**
- 新增障礙類型 = 新增一筆資料，而非新增程式碼

`unknown` 是合法值。資料缺漏時不假裝精確，由 agent 明白告知使用者。

詳細架構與圖表見 **[`docs/architecture.md`](docs/architecture.md)**。

## 文件

| 文件 | 內容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 架構圖（一日版 + 完整願景）、profile 評分設計、風險表 |
| [`docs/setup-gcp.md`](docs/setup-gcp.md) | GCP 逐步設定、錯誤碼對照表、金鑰安全 |
| [`docs/README.md`](docs/README.md) | 圖表產出方式、Windows 開發環境踩雷紀錄 |

## 技術選型

| 層 | 選用 |
| --- | --- |
| 3D 地圖 | Google Maps JavaScript API · Photorealistic 3D Maps (`Map3DElement`) |
| 前端 | React 19 + Vite 7 + TypeScript |
| 後端 | FastAPI（部署目標 Cloud Run） |
| Agent | Gemini + `google-genai` 自動 function calling |
| 資料庫 | Firestore（一日版先用 repo 內的 JSON 種子資料）|
| 路線候選 | repo 內 JSON 離線候選（Google Routes API 為後續規劃） |

引擎寫在 Python 而不是前端 TypeScript，是因為 **agent 必須呼叫它**。目前直接使用
`google-genai` 把既有引擎包成工具；若引擎放在前端，就得維護兩份規劃邏輯。

示範範圍：捷運板南線台北車站 → 台北市政府走廊及沿線公車。

## 快速開始

### 前置作業

在 GCP Console 完成三件事：

1. 建立專案並**連結有 credit 的計費帳戶**
2. 啟用 **Maps JavaScript API**（只需要這一個，不需要 Map Tiles API）
3. 建立 API 金鑰

逐步操作與疑難排解見 **[`docs/setup-gcp.md`](docs/setup-gcp.md)**。

### 後端（路線評分引擎 + Agent）

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 編輯 .env，填入 GEMINI_API_KEY（到 https://aistudio.google.com/app/apikey 取得）
.\.venv\Scripts\python.exe verify_engine.py       # 驗證差異化行為
.\.venv\Scripts\python.exe verify_geometry.py     # 驗證幾何資料完整
.\.venv\Scripts\python.exe verify_agent_tools.py  # 驗證 agent 工具（不需要金鑰）
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000 --reload
```

`verify_engine.py` 會把引擎的判斷完整攤開，並斷言五項核心行為。它不是單元測試，
是一份「看得懂的證明」—— 讓人確認輪椅走捷運、視障走公車是**算出來的**，不是寫死的。

API 文件在 <http://127.0.0.1:8000/docs>。核心端點：

| 端點 | 用途 |
| --- | --- |
| `POST /api/plan` | 單一 profile 的路線規劃，回傳可行路線**與被排除路線加原因** |
| `GET /api/compare` | 同一組起終點、多 profile 並列。這是專案的核心論證 |
| `GET /api/profiles` | 可用的障礙 profile 與可對話調整的參數 |
| `GET /api/corridor` | 走廊無障礙種子資料，含每筆的 confidence |
| `POST /api/chat` | 對話式規劃。Gemini 透過 function calling 呼叫上面的規劃工具，回傳文字回覆 + 相機指令 + 完整規劃結果 |

`/api/chat` 需要 `GEMINI_API_KEY`，未設定時回 HTTP 503 並附取得金鑰的連結，
不會讓其他端點跟著壞掉。Agent 不使用完整的 ADK 框架——直接用 `google-genai`
的自動 function calling（把既有引擎包成 Python 函式當 tools 傳入），理由與
取捨寫在 `api/app/agent/chat.py` 開頭的註解。

### 測試 Agent 對話

三種方式，由簡到繁：

1. **瀏覽器互動介面**：後端跑起來後開 <http://127.0.0.1:8000/docs>，找
   `POST /api/chat`，Try it out，貼：
   ```json
   { "session_id": "test1", "message": "我坐輪椅，要從台北車站到市政府" }
   ```
   同一個 `session_id` 可以連續送新的 `message` 保留對話上下文。

2. **測試腳本**（`scripts/test-chat.ps1`）：
   ```powershell
   # 單句
   powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Message "your text"
   # 連續對話
   powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Interactive
   ```
   會把 `reply`、`plan` 的 feasible/excluded 數量、`camera_commands` 整理成
   人類看得懂的格式印出來，不用自己讀原始 JSON。

3. **前端**：`web/src/lib/api.ts` 的 `sendChatMessage()`。

前端會優先呼叫後端 `/api/chat`。若後端離線、金鑰未設定或 API 發生其他錯誤，
目前會自動改用 mock 對話與假路線，確保畫面仍可展示。這個降級不會在 UI 顯示，
因此驗證真實 agent 時請同時查看後端 log，確認出現 `[chat] ... tool_calls=...`。

**判斷測試結果的標準**：`reply` 裡的數字（步行公尺、分鐘、坡度）要跟種子
資料（`api/app/data/candidates.json`）對得上；`plan` 若非 null，`feasible`
應至少有 1 條。若 `reply` 提到種子資料裡不存在的數字，代表工具呼叫失敗、
模型在編答案——回報這個情況，不要當成正常結果。

> 若 `scripts/test-chat.ps1` 遇到中文輸出變成亂碼：那是終端機顯示編碼問題，
> 資料本身沒壞，用瀏覽器 `/docs` 介面看原始 JSON 更準確。

> **安全性**：後端目前**沒有身分驗證**，僅供本機開發與 demo。部署到公開網址前必須
> 加上驗證與速率限制 —— 屆時它會開始接收使用者的無障礙需求，那是敏感個人資料。

### 前端

```powershell
cd web
Copy-Item .env.example .env.local
# 編輯 .env.local，填入 VITE_GOOGLE_MAPS_API_KEY
cmd /c "npm install"
cmd /c "npm run dev"
```

開 <http://localhost:5173>，會先看到對話與路線比較畫面。完成規劃後可選擇路線進入
3D 地圖，查看板南線七個車站標記、路線疊圖與相機定位；按「開始模擬」會依序掃過
各路段，公車路段另有移動標記與跟拍鏡頭。

> **Windows 注意**：必須用 `cmd /c` 前綴，否則 PowerShell 的執行原則會擋住 npm。
> 原因與永久解法見 [`docs/README.md`](docs/README.md#windows-上的注意事項)。

改 `.tsx` / `.css` 會熱更新。改 **`.env.local`**、`vite.config.ts`、`package.json`
必須**重啟 dev server**（Vite 只在啟動時讀這些檔案）。

## 專案結構

```
docs/                       架構文件與設定指南
scripts/                    診斷與環境建置工具（PowerShell）
api/
  verify_engine.py          引擎行為的可讀驗證
  app/
    main.py                 FastAPI 端點
    models.py               Feature 一律帶 confidence
    data/
      corridor.json         走廊無障礙事實（人工建置，每筆帶 confidence）
      profiles.json         障礙 profile：硬條件 + 軟權重
      candidates.json       離線候選路線
    engine/
      annotate.py           leg -> 客觀特徵。完全不知道障礙類型的存在
      rules.py              硬條件解譯器，含資料缺漏政策
      score.py              加權排序，保留完整 breakdown
      plan.py               組裝與解釋文字生成
    agent/
      tools.py              把評分引擎包成 Gemini 可呼叫工具
      chat.py               對話 session、function calling 與結果 capture
      camera.py             規劃結果 -> 地圖相機指令
web/
  public/simple-3d.html     最小重現頁，用於區分設定問題與程式問題
  src/
    lib/googleMaps.ts       Maps API 載入器 + 錯誤攔截
    lib/api.ts              FastAPI 前端封裝
    lib/routeSimulation.ts  3D 路線繪製、逐段相機移動與公車跟拍
    components/ChatPanel.tsx 對話、語音輸入與朗讀、mock 降級
    components/RoutePanel.tsx 可行與排除路線的比較介面
    components/Map3D.tsx    3D 地圖元件
    data/corridor.ts        板南線走廊座標與相機定位點
    App.tsx                 對話、路線與地圖狀態整合
```

引擎的三層責任分離是刻意的：

- **`annotate.py`** 只回答「客觀事實是什麼」，完全不知道障礙類型的存在
- **`rules.py`** 回答「對這個人可不可行」
- **`score.py`** 回答「可行的之中哪個負擔較小」

這個分離就是「新增障礙類型 = 新增一筆資料」得以成立的原因。`elderly` profile
就是證明 —— 它沒有寫任何新程式，只是重新加權。

## 工具腳本

全部在 `scripts/`，用 `powershell -ExecutionPolicy Bypass -File scripts\<名稱>` 執行。

| 腳本 | 用途 |
| --- | --- |
| `install-gcloud.ps1` | 用 ZIP 版安裝 gcloud CLI（winget 版是 GUI 精靈，無法腳本化）|
| `gcp-audit.ps1` | 查證專案、已啟用 API、計費狀態、金鑰限制 |
| `sync-maps-key.ps1` | 比對 `.env.local` 的金鑰是否真屬於這個專案，不符則修正 |
| `check-maps-key.ps1` | 不需登入的金鑰探針，區分計費問題與 API 啟用問題 |
| `check-gpu.ps1` | 硬體與顯示驅動盤點 |
| `check-chrome-gpu.ps1` | Chrome session / flag / 政策檢查 |
| `check-chrome-gpu2.ps1` | 分辨 `--disable-gpu` 是原因還是結果 |

> 所有 `.ps1` 都刻意寫成**純 ASCII**。Windows PowerShell 5.1 以 ANSI 解讀 `.ps1`，
> 非 ASCII 註解會弄壞 parser。這是實際踩到的坑。

## 三人分工

| 角色 | 負責 | 依賴 |
| --- | --- | --- |
| 前端 A | 3D 地圖疊路線、輪椅 vs 視障並排對比畫面、相機飛行 | `docs/api-contract.md`，可先用假資料開工 |
| 前端 B | 對話介面（輸入框、訊息氣泡），串 `POST /api/chat` | 同上，agent 的理解/決策邏輯已在後端做好 |
| 後端（此 repo 主線）| 引擎、種子資料、agent 工具與對話邏輯、契約文件、整合、demo 腳本 | — |

前端要串接的完整說明在 **[`docs/api-contract.md`](docs/api-contract.md)**，
含 curl 範例、TypeScript 型別（`web/src/types/api.ts`）、疊路線的邏輯建議、
Agent 的 `/api/chat` 說明（`CameraCommand` 怎麼轉成相機動作），以及幾個容易
踩的坑（`Feature.value` 為 `null` 不是 `false`、`geometry_precision` 的意義、
`plan`/`compare` 為 `null` 是正常情況）。

## 目前進度

- [x] 架構設計與圖表
- [x] 前端骨架 + Photorealistic 3D 地圖 + 相機控制 + 車站標記
- [x] GCP 環境建置與驗證工具鏈
- [x] 走廊無障礙種子資料（板南線 7 站 + 3 條公車，每筆帶 confidence）
- [x] Profile 驅動的路線評分引擎（輪椅 / 視障 / 高齡，五項行為驗證通過）
- [x] 路段幾何資料（17 個 leg 皆可畫圖，`verify_geometry.py` 驗證）
- [x] 前端 API 契約文件與型別定義
- [x] Agent 對話邏輯（function calling 呼叫規劃引擎、產生相機指令，`verify_agent_tools.py` 驗證）
- [x] 前端接上 `/api/chat`，顯示 agent 回覆與完整規劃結果
- [x] 路線比較介面（可行與被排除路線、推薦理由、逐段資訊）
- [x] 3D 地圖疊加選定路線，依步行／捷運／公車分色
- [x] 路線逐段模擬與公車移動標記／跟拍鏡頭
- [x] 語音輸入、回覆朗讀、亮暗色與視障高對比模式

### Demo 已知限制

- 只有「台北車站 → 台北市政府」這一組起終點有候選路線；反向與其他地點尚未支援。
- 17 個 leg 都有座標，但目前是端點錨定後的近似直線（`geometry_precision: approximate`），
  不是實際道路、軌道或公車 shape。
- 公車動畫時間為 demo 固定秒數，不代表真實車程；步行與捷運段目前只有鏡頭掃過，沒有車輛標記。
- 對話 session 存在 FastAPI process 的記憶體中，服務重啟後不保留，也不適合多 instance 部署。
- 前端遇到任何 `/api/chat` 錯誤都會靜默切到 mock；正式展示前應確認後端 log 的工具呼叫紀錄。
- 後端尚無身分驗證與速率限制，只適合本機開發與受控 demo，不應直接公開上線。

### 引擎目前的實際輸出

起點台北車站、終點台北市政府，五條候選路線：

| Profile | 首選 | 可行 | 排除 |
| --- | --- | --- | --- |
| 輪椅使用者 | 捷運板南線直達（市政府站 3 號出口，有電梯）| 1 | 4 |
| 視障者 | 信義幹線公車直達 | 4 | 1 |
| 高齡者 | 信義幹線公車直達 | 4 | 1 |

三個值得注意的行為，都是引擎自己算出來的：

- **輪椅排除了更快的路線並說明原因**：走市政府站 1 號出口快 2 分鐘，但那個出口有 28 階樓梯。
- **輪椅因資料缺漏而排除公車**，不是因為公車不好。低地板班次比例是 `unknown`，
  而輪椅 profile 對這個特徵的政策是 `block` —— 安全關鍵資訊不猜測。
- **視障排除了穿越無號誌路口的路線**，即使它比推薦路線快 6 分鐘。

**一個值得在簡報講的發現**：輪椅使用者只有 1 條可行路線，視障者有 4 條。
差距不是來自城市的無障礙設施，而是來自**資料缺口** —— 只要低地板公車資料補上，
輪椅使用者的選擇立刻從 1 條變成 3 條。資料的缺失本身就在限制身障者的移動自由。

## 開發筆記

建置 3D 地圖時踩到的兩個坑，記錄下來避免重複：

**1. 不要用 `@googlemaps/js-api-loader` 載 3D Maps。**
Photorealistic 3D Maps 只能透過 `google.maps.importLibrary` 取得，而它需要
`loading=async` 加 `callback` 這組 bootstrap 參數才會就緒。改用
[官方 inline bootstrap](https://developers.google.com/maps/documentation/javascript/3d/get-started) 才正常。

**2. 不要把 UI 的可見性綁在 `gmp-steadystate` 事件上。**
那個事件的語意是「圖磚全部載完**且**相機靜止」。Photorealistic 3D 圖磚串流常常超過
十秒，期間地圖是可用的。曾經因此用全屏遮罩蓋住一個正常運作的地圖，然後回報「渲染失敗」。
現在元素掛上就顯示，該事件只用來收掉「圖磚載入中」的角標。

除錯時的通則：**先跑 `web/public/simple-3d.html`**。它沒有 React、沒有抽象層，
就是官方最小範例加上把 console 印在畫面上。它通過而主程式失敗，就是本專案的程式問題。

## 致謝

概念啟發自 [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d)（MIT License）——
一個東京公共運輸的即時 3D 地圖。本專案未使用其程式碼（Mini Tokyo 3D 建構於
Mapbox GL JS，本專案使用 Google Maps Platform），但其「車輛位置為沿路線 shape
的時間函數」的動畫思路是本專案車輛圖層的設計來源。

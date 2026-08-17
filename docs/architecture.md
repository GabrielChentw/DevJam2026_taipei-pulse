# Taipei Pulse — 架構文件

無障礙導向的台北 3D 大眾運輸路線服務。以 Google Cloud 為基礎，透過對話式 agent
為不同障礙類型的使用者提供差異化的路線建議。

- **服務對象**：輪椅使用者、視障者（架構可擴充至高齡者等）
- **示範範圍**：捷運板南線 台北車站 ↔ 市政府 走廊及沿線公車
- **開發限制**：1 天、1 名開發者

---

## 1. 一日版架構（今天要做的）

```mermaid
flowchart TB
    subgraph SEED["種子資料 · 手工建置 + 一次性腳本"]
        D1["corridor.json<br/>走廊 12 站<br/>電梯 / 出口 / 階梯 / 導盲磚"]
        D2["routes.json<br/>2-3 條公車路線 shape<br/>TDX 靜態資料抓一次存檔"]
        D3["vehicles.json<br/>車牌 → 是否低地板"]
    end

    subgraph FS["Firestore"]
        P1[("accessibility_profiles<br/>wheelchair / low_vision")]
        P2[("users<br/>對話中學到的偏好")]
    end

    subgraph CR["單一 Cloud Run 服務 · FastAPI"]
        R1["Annotator<br/>路段標註客觀特徵"]
        R2["Filter + Scorer<br/>套用 profile"]
        R3["Explainer<br/>產生推薦 / 排除理由"]
        AG["ADK Agent<br/>Gemini + Tools"]
        SIM["Vehicle Simulator<br/>沿 shape 產生位置"]
    end

    subgraph FE["前端 · React + Vite · Firebase Hosting"]
        M1["gmp-map-3d<br/>Photorealistic 3D Tiles"]
        M2["Polyline3DElement<br/>路線疊圖"]
        M3["Marker3DElement<br/>電梯 / 站點 / 障礙點"]
        M4["Model3DElement<br/>移動中的巴士"]
        C1["Chat Panel"]
    end

    G1["Google Routes API<br/>候選大眾運輸路線"] --> R1
    D1 --> R1
    D2 --> R1
    D3 --> R1
    D2 --> SIM
    R1 --> R2
    P1 --> R2
    P2 --> R2
    R2 --> R3
    R3 --> AG
    AG --> C1
    AG -->|相機飛行指令| M1
    R3 --> M2
    D1 --> M3
    SIM -->|每秒輪詢| M4
    C1 --> AG
```

刻意的簡化：單一容器、單一 Firestore、其餘皆為靜態 JSON。
不用 Pub/Sub、不用 Redis、不用 Cloud SQL、不用 Vertex AI Agent Engine。

---

## 2. 核心設計：Profile 驅動的路線評分

系統最重要的設計決定是**把「世界的客觀事實」與「這個人的需求」徹底分離**。

不為每種障礙寫一套路由演算法。改為：路段標註中立的客觀特徵，
每種障礙是一組儲存在 DB 的硬條件與軟權重。新增障礙類型 = 新增一筆資料，而非新增程式碼。

```mermaid
flowchart LR
    subgraph FACT["事實層 · 與障礙類型無關"]
        F1["路段特徵標註<br/>has_elevator<br/>step_count<br/>low_floor_ratio<br/>walk_meters<br/>crossings<br/>tactile_paving<br/>audio_announce<br/>transfers<br/>station_complexity"]
    end

    subgraph DB["Firestore · accessibility_profiles"]
        P1["輪椅<br/>硬: 電梯必須有<br/>硬: 階梯 = 0<br/>硬: 公車須低地板<br/>權重: 坡度 高"]
        P2["視障<br/>硬: 須有語音報站<br/>權重: 轉乘 極高<br/>權重: 路口數 高<br/>權重: 車站複雜度 高"]
        P3["高齡 (擴充示範)<br/>權重: 步行距離 高<br/>權重: 擁擠度 中"]
    end

    subgraph ENGINE["同一套引擎"]
        E1["Hard Filter<br/>刷掉不可行路線"]
        E2["Soft Scoring<br/>加權排序"]
        E3["Explainer<br/>產生自然語言理由"]
    end

    R["候選路線<br/>Routes API 或離線 fallback"] --> F1
    F1 --> E1
    P1 --> E1
    P2 --> E1
    P3 --> E1
    E1 --> E2
    E2 --> E3
    E3 --> O1["可行路線 × N<br/>各附推薦理由"]
    E3 --> O2["被排除路線<br/>+ 排除原因"]
```

設計要點：

- **`unknown` 是合法值。** 資料缺漏時不假裝精確，由 agent 明白告知使用者。
- **被排除的路線要保留並回傳。** 「這條快 8 分鐘但那個出口只有樓梯，所以不推薦」
  比單純隱藏不可行路線更能建立信任。
- 輪椅與視障的需求**會互相衝突**（電梯 vs 導盲磚、可接受轉乘 vs 極度厭惡轉乘），
  因此同一組起終點會產生截然不同的建議。這是本專案的核心價值主張。

---

## 3. Agent 對話流程

Agent 不只回覆文字，它同時回傳結構化指令來操作 3D 地圖。

```mermaid
sequenceDiagram
    participant U as 使用者
    participant C as Chat Panel
    participant AG as ADK Agent (Gemini)
    participant RT as Routing Engine
    participant DB as Firestore
    participant MAP as gmp-map-3d

    U->>C: 我坐輪椅，要從台北車站到市政府
    C->>AG: 訊息 + session
    AG->>DB: 讀取已知偏好
    DB-->>AG: 首次對話，無記錄
    AG-->>U: 手動還是電動輪椅？單程大概能走多遠？
    U->>AG: 手動，300 公尺以內
    AG->>DB: 寫入 user profile 覆寫值
    AG->>RT: plan_accessible_route(起點, 終點, wheelchair, max_walk=300)
    RT->>RT: 標註 → 硬條件過濾 → 加權排序 → 產生理由
    RT-->>AG: 2 條可行 + 1 條排除(附原因)
    AG->>RT: get_next_low_floor_bus(站點, 路線)
    RT-->>AG: 低地板 6 分鐘 / 一般車 2 分鐘
    AG-->>C: 建議路線 + 為什麼不推薦另一條
    AG-->>MAP: fly_to_route(polyline) + 標記電梯位置
    MAP-->>U: 3D 飛行預覽整段路線
```

Agent 存在的正當性建立在四件它不可被下拉選單取代的事：

1. **問出使用者不會主動申報的隱性需求**（手動/電動輪椅、可上幾公分門檻、步行上限）
2. **把模糊語言翻譯成 profile 參數**（「我腳不太方便」→ 套哪個 profile、調哪些權重）
3. **解釋權衡，特別是解釋為什麼不推薦**
4. **記住**，第二次對話不需重問

---

## 4. 完整願景架構（Roadmap，用於簡報）

一日版刻意砍掉的部分。展示團隊知道這個系統該長成什麼樣。

```mermaid
flowchart TB
    subgraph EXT["外部資料源"]
        T1["TDX 公車即時動態 A1/A2"]
        T2["TDX 路線 Shape / 站點 / 車輛屬性"]
        T3["台北捷運 電梯狀態"]
        T4["data.taipei 人行道 / 無障礙設施"]
        G1["Google Routes / Places API"]
    end

    subgraph INGEST["擷取層"]
        S1["Cloud Scheduler"]
        I1["Realtime Ingestor"]
        I2["Static Loader"]
        P1["Pub/Sub"]
    end

    subgraph PROC["處理層"]
        M1["Map Matcher<br/>位置貼合路線"]
        M2["Trajectory Builder<br/>產生插值軌跡"]
        M3["Accessibility Tagger<br/>車牌 → 低地板"]
    end

    subgraph DATA["資料層"]
        R1[("Memorystore Redis<br/>即時車輛狀態")]
        F1[("Cloud SQL + PostGIS<br/>GTFS / 無障礙設施")]
        B1[("BigQuery<br/>歷史軌跡 / 覆蓋率分析")]
        C1[("Cloud Storage<br/>GTFS / glTF 模型")]
    end

    subgraph SERVE["服務層"]
        A1["Transit API<br/>REST + SSE"]
        A2["A11y Routing Engine"]
    end

    subgraph AGENT["Agent 層"]
        AG["ADK on Vertex AI Agent Engine"]
    end

    FE["前端 · Google Maps 3D"]

    S1 --> I1
    S1 --> I2
    T1 --> I1
    T2 --> I2
    T3 --> I2
    T4 --> I2
    I1 --> P1
    I2 --> C1
    I2 --> F1
    I2 --> B1
    P1 --> M1
    M1 --> M2
    M2 --> M3
    M3 --> R1
    C1 --> M1
    R1 --> A1
    R1 --> A2
    F1 --> A2
    B1 --> A2
    G1 --> A2
    A1 --> AG
    A2 --> AG
    A1 -->|SSE| FE
    A2 --> FE
    AG --> FE
```

一日版與完整版的差異：

| 面向 | 一日版 | 完整版 |
|---|---|---|
| 車輛位置 | 沿真實 shape 模擬 | TDX 即時動態 |
| 位置精度 | 直接繪製 | Map matching + 插值 |
| 無障礙資料 | 手工建置 12 站 | 自動擷取全市 |
| 資料庫 | Firestore | Cloud SQL + PostGIS + Redis |
| Agent 部署 | 內嵌於 Cloud Run | Vertex AI Agent Engine |
| 地理範圍 | 單一走廊 | 全台北 |

---

## 5. 已知風險與限制

| 風險 | 影響 | 緩解方式 |
|---|---|---|
| `gmp-map-3d` 仍為 Preview | API 可能變動 | 一日專案可接受；車輛圖層抽象在 interface 後 |
| TDX 低地板欄位覆蓋率未經驗證 | 核心功能可能無資料 | 改用手工建置的 `vehicles.json` |
| 視障相關開放資料稀少<br/>（導盲磚、有聲號誌未確認存在） | 視障 profile 較為啟發式 | 改用可推導的代理指標：轉乘次數、路口數、車站複雜度、語音報站；並由 agent 明確告知資料信心度 |
| Routes API 需啟用計費 | Demo 可能開天窗 | 固定示範起終點的候選路線寫入離線 JSON fallback |
| Photorealistic 3D Tiles 不供應 EEA 地區 | 不影響台灣 | 無 |
| Google Routes API 的 `TransitPreferences`<br/>僅有 `LESS_WALKING` / `FEWER_TRANSFERS`，<br/>**沒有輪椅無障礙選項** | 無法直接取得無障礙路線 | 這正是本專案自建評分引擎的理由 |

---

## 6. 圖表的產出方式

本文件所有圖表皆為 [Mermaid](https://mermaid.js.org/) 語法，四種取得圖檔的方式：

1. **GitHub** — push 上去後 `.md` 裡的 mermaid 區塊會自動渲染，不需任何工具。
2. **VS Code / Kiro** — 開啟 Markdown Preview（`Ctrl+Shift+V`）即可預覽。
3. **[mermaid.live](https://mermaid.live)** — 貼上程式碼，右上角 Actions 可匯出 PNG / SVG。
   要放進簡報時這是最快的方式，零安裝。
4. **本機批次產圖** — 見 `docs/README.md`，一行指令輸出全部 PNG 與 SVG。

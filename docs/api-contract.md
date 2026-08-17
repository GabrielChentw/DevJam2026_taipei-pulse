# API 契約：前端要串接的東西

給前端負責 3D 地圖疊路線的人看。後端跑在 `http://127.0.0.1:8000`，dev 模式下
Vite 已經把 `/api` proxy 過去了（見 `web/vite.config.ts`），**前端程式碼一律打
`/api/...`，不要寫死 127.0.0.1**。

TypeScript 型別在 `web/src/types/api.ts`，可以直接 import。呼叫的薄封裝在
`web/src/lib/api.ts`。

## 啟動後端

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000 --reload
```

自動生成的 API 文件在 <http://127.0.0.1:8000/docs>，可以在那裡直接互動測試，
不需要寫任何程式碼。

## 端點總覽

| 類別 | 端點 | 用途 |
| --- | --- | --- |
| 狀態 | `GET /api/health` | Cloud Run／本機健康檢查 |
| 規劃 | `GET /api/profiles`、`POST /api/plan`、`GET /api/compare` | Profile 驅動的可行性、排序與比較 |
| Agent | `POST /api/chat` | Gemini function calling、對話歷史、規劃結果與相機指令 |
| 走廊資料 | `GET /api/corridor`、`GET /api/accessibility` | 種子資料與官方無障礙快照／回退狀態 |
| 交通 | `GET /api/transit/arrivals`、`GET /api/transit/scene` | 即將到站與時刻表驅動的 3D 車輛物件 |
| 偏好 | `GET/PUT /api/users/{id}/preferences` | 匿名 opt-in 偏好；Firestore 或明確記憶體回退 |

## 路線規劃端點

### `GET /api/profiles`

拿到有哪些障礙 profile 可以選（下拉選單或分頁籤用）。

```powershell
curl http://127.0.0.1:8000/api/profiles
```

回傳陣列，每個元素含 `id`（例如 `"wheelchair"`）、`label`（例如 `"輪椅使用者"`）、
`summary`。目前有 `wheelchair`、`low_vision`、`elderly` 三個。

### `POST /api/plan`

單一 profile 的完整路線規劃。**這是你疊圖需要的主要端點。**

```powershell
curl -X POST http://127.0.0.1:8000/api/plan `
  -H "Content-Type: application/json" `
  -d '{\"origin\":\"台北車站\",\"destination\":\"台北市政府\",\"profile_id\":\"wheelchair\"}'
```

回傳 `PlanResponse`：

```ts
{
  feasible: EvaluatedRoute[],   // 可行路線，已排序，分數越低越前面
  excluded: EvaluatedRoute[],   // 被排除的路線，附原因 —— 不要在 UI 上完全藏起來
  summary: string,               // 一句話摘要，可直接顯示
  ...
}
```

### `GET /api/compare?origin=...&destination=...&profiles=wheelchair,low_vision`

同一組起終點、多個 profile 並列。**這是 demo 的核心畫面**：輪椅 vs 視障同時
顯示，答案不一樣。

```powershell
curl "http://127.0.0.1:8000/api/compare?profiles=wheelchair,low_vision"
```

回傳 `CompareResponse`，`results` 是 `{ wheelchair: PlanResponse, low_vision: PlanResponse }`。
`divergence` 欄位是一句話講清楚兩者為什麼不同，可以直接顯示在畫面上當旁白。

## 疊路線要看的欄位

`EvaluatedRoute.legs` 是 `AnnotatedLeg[]`，每個 leg 有：

```ts
{
  path: LatLngPoint[],           // 直接餵給 Polyline3DElement 的座標陣列
  geometry_precision: string,    // 'transit_shape' | 'road_snapped' | 'approximate' | 'missing'
  mode: 'walk' | 'metro' | 'bus',
  name: string,
}
```

**畫線邏輯建議**：

```ts
for (const leg of route.legs) {
  if (leg.path.length === 0) continue;   // 'missing'，這段跳過不畫

  const polyline = new Polyline3DElement({
    path: leg.path.map(({ lat, lng }) => ({ lat, lng, altitude: 3 })),
    strokeColor: colorForMode(leg.mode),   // walk / metro / bus 用不同顏色
    strokeWidth: 6,
  });
  map.append(polyline);
}
```

### 關於 `geometry_precision`

步行段在後端設定 `GOOGLE_ROUTES_API_KEY` 後，會以 Google Routes API 的 `WALK`
模式取得高品質 GeoJSON 路網幾何，並標成 `road_snapped`。

公車段在設定 `TDX_CLIENT_ID` 與 `TDX_CLIENT_SECRET` 後，會讀取 TDX 官方 WKT
Shape，自動依 RouteUID、方向與上下車站裁切，並標成 `transit_shape`。TDX 暫時失敗時
先降級到 Google Routes API `DRIVE` 的 `road_snapped` 路網；兩者皆不可用才使用端點線。

其餘情況會是：

- 走廊種子資料手打了車站、站牌、出口、目的地建築的座標
- `approximate`：兩點之間是**直線**，不是真實道路或捷運軌道的 shape；外部 API
  未設定或暫時失敗時也會安全降級到這個值
- 所以路線看起來會像用直線連接幾個點，不會貼著實際道路彎曲

建議：若有時間，用**虛線**
畫 `approximate` 的路段，會比實線更誠實。如果看到 `missing`，代表資料完全缺漏，
邏輯上就跳過不畫，這種情況目前不該出現（已用 `verify_geometry.py` 驗證過
17 個 leg 全部至少有 2 個點），但程式仍要處理這個 case 以防未來新增路線時漏填。

## 即將到站與低地板車輛

```http
GET /api/transit/arrivals?route_name=信義幹線&route_uid=TPE15708&direction=1&boarding_stop_uid=TPE170429
```

回傳的每一項車輛會分開標示三種來源：

- `timing_source`：`tdx_live` 或 `demo_simulation`
- `position_source`：`tdx_a2` 或 `demo_simulation`
- `accessibility_source`：目前固定是 `demo_simulation`

TDX A2／ETA 有車牌、所在站序與到站秒數，但目前沒有低地板或輪椅斜坡板欄位。
因此前端可以顯示「適合輪椅」Demo，但必須同時顯示來源，不可把模擬資格包裝成官方即時事實。
後端 15 秒快取；TDX 無班次或暫時失效時仍會回傳帶 `demo_fallback` 的可測試快照。

## 3D 交通場景與目標車

```http
GET /api/transit/scene?target_mode=metro&target_route_name=板南線&target_route_uid=BL&target_direction=0&target_boarding_stop_uid=BL12
```

回傳 `clock_time`、`clock_mode` 與 `vehicles[]`。每個物件包含目前位置、這一段路徑、
初始 `progress`、`segment_duration_seconds`、下一站、預計時間、是否為 `is_target`，以及資料來源。
前端收到快照後用同一個動畫時鐘內插標記位置，每 10 秒重新同步一次。

來源語意不可省略：

- `tdx_station_timetable`：捷運官方站間時刻表推算，**不是列車 GPS**
- `tdx_schedule_interpolation`：公車官方班距沿 TDX Shape 推算，**不是即時車機位置**
- `tdx_a2`：TDX 公車動態位置
- `demo_schedule_interpolation` / `demo_simulation`：Demo 回退資料

`clock_mode=schedule_playback` 代表目前時段沒有可呈現的捷運班次，場景固定播放 14:10 的
公開時刻表，畫面必須顯示「時刻表回放」，不可標成即時。目標公車仍沿用
`/api/transit/arrivals` 的低地板資格與獨立來源標示。

## Firestore 使用者偏好（需使用者主動選擇）

```http
PUT /api/users/{anonymousId}/preferences
Content-Type: application/json

{
  "accessibility_mode": "wheelchair",
  "profile_detail": "電動輪椅",
  "speech_rate": 1.25,
  "theme": "dark"
}
```

同一路徑 `GET` 可讀回。回應中的 `storage_mode` 可能是 `firestore`、`memory` 或
`memory_fallback`；只有 `firestore` 是可跨 Cloud Run instance／重啟的持久化結果。
API schema 刻意不接受 GPS、行程歷史與聊天內容。公開部署仍需 Firebase Auth 或 Identity
Platform 驗證；目前 anonymous id 僅適合受控 Demo，不能當成存取控制。

## `Feature.value` 可能是 `null` —— 不要當成 false

`AnnotatedLeg.features` 裡每一項是 `{ value, confidence, source?, detail? }`。
`value === null` 代表**沒有這筆資料**，跟 `value === false`（確定沒有這項設施）
是不同的事。畫面上如果要顯示設施圖示，這兩種情況的呈現方式應該不同（例如灰色
問號 vs 紅色叉）。

`confidence` 有四種：`verified`（有來源可查）、`regulatory`（法規保證）、
`estimated`（推估）、`unknown`（value 必為 null）。

## `EvaluatedRoute.violations` —— 被排除路線的理由

`excluded` 陣列裡每條路線的 `violations` 是排除原因清單，每個 `reason` 是可以
直接顯示的完整句子（例如「市政府站 1 號出口（僅樓梯）步行至市府大樓 有 28.0
階階梯，輪椅無法通行」）。`caused_by_missing_data: true` 代表排除原因是資料
缺漏而非確定不可行 —— 這種情況建議用不同的視覺樣式（例如「資料不足」標籤），
跟真的違反硬條件的排除區分開來。

## `POST /api/chat` —— 對話介面要串的端點

給負責對話 UI 的人看。**agent 的大腦（理解需求、決定呼叫哪個工具、產生回覆文字）
已經做好在後端**，前端只需要做輸入框、訊息氣泡、把 `camera_commands` 轉交給地圖元件。

### 呼叫方式

```ts
import { sendChatMessage } from '../lib/api';

// sessionId 用 crypto.randomUUID() 產生一次，存在 useState/useRef，整次對話重複使用。
const response = await sendChatMessage(sessionId, '我坐輪椅，要從台北車站到市政府');
```

### 回應裡要看的欄位

```ts
{
  reply: string,                    // 直接顯示成一則 agent 訊息
  camera_commands: CameraCommand[], // 交給地圖元件執行，見下方
  plan: PlanResponse | null,        // 這輪若觸發了規劃，完整結果在這裡
  compare: CompareResponse | null,  // 這輪若觸發了比較，完整結果在這裡
  history: ChatMessage[],           // 完整對話歷史，可用來重新渲染整個對話串
}
```

`plan` / `compare` 為 `null` 是正常情況——代表這輪對話 agent 判斷不需要呼叫規劃
工具（例如使用者在回答 agent 的追問，還沒問到具體路線）。**不要把 `null` 當成
錯誤**，UI 上只顯示 `reply` 文字即可。

一旦 `plan` 非 null，它的 `feasible[].legs[].path` 就是可以直接疊圖的座標，跟
`POST /api/plan` 回傳的東西結構完全一樣——**不需要在對話觸發規劃後再手動呼叫
一次 `/api/plan`**，agent 那次呼叫的完整結果已經包在 `ChatResponse` 裡了。

### CameraCommand —— agent 如何指揮地圖

```ts
{
  action: 'fly_to',           // 目前 agent 只會產生這個 action
  center: { lat, lng, altitude },
  range: 1800,
  tilt: 60,
  heading: 30,
  route_candidate_id: 'metro-direct',
}
```

建議的處理邏輯：

```ts
for (const cmd of response.camera_commands) {
  if (cmd.action === 'fly_to' && cmd.center) {
    map.flyCameraTo({
      endCamera: { center: cmd.center, range: cmd.range, tilt: cmd.tilt, heading: cmd.heading },
      durationMillis: 2500,
    });
  }
}
```

`agent` 決定「該飛去哪」，但飛行的動畫時長、緩動曲線由前端決定——這是刻意的
分工，agent 不直接操作 `Map3DElement`。

### 一個重要的環境需求

`/api/chat` 需要後端設定 `GEMINI_API_KEY`（見 `api/.env.example`）。**沒設定時
會回 HTTP 503**，`detail` 欄位是可以直接顯示的中文錯誤訊息，附取得金鑰的連結。
建議 UI 對 503 做特別處理（例如顯示「AI 助理暫時無法使用」而非泛用錯誤畫面），
因為這在 demo 前是最容易忘記設定的一步。

若金鑰存在但模型已下架或 Gemini 網路請求失敗，端點回 **HTTP 502** 並提供不含
金鑰的診斷訊息。前端此時會改呼叫 `/api/plan`，因此仍可取得含 path 的可導覽路線。

### 已知限制

- Session 存在後端記憶體，**重啟後端會清空所有對話**。demo 前重啟後端記得
  提醒自己第一句話要重講。
- 每輪對話都會累積完整歷史一起送給 Gemini，目前沒有做歷史裁剪，長對話
  （幾十輪以上）可能變慢或超過 context 上限，一日 demo 用不到這個量級。

## 已知限制（demo 前請注意）

- 只有台北車站 ↔ 台北市政府這一組起終點有資料。打其他起終點 `feasible` 和
  `excluded` 都會是空陣列，`summary` 會說明沒有候選路線。
- CORS 目前放行任意 `localhost` / `127.0.0.1` port，本機開發不會卡。部署到
  公開網址前要收緊（見 `api/app/main.py` 的註解）。

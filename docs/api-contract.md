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

## 三個端點

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
  geometry_precision: string,    // 'approximate' | 'missing'
  mode: 'walk' | 'metro' | 'bus',
  name: string,
}
```

**畫線邏輯建議**：

```ts
for (const leg of route.legs) {
  if (leg.path.length === 0) continue;   // 'missing'，這段跳過不畫

  const polyline = new Polyline3DElement({
    coordinates: leg.path,
    strokeColor: colorForMode(leg.mode),   // walk / metro / bus 用不同顏色
    strokeWidth: 6,
  });
  map.append(polyline);
}
```

### 關於 `geometry_precision: 'approximate'`

目前**所有** leg 都是 `approximate`，這是誠實的標示，不是 bug。原因：

- 走廊種子資料手打了車站、站牌、出口、目的地建築的座標
- 但兩點之間畫的是**直線**，不是真實道路或捷運軌道的 shape
- 所以路線看起來會像用直線連接幾個點，不會貼著實際道路彎曲

建議：不用特別處理 `approximate`（反正目前全部都是），但如果有時間，用**虛線**
畫 `approximate` 的路段，會比實線更誠實。如果看到 `missing`，代表資料完全缺漏，
邏輯上就跳過不畫，這種情況目前不該出現（已用 `verify_geometry.py` 驗證過
17 個 leg 全部至少有 2 個點），但程式仍要處理這個 case 以防未來新增路線時漏填。

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

## 已知限制（demo 前请注意）

- 只有台北車站 ↔ 台北市政府這一組起終點有資料。打其他起終點 `feasible` 和
  `excluded` 都會是空陣列，`summary` 會說明沒有候選路線。
- CORS 目前放行任意 `localhost` / `127.0.0.1` port，本機開發不會卡。部署到
  公開網址前要收緊（見 `api/app/main.py` 的註解）。

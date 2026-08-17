# GCP 設定步驟

讓最終 MVP 的 Photorealistic 3D 地圖、道路幾何、Gemini 對話、Firestore 偏好與
Cloud Run 後端可運作的設定清單。只展示 3D 地圖約需 10 分鐘；其餘服務皆為可選增強。

**最小可運作版本只需要 Maps JavaScript API。** Map Tiles API 是給 deck.gl / CesiumJS
那條渲染路線用的，本專案走 `Map3DElement`，不需要它。Routes API、Firestore 與
Cloud Run 依下方需求矩陣選擇啟用。

| 能力 | 需要的服務／憑證 | 未設定時 |
| --- | --- | --- |
| 3D 地圖 | Maps JavaScript API + 瀏覽器金鑰 | 地圖無法載入 |
| 沿道路步行／公車 fallback | Routes API + 後端金鑰 | 使用離線 waypoint 線 |
| 對話式規劃 | Gemini API key（Google AI Studio） | `/api/chat` 回 503；其他端點正常 |
| 公車 Shape／ETA／A2 | TDX Client ID / Secret | 使用 repo Demo 時刻表與示意路徑 |
| 記住匿名偏好 | Firestore Native mode + ADC | 使用 process 記憶體，重啟即消失 |
| 公開後端 | Cloud Run + Cloud Build | 本機 FastAPI 照常運作 |

順手先做：背景下載 [gcloud CLI](https://cloud.google.com/sdk/docs/install)，
之後部署 Cloud Run 會用到，讓它邊裝邊做下面的步驟。

---

## Step 0 · 先確認 credit 在哪裡

**計費帳戶與專案是兩個不同的東西。** 主辦方給的 credit 掛在某個「計費帳戶」上，
專案必須連到**那一個**，而不是個人信用卡。

1. 開 <https://console.cloud.google.com/billing>
2. 若主辦方給的是**兌換碼**，先到他們指定的網址兌換，兌換後才會出現對應的計費帳戶
3. 點進該計費帳戶 → 左側 **Credits** → 確認看得到剩餘額度

看不到額度就先別往下做，回頭問主辦方。

### 先確認登入的是哪個 Google 帳號

如果 credit 是發給某個特定 email，就必須用**那個帳號**登入建專案。
右上角頭像確認一下。用錯帳號是比 organization 更常見的坑。

### 主辦方可能已經開好專案了

有些比賽會直接給一個現成專案。到 <https://console.cloud.google.com> 右上角的
專案選擇器看看有沒有，有就直接用，跳過 Step 1、Step 2。

---

## Step 1 · 建立專案

1. <https://console.cloud.google.com/projectcreate>
2. Project name 填 `taipei-pulse`
3. **Location 欄位顯示「No organization」是正常的**，不用改。
   個人 Google 帳號沒有 organization，專案會直接掛在你的帳號底下，
   credit、API、計費全部照常運作，沒有任何功能受限。
   只有在主辦方明確要求你建在他們組織底下時，才需要改這個欄位。
4. 建好後記下 **Project ID** — 它跟 name 不同，會有隨機後綴，例如 `taipei-pulse-473921`

---

## Step 2 · 連結計費帳戶

1. 漢堡選單 → **Billing**
2. 若專案尚未連結，會顯示「This project has no billing account」→ 點 **Link a billing account**
3. 選 **Step 0 確認過有 credit 的那個帳戶** → **Set account**

直接連結（把 `YOUR_PROJECT_ID` 換成實際 ID）：

```
https://console.cloud.google.com/billing/linkedaccount?project=YOUR_PROJECT_ID
```

驗證：該頁面應顯示一個計費帳戶名稱，而**不是**「This project has no billing account」。
再回到 Billing → **Overview**，應看到專案列在其中，且 credit 額度有顯示。

> **這一步是本專案實際踩到的坑。**
> 主辦方給了 credit 不代表專案連上了它。計費帳戶與專案是兩個獨立的東西 ——
> credit 掛在計費帳戶上，專案必須另外連過去。
>
> 症狀：地圖區域出現變暗的「僅供開發使用 / For development purposes only」浮水印，
> 3D 圖磚完全不載入。
>
> 連結完成後等 2-3 分鐘，並用 `Ctrl+Shift+R` 硬重新載入（避開快取的 Maps script）。

順手做個保險：**Budgets & alerts** → 建一個預算警示（例如 credit 的 80%）。
credit 燒完會自動扣信用卡，這個警示是很便宜的保險。

---

## Step 3 · 啟用 Maps JavaScript API

1. **先確認右上角專案選擇器是 `taipei-pulse`**（在錯的專案上操作是超常見的坑）
2. 漢堡選單 → **APIs & Services** → **Library**
3. 搜尋 `Maps JavaScript API`
4. 點進去 → **Enable**

啟用後若跳轉到問卷頁面，跳過即可。

---

## Step 4 · 建立 API 金鑰

1. **APIs & Services** → **Credentials**
2. **+ CREATE CREDENTIALS** → **API key**
3. 複製金鑰

### 先不要加限制

這是刻意的。先確認地圖出得來，再加限制。若一開始就設限制然後失敗，
你會分不清是計費問題、API 沒開、還是 referer 設錯 —— 三個變數一起動，debug 會很痛苦。

先做 Step 5 驗證成功，**再回到這裡補上限制**：

- **Application restrictions** → **Websites** → 加入這兩筆：
  - `http://localhost:5173/*`
  - `http://127.0.0.1:5173/*`
- **API restrictions** → **Restrict key** → 只勾 **Maps JavaScript API**
- **SAVE**

> ⚠️ **限制設定最多需要 5 分鐘才生效。** 存檔後立刻測試看到失敗是正常的。

---

## Step 5 · 驗證

```powershell
cd web
Copy-Item .env.example .env.local
```

編輯 `web/.env.local`：

```
VITE_GOOGLE_MAPS_API_KEY=AIzaSy...你的金鑰
VITE_GOOGLE_MAPS_VERSION=weekly
```

Google 官方目前建議一般應用使用 `weekly` channel；`alpha` 僅供實驗功能，最終版不需要。

對話式 agent 另使用 Google AI Studio 產生的 Gemini API key，放在 `api/.env`：

```dotenv
GEMINI_API_KEY=你的_Gemini_API_Key
TAIPEI_PULSE_MODEL=gemini-3.6-flash
```

`GEMINI_API_KEY` 只存在後端。不要加 `VITE_` 前綴，也不要放進前端 bundle。

若要讓步行線貼合實際道路與步道路網，另在同一個 GCP 專案啟用 **Routes API**，
建立受伺服器端限制的 API 金鑰，並填入 `api/.env`：

```dotenv
GOOGLE_ROUTES_API_KEY=AIzaSy...你的伺服器金鑰
```

這把金鑰只由 FastAPI 後端使用，不要加上 `VITE_` 前綴，也不要沿用會送到瀏覽器的
Maps JavaScript API 金鑰。未設定時後端會保留原本的端點示意幾何。

公車營運線形由 TDX 提供。在 TDX 會員中心建立應用程式後，把後端專用憑證放進
同一個 `api/.env`（不可放進 `web/.env.local`）：

```dotenv
TDX_CLIENT_ID=你的_Client_ID
TDX_CLIENT_SECRET=你的_Client_Secret
```

可用 `.\.venv\Scripts\python.exe verify_tdx_shape.py` 確認信義幹線與忠孝幹線都取得
`transit_shape`；未設定或 TDX 暫時不可用時會依序降級到 Google DRIVE 與離線端點線。

若要讓「記住偏好」真正跨服務重啟保存，請在同一個 GCP 專案建立 **Firestore Native mode**
資料庫，Cloud Run service account 加上 `roles/datastore.user`，並在 `api/.env`（本機）或
Cloud Run 環境變數設定：

```dotenv
FIRESTORE_PROJECT_ID=你的_GCP_Project_ID
FIRESTORE_DATABASE=(default)
```

本機使用 `gcloud auth application-default login`；Cloud Run 直接使用服務帳戶，不要下載或提交
service-account JSON。資料寫在 `users/{anonymousId}/settings/preferences`，只含障礙模式、簡短輔具說明、
語速與亮暗主題，不含定位、行程或對話。沒設定 Firestore 時 API 會回報 `storage_mode=memory`，
方便測試但服務重啟後會消失。

**重啟 dev server**（新增 `.env` 檔案 Vite 不會熱更新）：

```powershell
cmd /c "npm run dev"
```

開 <http://localhost:5173>。成功的話會看到市政府站上空、傾斜 67.5 度的 3D 台北，
右上角狀態顯示「3D 地圖就緒」，底部四個按鈕可飛到台北車站、101、整條走廊。

---

## Step 6 · Cloud Run 後端（選用）

`api/Dockerfile` 已符合 Cloud Run 的 `$PORT` 契約，可直接從 `api/` 原始碼部署：

```powershell
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com
gcloud run deploy taipei-pulse-api --source api --region asia-east1
```

敏感值應透過 Cloud Run 的環境變數／Secret Manager 設定，不應烘進 image。Cloud Run
service account 若要寫 Firestore，需有 `roles/datastore.user`。目前 API 沒有身分驗證與
速率限制，因此只建議受控 demo；公開服務前必須加上 Firebase Auth／Identity Platform、
明確 CORS allowlist 與 rate limiting。

前端目前是 Vite SPA，repo **沒有綁定特定 Hosting 產品**。部署到任意靜態主機時，必須
把同源 `/api/*` 反向代理到 Cloud Run；本機開發則由 `web/vite.config.ts` 代理到 8000。

---

## 出錯時的對照表

| 症狀 | 真正的原因 |
| --- | --- |
| 訊息含**「僅供開發使用」**/ For development purposes only | **專案沒連結計費帳戶。**這是最明確的訊號，看到它就直接去修 Step 2，不用查別的 |
| 畫面顯示「Google Maps 拒絕了這個 API 金鑰」 | 計費未連結、API 未啟用、或 referer 限制未包含 `localhost:5173` |
| 「VITE_GOOGLE_MAPS_API_KEY 未設定」 | `.env.local` 未建立、變數名打錯、或未重啟 dev server |
| 「載入 maps3d 函式庫失敗」 | 確認 Maps JavaScript API 已啟用、金鑰限制正確，並使用 `weekly`；`alpha` 不是必要條件 |
| 地圖框出現但全黑 / 只有灰底 | 幾乎都是計費未連結。2D 地圖無計費會出圖但打浮水印，**3D Tiles 是直接不載入** |
| 設定都對但仍然失敗 | 剛改過金鑰限制，等 5 分鐘 |

### 錯誤碼會直接顯示在畫面上

Google Maps 認證失敗時不會 reject promise，只會呼叫 `window.gm_authFailure`
並把具體錯誤碼寫進 console。本專案已在 `web/src/lib/googleMaps.ts` 攔截這兩者，
**錯誤碼與對應的處理方式會直接顯示在畫面的錯誤框裡**，不需要自己去翻 console。

若想看原始訊息，DevTools 的 Console 仍會印出 Google 的完整輸出與文件連結。
錯誤碼名稱本身就是答案：

| 錯誤碼 | 意思 |
| --- | --- |
| `BillingNotEnabledMapError` | 計費帳戶沒連結 |
| `ApiNotActivatedMapError` | Maps JavaScript API 沒啟用 |
| `RefererNotAllowedMapError` | referer 限制沒包含目前網址 |
| `InvalidKeyMapError` | 金鑰貼錯或有多餘空白 |

---

## 關於金鑰安全

Vite 會把 `VITE_` 開頭的環境變數**編譯進前端 bundle**。這把金鑰在 build 出來的網站裡
是公開可見的，任何人打開 DevTools 都拿得到。這不是 bug — Maps JS API 本質上就是
前端直接呼叫。

因此**真正保護金鑰的機制是 referer 限制**，不是把它藏起來。這也是為什麼 Step 4 那個
限制設定在 demo 上線前一定要補回去，否則別人可以拿你的金鑰燒你的 credit。

`.env.local` 已列入 `.gitignore`，不會被 commit。但仍請注意：
**不要把金鑰貼到 chat、issue 或簡報截圖裡。**

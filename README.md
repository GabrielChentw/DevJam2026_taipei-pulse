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
| 後端 | Cloud Run · FastAPI |
| Agent | Agent Development Kit (ADK) + Gemini |
| 資料庫 | Firestore |
| 路線候選 | Google Routes API（含離線 fallback） |

示範範圍：捷運板南線 台北車站 ↔ 市政府 走廊及沿線公車。

## 快速開始

### 前置作業

在 GCP Console 完成三件事：

1. 建立專案並**連結有 credit 的計費帳戶**
2. 啟用 **Maps JavaScript API**（只需要這一個，不需要 Map Tiles API）
3. 建立 API 金鑰

逐步操作與疑難排解見 **[`docs/setup-gcp.md`](docs/setup-gcp.md)**。

### 前端

```powershell
cd web
Copy-Item .env.example .env.local
# 編輯 .env.local，填入 VITE_GOOGLE_MAPS_API_KEY
cmd /c "npm install"
cmd /c "npm run dev"
```

開 <http://localhost:5173>，應該看到市政府站上空的立體台北、板南線七個車站標記，
底部相機按鈕可飛到台北車站、101、整條走廊。

> **Windows 注意**：必須用 `cmd /c` 前綴，否則 PowerShell 的執行原則會擋住 npm。
> 原因與永久解法見 [`docs/README.md`](docs/README.md#windows-上的注意事項)。

改 `.tsx` / `.css` 會熱更新。改 **`.env.local`**、`vite.config.ts`、`package.json`
必須**重啟 dev server**（Vite 只在啟動時讀這些檔案）。

## 專案結構

```
docs/                     架構文件與設定指南
scripts/                  診斷與環境建置工具（PowerShell）
web/
  public/simple-3d.html   最小重現頁，用於區分設定問題與程式問題
  src/
    lib/googleMaps.ts     Maps API 載入器 + 錯誤攔截
    components/Map3D.tsx  3D 地圖元件
    data/corridor.ts      板南線走廊座標與相機定位點
    App.tsx
```

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

## 目前進度

- [x] 架構設計與圖表
- [x] 前端骨架 + Photorealistic 3D 地圖 + 相機控制 + 車站標記
- [x] GCP 環境建置與驗證工具鏈
- [ ] 走廊無障礙種子資料（板南線 7 站）
- [ ] Profile 驅動的路線評分引擎
- [ ] ADK Agent 與對話介面
- [ ] 巴士 3D 移動動畫

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

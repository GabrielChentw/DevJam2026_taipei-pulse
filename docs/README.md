# 文件與圖表

## 主要文件

| 檔案 | 用途 |
| --- | --- |
| `architecture.md` | 最終 MVP 架構、資料流、部署邊界與後續工作 |
| `system-architecture.mmd` | 可編輯的總體架構圖 Mermaid 原始檔 |
| `system-architecture.png` | README、評審文件與簡報可直接使用的點陣圖 |
| `system-architecture.svg` | 可無損縮放的向量圖 |
| `api-contract.md` | 前後端 API 與結構化資料契約 |
| `accessibility-data.md` | 無障礙資料來源、欄位與 fallback 說明 |
| `setup-gcp.md` | Google API、Firestore 與 Cloud Run 設定方式 |
| `taipei-pulse-workflow.png` | 早期 workflow 圖，保留作為開發歷程參考 |

## 執行位置與首次安裝

下列圖表指令都要在 **repo 根目錄**執行，不是在 `docs/` 或 `web/`。首次使用，或根目錄的 `package-lock.json` 更新後，先安裝鎖定版本的工具：

```powershell
# 工作目錄：DevJam2026_taipei-pulse（repo 根目錄）
cmd /c "npm ci"
```

根目錄的 `package.json` 提供 Mermaid 圖表工具；`web/package.json` 才提供前端的 `dev`、`build`、`preview`、`typecheck` 等指令。因此，安裝前端依賴不等於已安裝根目錄的圖表工具。

若執行時出現 `Missing script`，先確認所在目錄與該目錄的 `package.json`；若找不到 `mmdc`，確認已在根目錄完成上述安裝。

## 重新產生總體架構圖

```powershell
cmd /c "npm run architecture:png"
cmd /c "npm run architecture:svg"
```

輸出會直接更新 `docs/system-architecture.png` 與 `docs/system-architecture.svg`。

## 重新產生 architecture.md 內嵌圖

```powershell
cmd /c "npm run diagrams"
cmd /c "npm run diagrams:svg"
```

輸出位於 `docs/build/`；該目錄是本機產物，不需提交。GitHub 與支援 Mermaid 的 Markdown Preview 也能直接顯示文件中的圖。

## Windows 注意事項

若 PowerShell 執行原則阻擋 `npm.ps1`，使用上面的 `cmd /c` 形式即可，不需要修改系統設定。安裝時出現 esbuild postinstall 警告通常不影響 Vite 使用 optional dependency 中的 Windows 預編譯檔；仍應以實際 `npm run build` 結果為準。

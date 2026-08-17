# 文件與圖表

## 檔案

- `architecture.md` — 架構文件本體，所有圖表以 Mermaid 語法內嵌
- `build/` — 產出的 PNG（已被 `.gitignore` 排除，需要時重新產生即可）

## 四種取得圖檔的方式

依「所需工具由少到多」排列。

### 1. GitHub（零工具）

把 `architecture.md` push 上去，GitHub 會自動渲染 mermaid 區塊。適合讓隊友看。

### 2. VS Code / Kiro 預覽（零安裝）

開啟 `architecture.md`，按 `Ctrl+Shift+V` 開 Markdown Preview。

### 3. mermaid.live（要放進簡報時最快）

前往 <https://mermaid.live>，把 `architecture.md` 裡任一個 ```` ```mermaid ```` 區塊的內容
貼進左側編輯器，右上角 **Actions → PNG / SVG** 匯出。

改個 theme 或背景色只要點兩下，趕 demo 簡報時這是最有效率的路徑。

### 4. 本機批次產圖（一行指令出全部）

```powershell
npm run diagrams
```

輸出 `docs/build/architecture-1.png` ～ `architecture-4.png`，依文件中出現順序編號：

| 檔案 | 對應圖表 |
| --- | --- |
| `architecture-1.png` | 一日版架構 |
| `architecture-2.png` | Profile 驅動的路線評分 |
| `architecture-3.png` | Agent 對話流程 |
| `architecture-4.png` | 完整願景架構（Roadmap） |

需要向量圖（簡報放大不失真）時：

```powershell
npm run diagrams:svg
```

## Windows 上的注意事項

### PowerShell 執行原則會擋住 npm

這台機器的 `Get-ExecutionPolicy` 全部是 `Undefined`，在 Windows 用戶端等同 `Restricted`，
會導致 `npm.ps1` 無法載入：

```
npm : 因為這個系統上已停用指令碼執行，所以無法載入 ...\npm.ps1 檔案
```

兩個解法：

**A. 每次都用 `cmd /c` 繞過**（不改系統設定）

```powershell
cmd /c "npm run dev"
```

**B. 放寬目前使用者的執行原則**（一次設定，之後 `npm` 直接可用）

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`RemoteSigned` 允許本機指令碼執行、但從網路下載的指令碼仍需簽章。這是 Windows 上做
Node 開發的常見設定。**這會變更你的使用者層級安全設定，請自行決定是否套用。**

### esbuild 的 postinstall 警告

npm 11 之後預設不執行相依套件的 install script，安裝時會看到：

```
npm warn allow-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

**這個警告可以忽略。** esbuild 透過 optional dependencies 提供各平台的預編譯執行檔
（`@esbuild/win32-x64`），postinstall 只是備援路徑。已實測 Vite 7.3.6 正常啟動。

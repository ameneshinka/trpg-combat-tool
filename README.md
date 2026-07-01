# 拚點戰鬥系統 — 戰鬥引擎

KP 帶團用的拚點戰鬥輔助網頁。純靜態、無 build step，規則寫在資料裡、引擎通用。

## 快速開始（單機）

直接用瀏覽器開 `index.html`，或起個靜態伺服器：

```
python dev-server.py 8731     # 開發用（送 no-cache 標頭）
# 或
python -m http.server 8731
```

然後開 `http://localhost:8731`，按「載入範例名單 → 開始戰鬥」即可手動打一場。

- 機率加權硬幣由程式自動擲；其餘骰（技能抽選 1d6×2、傷害骰、凝神 1d20）為手動輸入欄位。
- 每張角色卡上有 KP 手動調整面板（設 HP／專注力／套用任意狀態層級）。
- NPC／技能／被動／印記透過設定畫面的 JSON 名單定義，見 `examples/npc-guide.json`。

## 第二階段：跨裝置連線（KP 端權威）

一台當 KP（跑引擎、權威），其他人當玩家（唯讀鏡像 + 送宣告／骰值）。

### Firebase 設定（一次性）

1. 到 <https://console.firebase.google.com> 建立專案。
2. 建立 **Realtime Database**（測試模式即可）。
3. 專案設定 → 你的 Web 應用程式 → 複製 config，填進 `js/firebase-config.js`
   （尤其是 `databaseURL`）。
4. 未填 config 時，連線模式自動停用，單機照常可用。

> ⚠ **原型階段安全性**：目前規則寬鬆（有房號即可讀寫），任何知道房號者都能讀寫該房。
> 適合 Discord 語音跑團的信任情境，但**請勿放真實隱私資料**。嚴格 Auth 規則留待後續。

### 使用流程

- **KP**：選「建立房間」→ 產生房號 → 開始戰鬥。把房號告訴玩家。
- **玩家**：選「加入房間」→ 輸入房號與暱稱 → 選擇要控制的角色 → 即時看到戰況，
  輪到自己角色時可直接填骰／宣告，KP 端會採用（KP 也能代填／覆寫；最終配對由 KP 裁定）。

### 已知限制

- **KP 在「回合進行中」重整**會遺失當前回合的進度（引擎的 generator 執行狀態無法序列化），
  重連後會從**該回合開頭**重新開始。回合與回合**之間**重整則安全（自動存檔還原）。
- **玩家**重整永遠安全（不持有引擎，重連即取最新狀態）。
- 換一台裝置／清掉瀏覽器資料當 KP 重連時，因本機沒有戰鬥存檔而無法還原。

## 檔案結構

```
index.html            入口 + 設定/戰鬥兩個畫面
style.css
dev-server.py         開發用 no-cache 靜態伺服器
js/
  data.js             資料模型工廠 + 狀態目錄 + 範例名單
  firebase-config.js  ← 使用者填入 Firebase 設定
  sync.js             同步層（Realtime Database，用到才載入 SDK）
  ui.js               面板/紀錄渲染 + 三模式（solo/kp/player）+ 表單
  app.js              設定畫面 + 模式切換 + 重連
  engine/
    slotmap.js        條件直譯器、slotMap 結算、抽選、有效威力/DEX
    clash.js          §6 拚點演算法
    damage.js         §7 傷害結算（逐枚、凝神、混亂中途重檢）
    triggers.js       §8 狀態觸發 + 技能效果處理器（印記施加/讀取）
    turncycle.js      §5 六階段回合生命週期 + §9 攔截
examples/
  npc-guide.json      NPC 建資料三階範例（含印記、形態轉換）
```

## 規格

見 `拚點戰鬥系統_規格書.md`（規則以該文件為準）。

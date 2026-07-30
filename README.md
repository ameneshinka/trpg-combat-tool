# 拚點戰鬥系統 — 戰鬥追蹤工具

KP 帶線上跑團時，與玩家共用的**戰鬥狀態追蹤與計算工具**。純靜態、無 build step。

## 規則的真相來源：三個 skill

程式碼**不**內含規則定義。所有規則以 skill 為準（舊的 `拚點戰鬥系統_規格書.md` 已作廢刪除）：

| Skill | 負責 |
|------|------|
| `trpg-clash-rules` | **規則的單一真相來源** —— 拚點、傷害、狀態、回合流程、角卡對應數值 |
| `trpg-combat-webapp` | 怎麼實作 —— 架構決策、資料模型、KP 介面、同步、部署紀律 |
| `trpg-character-design` | 角色設計與平衡分析方法 |

改動任何計算邏輯前，先讀 `trpg-clash-rules`。

## 快速開始

```bash
python dev-server.py 8731
```
開 <http://localhost:8731>。直接開 `index.html`（file://）也能跑單機。

- **單機**：KP 一人操作，完整打完一場。
- **建立房間（KP）／加入房間（玩家）**：需先填 `js/firebase-config.js` 的 `databaseURL`。
  KP 端權威 —— 玩家只送宣告／骰值，KP 採用後才寫入正式狀態。

**回歸測試**：開 <http://localhost:8731/tests/>（83 項，含 skill 指定的兩個驗算）。

## 檔案結構

```
engine/               純計算，無 DOM 依賴、可單元測試
  states.js           層數/級數管線、持續狀態、觸發、混亂/恐慌、震顫/瀑
  clash.js            拚點（碎幣模型、綠幣對消、判輸、專注力結算）
  damage.js           傷害（逐枚累加、分組相乘、凝神、防守）
  passives.js         被動「具名函式」註冊表（邏輯寫死在這）
  turn.js             六階段控制器、DEX 定序、攔截、槽位、抽技能
data/
  characters.js       ★ 唯一的「改平衡」檔案：數值、技能組成、tuning
ui/
  panels.js           實體面板、結算順序、事件 log
  battle.js           推進 turn generator、渲染手動骰與宣告表單
  app.js              設定畫面、連線模式、KP 裁定玩家輸入
js/
  sync.js             Firebase 同步層（SDK 用到才動態載入）
  firebase-config.js  ← 填你的 Firebase 設定
tests/                回歸測試（瀏覽器開啟）
database.rules.json   Firebase 安全規則
```

**調平衡只改 `data/characters.js`**，永遠不用進 `engine/`。
被動邏輯是程式碼（形狀差異太大，資料驅動表達不了跨實體偵測／遞迴／延遲債務），
但**數字一律放在角色的 `tuning`**。

## 目前狀態

- ✅ 引擎：拚點、傷害、狀態、六階段、DEX 定序、攔截、防守／閃躲、自訂資源
- ✅ 回歸測試 83 項全過（含 skill 的碎幣驗算與 294 傷害驗算）
- ✅ Firebase 同步、KP 權威、玩家選角與輸入通道
- ⏳ **四名 PC 的技能組尚未填寫** —— `data/characters.js` 的 `PC_TEMPLATES` 有骨架與定位註解，
  補上技能後即可加入名單（建議搭 `trpg-character-design` skill 做平衡檢查）
- 目前名單是兩個測試用角色，數值刻意對齊 skill 的驗算範例，方便桌邊快速驗證引擎沒壞

## 未定義的裁決（本工具的暫行選擇）

規則 skill 未明訂、實作時必須選一個做法的地方。**要改請直接說**：

1. **【防守】是否需要拚贏才生效？**
   本工具採「**使用即生效**」——不論拚點輸贏都給臨時生命值。
   理由：臨時生命值的用途就是吸收這次傷害；若只在拚贏時生效，而拚贏本來就不會被打中，效果會近乎無用。

2. **無人攻擊時使用【防守】** → 照樣給臨時生命值（視為自我增益）。

3. **玩家端可自行填寫自己角色的手動骰**（1d6／傷害乘數／凝神），KP 端採用。
   `confirmPairing` 與 NPC 槽位永遠只有 KP 能操作。

## 已知限制

- **不使用 localStorage／sessionStorage**（依 webapp skill）。
  → 重整後 clientId 會變：玩家需重選角色；KP 的狀態從 Firebase `/state` 還原。
- Firebase 設定金鑰會公開在前端（正常），**但安全規則必須發布**（見 `database.rules.json`）。
- 執行期**不呼叫任何 LLM** —— 戰鬥計算是確定性運算，必須每次一致。

## 部署紀律（webapp skill）

- 平衡測試在本機跑，不用每次都部署。
- 跑團**前一天**定版、部署、自己完整測一場。
- **帶團當天不動程式碼**。桌邊要調就用 KP 面板的數值覆寫（只改數字、不改邏輯），事後再回頭改 `characters.js`。

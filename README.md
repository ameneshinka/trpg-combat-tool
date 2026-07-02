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
- **角色／技能／效果／被動／形態轉換全部用表單編輯**（三欄：清單／表單／即時預覽），
  草稿自動儲存；「進階 JSON 模式」drawer 供貼上/匯出整份名單，與表單雙向同步。
  資料格式見下方參考與 `examples/npc-guide.json`。

## 第二階段：跨裝置連線（KP 端權威）

一台當 KP（跑引擎、權威），其他人當玩家（唯讀鏡像 + 送宣告／骰值）。

### Firebase 設定（一次性）

1. 到 <https://console.firebase.google.com> 建立專案。
2. 建立 **Realtime Database**。
3. 專案設定 → 你的 Web 應用程式 → 複製 config，填進 `js/firebase-config.js`
   （尤其是 `databaseURL`）。
4. **發布安全規則**：Firebase Console → Realtime Database → 「規則」分頁 →
   貼上本 repo 的 [`database.rules.json`](database.rules.json) 內容 → 發布。
   （鎖定模式下連線功能會整個 Permission denied；全開模式則任何人可讀寫整個資料庫——
   這份規則是兩者的中間值，也是連線功能能動的前提。）
5. 未填 config 時，連線模式自動停用，單機照常可用。

> **安全模型（無登入、房號即密鑰）**：規則只開放 `/rooms/{房號}` 底下的讀寫，
> 房號格式受驗證、房間清單無法被列舉（猜不到房號就進不來）、資料結構與欄位長度受限制。
> 知道房號的人可以讀寫該房——適合 Discord 語音跑團的信任情境，
> **請勿放真實隱私資料**。更嚴格的 Anonymous Auth + KP 專屬寫入權限留待後續。

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
  ui.js               面板/紀錄渲染 + 三模式（solo/kp/player）+ 戰鬥表單
  editor.js           表單式名單編輯器（三欄、效果/條件/被動建構器、即時預覽、JSON 雙向同步）
  app.js              設定畫面 + 模式切換 + 重連
  engine/
    slotmap.js        條件直譯器、slotMap 結算、抽選、有效威力/DEX
    clash.js          §6 拚點演算法
    damage.js         §7 傷害結算（逐枚、凝神、混亂中途重檢）
    triggers.js       §8 狀態觸發 + 技能效果處理器（印記施加/讀取）
    turncycle.js      §5 六階段回合生命週期 + §9 攔截
examples/
  npc-guide.json      NPC 建資料範例（印記、形態轉換、喚出、被動、殘響）
```

## 資料格式參考（規則寫在資料裡）

所有內容以 JSON 名單定義，引擎通用、新增內容免改程式。完整範例見 `examples/npc-guide.json`。

### 技能效果（skill.useEffects / hitEffects / 被動 effects 共用）

| type | 說明 |
|------|------|
| `applyState` | 施加狀態：`{ who:"self"\|"target", state, layerDelta, levelDelta, isMark }` |
| `invokeSkill` | 喚出技能：`{ skillId, targetRef:"target"\|"self" }` 繞過骰選直接打出（可為 `drawable:false`） |
| `tremorBurst` | 震顫爆發：`{ who }` 混亂值上修＝震顫級數，然後震顫歸零（不扣血） |
| `burstResonance` | 瀑殘響：`{ who, burst:"血瀑"\|"炎瀑"\|"荊棘瀑" }` 目標須帶該瀑標記；扣血＝混亂值上修＝⌊(震顫＋夥伴)×50%⌋，然後夥伴與震顫歸零（標記保留、可重複引爆） |
| `heal` / `tempHp` / `focus` | 數值：`{ who, amount }` |

> 「瀑」是純標記（無層/級），由 `applyState`（state 為 `血瀑`/`炎瀑`/`荊棘瀑`）貼上、持續存在，
> 由對應殘響效果引爆。夥伴狀態：血瀑→失血、炎瀑→延燒、荊棘瀑→開裂。震顫平常只累積級數，
> 遇 `tremorBurst`／`burstResonance` 才一次性化為混亂值上修（門檻追上當前 HP 即提早進入混亂）。

效果可加 `condition`（見下）做條件式觸發。

### 條件（skill.conditions / slotMapRule.condition / passive.condition / effect.condition）

`{ type, who:"self"\|"target", ... }`：
- `hasState`（`state`, `minLayer?`, `minLevel?`）、`stateLayerEquals` / `stateLevelEquals`（`state`, `value`）
- `not`（`cond`）、`and` / `or`（`conds[]`）、`always`

技能條件式威力：`skill.conditions = [{ condition, basePowerDelta, coinPowerDelta }]`。

### 被動（entity.passives[]）

`{ id, name, trigger, condition?, chance?, target, targetState?, effects[] }`
- `trigger`：`turnStart`（§5 階段一）、`turnEnd`（§5 階段六，施加狀態自動豁免當回合層-1）、`interceptOverride`（§9 攔截例外）
- `target`：`self` / `randomEnemy` / `randomEnemyWithout`(配 `targetState`) / `lowestHpEnemy` / `allEnemies` / `randomAlly`
- `chance`：0~1，省略=必定；有隨機成分時工具自動決定並暫停讓 KP 覆寫

### 形態轉換（entity.slotMapRules[]）

`{ condition, slot:"A"\|"B"\|"C", setSkillId, priority }`——條件成立時把某槽位改指向另一技能（替換/解鎖）。

## 規格

見 `拚點戰鬥系統_規格書.md`（規則以該文件為準）。

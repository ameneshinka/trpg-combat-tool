// ============================================================
// 角色資料（唯一的「改平衡」檔案）
// 規則來源：trpg-clash-rules skill（references/authoring.md）
// 架構原則（trpg-combat-webapp skill）：邏輯寫死在 engine/passives.js，數字外放在這裡。
//   → 調平衡只改本檔，永遠不用進 engine/。
//
// ⚠ 本檔目前是「骨架」：四名 PC 的技能組仍在調整中（見 party-context）。
//   把真實技能文本補進來時，照下方對照表換算數值，並用 trpg-character-design skill 做平衡檢查。
// ============================================================
(function (global) {
  "use strict";

  // ============================================================
  // 角卡 → 數值 對照表（authoring.md）
  // ------------------------------------------------------------
  // 硬幣數量（依該技能所用武器的技能熟練度）
  //   ≤40 → 1D2　│　41–65 → 1D2 +1　│　66–90 → 1D2 +2　（至少 1 枚）
  //   ⚠ 可增加但選擇不增加時：每放棄一枚硬幣，「每一枚」硬幣的威力 +50%
  //
  // 基礎威力（依技能熟練度）
  //   ≤30 → 1 │ 31–45 → 2 │ 46–60 → 3 │ 61–75 → 5 │ 76–90 → 7 │ 91–99 → 9 │ ≥100 → 12
  //
  // 硬幣威力（依武器對應屬性：格鬥類與投擲 → STR；射擊類 → INT）
  //   ≤40 → +3 │ 41–50 → +4 │ 51–60 → +5 │ 61–70 → +6
  //   71–80 → +9 │ 81–90 → +12 │ 91–99 → +15 │ ≥100 → +20
  //
  // 防禦型技能（硬幣數量皆為 1，不受抽選限制，同回合可用多次）
  //   【防守】基威 ← SIZ、幣威 ← CON、效果：臨時生命值 + 最終威力 × 5
  //   【閃躲】基威 ← 「閃避」技能、幣威 ← LUK、效果：躲掉攻擊型技能
  //          ⚠ 硬幣損失持續到回合結束（作用域唯一例外）
  //
  // ⚠ 平衡註記：高階角色的幣威佔最終威力比重遠大於基威
  //   （基威 7、幣威 +9、3 枚 → 基威只佔 21%）
  //   → 用【虛弱】削基威效果有限；【恍惚】（歸零幣威）極強。
  // ============================================================

  const helpers = {
    coinsFromProficiency: function (p, rolled1d2) {
      const bonus = p <= 40 ? 0 : (p <= 65 ? 1 : 2);
      return Math.max(1, (rolled1d2 || 1) + bonus);
    },
    basePowerFromProficiency: function (p) {
      if (p <= 30) return 1;
      if (p <= 45) return 2;
      if (p <= 60) return 3;
      if (p <= 75) return 5;
      if (p <= 90) return 7;
      if (p <= 99) return 9;
      return 12;
    },
    coinPowerFromAttribute: function (a) {
      if (a <= 40) return 3;
      if (a <= 50) return 4;
      if (a <= 60) return 5;
      if (a <= 70) return 6;
      if (a <= 80) return 9;
      if (a <= 90) return 12;
      if (a <= 99) return 15;
      return 20;
    }
  };

  // ---------------- 建構工廠 ----------------
  function skill(o) {
    return {
      id: o.id,
      name: o.name,
      type: o.type || "attack",          // "attack" | "defense"
      drawable: o.drawable !== false,     // false = 不進抽選池，只能被解鎖或喚出
      isDodge: !!o.isDodge,               // 【閃躲】：硬幣損失持續到回合結束
      isGuard: !!o.isGuard,               // 【防守】：臨時生命值 = 最終威力 × 5
      basePower: o.basePower || 0,
      coinPower: o.coinPower || 0,
      coins: o.coins || [],               // 有順序；設計慣例：普通幣在前段、紅幣在後段
      onUse: o.onUse || null,             // function(ctx) 使用時
      onHit: o.onHit || null,             // function(ctx) 命中時
      text: o.text || "",                 // ★ 技能文本：角卡上的原文，桌邊查詢用（顯示在角色詳情浮窗）
      notes: o.notes || ""                //   設計備註：給設計者看的，與 text 分開顯示
    };
  }

  function entity(o) {
    const attrs = Object.assign({ STR: 50, INT: 50, CON: 50, SIZ: 50, LUK: 50 }, o.attributes);
    const lib = (o.skillLibrary || []).map(skill);
    return {
      id: o.id,
      name: o.name,
      isPC: !!o.isPC,
      hp: o.hp, maxHp: o.maxHp !== undefined ? o.maxHp : o.hp,
      dex: o.dex,
      attributes: attrs,
      // --- 執行期欄位（戰鬥開始時初始化）---
      focus: 0,
      tempHp: 0,
      slots: 0,
      skillLibrary: lib,
      slotMap: Object.assign({ A: null, B: null, C: null }, o.slotMap),
      defaultSlotMap: Object.assign({ A: null, B: null, C: null }, o.slotMap),
      slotMapRules: o.slotMapRules || [],
      passives: o.passives || [],
      tuning: o.tuning || {},             // ← 調平衡的數字集中在這
      states: o.states ? JSON.parse(JSON.stringify(o.states)) : {},
      resources: Object.assign({}, o.resources),   // 自訂數值資源（子彈等），不走層數管線
      resourceMax: Object.assign({}, o.resourceMax),
      confusionThresholds: null,          // null → 開戰時用 maxHp 60% 與 0%
      confusionLockTurns: 0,
      panicNextTurn: false, panicRecovering: false,
      isConfused: false, cantActRestOfTurn: false,
      canAct: true,
      dodgeRuntime: null, dodgeRuntimeSkillId: null,
      drawnSkills: [], declarations: [],
      notes: o.notes || ""
    };
  }

  // ---------------- 通用防禦技能 ----------------
  // 每個角色都該有這兩把（數值依角卡）。不受抽選限制、各佔一槽、同回合可多次。
  function makeGuard(siz, con) {
    return {
      id: "guard", name: "防守", type: "defense", isGuard: true,
      basePower: helpers.basePowerFromProficiency(siz),
      coinPower: helpers.coinPowerFromAttribute(con),
      coins: ["normal"],
      text: "增加「最終威力 × 5」的臨時生命值。基礎威力取自 SIZ、硬幣威力取自 CON。" +
        "不受抽選限制（想用就能用），佔一個槽位，同一回合可使用多次。",
      notes: "臨時生命值在階段六「回合結束傷害結算完之後」才歸零。" +
        "本工具的裁決：使用即生效，不論拚點輸贏（否則拚贏本來就不會被打中，效果近乎無用）"
    };
  }
  function makeDodge(dodgeSkillValue, luk) {
    return {
      id: "dodge", name: "閃躲", type: "defense", isDodge: true,
      basePower: helpers.basePowerFromProficiency(dodgeSkillValue),
      coinPower: helpers.coinPowerFromAttribute(luk),
      coins: ["normal"],
      text: "躲掉進攻的攻擊型技能，使其無法命中。基礎威力取自「閃避」技能、硬幣威力取自 LUK。" +
        "不受抽選限制，佔一個槽位，同一回合可使用多次。",
      notes: "⚠ 硬幣作用域的唯一例外：閃躲的硬幣一旦損失，持續到回合結束才恢復。" +
        "拚贏（未損失）→ 可以繼續用同一個閃躲擋下一個攻擊，次數不限；" +
        "拚輸 → 本回合剩下的所有攻擊都會命中"
    };
  }

  // ============================================================
  // 回歸測試／示範用角色
  // 數值刻意對齊 trpg-clash-rules 的兩個驗算範例，方便桌邊快速驗證引擎沒壞。
  // ============================================================
  const TEST_DUMMY = entity({
    id: "test_red", name: "測試假人（紅幣）", isPC: false,
    hp: 200, dex: 10,
    attributes: { STR: 50, INT: 50, CON: 50, SIZ: 50, LUK: 50 },
    skillLibrary: [
      { id: "t_red", name: "四紅幣測試", basePower: 7, coinPower: 3,
        coins: ["red", "red", "red", "red"],
        text: "全紅幣技能。紅幣拚輸時不會消失，只會「碎幣」（本次使用期間硬幣威力視為 +1），" +
          "因此可擲數恆為 4，攻擊次數也恆為 4 下。判輸時機＝所有紅幣皆已碎幣。",
        notes: "clash.md 驗算：拚點威力 19 → 17 → 15；傷害打 4 下 8/9/12/15" },
      { id: "t_normal", name: "四普通幣測試", basePower: 7, coinPower: 9,
        coins: ["normal", "normal", "normal", "normal"],
        text: "全普通幣技能。普通幣拚輸即「損失」（暫時退出序列），可擲數與攻擊次數隨之下降 —— " +
          "普通幣像盾，連敗會雪崩。",
        notes: "damage.md 驗算：損失 1 枚、乘數 4、正反正 → 83/83/128 合計 294" },
      { id: "t_mixed", name: "混搭測試", basePower: 5, coinPower: 4,
        coins: ["normal", "normal", "red", "red"],
        text: "混搭型別：前段兩枚普通幣當緩衝（輸掉即損失），撐過前幾次交換後進入後段紅幣的持久戰。",
        notes: "設計慣例：普通幣連續置於前段、紅幣連續置於後段，不交叉排列" },
      makeGuard(50, 50), makeDodge(50, 50)
    ],
    slotMap: { A: "t_red", B: "t_normal", C: "t_mixed" },
    notes: "引擎驗證用；正式帶團請換成真實敵人"
  });

  const TEST_TARGET = entity({
    id: "test_target", name: "測試標靶", isPC: true,
    hp: 1000, dex: 12,
    attributes: { STR: 50, INT: 50, CON: 50, SIZ: 50, LUK: 50 },
    skillLibrary: [
      { id: "tt_poke", name: "戳", basePower: 1, coinPower: 1, coins: ["normal"],
        text: "最弱的單幣攻擊。1 枚普通幣的技能「輸不起任何一次交換」，但仍能拚（不是一進場就判輸）。" },
      { id: "tt_poke2", name: "再戳", basePower: 2, coinPower: 1, coins: ["normal", "normal"],
        text: "兩枚普通幣的攻擊，用來觀察逐枚傷害結算與反面照打的行為。" },
      { id: "tt_poke3", name: "重戳", basePower: 3, coinPower: 2, coins: ["normal"],
        text: "單幣但基礎威力較高，用來測試拚點威力比較。" },
      makeGuard(50, 50), makeDodge(50, 50)
    ],
    slotMap: { A: "tt_poke", B: "tt_poke2", C: "tt_poke3" },
    notes: "高血量標靶，方便觀察傷害與狀態結算"
  });

  // ============================================================
  // 四名 PC（骨架 —— 技能組待補）
  // 定位摘要來自 trpg-character-design skill 的 party-context。
  // 補資料時：① 依角卡對照表換算基威/幣威/硬幣數 ② 被動邏輯寫進 engine/passives.js
  //          ③ 這裡只放 passive ID 與 tuning 數字 ④ 用 character-design skill 做平衡檢查
  // ============================================================
  const PC_TEMPLATES = [
    {
      id: "pc_yuzuki", name: "夜櫻結月", isPC: true, hp: 60, dex: 12,
      attributes: { STR: 50, INT: 75, CON: 50, SIZ: 50, LUK: 50 },
      notes: "核心：囤【虛弱】→《爆裂綻放》兌換成凝神／傷害強化／強壯。純傷害爆發，全被動（靠《櫻之香》集滿）。原始數值最高（高 INT → 幣威 +9），爆發週期固定約 4 回合、無法加速。",
      tuning: { /* 例：綻放門檻、每回合虛弱收入 */ },
      passives: []
    },
    {
      id: "pc_akira", name: "渡邊旭", isPC: true, hp: 65, dex: 14,
      attributes: { STR: 70, INT: 50, CON: 60, SIZ: 55, LUK: 50 },
      notes: "核心：囤《勁足》→ 門檻歸零換取特殊技能「肉斬骨斷」。定位混亂值推升（控場），半被動。",
      tuning: { /* 例：勁足門檻、歸零時解鎖的技能 id */ },
      passives: []
    },
    {
      id: "pc_will", name: "威爾‧賽爾弗特", isPC: true, hp: 55, dex: 13,
      attributes: { STR: 50, INT: 72, CON: 50, SIZ: 50, LUK: 55 },
      notes: "核心：彈匣【子彈】驅動，鋪震顫層數＋引爆。開場即滿檔但每兩回合要停下換彈。《援護射擊》= 隊友觸發震顫爆發時自動發射技能A ⚠ 屬「玩家無法拒絕」→ 需次數上限（見 tuning.supportShotsPerTurn）。",
      resources: { "子彈": 6 }, resourceMax: { "子彈": 6 },
      tuning: { ammoKey: "子彈", supportShotsPerTurn: 1, supportShotCost: 1, supportSkillId: null },
      passives: []
    },
    {
      id: "pc_kazuma", name: "霧島和真", isPC: true, hp: 58, dex: 11,
      attributes: { STR: 45, INT: 65, CON: 55, SIZ: 50, LUK: 60 },
      notes: "核心：《仁心》驅動治療、《茶乃的秘方藥》自救。補師／減益／專注力，全被動，約 R4–R5 進入完全體。⚠ 仁心是互斥資源：治療與急救（救混亂隊友）共用，急救需滿額。",
      resources: { "仁心": 0 }, resourceMax: { "仁心": 10 },
      tuning: { /* 例：仁心每回合收入、急救門檻 */ },
      passives: []
    }
  ];

  // ============================================================
  // 對外 API
  // ============================================================
  global.Characters = {
    helpers: helpers,
    entity: entity,
    skill: skill,
    makeGuard: makeGuard,
    makeDodge: makeDodge,

    // 目前可用的參戰名單（換成真實角色後改這裡）
    roster: function () {
      return [entity(JSON.parse(JSON.stringify(stripRuntime(TEST_TARGET)))),
              entity(JSON.parse(JSON.stringify(stripRuntime(TEST_DUMMY))))];
    },
    // PC 槽位成長順序（戰鬥輪開始前由 KP 指定；預設照名單順序）
    pcGrowthOrder: function () { return ["test_target"]; },

    // 四名 PC 骨架（技能組待補）
    PC_TEMPLATES: PC_TEMPLATES,
    buildPc: function (id) {
      const t = PC_TEMPLATES.find(function (x) { return x.id === id; });
      if (!t) throw new Error("找不到 PC 骨架：" + id);
      if (!t.skillLibrary || !t.skillLibrary.length) {
        throw new Error(t.name + " 的技能組尚未填寫（見 data/characters.js 的 PC_TEMPLATES）");
      }
      return entity(t);
    }
  };

  // entity() 產出的物件含執行期欄位；重新建構時只留設定欄位
  function stripRuntime(e) {
    return {
      id: e.id, name: e.name, isPC: e.isPC, hp: e.maxHp, maxHp: e.maxHp, dex: e.dex,
      attributes: e.attributes, skillLibrary: e.skillLibrary, slotMap: e.defaultSlotMap,
      slotMapRules: e.slotMapRules, passives: e.passives, tuning: e.tuning,
      states: e.states, resources: e.resources, resourceMax: e.resourceMax, notes: e.notes
    };
  }

})(window);

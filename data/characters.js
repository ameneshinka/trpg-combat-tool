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

  // ---------------- 深拷貝 ----------------
  /**
   * 遞迴深拷貝設定物件，但「函式原樣帶過」。
   * ⚠ 不可以用 JSON.parse(JSON.stringify(...))：那會把技能的 onUse / onHit
   *   與被動的函式整個吃掉。小怪技能十之八九要寫「命中時上震顫」，一定會踩到。
   *   技能 hook 與被動都是無狀態函式，多個實例共用同一份參照是安全的。
   */
  function cloneSpec(v) {
    if (Array.isArray(v)) return v.map(cloneSpec);
    if (v && typeof v === "object") {
      const o = {};
      Object.keys(v).forEach(function (k) { o[k] = cloneSpec(v[k]); });
      return o;
    }
    return v;   // 純值與 function 都走這裡
  }

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
      // --- 效果鉤子（engine/effects.js）---
      // ⚠ coinEffects 依「原始硬幣位置」索引，與 coins 一一對應；
      //   每格 = { onUse, onHead, onHit, afterHit }，不需要的格子放 null。
      coinEffects: o.coinEffects || null,
      onUse: o.onUse || null,             // function(ctx) 技能層級 [使用時]（拚點之前，可改威力）
      onHit: o.onHit || null,             // function(ctx) 整把技能的硬幣都跑完之後
      afterUse: o.afterUse || null,       // function*(ctx) [使用後]；設 ctx.runtime.repeat 可要求重複使用
      onClashLose: o.onClashLose || null, // function(ctx) [拚點拚輸時]（ctx.target = 贏的那一方）
      targetSide: o.targetSide || null,   // "ally" → 以友方為對象（和真技能A）；預設打敵方
      text: o.text || "",                 // ★ 技能文本：角卡上的原文，桌邊查詢用（顯示在角色詳情浮窗）
      notes: o.notes || ""                //   設計備註：給設計者看的，與 text 分開顯示
    };
  }

  function entity(o) {
    const attrs = Object.assign({ STR: 50, INT: 50, CON: 50, SIZ: 50, LUK: 50 }, o.attributes);
    const lib = (o.skillLibrary || []).map(skill);
    return {
      id: o.id,
      blueprintId: o.blueprintId || o.id,   // 同款小怪的所有實例共用同一個藍圖 id（批次操作靠它分組）
      name: o.name,
      baseName: o.baseName || o.name,       // 不含 A/B/C 後綴的本體名（批次提問時顯示用）
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
  // NPC 倉庫（藍圖）
  // ------------------------------------------------------------
  // 一款 NPC 一筆 = 「本體」。戰場上要放幾隻，由編成畫面決定（Characters.spawn）。
  // 每個實例的 HP／臨時HP／專注力／槽位／狀態／印記／資源／宣告 全部各算各的，
  // 共用的只有這裡的定義 —— 所以調平衡只要改這一筆，同款全部同步。
  //
  // 藍圖 = entity() 吃的所有設定欄位，外加三個倉庫展示用欄位：
  //   category    倉庫分組
  //   blurb       卡片上的一句話定位
  //   defaultCount 投放數量預設值
  // ============================================================
  const NPC_LIBRARY = [
    // --------------------------------------------------------
    // 填表範本：哥布林兵
    // 角卡 → 數值的換算過程全部寫在註解裡，照抄就能建下一款小怪。
    // --------------------------------------------------------
    {
      id: "goblin_grunt", name: "哥布林兵",
      category: "小怪",
      blurb: "最基本的雜兵。兩枚硬幣，輸兩次就沒得拚 —— 靠數量壓人，不靠單體。",
      defaultCount: 3,
      hp: 30, dex: 40,   // ⚠ dex = 角卡敏捷值（1–99 尺度），與 PC 同一把尺
      attributes: { STR: 40, INT: 25, CON: 45, SIZ: 35, LUK: 30 },
      skillLibrary: [
        // 【格鬥：棍棒】熟練度 45 → 基威 2；硬幣 1D2(+1)，設計時取 2 枚；STR 40 → 幣威 +3
        { id: "gg_swing", name: "亂棍", basePower: 2, coinPower: 3,
          coins: ["normal", "normal"],
          text: "兩枚普通幣的基本攻擊。輸一次掉一枚，輸兩次就沒有完好硬幣可拚。",
          notes: "熟練度45→基威2　│　1D2(+1) 取 2 枚　│　STR40→幣威+3" },
        // 紅幣版：輸掉只會碎幣（有效幣威視為 +1），可擲數不變 → 適合纏鬥
        { id: "gg_cling", name: "死纏爛打", basePower: 2, coinPower: 3,
          coins: ["normal", "red"],
          text: "前段普通幣當緩衝，後段紅幣輸了也不會消失（碎幣），能一直拚下去。",
          notes: "設計慣例：普通幣在前段、紅幣在後段，不交叉排列" },
        // 綠幣版：專門對付紅幣對手
        { id: "gg_pierce", name: "破盾突刺", basePower: 2, coinPower: 3,
          coins: ["green", "normal"],
          text: "拚點開始前，綠幣與對方的紅幣互相抵銷（雙方都算損失，對方的紅幣不算碎幣）。",
          notes: "綠幣放前段：沒有紅幣可消時，它就退化成一枚普通的緩衝幣" },
        makeGuard(35, 45),    // 防守：基威←SIZ 35、幣威←CON 45
        makeDodge(25, 30)     // 閃躲：基威←閃避技能 25、幣威←LUK 30
      ],
      slotMap: { A: "gg_swing", B: "gg_cling", C: "gg_pierce" },
      notes: "抽選機率 A 75%／B 55.6%／C 30.6% → 主力是《亂棍》，《破盾突刺》是驚喜。"
    },

    // --------------------------------------------------------
    // 回歸測試用假人
    // 數值刻意對齊 trpg-clash-rules 的兩個驗算範例，方便桌邊快速驗證引擎沒壞。
    // --------------------------------------------------------
    {
      id: "test_red", name: "測試假人（紅幣）",
      category: "測試", blurb: "引擎驗算用：碎幣 19/17/15、傷害 294 兩個範例的對照組。", defaultCount: 1,
      hp: 200, dex: 45,
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
    }
  ];

  // ============================================================
  // PC 名單（維持寫死；編成畫面只管 NPC）
  // ============================================================
  const TEST_TARGET_SPEC = {
    id: "test_target", name: "測試標靶", isPC: true,
    hp: 1000, dex: 60,
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
  };

  // ============================================================
  // 四名 PC
  // ------------------------------------------------------------
  // 數值來自使用者提供的角卡，已是換算完的最終值（我逐項對過對照表，全部自洽）。
  // 被動邏輯在 engine/passives.js（具名函式），這裡只放 passive ID 與 tuning 數字。
  // 逐枚硬幣的效果鉤子見 engine/effects.js 的說明。
  //
  // 結算順序（有效 DEX）：旭 90 > 威爾 65 > 結月 60 > 和真 50
  // ⚠ 震顫是旭／威爾／結月三人的共用資源，引爆會清空級數 —— 出招順序要協調。
  // ============================================================

  // 逐枚 [使用時] 消耗子彈；不足 → 停止該技能的傷害結算（威爾被動1）
  function ammoUse(n) {
    return function (ctx) {
      const key = ctx.tuning.ammoKey || "子彈";
      if (!ctx.spend(ctx.self, key, n, "《" + ctx.skill.name + "》消耗" + key)) {
        ctx.stop(ctx.self.name + " 的" + key + "不足 " + n + " 發 → 無法使用該硬幣，停止本技能的傷害結算");
      }
    };
  }
  // 對目標施加【震顫】
  function tremor(layer, level) {
    return function (ctx) { ctx.apply(ctx.target, "震顫", layer, level); };
  }
  // 引爆目標的【震顫】（走 ctx.tremorBurst 才會廣播給威爾的破甲與援護射擊）
  function burst(opts) {
    return function (ctx) { ctx.tremorBurst(ctx.target, opts); };
  }

  // ------------------------------------------------------------
  // 威爾‧賽爾弗特 —— 彈匣驅動，鋪震顫級數 ＋ 引爆
  // ------------------------------------------------------------
  const PC_WILL = {
    id: "pc_will", name: "威爾‧賽爾弗特", isPC: true,
    hp: 220, dex: 65,
    attributes: { STR: 80, INT: 55, CON: 55, SIZ: 55, LUK: 65 },
    sheet: { 力量: 80, 敏捷: 65, 意志: 55, 體質: 55, 外貌: 80, 教育: 60, 體型: 55, 智力: 55, 幸運: 65 },
    resources: { "子彈": 9 }, resourceMax: { "子彈": 9 },
    passives: ["will_magazine", "will_quickload", "will_pierce", "will_support"],
    tuning: {
      ammoKey: "子彈", magazineMax: 9,
      quickReloadFocusCost: 10, quickReloadAmount: 8, quickReloadThreshold: 1,
      supportSkillId: "w_a", supportShotCost: 1,
      cRepeatAmmoThreshold: 2,
      cTremorPerStep: 4, cTremorBonusPerStep: 2, cTremorBonusCap: 5,
      cFragileBonusPerLayer: 1, cFragileBonusCap: 5
    },
    slotMap: { A: "w_a", B: "w_b", C: "w_c" },
    skillLibrary: [
      { id: "w_a", name: "隱・無光伴星", basePower: 5, coinPower: 5, coins: ["normal"],
        coinEffects: [{
          onUse: ammoUse(1),
          onHit: tremor(1, 3)
        }],
        text: "1 枚硬幣｜基礎威力 5｜硬幣威力 +5\n" +
          "硬幣1 [使用時] 消耗 1 枚【子彈】\n" +
          "硬幣1 [命中時] 命中的敵方單位增加 1 層【震顫】層數與 3 級【震顫】級數",
        notes: "唯一會「鋪層」的招 —— 技能B/C 的級數要靠它先鎖住層數才存得住。也是援護射擊自動發射的那一把。" },

      { id: "w_b", name: "連・戰術疊加", basePower: 5, coinPower: 5,
        coins: ["normal", "normal", "normal"],
        coinEffects: [
          { onUse: ammoUse(1), onHit: tremor(0, 3) },
          { onUse: ammoUse(1), onHit: tremor(1, 4) },
          { onUse: ammoUse(1), onHit: tremor(1, 5), afterHit: burst() }
        ],
        text: "3 枚硬幣｜基礎威力 5｜硬幣威力 +5\n" +
          "硬幣1 [使用時] 消耗 1 枚【子彈】／[命中時] 增加 3 級【震顫】級數\n" +
          "硬幣2 [使用時] 消耗 1 枚【子彈】／[命中時] 增加 1 層【震顫】層數與 4 級【震顫】級數\n" +
          "硬幣3 [使用時] 消耗 1 枚【子彈】／[命中時] 增加 1 層【震顫】層數與 5 級【震顫】級數\n" +
          "　　　[命中後] 對命中的敵方單位施加 1 次【震顫爆發】",
        notes: "⚠ 硬幣1 只給級數不給層 → 對「乾淨」的目標那 3 級會整個蒸發（裁決 6，有意的設計張力）。" +
          "先用技能A 鋪層，B 的收益才完整。" },

      { id: "w_c", name: "續・追魂彈幕", basePower: 5, coinPower: 5, coins: ["normal"],
        // [使用時] 的條件式加成：拚點之前算，且「只算一次、全程沿用」（裁決 12）
        onUse: function (ctx) {
          const t = ctx.target;
          if (!t) return;
          const tr = ctx.S.levelOf(t, "震顫");
          const fr = ctx.S.layerOf(t, "易損");
          const cp = Math.min(ctx.tuning.cTremorBonusCap,
            Math.floor(tr / ctx.tuning.cTremorPerStep) * ctx.tuning.cTremorBonusPerStep);
          const bp = Math.min(ctx.tuning.cFragileBonusCap, fr * ctx.tuning.cFragileBonusPerLayer);
          ctx.runtime.coinPowerBonus = cp;
          ctx.runtime.basePowerBonus = bp;
          ctx.log("《追魂彈幕》條件式加成：" + t.name + " 震顫 " + tr + " 級 → 幣威 +" + cp +
            "；易損 " + fr + " 層 → 基威 +" + bp + "（只算一次，重複使用時沿用）");
        },
        coinEffects: [{
          onUse: ammoUse(2),
          // ⚠ onHead 排在凝神判定之後 → 這枚吃不到，留給後續的重複使用（裁決 14）
          onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 6); },
          onHit: tremor(0, 6),
          afterHit: function (ctx) {
            ctx.tremorBurst(ctx.target);
            ctx.apply(ctx.target, "恍惚", 1, 0);
          }
        }],
        // [使用後]：子彈 ≥2 就重新使用。⚠ 只在拚贏／單方面攻擊時才跑（裁決 11）
        afterUse: function (ctx) {
          const key = ctx.tuning.ammoKey || "子彈";
          const need = ctx.tuning.cRepeatAmmoThreshold || 2;
          if (ctx.resource(ctx.self, key) >= need) {
            ctx.runtime.repeat = true;
            ctx.log("《追魂彈幕》剩餘" + key + " " + ctx.resource(ctx.self, key) + " 發（≥" + need + "）→ 重新使用");
          }
        },
        text: "1 枚硬幣｜基礎威力 5｜硬幣威力 +5\n" +
          "[使用時] 對象每有 4 級【震顫】，硬幣1 的硬幣威力 +2（至多 +5）\n" +
          "[使用時] 對象每有 1 層【易損】，硬幣1 的基礎威力 +1（至多 +5）\n" +
          "[使用後] 如果剩餘子彈 ≥ 2，則重新使用此技能\n" +
          "硬幣1 [使用時] 消耗 2 枚【子彈】\n" +
          "　　　[硬幣正面時] 對自己施加 1 層【凝神】層數與 6 級【凝神】級數\n" +
          "　　　[命中時] 增加 6 級【震顫】級數\n" +
          "　　　[命中後] 施加 1 次【震顫爆發】、施加 1 層【恍惚】",
        notes: "滿彈 9 發最多連射 4 次（9→7→5→3→1）。快速裝填在整條連鎖跑完之前不觸發（裁決 9），" +
          "否則會變成無限迴圈。拚輸則完全不發動，子彈一發都不扣（裁決 11、13）。" },

      makeGuard(55, 55),   // 基威 3 ← SIZ 55／幣威 +5 ← CON 55
      makeDodge(65, 65)    // 基威 5 ← 閃避 61–75／幣威 +6 ← LUK 65
    ],
    notes: "彈匣驅動的爆發輸出。開場滿彈 9 發，每個戰鬥輪回滿。" +
      "⚠《援護射擊》沒有次數上限 —— 旭與結月引爆震顫時會自動抽走他的子彈，桌邊要協調出招順序。"
  };

  // ------------------------------------------------------------
  // 夜櫻結月 —— 囤【虛弱】換爆發，全被動
  // ------------------------------------------------------------
  const PC_YUZUKI = {
    id: "pc_yuzuki", name: "夜櫻結月", isPC: true,
    hp: 240, dex: 60,
    attributes: { STR: 50, INT: 80, CON: 60, SIZ: 60, LUK: 65 },
    sheet: { 力量: 50, 敏捷: 60, 意志: 80, 體質: 60, 外貌: 85, 教育: 80, 體型: 60, 智力: 80, 幸運: 65 },
    markMeta: { "櫻之香": { noDecay: true }, "爆裂綻放": { noDecay: true, maxLayer: 1 } },
    // ⚠ 陣列順序 = 同 kind 內的結算順序：撒香(buff) → 檢查全員(cost) → 綻放(cost) → 級數換層(cost)
    passives: ["yuzuki_charisma", "yuzuki_composure", "yuzuki_fragrance", "yuzuki_bloom", "yuzuki_command"],
    tuning: { markKey: "櫻之香", commandThreshold: 20, commandPerLayer: 5, commandMaxLayers: 3 },
    slotMap: { A: "y_a", B: "y_b", C: "y_c" },
    skillLibrary: [
      { id: "y_a", name: "鏡花水月", basePower: 7, coinPower: 9, coins: ["normal", "normal"],
        coinEffects: [
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 2); } },
          { onHit: function (ctx) { ctx.apply(ctx.self, "虛弱", 3, 0); }, afterHit: burst() }
        ],
        text: "2 枚硬幣｜基礎威力 7｜硬幣威力 +9\n" +
          "硬幣1 [硬幣正面時] 對自身增加 1 層【凝神】層數與 2 級【凝神】強度\n" +
          "硬幣2 [命中時] 對自身增加 3 層【虛弱】\n" +
          "硬幣2 [命中時] 對命中的敵方單位施加 1 次【震顫爆發】",
        notes: "她唯一的引爆手段 —— ⚠ 會觸發威爾的援護射擊，抽走他 1 發子彈。" },

      { id: "y_b", name: "月影風清", basePower: 7, coinPower: 9,
        coins: ["normal", "normal", "normal"],
        coinEffects: [
          { onHit: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 2); } },
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 2); },
            onHit: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 0); } },
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 2); },
            onHit: function (ctx) {
              ctx.apply(ctx.self, "虛弱", 3, 0);
              ctx.apply(ctx.self, "凝神", 1, 0);
            } }
        ],
        text: "3 枚硬幣｜基礎威力 7｜硬幣威力 +9\n" +
          "硬幣1 [命中時] 對自身增加 2 級【凝神】強度\n" +
          "硬幣2 [硬幣正面時] +2 級／[命中時] +1 層【凝神】層數\n" +
          "硬幣3 [硬幣正面時] +2 級／[命中時] 對自身增加 3 層【虛弱】、+1 層【凝神】層數",
        notes: "⚠ 每一枚的 [正面時] 級數都排在 [命中時] 給層之前 → 沒有凝神層數時第一筆級數必定蒸發（裁決 18）。" },

      { id: "y_c", name: "月落星沉", basePower: 7, coinPower: 9,
        coins: ["normal", "normal", "normal"],
        coinEffects: [
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 3); },
            onHit: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 0); } },
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 4); },
            onHit: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 0); } },
          { onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 0, 5); },
            onHit: function (ctx) { ctx.apply(ctx.self, "凝神", 2, 0); } }
        ],
        text: "3 枚硬幣｜基礎威力 7｜硬幣威力 +9\n" +
          "硬幣1 [硬幣正面時] +3 級／[命中時] +1 層【凝神】\n" +
          "硬幣2 [硬幣正面時] +4 級／[命中時] +1 層【凝神】\n" +
          "硬幣3 [硬幣正面時] +5 級／[命中時] +2 層【凝神】",
        notes: "堆凝神的主力。凝神級數超過 20 之後由《乘勝指揮》換成層數（層數＝可觸發次數）。" },

      { id: "guard", name: "防守", type: "defense", isGuard: true,
        basePower: 3, coinPower: 5, coins: ["normal"],
        // ⚠ 裁決 24：先 +4 層虛弱，再用「加完的總層數」算幣威加成，且加成無上限
        onUse: function (ctx) {
          ctx.apply(ctx.self, "虛弱", 4, 0);
          const w = ctx.S.layerOf(ctx.self, "虛弱");
          ctx.runtime.coinPowerBonus = Math.floor(w / 3);
          ctx.log("《防守》【虛弱】" + w + " 層 → 幣威 +" + ctx.runtime.coinPowerBonus + "（無上限）");
        },
        afterUse: function (ctx) { ctx.apply(ctx.self, "凝神", 2, 0); },
        text: "1 枚硬幣｜基礎威力 3｜硬幣威力 +5\n" +
          "[使用時] 對自身增加 4 層【虛弱】\n" +
          "[使用時] 自身每有 3 層【虛弱】，防守的硬幣威力增加 1\n" +
          "增加 最終威力 ×5 的臨時生命值。\n" +
          "[使用後] 對自身增加 2 層【凝神】層數",
        notes: "⚠【虛弱】只影響攻擊型技能，不影響防守（裁決 17）→ 囤貨越多，她的防守反而越硬。" +
          "同時也是她「囤虛弱＋鎖凝神層」的主要引擎。" },

      makeDodge(25, 65)    // 基威 1 ← 閃避 ≤30／幣威 +6 ← LUK 65
    ],
    notes: "純傷害爆發，全被動。約每 3 回合觸發一次《爆裂綻放》（除自己外 3 名 PC，每回合撒 1 人）。" +
      "⚠ 閃避技能 ≤30 → 閃躲基威只有 1，她幾乎閃不掉。"
  };

  // ------------------------------------------------------------
  // 渡邊旭 —— 囤〈勁足〉換《肉斬骨斷》，控場／收割
  // ------------------------------------------------------------
  const PC_AKIRA = {
    id: "pc_akira", name: "渡邊旭", isPC: true,
    hp: 240, dex: 90,
    attributes: { STR: 50, INT: 70, CON: 75, SIZ: 50, LUK: 85 },
    sheet: { 力量: 50, 敏捷: 90, 意志: 50, 體質: 75, 外貌: 50, 教育: 75, 體型: 50, 智力: 70, 幸運: 85 },
    markMeta: { "勁足": { noDecay: true } },
    // ⚠ 順序：勁足(buff) → 殺手本位(buff) → 振刀(cost，歸零) → 望月思鄉(cost，回合結束)
    passives: ["akira_stride", "akira_killer", "akira_vibrate", "akira_homesick"],
    tuning: {
      strideKey: "勁足", stridePerTurn: 2, stridePerSwift: 3,
      killerGuardAt: 5, killerGuard: 3,
      killerAmpAt: 10, killerAmp: 3,
      killerWeakenAt: 15, killerWeaken: 3,
      homesickSwift: 4, homesickGuard: 2, homesickAmp: 2,
      vibrateThreshold: 17, vibrateSkillId: "a_d",
      dodgeBaseBonusCap: 4, dodgeFocusCostCap: 10
    },
    slotMap: { A: "a_a", B: "a_b", C: "a_c" },
    skillLibrary: [
      { id: "a_a", name: "前哨試探", basePower: 7, coinPower: 4, coins: ["normal", "normal"],
        coinEffects: [
          { onHit: tremor(1, 3) },
          { onHit: tremor(0, 3) }
        ],
        text: "2 枚硬幣｜基礎威力 7｜硬幣威力 +4\n" +
          "硬幣1 [命中時] 增加 1 層【震顫】層數與 3 級【震顫】級數\n" +
          "硬幣2 [命中時] 增加 3 級【震顫】級數" },

      { id: "a_b", name: "連鎖壓迫", basePower: 7, coinPower: 4,
        coins: ["normal", "normal", "normal"],
        coinEffects: [
          { onHit: tremor(1, 4) },
          { onHit: tremor(0, 6) },
          { onHit: function (ctx) {
              ctx.apply(ctx.target, "震顫", 0, 8);
              ctx.apply(ctx.self, "勁足", 1, 0, { isMark: true, noDecay: true });
            } }
        ],
        text: "3 枚硬幣｜基礎威力 7｜硬幣威力 +4\n" +
          "硬幣1 [命中時] 增加 1 層【震顫】層數與 4 級【震顫】級數\n" +
          "硬幣2 [命中時] 增加 6 級【震顫】級數\n" +
          "硬幣3 [命中時] 增加 8 級【震顫】級數、對自身施加 1 層〈勁足〉" },

      { id: "a_c", name: "終局共震", basePower: 7, coinPower: 4,
        coins: ["normal", "normal", "normal"],
        coinEffects: [
          { onHit: tremor(1, 5) },
          { onHit: function (ctx) {
              ctx.apply(ctx.target, "震顫", 1, 7);
              ctx.apply(ctx.self, "勁足", 1, 0, { isMark: true, noDecay: true });
            } },
          { onHit: function (ctx) {
              ctx.apply(ctx.target, "震顫", 0, 9);
              ctx.apply(ctx.self, "勁足", 1, 0, { isMark: true, noDecay: true });
            },
            afterHit: burst() }
        ],
        text: "3 枚硬幣｜基礎威力 7｜硬幣威力 +4\n" +
          "硬幣1 [命中時] 增加 1 層【震顫】層數與 5 級【震顫】級數\n" +
          "硬幣2 [命中時] 增加 1 層與 7 級、對自身施加 1 層〈勁足〉\n" +
          "硬幣3 [命中時] 增加 9 級、對自身施加 1 層〈勁足〉\n" +
          "　　　[命中時] 對命中的敵方單位施加 1 次【震顫爆發】",
        notes: "⚠ 會觸發威爾的援護射擊。" },

      { id: "a_d", name: "肉斬骨斷", basePower: 16, coinPower: 1,
        drawable: false,   // 只能由《振刀》解鎖（本回合限定、不受抽選限制）
        coins: ["normal", "normal", "red", "red"],
        coinEffects: [
          { onUse: tremor(2, 1), afterHit: burst({ keepLevel: true }) },
          { onUse: tremor(1, 1), afterHit: burst({ keepLevel: true }) },
          { onUse: tremor(2, 1), afterHit: burst({ keepLevel: true }) },
          { onUse: tremor(1, 1), afterHit: burst() }
        ],
        afterUse: function (ctx) {
          ctx.apply(ctx.self, "勁足", 4, 0, { isMark: true, noDecay: true });
        },
        text: "4 枚硬幣｜基礎威力 16｜硬幣威力 +1（硬幣3、4 為紅色硬幣）\n" +
          "硬幣1 [使用時] 增加 2 層【震顫】層數與 1 級／[命中時] 施加【震顫爆發】，此次不歸零級數\n" +
          "硬幣2 [使用時] 增加 1 層與 1 級／[命中時] 施加【震顫爆發】，此次不歸零級數\n" +
          "硬幣3 [使用時] 增加 2 層與 1 級／[命中時] 施加【震顫爆發】，此次不歸零級數\n" +
          "硬幣4 [使用時] 增加 1 層與 1 級／[命中時] 施加【震顫爆發】\n" +
          "　　　[使用後] 對自身施加 4 層〈勁足〉",
        notes: "收割技，不是傷害技（基威 16、幣威 +1，四下打不痛）—— 它的價值是把混亂值一口氣推上去。" +
          "前三枚不歸零級數 → 同一筆級數連炸四次。[使用時] 共給 6 層震顫、四次爆發 −4 層，淨 +2 剛好撐完。" +
          "⚠ 拚輸則 17 層勁足白費（裁決 30）。⚠ 四次爆發會觸發威爾的援護射擊四次。" },

      { id: "guard", name: "防守", type: "defense", isGuard: true,
        basePower: 3, coinPower: 9, coins: ["normal"],
        afterUse: function (ctx) {
          ctx.apply(ctx.self, "勁足", 1, 0, { isMark: true, noDecay: true });
        },
        text: "1 枚硬幣｜基礎威力 3｜硬幣威力 +9\n" +
          "增加 最終威力 ×5 的臨時生命值。\n" +
          "[使用後] 對自身施加 1 層〈勁足〉" },

      { id: "dodge", name: "閃躲", type: "defense", isDodge: true,
        basePower: 5, coinPower: 12, coins: ["normal"],
        // ⚠ 裁決 26：加的是「基礎威力」，上限 +4（文本括號寫「硬幣威力」是筆誤）
        // ⚠ 裁決 32：每擋一次就各觸發一次，兩邊都有每回合累計上限
        onUse: function (ctx) {
          const c = ctx.self._turnCounters = ctx.self._turnCounters || {};
          const cap = ctx.tuning.dodgeBaseBonusCap || 4;
          const want = Math.floor(ctx.S.layerOf(ctx.self, "勁足") / 2);
          const give = Math.max(0, Math.min(want, cap - (c.dodgeBaseBonus || 0)));
          c.dodgeBaseBonus = (c.dodgeBaseBonus || 0) + give;
          ctx.runtime.basePowerBonus = give;
          if (give) ctx.log("《閃躲》〈勁足〉加成 → 基威 +" + give + "（本回合累計 " + c.dodgeBaseBonus + "／" + cap + "）");
        },
        afterUse: function (ctx) {
          const c = ctx.self._turnCounters = ctx.self._turnCounters || {};
          const cap = ctx.tuning.dodgeFocusCostCap || 10;
          const want = Math.floor(ctx.S.layerOf(ctx.self, "勁足") / 2) * 4;
          const pay = Math.max(0, Math.min(want, cap - (c.dodgeFocusCost || 0)));
          c.dodgeFocusCost = (c.dodgeFocusCost || 0) + pay;
          if (pay) ctx.addFocus(ctx.self, -pay, "《閃躲》的代價");
        },
        text: "1 枚硬幣｜基礎威力 5｜硬幣威力 +12\n" +
          "[使用前]〈勁足〉每有 2 層，基礎威力 +1（一回合內至多 +4）\n" +
          "躲過敵方單位的攻擊，使其無法命中。\n" +
          "[使用後]〈勁足〉每有 2 層，專注力 −4（一回合內至多 −10）",
        notes: "幸運 85 → 幣威 +12，全隊最會閃。但囤勁足時每擋一次都要付專注力。" }
    ],
    notes: "全隊最快（DEX 90）。鋪震顫級數的主力，累到 17 層〈勁足〉觸發《振刀》換《肉斬骨斷》收割。" +
      "被動2 與被動4 的加減剛好淨 0（守護／傷害強化／迅捷三條都是），所以增益穩定維持不會累積。"
  };

  // ------------------------------------------------------------
  // 霧島和真 —— 《仁心》驅動治療與急救，補師／減益
  // ------------------------------------------------------------
  const PC_KAZUMA = {
    id: "pc_kazuma", name: "霧島和真", isPC: true,
    hp: 260, dex: 50,
    attributes: { STR: 85, INT: 60, CON: 75, SIZ: 60, LUK: 60 },
    sheet: { 力量: 85, 敏捷: 50, 意志: 85, 體質: 75, 外貌: 55, 教育: 85, 體型: 60, 智力: 60, 幸運: 60 },
    markMeta: {
      "仁心": { noDecay: true, maxLayer: 4 },
      "茶乃的秘方藥": { noDecay: true, maxLayer: 5 }
    },
    passives: ["kazuma_perception", "kazuma_benevolence", "kazuma_chano",
               "kazuma_hippocrates", "kazuma_adrenaline"],
    tuning: {
      benevolenceKey: "仁心", benevolenceMax: 4,
      firstAidCost: 4, firstAidGuard: 10, adrenalineLayers: 2, adrenalineDebt: 8,
      medicineKey: "茶乃的秘方藥", medicineMax: 5,
      medicineHealCost: 1, medicineHpTrigger: 0.5, medicineHealPct: 0.15,
      medicineUnstunCost: 3, medicineFocusSet: 30
    },
    slotMap: { A: "k_a", B: "k_b", C: "k_c" },
    skillLibrary: [
      { id: "k_a", name: "外科醫生的堅定守護", type: "defense", targetSide: "ally",
        basePower: 3, coinPower: 9, coins: ["normal", "normal"],
        coinEffects: [
          { // ⚠ [使用時] 的仁心消耗放在逐枚鉤子 → 只有技能真的跑起來才扣（裁決 36：拚輸不扣）
            onUse: function (ctx) { ctx.apply(ctx.self, "仁心", -1, 0); },
            onHead: function (ctx) {
              if (ctx.self.focus < 25) return;
              const n = ctx.S.layerOf(ctx.self, "仁心");
              ctx.allies(false).forEach(function (a) { ctx.addFocus(a, n, "《堅定守護》"); });
              ctx.addFocus(ctx.self, -n * 2, "《堅定守護》的代價");
            } },
          { // ⚠ 反面也算命中（裁決 33）
            onHit: function (ctx) {
              const ally = ctx.target;
              if (!ally) return;
              if (ctx.S.layerOf(ally, "檢傷分類") > 0) {
                ctx.log("《堅定守護》" + ally.name + " 已有〈檢傷分類〉，本次不治療");
                return;
              }
              const n = ctx.S.layerOf(ctx.self, "仁心");
              ctx.heal(ally, Math.floor(ally.maxHp * (n * 2) / 100), "《堅定守護》");
            } }
        ],
        afterUse: function (ctx) {
          if (ctx.target) ctx.apply(ctx.target, "檢傷分類", 1, 0, { isMark: true });
          ctx.apply(ctx.self, "仁心", 1, 0, { isMark: true, noDecay: true, maxLayer: 4 });
        },
        onClashLose: function (ctx) { ctx.apply(ctx.target, "恍惚", 2, 0); },
        text: "2 枚硬幣｜基礎威力 3｜硬幣威力 +9\n" +
          "此技能視為特殊的防禦型技能，不會造成傷害，但霧島和真被敵方攻擊型技能作為對象時，" +
          "需要先和該敵方單位拚點，拚點成功才能繼續使用此技能（拚點輸贏仍影響專注力）。" +
          "僅能以自己以外的友方單位作為對象。\n" +
          "[拚點拚輸時] 對攻擊自己的敵方單位施加 2 層【恍惚】\n" +
          "[使用時] 減少 1 層〈仁心〉\n" +
          "硬幣1 [硬幣正面時] 若自身專注力 ≥ 25，全體友方回復等同〈仁心〉層數的專注力，" +
          "自身減少〈仁心〉層數 ×2 的專注力\n" +
          "硬幣2 [命中時] 若對象的〈檢傷分類〉為 0，回復（對象生命上限 ×〈仁心〉層數 ×2%）的生命值\n" +
          "　　　[使用後] 對對象施加 1 層〈檢傷分類〉、對自身施加 1 層〈仁心〉",
        notes: "⚠ 它是防禦型，但佔著 slotMap 的 A 槽位 → 受 1d6 抽選限制（裁決 34），" +
          "不像【防守】【閃躲】那樣想用就能用。〈檢傷分類〉每回合 −1，所以同一人隔一回合才能再治療。" },

      { id: "k_b", name: "不務正業的手術刀", basePower: 3, coinPower: 9,
        coins: ["normal", "normal"],
        coinEffects: [
          { onHead: tremor(1, 2) },
          { onHead: tremor(1, 3) }
        ],
        text: "2 枚硬幣｜基礎威力 3｜硬幣威力 +9\n" +
          "硬幣1 [硬幣正面時] 對命中的敵方單位增加 1 層【震顫】層數與 2 級【震顫】級數\n" +
          "硬幣2 [硬幣正面時] 對命中的敵方單位增加 1 層【震顫】層數與 3 級【震顫】級數",
        notes: "他只鋪不引爆 —— 級數留給旭與威爾去炸。" },

      { id: "k_c", name: "無奈的緊急麻醉", basePower: 3, coinPower: 9, coins: ["normal"],
        coinEffects: [{
          onHead: function (ctx) {
            ctx.apply(ctx.target, "易損", 3, 0);
            ctx.apply(ctx.target, "傷害弱化", 3, 0);
          },
          onHit: function (ctx) { ctx.apply(ctx.self, "守護", 3, 0); }
        }],
        text: "1 枚硬幣｜基礎威力 3｜硬幣威力 +9\n" +
          "硬幣1 [硬幣正面時] 對命中的敵方單位增加 3 層【易損】與 3 層【傷害弱化】\n" +
          "　　　[命中時] 對自身施加 3 層【守護】",
        notes: "純減益技。【易損】也回頭強化威爾技能C 的基礎威力。" },

      makeGuard(60, 75),   // 基威 3 ← SIZ 60／幣威 +9 ← CON 75
      makeDodge(25, 60)    // 基威 1 ← 閃避 ≤30／幣威 +5 ← LUK 60
    ],
    notes: "全隊最慢（DEX 50）→ 他的治療永遠在最後才發生。" +
      "⚠《仁心》上限 4、每回合只 +1 → 急救（消耗 4 層）大約每 4 回合才有一次。" +
      "三把技能的幣威 +9 對應 CON 75（非表格的 STR/INT），使用者給的是最終值。"
  };

  const PC_TEMPLATES = [PC_WILL, PC_YUZUKI, PC_AKIRA, PC_KAZUMA];

  // ============================================================
  // 藍圖 → 戰場實例
  // ============================================================
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function instanceSuffix(i) { return i < LETTERS.length ? LETTERS[i] : String(i + 1); }

  function findBlueprint(id) {
    const bp = NPC_LIBRARY.find(function (b) { return b.id === id; });
    if (!bp) throw new Error("倉庫裡沒有這款 NPC：" + id);
    return bp;
  }

  // 藍圖的展示欄位不該進 entity
  function toEntitySpec(bp) {
    const spec = cloneSpec(bp);
    delete spec.category; delete spec.blurb; delete spec.defaultCount;
    spec.blueprintId = bp.id;
    spec.isPC = false;
    return spec;
  }

  /**
   * 從藍圖生出 count 個「互不干擾」的實例。
   * id  永遠帶 #n（goblin_grunt#1…）—— byId 表、宣告 key「id#槽位」、
   *     Firebase 的 players/pcIds 全靠 id，不能撞。
   * 名字 只有 count > 1 才加後綴（哥布林兵 A／B／C），單隻時維持原名。
   */
  function spawn(blueprintId, count) {
    const bp = findBlueprint(blueprintId);
    const n = Math.max(1, Number(count) || 1);
    const out = [];
    for (let i = 0; i < n; i++) {
      const spec = toEntitySpec(bp);
      spec.id = bp.id + "#" + (i + 1);
      spec.name = n > 1 ? bp.name + " " + instanceSuffix(i) : bp.name;
      spec.baseName = bp.name;
      out.push(entity(spec));
    }
    return out;
  }

  // 給倉庫的「查看詳情」用：丟棄用實例，不進戰場
  function preview(blueprintId) {
    return entity(toEntitySpec(findBlueprint(blueprintId)));
  }

  // ============================================================
  // 對外 API
  // ============================================================
  global.Characters = {
    helpers: helpers,
    entity: entity,
    skill: skill,
    makeGuard: makeGuard,
    makeDodge: makeDodge,
    cloneSpec: cloneSpec,

    // --- NPC 倉庫 ---
    NPC_LIBRARY: NPC_LIBRARY,
    spawn: spawn,
    preview: preview,

    // --- PC 名單（寫死）---
    pcRoster: function () {
      return PC_TEMPLATES.map(function (t) { return entity(cloneSpec(t)); });
    },
    // PC 槽位成長順序（戰鬥輪開始前由 KP 指定；預設照名單順序）
    pcGrowthOrder: function () { return PC_TEMPLATES.map(function (t) { return t.id; }); },
    // 引擎驗證用的高血量標靶（不在正式名單裡，需要時自己取用）
    testTarget: function () { return entity(cloneSpec(TEST_TARGET_SPEC)); },

    // 四名 PC 骨架（技能組待補）
    PC_TEMPLATES: PC_TEMPLATES,
    buildPc: function (id) {
      const t = PC_TEMPLATES.find(function (x) { return x.id === id; });
      if (!t) throw new Error("找不到 PC 骨架：" + id);
      if (!t.skillLibrary || !t.skillLibrary.length) {
        throw new Error(t.name + " 的技能組尚未填寫（見 data/characters.js 的 PC_TEMPLATES）");
      }
      return entity(cloneSpec(t));
    }
  };

})(window);

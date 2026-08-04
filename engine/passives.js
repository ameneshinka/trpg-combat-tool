// ============================================================
// 被動邏輯註冊表
// 規則來源：trpg-combat-webapp skill（references/data-model.md）
//
// 為什麼被動是「程式碼」而不是「資料」：
//   被動的形狀差異太大（跨實體偵測、監聽隊友觸發、延遲債務、技能遞迴），
//   硬要做成資料驅動只會逼你發明一套迷你程式語言，比直接寫程式更糟。
//   → 邏輯寫在這裡（具名函式），角色資料只放 passive ID。
//   → 但「數字」要外放在 data/characters.js 的 tuning 裡，改平衡不用進 engine/。
//
// 一個被動的形狀：
//   {
//     id, name,
//     text,                         // ★ 被動文本：角卡原文，桌邊查詢用（顯示在角色詳情浮窗）
//     kind: "buff" | "cost",        // 階段一排序用：先結算 buff，再結算 cost
//     allowsInterceptingPlayers,    // （選用）非 PC 方可攔截打向玩家的攻擊（§9 例外）
//     onTurnStart(ctx),             // 階段一 step5
//     onTurnEnd(ctx),               // 階段六 step1（此時施加的狀態自動豁免層 −1）
//     onHit(ctx), onClashWin(ctx), onClashLose(ctx), onAllyTremorBurst(ctx) …
//   }
// ctx = { self, battle, events, tuning, S, C, D, yieldRequest? }
//
// onTurnStart / onTurnEnd 可以是 generator function（需要擲骰或 KP 裁定時 yield）。
// ============================================================
(function (global) {
  "use strict";
  const Passives = global.Passives = {};
  const S = global.States;

  const registry = {};

  Passives.register = function (def) {
    if (!def || !def.id) throw new Error("被動必須有 id");
    if (registry[def.id]) throw new Error("被動 id 重複：" + def.id);
    registry[def.id] = def;
    return def;
  };
  Passives.get = function (id) { return registry[id] || null; };
  Passives.all = function () { return Object.keys(registry).map(function (k) { return registry[k]; }); };

  // 取得某實體的被動定義（略過未註冊的 id，並記錄警告）
  function passivesOf(entity, events) {
    return (entity.passives || []).map(function (id) {
      const p = registry[id];
      if (!p && events) events.push("⚠ 找不到被動定義：" + id + "（" + entity.name + "）");
      return p;
    }).filter(Boolean);
  }
  Passives.passivesOf = passivesOf;

  // 被動與技能共用同一個 ctx（engine/effects.js）→ 被動也拿得到
  // heal／addFocus／setFocus／spend／gain／apply／allies／enemies／tremorBurst
  function makeCtx(entity, battle, events) {
    return global.Effects.makeCtx({
      self: entity, battle: battle, events: events
    });
  }
  Passives.makeCtx = makeCtx;

  function isGenerator(fn) {
    return global.Effects.isGeneratorFn(fn);
  }

  /**
   * 對「單一實體」觸發一個被動鉤子。
   * 鉤子可以是 generator（需要 KP／玩家裁定時 yield —— 威爾的快速裝填、和真的急救）。
   */
  function* fire(entity, hook, battle, events, payload) {
    if (!entity || entity.hp <= 0) return;
    for (const p of passivesOf(entity, events)) {
      if (typeof p[hook] !== "function") continue;
      const ctx = makeCtx(entity, battle, events);
      ctx.payload = payload || {};
      ctx.passive = p;
      if (isGenerator(p[hook])) yield* p[hook](ctx);
      else p[hook](ctx);
    }
  }
  Passives.fire = fire;

  /** 這個實體現在能不能對事件做出反應（裁決 16：混亂／恐慌／倒下時不觸發）。 */
  function canReact(entity) {
    return entity.hp > 0 && !entity.isPanicking &&
      (entity.confusionLockTurns || 0) <= 0 && !entity.cantActRestOfTurn;
  }
  Passives.canReact = canReact;

  /**
   * 廣播一次【震顫爆發】。
   * ⚠ 不論有沒有真的爆出級數都要廣播 —— 裁決 7／16：
   *   「只要技能文本帶爆發效果就算造成」，爆發落空一樣觸發破甲與援護射擊。
   *
   * 自己的爆發 → onOwnTremorBurst（威爾的槍械破甲）
   * 隊友的爆發 → onAllyTremorBurst（威爾的援護射擊；只吃同陣營）
   */
  function broadcastTremorBurst(battle, source, target, levels, skill, events) {
    if (!battle) return;
    battle.entities.forEach(function (e) {
      if (!canReact(e)) return;
      const own = (e.id === source.id);
      if (!own && e.isPC !== source.isPC) return;   // 「友方」＝同陣營
      passivesOf(e, events).forEach(function (p) {
        const hook = own ? p.onOwnTremorBurst : p.onAllyTremorBurst;
        if (typeof hook !== "function") return;
        const ctx = makeCtx(e, battle, events);
        ctx.passive = p;
        ctx.payload = {
          sourceId: source.id, sourceName: source.name,
          targetId: target.id, targetName: target.name,
          levels: levels, skillId: skill && skill.id
        };
        hook.call(p, ctx);   // ⚠ 用 call 保住 this，被動內部會用 this.name
      });
    });
  }
  Passives.broadcastTremorBurst = broadcastTremorBurst;

  /**
   * 階段一 step5：回合開始被動結算。
   * ⚠ 順序規定：先結算「給予增益」(kind:"buff") 的被動，再結算「消耗資源」(kind:"cost") 的。
   *    例：「≥門檻給增益」與「≥門檻歸零換大招」同時成立時，先拿增益再歸零。
   */
  function* runTurnStart(battle, events) {
    const phases = ["buff", "cost"];
    for (const phase of phases) {
      for (const e of battle.entities) {
        if (e.hp <= 0 || !e.canAct) continue;
        for (const p of passivesOf(e, events)) {
          if (!p.onTurnStart) continue;
          if ((p.kind || "buff") !== phase) continue;
          const ctx = makeCtx(e, battle, events);
          ctx.passive = p;
          if (isGenerator(p.onTurnStart)) yield* p.onTurnStart(ctx);
          else p.onTurnStart(ctx);
        }
      }
    }
  }
  Passives.runTurnStart = runTurnStart;

  /**
   * 階段六 step1：回合結束被動。
   * ⚠ 此時施加的狀態要豁免本回合的層 −1 → 一律帶 exemptThisTurn。
   *    被動內部請用 ctx.applyState() 而非直接呼叫 States.apply，以自動帶上豁免旗標。
   */
  function* runTurnEnd(entities, battle, events) {
    for (const e of entities) {
      if (e.hp <= 0) continue;
      for (const p of passivesOf(e, events)) {
        if (!p.onTurnEnd) continue;
        const ctx = makeCtx(e, battle, events);
        ctx.passive = p;
        ctx.applyState = function (target, name, layer, level, opts) {
          return S.apply(target, name, layer, level,
            Object.assign({}, opts, { exemptThisTurn: true }));
        };
        if (isGenerator(p.onTurnEnd)) yield* p.onTurnEnd(ctx);
        else p.onTurnEnd(ctx);
      }
    }
  }
  Passives.runTurnEnd = runTurnEnd;

  /** 戰鬥輪開始（不是回合）：威爾的彈匣回滿、和真的秘方藥補滿。 */
  function runBattleRoundStart(battle, events) {
    battle.entities.forEach(function (e) {
      if (e.hp <= 0) return;
      passivesOf(e, events).forEach(function (p) {
        if (typeof p.onBattleRoundStart !== "function") return;
        const ctx = makeCtx(e, battle, events);
        ctx.passive = p;
        p.onBattleRoundStart(ctx);
      });
    });
  }
  Passives.runBattleRoundStart = runBattleRoundStart;

  /** 廣播一個事件給所有實體的被動（跨實體偵測用，例如「隊友觸發震顫爆發」）。 */
  function broadcast(hook, battle, payload, events) {
    battle.entities.forEach(function (e) {
      if (e.hp <= 0) return;
      passivesOf(e, events).forEach(function (p) {
        if (typeof p[hook] !== "function") return;
        const ctx = makeCtx(e, battle, events);
        ctx.payload = payload;
        p[hook](ctx);
      });
    });
  }
  Passives.broadcast = broadcast;

  // ============================================================
  // 角色被動（四名 PC 共 17 個）
  // ⚠ 數字一律從 ctx.tuning 讀，不寫死在這裡 —— 調平衡只改 data/characters.js。
  // ⚠ 需要玩家／KP 裁定的被動寫成 generator，yield 一個 passiveChoice 請求。
  // ============================================================

  /** 需要玩家自行選擇的被動，統一用這個請求形狀。回傳選中的 option id（或 null）。 */
  function choiceRequest(ctx, title, detail, options, suggested) {
    return {
      type: "passiveChoice",
      entityId: ctx.self.id, name: ctx.self.name,
      passiveName: ctx.passive ? ctx.passive.name : "",
      title: title, detail: detail || "",
      options: options, suggested: suggested || null
    };
  }

  // ---------------- 威爾‧賽爾弗特 ----------------

  Passives.register({
    id: "will_magazine",
    name: "彈匣上限",
    text: "彈匣至多可以裝填 9 發【子彈】。【子彈】的數量不因為回合結束而減少。" +
      "當【子彈】剩餘數量小於技能傷害結算期間使用某硬幣所需的消耗量時，" +
      "無法使用該硬幣，並停止該技能的傷害結算。裝填子彈需要花費 1 個回合的行動。",
    kind: "buff",
    // 「花費 1 個回合的行動」＝整個回合什麼都不能做（裁決 15）。
    // 階段一、抽技能之前詢問；效果在回合結束結算。
    turnActions: [{
      id: "reload",
      label: "裝填子彈",
      hint: "整個回合什麼都不能做（連防守／閃躲也不行），回合結束時彈匣裝滿",
      available: function (e) {
        const key = (e.tuning || {}).ammoKey || "子彈";
        const max = (e.resourceMax || {})[key] || 9;
        return ((e.resources || {})[key] || 0) < max;
      }
    }],
    onTurnEnd: function (ctx) {
      if (ctx.self.turnActionTaken !== "reload") return;
      const key = ctx.tuning.ammoKey || "子彈";
      const max = ctx.tuning.magazineMax || 9;
      ctx.self.resources[key] = max;
      ctx.log("〈" + this.name + "〉" + ctx.self.name + " 完成裝填 → " + key + " 補滿 " + max + " 發");
    },
    // 戰鬥輪開始回滿（裁決 15）
    onBattleRoundStart: function (ctx) {
      const key = ctx.tuning.ammoKey || "子彈";
      ctx.self.resources[key] = ctx.tuning.magazineMax || 9;
    }
  });

  Passives.register({
    id: "will_quickload",
    name: "快速裝填",
    text: "當【子彈】數量小於或等於 1 時，可以自行選擇是否要消耗 10 點專注力，" +
      "以立刻將【子彈】數量增加 8 發，而不需耗費下回合的行動能力。" +
      "此被動於「技能傷害結算期間」不觸發。",
    kind: "buff",
    // ⚠ 呼叫點在 runAttackDamage「外面」→ 技能C 的遞迴連鎖跑完之前不會觸發（裁決 9），
    //   否則「打到剩 1 發 → 快填 → 又 ≥2 發 → 繼續打」會變成無限迴圈。
    // ⚠ 沒有每回合次數上限（裁決 14）—— 天然上限是專注力：從 0 連用 4 次就跨到 −40 進恐慌。
    onAfterSkillResolved: function* (ctx) {
      const key = ctx.tuning.ammoKey || "子彈";
      const threshold = ctx.tuning.quickReloadThreshold !== undefined ? ctx.tuning.quickReloadThreshold : 1;
      if (ctx.resource(ctx.self, key) > threshold) return;
      const cost = ctx.tuning.quickReloadFocusCost || 10;
      const amount = ctx.tuning.quickReloadAmount || 8;
      const pick = yield choiceRequest(ctx,
        "要用快速裝填嗎？",
        ctx.self.name + " 目前 " + key + " 只剩 " + ctx.resource(ctx.self, key) + " 發。" +
          "消耗 " + cost + " 點專注力立刻 +" + amount + " 發（目前專注力 " + ctx.self.focus + "）。" +
          "⚠ 專注力跨越到 −40 會在下回合進入恐慌。",
        [{ id: "yes", label: "使用（專注力 −" + cost + "，" + key + " +" + amount + "）" },
         { id: "no", label: "不用" }]);
      if (pick !== "yes") return;
      ctx.addFocus(ctx.self, -cost, "〈快速裝填〉");
      ctx.gain(ctx.self, key, amount, "〈快速裝填〉");
    }
  });

  Passives.register({
    id: "will_pierce",
    name: "槍械破甲",
    text: "使用會消耗【子彈】的技能並造成敵方單位【震顫爆發】時，對命中的敵方單位施加 1 層【易損】。",
    kind: "buff",
    // 裁決 7：只要技能文本帶爆發效果就算「造成」—— 爆發落空（震顫 0 級）也照給。
    onOwnTremorBurst: function (ctx) {
      const t = ctx.battle.entities.find(function (x) { return x.id === ctx.payload.targetId; });
      if (!t || t.hp <= 0) return;
      ctx.log("〈" + this.name + "〉" + ctx.self.name + " 引爆震顫 → " + t.name + " 獲得【易損】");
      ctx.apply(t, "易損", 1, 0);
    }
  });

  Passives.register({
    id: "will_support",
    name: "援護射擊",
    text: "當敵方單位受到自己以外的其他友方單位的帶有【震顫爆發】效果的攻擊時，" +
      "立刻對同一敵方單位接著使用一次額外的技能 A 做單方面攻擊。",
    kind: "buff",
    // 裁決 16：照樣消耗 1 發子彈（不足就空放）；只要技能帶爆發就觸發（不看有沒有爆出級數）；
    //          不佔槽位；沒有次數上限；威爾自己混亂／恐慌／倒下時不觸發（由 broadcast 的 canReact 擋）。
    onAllyTremorBurst: function (ctx) {
      const skillId = ctx.tuning.supportSkillId;
      if (!skillId) return;
      ctx.self.pendingInvocations = ctx.self.pendingInvocations || [];
      ctx.self.pendingInvocations.push({
        skillId: skillId, targetId: ctx.payload.targetId, label: "援護射擊"
      });
      ctx.log("〈" + this.name + "〉" + ctx.payload.sourceName + " 引爆震顫 → " +
        ctx.self.name + " 自動追加一次攻擊");
    }
  });

  // ---------------- 夜櫻結月 ----------------

  Passives.register({
    id: "yuzuki_charisma",
    name: "千金小姐的領袖魅力",
    text: "回合開始時，對隨機一名除了自己以外，且沒有〈櫻之香〉的友方單位，添加 1 層〈櫻之香〉。",
    kind: "buff",   // ⚠ 必須是 buff：要先撒香，被動2（cost）才看得到「全員都有」（裁決 19）
    onTurnStart: function* (ctx) {
      const mark = ctx.tuning.markKey || "櫻之香";
      // 「友方單位」＝存活的 PC，不含自己、不含友方 NPC（裁決 20）
      const pool = ctx.allies(false).filter(function (a) { return ctx.S.layerOf(a, mark) <= 0; });
      if (!pool.length) return;
      const suggested = pool[Math.floor(Math.random() * pool.length)];
      const pick = yield choiceRequest(ctx,
        "〈" + mark + "〉要撒給誰？",
        "工具已隨機挑出 " + suggested.name + "，KP 可以覆寫（authoring.md：隨機目標由工具選、KP 可覆寫）。",
        pool.map(function (a) { return { id: a.id, label: a.name }; }),
        suggested.id);
      const target = pool.find(function (a) { return a.id === pick; }) || suggested;
      ctx.apply(target, "櫻之香", 1, 0, { isMark: true, noDecay: true });
      ctx.log("〈" + this.name + "〉" + target.name + " 獲得 1 層〈" + mark + "〉");
    }
  });

  Passives.register({
    id: "yuzuki_fragrance",
    name: "櫻之香",
    text: "〈櫻之香〉的層數不因為回合結束而減少。" +
      "[回合開始時] 當除了自己以外的全部友方單位都擁有〈櫻之香〉，" +
      "則使所有友方單位的〈櫻之香〉層數歸零，使自身獲得 1 層〈爆裂綻放〉。",
    kind: "cost",
    onTurnStart: function (ctx) {
      const mark = ctx.tuning.markKey || "櫻之香";
      const allies = ctx.allies(false);
      if (!allies.length) return;
      if (!allies.every(function (a) { return ctx.S.layerOf(a, mark) > 0; })) return;
      allies.forEach(function (a) { ctx.S.zeroState(a, mark, "集滿換〈爆裂綻放〉"); });
      ctx.apply(ctx.self, "爆裂綻放", 1, 0, { isMark: true, noDecay: true, maxLayer: 1 });
      ctx.log("〈" + this.name + "〉全體友方都帶著〈" + mark + "〉→ 全部歸零，" +
        ctx.self.name + " 獲得〈爆裂綻放〉！");
    }
  });

  Passives.register({
    id: "yuzuki_bloom",
    name: "爆裂綻放",
    text: "〈爆裂綻放〉的層數最大值為 1。自身擁有〈爆裂綻放〉的回合，臨時獲得以下的增益：" +
      "① 對自身增加等同於【虛弱】層數的【凝神】級數 " +
      "② 對自身增加等同於【虛弱】層數的【傷害強化】層數 " +
      "③ 對自身增加等同於【虛弱】層數的一半的【強壯】層數。" +
      "獲得以上增益後，將自身所有的【虛弱】層數歸零。" +
      "[回合結束時]〈爆裂綻放〉的層數歸零，因為〈爆裂綻放〉效果而臨時增加的增益狀態之層數歸零。",
    kind: "cost",   // ⚠ 排在被動2 之後（同 kind 依 entity.passives 陣列順序）
    onTurnStart: function (ctx) {
      if (ctx.S.layerOf(ctx.self, "爆裂綻放") <= 0) return;
      const w = ctx.S.layerOf(ctx.self, "虛弱");
      if (w <= 0) { ctx.log("〈" + this.name + "〉但沒有【虛弱】可以兌換，無增益"); return; }
      ctx.log("〈" + this.name + "〉" + ctx.self.name + " 以 " + w + " 層【虛弱】兌換增益");
      // ⚠ 記帳式：只記「實際給進去多少」，回合結束原數收回，她自己疊的完整保留（裁決 21）
      ctx.grant(ctx.self, "bloom", "凝神", 0, w);            // 級數（層數為 0 時會被丟棄 —— 裁決 18）
      ctx.grant(ctx.self, "bloom", "傷害強化", w, 0);        // ⚠ 吃 16 層上限（裁決 22）
      ctx.grant(ctx.self, "bloom", "強壯", Math.floor(w / 2), 0);  // 「一半」無條件捨去
      ctx.S.zeroState(ctx.self, "虛弱", "〈爆裂綻放〉兌換");
      ctx.log("　→【虛弱】層數歸零");
    },
    onTurnEnd: function (ctx) {
      if (ctx.S.layerOf(ctx.self, "爆裂綻放") <= 0 && !(ctx.self._grants || {}).bloom) return;
      ctx.revoke("bloom");
      ctx.S.zeroState(ctx.self, "爆裂綻放", "回合結束收回");
      ctx.log("〈" + this.name + "〉回合結束 → 標記與臨時增益一併收回");
    }
  });

  Passives.register({
    id: "yuzuki_composure",
    name: "千金小姐的沉著調度",
    text: "拚點失敗時，使所有擁有〈櫻之香〉的友方單位獲得 1 層【迅捷】，對自己施加 1 層【綁縛】。" +
      "對敵方單位單方面攻擊時，對自身施加 2 層【傷害強化】以及 2 級【凝神】強度，並額外扣除 5 點專注力。",
    kind: "buff",
    // 裁決 23：兩條都「每次各觸發一次，不設上限」
    onClashLose: function (ctx) {
      const mark = ctx.tuning.markKey || "櫻之香";
      const marked = ctx.allies(false).filter(function (a) { return ctx.S.layerOf(a, mark) > 0; });
      marked.forEach(function (a) { ctx.apply(a, "迅捷", 1, 0); });
      ctx.apply(ctx.self, "綁縛", 1, 0);
      ctx.log("〈" + this.name + "〉拚點失敗 → " + (marked.length || "無") + " 名帶香友方獲得【迅捷】，自身吃 1 層【綁縛】");
    },
    onUnilateralAttack: function (ctx) {
      ctx.apply(ctx.self, "傷害強化", 2, 0);
      ctx.apply(ctx.self, "凝神", 0, 2);   // ⚠ 沒有凝神層數時這 2 級會被丟掉（裁決 18）
      ctx.addFocus(ctx.self, -5, "〈" + this.name + "〉單方面攻擊的代價");
    }
  });

  Passives.register({
    id: "yuzuki_command",
    name: "千金小姐的乘勝指揮",
    text: "[回合開始時] 自身的【凝神】級數如果大於 20，超過 20 級的級數每有 5 級，" +
      "就失去 5 級【凝神】級數，並對自身增加 1 層【凝神】層數。" +
      "此效果一回合最多只能增加 3 層【凝神】層數。",
    kind: "cost",
    onTurnStart: function (ctx) {
      const base = ctx.tuning.commandThreshold || 20;
      const per = ctx.tuning.commandPerLayer || 5;
      const cap = ctx.tuning.commandMaxLayers || 3;
      const lv = ctx.S.levelOf(ctx.self, "凝神");
      if (lv <= base) return;
      const layers = Math.min(cap, Math.floor((lv - base) / per));
      if (layers <= 0) return;
      ctx.apply(ctx.self, "凝神", layers, -(layers * per));
      ctx.log("〈" + this.name + "〉凝神 " + lv + " 級（超過 " + base + "）→ 換得 " +
        layers + " 層凝神層數，級數 −" + (layers * per));
    }
  });

  // ---------------- 渡邊旭 ----------------

  Passives.register({
    id: "akira_stride",
    name: "勁足",
    text: "〈勁足〉的層數不因為回合結束而減少。" +
      "[回合開始時] 對自身施加 2 層〈勁足〉。" +
      "[回合開始時] 如果自身擁有大於或等於 3 層〈勁足〉，則每擁有 3 層〈勁足〉，就對自身施加 1 層【迅捷】。",
    kind: "buff",
    onTurnStart: function (ctx) {
      const mark = ctx.tuning.strideKey || "勁足";
      ctx.apply(ctx.self, mark, ctx.tuning.stridePerTurn || 2, 0, { isMark: true, noDecay: true });
      const n = ctx.S.layerOf(ctx.self, mark);
      const per = ctx.tuning.stridePerSwift || 3;
      const swift = Math.floor(n / per);
      if (swift > 0) {
        ctx.apply(ctx.self, "迅捷", swift, 0);
        ctx.log("〈" + this.name + "〉" + mark + " " + n + " 層 → 【迅捷】+" + swift + " 層");
      }
    }
  });

  Passives.register({
    id: "akira_killer",
    name: "殺手本位",
    text: "[回合開始時] 根據自身擁有的〈勁足〉層數，獲得以下增益（可疊加）：" +
      "≥5 層 → 對自身施加 3 層【守護】；≥10 層 → 對自身施加 3 層【傷害強化】；" +
      "≥15 層 → 所有敵方單位增加 3 層【傷害弱化】。",
    kind: "buff",
    // ⚠ 給敵人的【傷害弱化】是「本回合限定」（裁決 28）：用記帳式增益，回合結束移除自己給的那份。
    //   照文本字面（回合結束再疊 3 層【傷害強化】抵銷）會讓敵人身上的層數無限往上疊。
    onTurnStart: function (ctx) {
      const mark = ctx.tuning.strideKey || "勁足";
      const n = ctx.S.layerOf(ctx.self, mark);
      const t = ctx.tuning;
      if (n >= (t.killerGuardAt || 5)) ctx.apply(ctx.self, "守護", t.killerGuard || 3, 0);
      if (n >= (t.killerAmpAt || 10)) ctx.apply(ctx.self, "傷害強化", t.killerAmp || 3, 0);
      if (n >= (t.killerWeakenAt || 15)) {
        ctx.enemies().forEach(function (e) {
          ctx.grant(e, "killer", "傷害弱化", t.killerWeaken || 3, 0);
        });
        ctx.log("〈" + this.name + "〉" + mark + " " + n + " 層 → 全體敵方【傷害弱化】+" +
          (t.killerWeaken || 3) + " 層（本回合限定）");
      }
    },
    onTurnEnd: function (ctx) {
      ctx.revoke("killer");
    }
  });

  Passives.register({
    id: "akira_vibrate",
    name: "振刀",
    text: "[回合開始時] 如果自身擁有大於或等於 17 層〈勁足〉，則將〈勁足〉的層數歸零，" +
      "本回合可以使用的攻擊型技能新增一個「技能 D：肉斬骨斷」。",
    kind: "cost",   // ⚠ 消耗類 → 一定在殺手本位（buff）之後結算，先拿增益再歸零
    onTurnStart: function (ctx) {
      const mark = ctx.tuning.strideKey || "勁足";
      const need = ctx.tuning.vibrateThreshold || 17;
      const n = ctx.S.layerOf(ctx.self, mark);
      if (n < need) return;
      ctx.S.zeroState(ctx.self, mark, "〈振刀〉歸零換《肉斬骨斷》");
      // 裁決 27／31：直接可用、不受抽選限制、只有本回合、沒用到就白費
      ctx.self.tempSkillIds = [ctx.tuning.vibrateSkillId || "a_d"];
      ctx.log("〈" + this.name + "〉" + mark + " 達 " + n + " 層 → 歸零，本回合解鎖《肉斬骨斷》" +
        "（不受抽選限制，仍佔一個槽位；沒用到就白費）");
    },
    onTurnEnd: function (ctx) {
      if (!(ctx.self.tempSkillIds || []).length) return;
      ctx.self.tempSkillIds = [];
      ctx.log("〈" + this.name + "〉《肉斬骨斷》的解鎖於回合結束失效");
    }
  });

  Passives.register({
    id: "akira_homesick",
    name: "望月思鄉",
    text: "[回合結束時] 使自身減少 4 層【迅捷】。" +
      "[回合結束時] 如果自身擁有的〈勁足〉層數大於或等於 5，使自身減少 2 層【守護】。" +
      "[回合結束時] 如果自身擁有的〈勁足〉層數大於或等於 10，使自身減少 2 層【傷害強化】。" +
      "[回合結束時] 如果自身擁有的〈勁足〉層數大於或等於 15，所有敵方單位增加 3 層【傷害強化】。",
    kind: "cost",
    // ⚠ 裁決 25：這裡的減層是「額外於」通則的回合結束 −1，兩者相加
    //   → 守護 +3 / −2−1、傷害強化 +3 / −2−1、迅捷 +⌊勁足/3⌋ / −4−1 三條剛好淨 0。
    // ⚠ 最後一條（給敵人傷害強化）依裁決 28 改寫成殺手本位的 revoke，這裡不再重複施加。
    onTurnEnd: function (ctx) {
      const mark = ctx.tuning.strideKey || "勁足";
      const n = ctx.S.layerOf(ctx.self, mark);
      const t = ctx.tuning;
      ctx.apply(ctx.self, "迅捷", -(t.homesickSwift || 4), 0);
      if (n >= (t.killerGuardAt || 5)) ctx.apply(ctx.self, "守護", -(t.homesickGuard || 2), 0);
      if (n >= (t.killerAmpAt || 10)) ctx.apply(ctx.self, "傷害強化", -(t.homesickAmp || 2), 0);
    }
  });

  // ---------------- 霧島和真 ----------------

  Passives.register({
    id: "kazuma_perception",
    name: "動靜感知",
    text: "於戰鬥時使用的【偵查】技能會獲得一顆獎勵骰。" +
      "（⚠ 這是 COC 的技能檢定，不在拚點系統內 —— 本工具只顯示文本，不做結算。）",
    kind: "buff"
    // 無 hook：刻意不實作
  });

  Passives.register({
    id: "kazuma_benevolence",
    name: "仁心",
    text: "〈仁心〉的層數不因為回合結束而減少，層數上限為 4 層。" +
      "[回合開始時] 獲得 1 層〈仁心〉。" +
      "[回合開始時] 使自身專注力增加，增加量等同於〈仁心〉的層數 ×50%（向下取整）。",
    kind: "buff",
    onTurnStart: function (ctx) {
      const key = ctx.tuning.benevolenceKey || "仁心";
      const max = ctx.tuning.benevolenceMax || 4;
      ctx.apply(ctx.self, key, 1, 0, { isMark: true, noDecay: true, maxLayer: max });
      const n = ctx.S.layerOf(ctx.self, key);
      const gain = Math.floor(n * 0.5);
      if (gain > 0) ctx.addFocus(ctx.self, gain, "〈" + this.name + "〉");
    }
  });

  Passives.register({
    id: "kazuma_hippocrates",
    name: "希波克拉底精神",
    text: "[回合結束時] 如果有自身以外的友方單位處於【混亂】狀態，可自行選擇，消耗 4 層〈仁心〉，" +
      "使該友方單位獲得 10 層【守護】與 2 層〈緊急腎上腺素〉。",
    kind: "cost",
    // 裁決 39：玩家挑一位，一回合一次（仁心上限 4、一次耗盡，本來也只夠一次）
    onTurnEnd: function* (ctx) {
      const key = ctx.tuning.benevolenceKey || "仁心";
      const cost = ctx.tuning.firstAidCost || 4;
      if (ctx.S.layerOf(ctx.self, key) < cost) return;
      const confused = ctx.allies(false).filter(function (a) {
        return a.isConfused || (a.confusionLockTurns || 0) > 0;
      });
      if (!confused.length) return;
      const pick = yield choiceRequest(ctx,
        "要用急救嗎？（消耗 " + cost + " 層〈" + key + "〉）",
        "獲救者得到 10 層【守護】與 2 層〈緊急腎上腺素〉。" +
          "⚠ 腎上腺素退場時，該名隊友會在兩回合後被扣 8 層【守護】。",
        confused.map(function (a) { return { id: a.id, label: a.name + "（混亂中）" }; })
          .concat([{ id: "no", label: "不使用" }]));
      if (!pick || pick === "no") return;
      const target = confused.find(function (a) { return a.id === pick; });
      if (!target) return;
      ctx.spend(ctx.self, key, 0);   // 印記不是資源，下面直接改層數
      ctx.apply(ctx.self, key, -cost, 0);
      // ⚠ 回合結束才施加的狀態要豁免本回合的層 −1（裁決 #16）
      ctx.apply(target, "守護", ctx.tuning.firstAidGuard || 10, 0, { exemptThisTurn: true });
      ctx.apply(target, "緊急腎上腺素", ctx.tuning.adrenalineLayers || 2, 0,
        { isMark: true, exemptThisTurn: true });
      ctx.log("〈" + this.name + "〉" + ctx.self.name + " 急救 " + target.name);
    }
  });

  Passives.register({
    id: "kazuma_adrenaline",
    name: "緊急腎上腺素",
    text: "〈緊急腎上腺素〉的層數預設為 0 層，僅會因為被動 3 的效果而增加，僅會因為回合結束而減少 1 層。" +
      "當〈緊急腎上腺素〉從 1 層減少至 0 層時，於下一個回合的 [回合開始時]，" +
      "「被施加緊急腎上腺素的對象」減少 8 層【守護】。",
    kind: "cost",
    // ⚠ 這個被動掛在和真身上，但債務要記在「隊友」身上（裁決 40）→ 用延遲債務。
    //   偵測時機：回合結束的通則層 −1 之前，先看誰身上是 1 層。
    onTurnEnd: function (ctx) {
      const mark = "緊急腎上腺素";
      const debt = ctx.tuning.adrenalineDebt || 8;
      ctx.allies(true).forEach(function (a) {
        const st = a.states[mark];
        if (!st || st.layer !== 1 || st.addedThisTurn) return;   // 剛掛上的不算
        ctx.S.addPendingDebt(a, { name: "守護", layer: -debt, label: "緊急腎上腺素退場" });
        ctx.log("〈" + ctx.passive.name + "〉" + a.name + " 的腎上腺素即將退場 → " +
          "下回合開始減少 " + debt + " 層【守護】");
      });
    }
  });

  Passives.register({
    id: "kazuma_chano",
    name: "是茶乃的心意唷～",
    text: "[戰鬥輪第一回合開始時] 獲得 5 層〈茶乃的秘方藥〉。層數不因回合結束而減少，上限 5 層。" +
      "當自身的生命值小於或等於（生命值上限 ×50%）時，消耗 1 層，立刻恢復（生命值上限 ×15%）的生命值，" +
      "此效果一回合只能使用一次。" +
      "當自身進入【混亂】狀態時，消耗 3 層，立刻解除【混亂】狀態，並將專注力調整至 30。",
    kind: "buff",
    onBattleRoundStart: function (ctx) {
      const key = ctx.tuning.medicineKey || "茶乃的秘方藥";
      const max = ctx.tuning.medicineMax || 5;
      ctx.S.zeroState(ctx.self, key, "戰鬥輪開始重置");
      ctx.apply(ctx.self, key, max, 0, { isMark: true, noDecay: true, maxLayer: max });
    },
    // 裁決 37：兩個效果都讓玩家選 → 寫成 generator，在每次技能結算完檢查
    onAfterSkillResolved: function* (ctx) { yield* chanoCheck(ctx); },
    onTurnStart: function* (ctx) { yield* chanoCheck(ctx); },
    onTurnEnd: function* (ctx) { yield* chanoCheck(ctx); }
  });

  /** 茶乃的秘方藥：兩個效果的共用檢查（治療 1 層／解混亂 3 層）。 */
  function* chanoCheck(ctx) {
    const key = ctx.tuning.medicineKey || "茶乃的秘方藥";
    const self = ctx.self;

    // ① 解除混亂（3 層）—— 裁決 38：全部解除，本回合立刻能動
    const confused = self.isConfused || (self.confusionLockTurns || 0) > 0;
    const unstunCost = ctx.tuning.medicineUnstunCost || 3;
    if (confused && ctx.S.layerOf(self, key) >= unstunCost) {
      const pick = yield choiceRequest(ctx,
        "要用秘方藥解除【混亂】嗎？（消耗 " + unstunCost + " 層）",
        "解除後本回合立刻恢復行動，專注力調整至 " + (ctx.tuning.medicineFocusSet || 30) + "。",
        [{ id: "yes", label: "使用" }, { id: "no", label: "不用" }]);
      if (pick === "yes") {
        ctx.apply(self, key, -unstunCost, 0);
        self.isConfused = false;
        self.confusionLockTurns = 0;
        self.cantActRestOfTurn = false;
        ctx.setFocus(self, ctx.tuning.medicineFocusSet || 30, "〈秘方藥〉");
        ctx.log("〈茶乃的秘方藥〉" + self.name + " 解除【混亂】，本回合立刻能動");
      }
    }

    // ② 補血（1 層）—— 一回合只能一次
    const healCost = ctx.tuning.medicineHealCost || 1;
    const trigger = Math.floor(self.maxHp * (ctx.tuning.medicineHpTrigger || 0.5));
    const amount = Math.floor(self.maxHp * (ctx.tuning.medicineHealPct || 0.15));
    const counters = self._turnCounters = self._turnCounters || {};
    if (self.hp > 0 && self.hp <= trigger && !counters.chanoHeal &&
        ctx.S.layerOf(self, key) >= healCost) {
      const pick = yield choiceRequest(ctx,
        "要用秘方藥回血嗎？（消耗 " + healCost + " 層）",
        self.name + " 目前 HP " + self.hp + "／" + self.maxHp +
          "（已低於 50% 的 " + trigger + "）→ 回復 " + amount + " 點。一回合只能用一次。",
        [{ id: "yes", label: "使用" }, { id: "no", label: "不用" }]);
      if (pick === "yes") {
        ctx.apply(self, key, -healCost, 0);
        counters.chanoHeal = true;
        ctx.heal(self, amount, "〈茶乃的秘方藥〉");
      }
    }
  }

  // ---------------- 敵方 NPC：熟練工作的女僕 ----------------
  // ⚠ 敵方 NPC 的數值由 KP 自訂，不套角卡換算表。

  Passives.register({
    id: "maid_order",
    name: "整頓混亂",
    text: "使用技能時，如果目標對象的生命值小於生命值上限的 50%，則使技能的基礎威力 +1。",
    kind: "buff",
    // ⚠ 被動一律用「累加」而不是「指派」—— 技能自己的 onUse 是指派（威爾技能C、結月防守），
    //   而 beginSkillUse 把被動排在技能之後，用指派會把技能的加成整個蓋掉。
    // ⚠ 裁決 43：防禦型技能也算 —— 拚點時防禦方拿到的 target 就是攻擊者；
    //   只有「無人攻擊的防守」沒有目標，條件自然不成立。
    onSkillUse: function (ctx) {
      const t = ctx.payload.targetId && ctx.battle
        ? ctx.battle.entities.find(function (x) { return x.id === ctx.payload.targetId; })
        : null;
      if (!t) return;
      const pct = ctx.tuning.orderHpThreshold !== undefined ? ctx.tuning.orderHpThreshold : 0.5;
      if (t.hp >= t.maxHp * pct) return;
      const bonus = ctx.tuning.orderBasePower || 1;
      ctx.payload.runtime.basePowerBonus += bonus;
      ctx.log("〈" + this.name + "〉" + t.name + " 已低於 " + Math.round(pct * 100) +
        "%（" + t.hp + "／" + t.maxHp + "）→ 基礎威力 +" + bonus);
    }
  });

  Passives.register({
    id: "maid_tidy",
    name: "整潔強迫症",
    text: "進入恐慌狀態的回合結束後，下回合開始時，獲得一層【迅捷】。",
    kind: "buff",
    // ⚠ 時機能成立是因為階段六「步驟1 跑被動、步驟4 才清恐慌旗標」→ 這裡看得到 isPanicking。
    //   用延遲債務掛到下回合開始（由階段一開頭的 runPendingDebts 結算），
    //   剛好落在「恢復行動的那一回合」（裁決 42）。
    onTurnEnd: function (ctx) {
      if (!ctx.self.isPanicking) return;
      ctx.S.addPendingDebt(ctx.self, {
        name: "迅捷", layer: ctx.tuning.tidySwift || 1, label: this.name
      });
      ctx.log("〈" + this.name + "〉" + ctx.self.name + " 恐慌回合結束 → 下回合開始獲得【迅捷】");
    }
  });

  Passives.resetPerTurnCounters = function (entities) {
    entities.forEach(function (e) {
      e._supportShots = 0;
      e._turnCounters = {};   // 技能的每回合累計上限（旭閃躲的 +4 基威／−10 專注力）
    });
  };

})(window);

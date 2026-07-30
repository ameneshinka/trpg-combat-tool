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

  function makeCtx(entity, battle, events) {
    return {
      self: entity,
      battle: battle,
      events: events,
      tuning: entity.tuning || {},
      S: global.States, C: global.Clash, D: global.Damage
    };
  }
  Passives.makeCtx = makeCtx;

  function isGenerator(fn) {
    return fn && fn.constructor && fn.constructor.name === "GeneratorFunction";
  }

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
  function runTurnEnd(entities, battle, events) {
    entities.forEach(function (e) {
      if (e.hp <= 0) return;
      passivesOf(e, events).forEach(function (p) {
        if (!p.onTurnEnd) return;
        const ctx = makeCtx(e, battle, events);
        ctx.applyState = function (target, name, layer, level, opts) {
          return S.apply(target, name, layer, level,
            Object.assign({}, opts, { exemptThisTurn: true }));
        };
        p.onTurnEnd(ctx);
      });
    });
  }
  Passives.runTurnEnd = runTurnEnd;

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
  // 內建示範被動（可刪；角色實作時照這個形狀寫）
  // 數字一律從 ctx.tuning 讀，不寫死在這裡。
  // ============================================================

  // 回合開始：回復專注力（增益類）
  Passives.register({
    id: "demo_focus_regen",
    name: "示範：凝氣",
    text: "每回合開始時，自身回復 focusRegen 點專注力（預設 3）。",
    kind: "buff",
    onTurnStart: function (ctx) {
      const amount = ctx.tuning.focusRegen || 3;
      ctx.self.focus = ctx.S.clampFocus(ctx.self.focus + amount);
      ctx.events.push("〈" + this.name + "〉" + ctx.self.name + " 專注力 +" + amount +
        "（現 " + ctx.self.focus + "）");
    }
  });

  // 回合開始：資源達門檻則歸零換取解鎖（消耗類 → 一定在增益類之後結算）
  Passives.register({
    id: "demo_resource_spend",
    name: "示範：門檻兌換",
    text: "每回合開始時，若自訂資源達到 threshold，將其歸零並解鎖特殊技能。" +
      "屬「消耗資源」類 → 階段一一定在所有「給予增益」類被動之後才結算。",
    kind: "cost",
    onTurnStart: function (ctx) {
      const key = ctx.tuning.resourceKey || "資源";
      const threshold = ctx.tuning.threshold || 10;
      const have = ctx.self.resources[key] || 0;
      if (have < threshold) return;
      ctx.self.resources[key] = 0;
      ctx.self.unlockedBigSkill = true;
      ctx.events.push("〈" + this.name + "〉" + ctx.self.name + " 消耗 " + have + " 點" + key +
        "（達門檻 " + threshold + "）→ 解鎖特殊技能");
    }
  });

  // 攔截例外被動（§9）：讓非 PC 方可以攔截打向玩家的攻擊
  Passives.register({
    id: "demo_intercept_override",
    name: "示範：守護者本能",
    text: "此角色可以攔截「打向玩家」的攻擊 —— 規則 §9「敵方不能攔截玩家」的例外。" +
      "仍須符合攔截資格（有效 DEX 嚴格大於被攔技能當前目標）。",
    kind: "buff",
    allowsInterceptingPlayers: true
  });

  // 跨實體偵測：隊友觸發震顫爆發時自動發射一次技能（威爾的援護射擊形狀）
  // ⚠ party-context 指出這類「玩家無法拒絕」的被動需要次數上限 → maxPerTurn 從 tuning 讀。
  Passives.register({
    id: "demo_ally_tremor_support",
    name: "示範：援護射擊",
    text: "隊友觸發【震顫爆發】時，自動消耗 supportShotCost 點彈藥發射一次技能A。" +
      "⚠ 每回合上限 supportShotsPerTurn 次 —— 因為這個被動玩家無法拒絕（隊友的高光回合會吃掉我的子彈），" +
      "依 character-design skill 屬「玩家沒有選擇」類型，必須設次數上限。",
    kind: "buff",
    onAllyTremorBurst: function (ctx) {
      const max = ctx.tuning.supportShotsPerTurn || 1;
      ctx.self._supportShots = ctx.self._supportShots || 0;
      if (ctx.self._supportShots >= max) {
        ctx.events.push("〈" + this.name + "〉" + ctx.self.name + " 本回合次數已用盡（上限 " + max + "）");
        return;
      }
      const cost = ctx.tuning.supportShotCost || 1;
      const ammoKey = ctx.tuning.ammoKey || "子彈";
      if ((ctx.self.resources[ammoKey] || 0) < cost) {
        ctx.events.push("〈" + this.name + "〉" + ctx.self.name + " " + ammoKey + "不足，無法援護");
        return;
      }
      ctx.self.resources[ammoKey] -= cost;
      ctx.self._supportShots++;
      ctx.self.pendingInvocations = ctx.self.pendingInvocations || [];
      ctx.self.pendingInvocations.push({
        skillId: ctx.tuning.supportSkillId,
        targetId: ctx.payload && ctx.payload.targetId
      });
      ctx.events.push("〈" + this.name + "〉" + ctx.self.name + " 因隊友引爆震顫而自動發射（消耗 " +
        cost + " " + ammoKey + "）");
    }
  });

  // 每回合重置「本回合次數」類計數器
  Passives.resetPerTurnCounters = function (entities) {
    entities.forEach(function (e) { e._supportShots = 0; });
  };

})(window);

// ============================================================
// 狀態觸發引擎 (規格書 §8)
// 層數驅動的「持續生效」係數已內嵌於 damage.js（守護/易損/傷害強化弱化）
// 與 slotmap.js（迅捷/綁縛 → 有效DEX）。這裡專注於「有觸發時機」的狀態。
// ============================================================
(function (global) {
  "use strict";
  const Engine = global.Engine = global.Engine || {};
  const getState = Engine.getState;

  // 被攻擊時：萎靡（專注力-級數）、開裂（血量-級數）。每枚硬幣各觸發一次。
  function applyOnHitTriggers(target, log) {
    log = log || function () {};
    const weak = getState(target, "萎靡");
    if ((weak.layer || 0) > 0 && (weak.level || 0) > 0) {
      target.focus -= weak.level;
      Engine.addStateLayer(target, "萎靡", -1);
      log("→ §8萎靡觸發：" + target.name + " 專注力 -" + weak.level + "（萎靡層-1，現專注力=" + target.focus + "）");
    }
    const crack = getState(target, "開裂");
    if ((crack.layer || 0) > 0 && (crack.level || 0) > 0) {
      target.hp = Math.max(0, target.hp - crack.level);
      Engine.addStateLayer(target, "開裂", -1);
      log("→ §8開裂觸發：" + target.name + " 血量 -" + crack.level + "（開裂層-1，現HP=" + target.hp + "）");
    }
  }
  Engine.applyOnHitTriggers = applyOnHitTriggers;

  // 進行拚點時：失血（血量-級數）。每次交換各觸發一次。
  function applyBleedOnExchange(entity, log) {
    log = log || function () {};
    const bleed = getState(entity, "失血");
    if ((bleed.layer || 0) > 0 && (bleed.level || 0) > 0) {
      entity.hp = Math.max(0, entity.hp - bleed.level);
      Engine.addStateLayer(entity, "失血", -1);
      log("→ §8失血觸發：" + entity.name + " 血量 -" + bleed.level + "（失血層-1，現HP=" + entity.hp + "）");
    }
  }
  Engine.applyBleedOnExchange = applyBleedOnExchange;

  // 回合結束時：延燒（血量-級數），每回合一次。其層-1與通則回合結束層-1視為同一次，不重複扣。
  function applyEndOfTurnBurn(entity, log) {
    log = log || function () {};
    const burn = getState(entity, "延燒");
    if ((burn.layer || 0) > 0 && (burn.level || 0) > 0) {
      entity.hp = Math.max(0, entity.hp - burn.level);
      log("→ §8延燒觸發：" + entity.name + " 血量 -" + burn.level + "（現HP=" + entity.hp + "，層數將於本階段通則一併-1，不重複扣）");
      return true; // 表示此狀態本回合已經「剛結算過」，但它不是「剛被加上的」，仍會被通則-1（延燒不豁免，只是不重複扣兩次）
    }
    return false;
  }
  Engine.applyEndOfTurnBurn = applyEndOfTurnBurn;

  // ------------------------------------------------------------
  // 技能效果處理器（§3.2 useEffects/hitEffects, §11 印記施加, §4.3 喚出）
  // 為 generator：invokeSkill 喚出的攻擊技需暫停等傷害骰，故整條路徑用 yield*。
  // 支援的效果類型：
  //   { type:"applyState", who:"self"|"target", state, layerDelta, levelDelta, isMark }
  //   { type:"invokeSkill", skillId, targetRef:"target"|"self" }
  //        繞過骰選，直接以「單方面攻擊」打出 caster 技能庫裡的該技能（可為 drawable:false）
  //   { type:"heal"/"tempHp"/"focus", who, amount }  常見數值效果
  // caster/target 為 entity；condition（若有）以 §4.3 直譯器判定。
  // ------------------------------------------------------------
  const MAX_INVOKE_DEPTH = 3;

  function* applySkillEffects(caster, target, effects, timingLabel, log, depth, exemptStates) {
    log = log || function () {};
    depth = depth || 0;
    const list = effects || [];
    for (let i = 0; i < list.length; i++) {
      const eff = list[i];
      if (eff.condition && !Engine.evaluateCondition(eff.condition, { self: caster, target: target })) continue;

      if (eff.type === "applyState") {
        const who = eff.who === "target" ? target : caster;
        if (!who) continue;
        Engine.applyState(who, eff.state, eff.layerDelta || 0, eff.levelDelta || 0, { isMark: !!eff.isMark, exemptThisTurn: !!exemptStates });
        log("→ [" + timingLabel + "] " + who.name + " 獲得「" + eff.state + "」" +
          (eff.layerDelta ? " 層+" + eff.layerDelta : "") + (eff.levelDelta ? " 級+" + eff.levelDelta : "") +
          (eff.isMark ? "（印記）" : ""));

      } else if (eff.type === "invokeSkill") {
        if (depth >= MAX_INVOKE_DEPTH) { log("→ [" + timingLabel + "] 喚出遞迴過深，停止。", "info"); continue; }
        const tgt = eff.targetRef === "self" ? caster : target;
        yield* invokeSkillEffect(caster, tgt, eff.skillId, timingLabel, log, depth + 1);

      } else if (eff.type === "heal") {
        const who = eff.who === "target" ? target : caster;
        if (!who) continue;
        who.hp = Math.min(who.maxHp, who.hp + (eff.amount || 0));
        log("→ [" + timingLabel + "] " + who.name + " 回復 " + (eff.amount || 0) + " HP（現 " + who.hp + "）");

      } else if (eff.type === "tempHp") {
        const who = eff.who === "target" ? target : caster;
        if (!who) continue;
        who.tempHp = (who.tempHp || 0) + (eff.amount || 0);
        log("→ [" + timingLabel + "] " + who.name + " 獲得臨時生命值 +" + (eff.amount || 0) + "（現 " + who.tempHp + "）");

      } else if (eff.type === "focus") {
        const who = eff.who === "target" ? target : caster;
        if (!who) continue;
        who.focus = Math.max(-40, Math.min(40, (who.focus || 0) + (eff.amount || 0)));
        log("→ [" + timingLabel + "] " + who.name + " 專注力 " + (eff.amount >= 0 ? "+" : "") + (eff.amount || 0) + "（現 " + who.focus + "）");

      } else if (eff.type === "detonateState") {
        // §8「爆發／殘響」：引爆累積的級數驅動狀態（血瀑/炎瀑/荊棘瀑…），依文本造成
        // 正比傷害，並可附帶施加其他狀態（如延燒額外），最後消耗掉該狀態。
        const who = eff.who === "self" ? caster : target;
        if (!who) continue;
        const st = Engine.getState(who, eff.state);
        const amount = (st.level || st.layer || 0);
        if (amount <= 0) { log("→ [" + timingLabel + "] 引爆〈" + eff.state + "〉但無累積，無效果。"); continue; }
        if (eff.damagePerLevel) {
          Engine.applyDirectDamage(who, amount * eff.damagePerLevel, log, "[" + timingLabel + "] 引爆" + eff.state);
        }
        if (eff.alsoApply) {
          Engine.applyState(who, eff.alsoApply.state, eff.alsoApply.layerDelta || 0, eff.alsoApply.levelDelta || 0, { exemptThisTurn: !!exemptStates });
          log("→ [" + timingLabel + "] 引爆附帶：" + who.name + " 獲得「" + eff.alsoApply.state + "」");
        }
        if (eff.consume !== false) {
          const s = Engine.ensureState(who, eff.state); s.layer = 0; s.level = 0;
          log("→ [" + timingLabel + "] 〈" + eff.state + "〉已被引爆消耗。");
        }

      } else {
        log("→ [" + timingLabel + "] 未知效果類型：" + eff.type, "info");
      }
    }
  }
  Engine.applySkillEffects = applySkillEffects;

  // §4.3 喚出：直接以單方面攻擊打出 caster 的某技能（繞過拚點與骰選）
  function* invokeSkillEffect(caster, target, skillId, timingLabel, log, depth) {
    const skill = Engine.findSkill(caster, skillId);
    if (!skill) { log("→ 喚出失敗：" + caster.name + " 技能庫中找不到 " + skillId, "info"); return; }
    if (!target || target.hp <= 0) { log("→ 喚出《" + skill.name + "》但無有效目標。", "info"); return; }
    log("→ [" + timingLabel + "] " + caster.name + " 喚出《" + skill.name + "》直接打出（繞過骰選）", "info");

    // 喚出技本身的 useEffects
    yield* applySkillEffects(caster, target, skill.useEffects, "喚出使用時", log, depth);

    if (skill.type === "attack") {
      const coins = skill.coins.map(function (c) { return { type: c.type }; });
      const eff = Engine.computeEffectivePower(caster, skill, target);
      yield* Engine.damageResolution(caster, target, coins, eff.basePower, eff.coinPower, "喚出:" + skill.name, log);
      if (target.hp >= 0) yield* applySkillEffects(caster, target, skill.hitEffects, "喚出命中時", log, depth);
    } else {
      // 防禦型被喚出：無傷害，只結算其效果
      yield* applySkillEffects(caster, target, skill.hitEffects, "喚出（防禦型）", log, depth);
    }
  }
  Engine.invokeSkillEffect = invokeSkillEffect;

  // ------------------------------------------------------------
  // 被動邏輯引擎（§3.1 passives, §5 step5/§5 phase6-step2, §12C）
  // 宣告式：passive = { id, name, trigger, condition?, chance?, target, targetState?, effects[] }
  //   trigger: "turnStart" | "turnEnd"
  //   target : "self" | "randomEnemy" | "randomEnemyWithout" | "lowestHpEnemy" | "allEnemies" | "randomAlly"
  //   chance : 0..1（省略=必定）；隨機成分（chance 或多候選）會 yield 給 KP 覆寫（§13）
  //   effects: 與技能效果同一套（applyState/invokeSkill/heal/focus…）
  // turnEnd 施加的狀態會標為豁免（§5 phase6 例外，不吃當回合層-1）。
  // ------------------------------------------------------------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function resolvePassiveTargets(battleState, entity, p) {
    const alive = battleState.entities.filter(function (e) { return e.hp > 0; });
    const enemies = alive.filter(function (e) { return e.isPC !== entity.isPC; });
    const allies = alive.filter(function (e) { return e.isPC === entity.isPC && e.id !== entity.id; });
    switch (p.target) {
      case "self": return [entity];
      case "randomEnemy": return shuffle(enemies);
      case "randomEnemyWithout": return shuffle(enemies.filter(function (e) {
        const st = e.states[p.targetState]; return !(st && (st.layer || 0) > 0);
      }));
      case "lowestHpEnemy": return enemies.slice().sort(function (a, b) { return a.hp - b.hp; });
      case "allEnemies": return enemies;
      case "randomAlly": return shuffle(allies);
      default: return [entity];
    }
  }

  function* runPassives(battleState, entity, when, log) {
    log = log || function () {};
    const list = (entity.passives || []).filter(function (p) { return p.trigger === when; });
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.condition && !Engine.evaluateCondition(p.condition, { self: entity, target: null })) continue;

      const candidates = resolvePassiveTargets(battleState, entity, p);
      let fire = (p.chance === undefined) ? true : (Math.random() < p.chance);
      let chosen = candidates.length ? [candidates[0]] : [];
      const isMulti = (p.target === "allEnemies");
      const hasRandom = (p.chance !== undefined) || (candidates.length > 1) || (p.target && p.target !== "self");

      // 有隨機成分 → 工具先自動決定，再 yield 給 KP 覆寫（§13：自動骰/選、KP 可覆寫）
      if (hasRandom) {
        const ov = yield {
          type: "passiveResolve",
          entityId: entity.id,
          passiveName: p.name || p.id,
          autoFire: fire,
          allowMulti: isMulti,
          autoTargetId: chosen[0] ? chosen[0].id : null,
          targetChoices: candidates.map(function (c) { return { id: c.id, name: c.name }; })
        };
        if (ov) {
          if (typeof ov.fire === "boolean") fire = ov.fire;
          if (ov.targetIds) {
            chosen = ov.targetIds.map(function (id) { return battleState.entities.find(function (e) { return e.id === id; }); }).filter(Boolean);
          }
        }
      }

      if (!fire) { log(entity.name + " 的被動〈" + (p.name || p.id) + "〉未觸發。"); continue; }
      const targets = (p.target === "self") ? [entity] : (isMulti ? candidates : chosen);
      if (targets.length === 0) { log(entity.name + " 的被動〈" + (p.name || p.id) + "〉無可用目標，略過。"); continue; }
      for (let t = 0; t < targets.length; t++) {
        log(entity.name + " 的被動〈" + (p.name || p.id) + "〉觸發 → " + targets[t].name);
        yield* applySkillEffects(entity, targets[t], p.effects, "被動:" + (p.name || p.id), log, 0, when === "turnEnd");
      }
    }
  }
  Engine.runPassives = runPassives;

})(window);

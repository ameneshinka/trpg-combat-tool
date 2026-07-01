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
  // 技能效果處理器（§3.2 useEffects/hitEffects, §11 印記施加）
  // 支援的效果類型：
  //   { type:"applyState", who:"self"|"target", state, layerDelta, levelDelta, isMark }
  //   { type:"invokeSkill", ... }  → MVP 尚未自動化，僅記錄提示由 KP 手動處理
  // caster/target 為 entity；condition（若有）以 §4.3 直譯器判定。
  // ------------------------------------------------------------
  function applySkillEffects(caster, target, effects, timingLabel, log) {
    log = log || function () {};
    (effects || []).forEach(function (eff) {
      if (eff.condition && !Engine.evaluateCondition(eff.condition, { self: caster, target: target })) return;
      if (eff.type === "applyState") {
        const who = eff.who === "target" ? target : caster;
        if (!who) return;
        Engine.applyState(who, eff.state, eff.layerDelta || 0, eff.levelDelta || 0, { isMark: !!eff.isMark });
        log("→ [" + timingLabel + "] " + who.name + " 獲得「" + eff.state + "」" +
          (eff.layerDelta ? " 層+" + eff.layerDelta : "") + (eff.levelDelta ? " 級+" + eff.levelDelta : "") +
          (eff.isMark ? "（印記）" : ""));
      } else if (eff.type === "invokeSkill") {
        log("→ [" + timingLabel + "] invokeSkill 效果（喚出《" + (eff.skillId || "?") + "》）為 MVP 範圍外，請 KP 手動以該技能結算。", "info");
      } else {
        log("→ [" + timingLabel + "] 未知效果類型：" + eff.type, "info");
      }
    });
  }
  Engine.applySkillEffects = applySkillEffects;

})(window);

// ============================================================
// 傷害結算 (規格書 §7) —— generator 形式，逐枚硬幣可在需要時
// yield 一個「需要手動輸入」的請求給呼叫端 (turncycle/ui)。
// ============================================================
(function (global) {
  "use strict";
  const Engine = global.Engine = global.Engine || {};
  const getState = Engine.getState;

  function floor(x) { return Math.floor(x); }

  function attackerCoef(attacker, concentrationTriggered) {
    const boost = getState(attacker, "傷害強化").layer || 0;
    const weak = getState(attacker, "傷害弱化").layer || 0;
    let c = 1 + boost * 0.05 - weak * 0.05;
    if (concentrationTriggered) c += 0.30;
    return c;
  }
  function targetCoef(target) {
    const vuln = getState(target, "易損").layer || 0;
    const guard = getState(target, "守護").layer || 0;
    let c = 1;
    if (target.isConfused) c += 0.80;
    c += vuln * 0.05 - guard * 0.05;
    return c;
  }
  Engine.attackerCoef = attackerCoef;
  Engine.targetCoef = targetCoef;

  function getConfusionThresholds(entity) {
    // 混亂值門檻＝角色實際持有的門檻（可被「震顫爆發／瀑」永久上修），否則用預設。
    // 震顫本身「不」持續改門檻，只累積，等爆發時一次上修（見 raiseNearestConfusionThreshold）。
    return entity.confusionThresholds && entity.confusionThresholds.length
      ? entity.confusionThresholds
      : [Math.floor(entity.maxHp * 0.6), 0];
  }

  // 把「距離當前HP最接近」的混亂門檻往上修 amount（永久），並在門檻追上當前HP時立即進混亂。
  function raiseNearestConfusionThreshold(entity, amount, log) {
    log = log || function () {};
    amount = Math.max(0, Math.floor(amount || 0));
    if (amount <= 0) return;
    if (!entity.confusionThresholds || !entity.confusionThresholds.length) {
      entity.confusionThresholds = [Math.floor(entity.maxHp * 0.6), 0];
    }
    let idx = 0, best = Infinity;
    for (let i = 0; i < entity.confusionThresholds.length; i++) {
      const d = Math.abs(entity.hp - entity.confusionThresholds[i]);
      if (d < best) { best = d; idx = i; }
    }
    entity.confusionThresholds[idx] += amount;
    log("混亂值上修：最接近HP的門檻 +" + amount + " → " + entity.confusionThresholds[idx]);
    if (!entity.isConfused && entity.confusionLockTurns <= 0 && entity.hp <= entity.confusionThresholds[idx]) {
      entity.isConfused = true;
      entity.confusionLockTurns = 2;
      entity.cantActRestOfTurn = true;
      log("⚠ 混亂值追上當前HP，" + entity.name + " 立即進入混亂！（confusionLockTurns=2）");
    }
  }
  Engine.raiseNearestConfusionThreshold = raiseNearestConfusionThreshold;
  function checkConfusionCrossing(entity, hpBefore, hpAfter) {
    if (entity.isConfused || entity.confusionLockTurns > 0) return false;
    const thresholds = getConfusionThresholds(entity);
    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i];
      if (hpBefore > t && hpAfter <= t) return true;
    }
    return false;
  }
  Engine.checkConfusionCrossing = checkConfusionCrossing;

  // 直接扣血（非逐枚攻擊）：先扣臨時生命值、再扣真實血量，並重檢黃金交叉。
  // 供爆發/殘響、開裂、延燒等「文本直接扣血」的效果共用。
  function applyDirectDamage(target, amount, log, label) {
    log = log || function () {};
    amount = Math.max(0, Math.floor(amount || 0));
    if (amount === 0) return;
    const before = target.hp, tb = target.tempHp;
    let remain = amount;
    if (target.tempHp > 0) { const f = Math.min(target.tempHp, remain); target.tempHp -= f; remain -= f; }
    target.hp = Math.max(0, target.hp - remain);
    log((label || "直接傷害") + "：" + target.name + " -" + amount + "（臨時血" + tb + "→" + target.tempHp + "，HP " + before + "→" + target.hp + "）");
    if (!target.isConfused && target.confusionLockTurns <= 0 && checkConfusionCrossing(target, before, target.hp)) {
      target.isConfused = true;
      target.confusionLockTurns = 2;
      target.cantActRestOfTurn = true;
      log("⚠ " + target.name + " 血量跨越混亂值，進入混亂！（confusionLockTurns=2）");
    }
  }
  Engine.applyDirectDamage = applyDirectDamage;

  /**
   * 逐枚硬幣傷害結算 generator。
   * @param attacker 攻擊方 entity
   * @param target   目標 entity
   * @param coinsAlive  存活硬幣陣列 [{type}] （拚點後存活、或單方面攻擊的全部硬幣）
   * @param basePower / coinPower  該技能（或追加攻擊視同 1/1）的基礎威力與硬幣威力
   * @param skillLabel 顯示用技能名稱
   * @param log 記錄 callback(msg, cls)
   *
   * yield 形式：
   *   { type: 'damageDie', skillLabel } → 呼叫端需 .next(number) 回傳傷害骰值（整把技能共用，只問一次）
   *   { type: 'concentrationD20', coinIndex } → 僅在攻擊方有凝神級數>0時才問，.next(number 1-20)
   *
   * 回傳（generator return）：
   *   { totalDamage, coinResults:[...], confusionTriggered:bool, log }
   */
  function* damageResolution(attacker, target, coinsAlive, basePower, coinPower, skillLabel, log) {
    log = log || function () {};
    if (coinsAlive.length === 0) {
      log(skillLabel + "：沒有存活硬幣，無傷害。");
      return { totalDamage: 0, coinResults: [], confusionTriggered: false };
    }

    const damageDie = yield { type: "damageDie", skillLabel: skillLabel, attackerId: attacker.id };
    log(skillLabel + " 傷害骰（整把技能共用）= " + damageDie);

    let powerAccum = 0; // 已累計的「正面硬幣」威力加成（恍惚會讓個別硬幣的加成歸零）
    let totalDamage = 0;
    const coinResults = [];
    let confusionTriggered = false;

    for (let i = 0; i < coinsAlive.length; i++) {
      if (target.hp <= 0) { log(target.name + " 已倒下，停止後續硬幣結算。"); break; }

      const probHeads = Engine.headsProbFromFocus(attacker.focus);
      const isHeads = Engine.flipCoin(probHeads);

      // §8 恍惚：使用技能擲硬幣時，該枚硬幣威力歸零（層-1）
      let effectiveCoinPower = coinPower;
      const dazedState = getState(attacker, "恍惚");
      if ((dazedState.layer || 0) > 0) {
        effectiveCoinPower = 0;
        Engine.addStateLayer(attacker, "恍惚", -1);
        log("→ " + attacker.name + " 處於恍惚，該枚硬幣威力歸零（恍惚層-1）");
      }

      if (isHeads) powerAccum += effectiveCoinPower;
      const finalPower = basePower + powerAccum;

      // 凝神判定（攻擊方自身狀態）
      let concentrationTriggered = false;
      const conState = getState(attacker, "凝神");
      if ((conState.level || 0) > 0) {
        const d20 = yield { type: "concentrationD20", coinIndex: i, attackerId: attacker.id };
        if (d20 < conState.level) {
          concentrationTriggered = true;
          Engine.addStateLevel(attacker, "凝神", -2);
          Engine.addStateLayer(attacker, "凝神", -1);
          log("→ 凝神觸發！(1d20=" + d20 + " < 級數" + conState.level + ") 該枚 +30%，凝神級數-2、層數-1");
        } else {
          log("→ 凝神判定未觸發 (1d20=" + d20 + " ≥ 級數" + conState.level + ")");
        }
      }

      const aCoef = attackerCoef(attacker, concentrationTriggered);
      const tCoef = targetCoef(target);
      const rawDamage = finalPower * damageDie * aCoef * tCoef;
      const dmg = floor(rawDamage);

      const hpBefore = target.hp;
      const tempBefore = target.tempHp;
      let remain = dmg;
      if (target.tempHp > 0) {
        const fromTemp = Math.min(target.tempHp, remain);
        target.tempHp -= fromTemp;
        remain -= fromTemp;
      }
      target.hp = Math.max(0, target.hp - remain);
      const hpAfter = target.hp;

      totalDamage += dmg;
      coinResults.push({
        index: i, type: coinsAlive[i].type, heads: isHeads, finalPower: finalPower,
        concentrationTriggered: concentrationTriggered, damage: dmg
      });

      log("硬幣#" + (i + 1) + "（" + coinsAlive[i].type + "）" + (isHeads ? "正面" : "反面") +
        "，最終威力=" + finalPower + "，傷害骰=" + damageDie +
        "，攻方係數=" + aCoef.toFixed(2) + "，目標係數=" + tCoef.toFixed(2) +
        " → 傷害=" + dmg + "（臨時血" + tempBefore + "→" + target.tempHp + "，HP " + hpBefore + "→" + hpAfter + "）");

      // §8 被攻擊時觸發：萎靡（專注力-級數）、開裂（血量-級數），每枚硬幣各觸發一次
      if (Engine.applyOnHitTriggers) Engine.applyOnHitTriggers(target, log);

      // 每扣完一次血，重新檢查黃金交叉（含開裂額外造成的扣血）
      if (!confusionTriggered && checkConfusionCrossing(target, hpBefore, target.hp)) {
        confusionTriggered = true;
        target.isConfused = true;
        target.confusionLockTurns = 2;
        target.cantActRestOfTurn = true;
        log("⚠ " + target.name + " 血量跨越混亂值，立即進入混亂！本回合剩餘行動作廢，confusionLockTurns=2，同一次攻擊剩餘硬幣 +80%。");
      }
    }

    return { totalDamage: totalDamage, coinResults: coinResults, confusionTriggered: confusionTriggered };
  }
  Engine.damageResolution = damageResolution;

})(window);

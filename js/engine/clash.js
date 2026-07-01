// ============================================================
// 拚點演算法 (規格書 §6a–§6d)
// ============================================================
(function (global) {
  "use strict";
  const Engine = global.Engine = global.Engine || {};

  function clampProb(p) {
    if (p < 0.10) return 0.10;
    if (p > 0.90) return 0.90;
    return p;
  }
  function headsProbFromFocus(focus) {
    return clampProb(0.5 + (focus || 0) / 100);
  }
  Engine.headsProbFromFocus = headsProbFromFocus;

  function flipCoin(prob) {
    return Math.random() < prob;
  }
  Engine.flipCoin = flipCoin;

  // side working struct: { entityId, focus, basePower, coinPower, coins:[{type,status}] }
  // target = 對手 entity，供 computeEffectivePower 判定「若目標有印記X → 威力+Y」等條件式
  function prepareClashSide(entity, skill, target) {
    const eff = global.Engine.computeEffectivePower(entity, skill, target || null);
    return {
      entityId: entity.id,
      entityName: entity.name,
      focus: entity.focus || 0,
      skillId: skill.id,
      skillName: skill.name,
      skillType: skill.type,
      basePower: eff.basePower,
      coinPower: eff.coinPower,
      coins: skill.coins.map(function (c) { return { type: c.type, status: "alive" }; })
    };
  }
  Engine.prepareClashSide = prepareClashSide;

  function aliveCoins(side) { return side.coins.filter(function (c) { return c.status === "alive"; }); }
  function aliveOfType(side, type) { return aliveCoins(side).filter(function (c) { return c.type === type; }); }
  function countAlive(side) { return aliveCoins(side).length; }

  function removeCoinsAsLost(coinList, n) {
    for (let i = 0; i < n && i < coinList.length; i++) coinList[i].status = "lost";
  }

  // §6d 綠幣對消（拚點開始前）
  function preClashGreenCancel(sideA, sideB, log) {
    const greenA = aliveOfType(sideA, "green");
    const redA = aliveOfType(sideA, "red");
    const greenB = aliveOfType(sideB, "green");
    const redB = aliveOfType(sideB, "red");
    const cancelByA = Math.min(greenA.length, redB.length); // A的綠 消 B的紅
    const cancelByB = Math.min(greenB.length, redA.length); // B的綠 消 A的紅

    removeCoinsAsLost(greenA, cancelByA);
    removeCoinsAsLost(redB, cancelByA);
    removeCoinsAsLost(greenB, cancelByB);
    removeCoinsAsLost(redA, cancelByB);

    if (cancelByA > 0) log(sideA.entityName + " 的綠幣對消 " + sideB.entityName + " 的紅幣 ×" + cancelByA);
    if (cancelByB > 0) log(sideB.entityName + " 的綠幣對消 " + sideA.entityName + " 的紅幣 ×" + cancelByB);
  }
  Engine.preClashGreenCancel = preClashGreenCancel;

  function removeFrontAliveCoin(side) {
    const c = side.coins.find(function (c) { return c.status === "alive"; });
    if (!c) return null;
    c.status = (c.type === "red") ? "shattered" : "lost";
    return c;
  }

  function shatteredRed(side) {
    return side.coins.filter(function (c) { return c.status === "shattered"; });
  }
  Engine.shatteredRed = shatteredRed;

  /**
   * 執行一場拚點（§6a-6d）。
   * sideA / sideB: { entity, skill }
   * 回傳 ClashResult，不修改傳入的 entity / skill 物件本身。
   */
  function runClash(refA, refB, log) {
    log = log || function () {};
    const entityA = refA.entity, entityB = refB.entity;
    const sideA = prepareClashSide(entityA, refA.skill, entityB);
    const sideB = prepareClashSide(entityB, refB.skill, entityA);

    preClashGreenCancel(sideA, sideB, log);

    // 邊界：若某方一開局可擲硬幣即為 0（多半是綠幣對消造成），直接判輸，不計交換次數
    if (countAlive(sideA) === 0 || countAlive(sideB) === 0) {
      const aZero = countAlive(sideA) === 0, bZero = countAlive(sideB) === 0;
      let winnerSide, loserSide;
      if (aZero && bZero) { winnerSide = null; loserSide = null; }
      else if (aZero) { winnerSide = "B"; loserSide = "A"; }
      else { winnerSide = "A"; loserSide = "B"; }
      log("拚點開局即有一方無可擲硬幣，直接判定（不計交換次數，專注力不變）。");
      return buildResult(sideA, sideB, winnerSide, loserSide, 0, log);
    }

    let k = 0; // 交換次數（含平手重擲）
    let winnerSide = null, loserSide = null;

    while (true) {
      k++;
      const a = aliveCoins(sideA), b = aliveCoins(sideB);
      const probA = headsProbFromFocus(sideA.focus);
      const probB = headsProbFromFocus(sideB.focus);
      let headsA = 0, headsB = 0;
      a.forEach(function () { if (flipCoin(probA)) headsA++; });
      b.forEach(function () { if (flipCoin(probB)) headsB++; });
      const powerA = sideA.basePower + headsA * sideA.coinPower;
      const powerB = sideB.basePower + headsB * sideB.coinPower;

      log("交換#" + k + "：" + sideA.entityName + " 正面" + headsA + "/" + a.length +
        " → 威力" + powerA + "　vs　" + sideB.entityName + " 正面" + headsB + "/" + b.length +
        " → 威力" + powerB);

      // §8 失血：進行拚點時，每次交換各觸發一次
      if (global.Engine.applyBleedOnExchange) {
        global.Engine.applyBleedOnExchange(entityA, log);
        global.Engine.applyBleedOnExchange(entityB, log);
      }

      if (powerA === powerB) {
        log("→ 平手，重擲（不損幣，仍計入交換次數）");
        continue;
      }
      const loser = powerA > powerB ? sideB : sideA;
      const lost = removeFrontAliveCoin(loser);
      log("→ " + loser.entityName + " 輸了這次交換，損失第一枚硬幣（" +
        (lost.type === "red" ? "紅幣，碎幣" : lost.type === "green" ? "綠幣，損失" : "普通幣，損失") + "）");

      if (countAlive(loser) === 0) {
        winnerSide = (loser === sideA) ? "B" : "A";
        loserSide = (loser === sideA) ? "A" : "B";
        log((winnerSide === "A" ? sideA.entityName : sideB.entityName) + " 的技能通過拚點！（共 " + k + " 次交換）");
        break;
      }
    }

    return buildResult(sideA, sideB, winnerSide, loserSide, k, log);
  }
  Engine.runClash = runClash;

  function buildResult(sideA, sideB, winnerSide, loserSide, k, log) {
    const bothAttack = sideA.skillType === "attack" && sideB.skillType === "attack";
    let focusDeltaWinner = 0, focusDeltaLoser = 0;
    if (bothAttack && winnerSide && k > 0) {
      const delta = 2 * k + 2;
      focusDeltaWinner = delta;
      focusDeltaLoser = -delta;
      log("專注力結算：勝方 +" + delta + "，敗方 -" + delta + "（交換次數 k=" + k + "）");
    } else if (winnerSide) {
      log("專注力不變（非雙方皆攻擊型技能）。");
    }
    return {
      sideA: sideA, sideB: sideB,
      winnerSide: winnerSide, loserSide: loserSide,
      exchanges: k,
      focusDeltaWinner: focusDeltaWinner,
      focusDeltaLoser: focusDeltaLoser,
      bothAttack: bothAttack
    };
  }

})(window);

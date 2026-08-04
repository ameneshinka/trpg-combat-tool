// ============================================================
// 傷害引擎
// 規則來源：trpg-clash-rules skill（references/damage.md）
//
//   單枚傷害 = ⌊ 最終威力 × 傷害乘數 × 攻擊方係數 × 目標方係數 ⌋
//
// 四個最容易寫錯的點：
//   1. 最終威力逐枚累加各自的有效幣威（碎幣 +1），禁用乘法。
//   2. 反面照樣打一下，只是不增加最終威力；只有「已損失」的硬幣才跳過。
//   3. 目標方係數在同一次攻擊中會變動 —— 每枚結算完要重檢黃金交叉，
//      目標中途進混亂 → 剩餘硬幣立刻吃 +80%。
//   4. 分組相乘：攻方組內相加、目標組內相加，兩組再相乘。每下各自無條件退位。
//
// generator：需要手動骰時 yield 出請求，由呼叫端 next(值) 餵回。
// ============================================================
(function (global) {
  "use strict";
  const Damage = global.Damage = {};
  const S = global.States;
  const C = global.Clash;

  /**
   * 逐枚結算傷害。
   *
   * @param attacker 攻擊方 entity
   * @param target   目標 entity
   * @param coinRuntime 該次技能使用的硬幣執行期狀態（含碎幣；已損失者會被跳過）
   * @param basePower  已套用強壯／虛弱的基礎威力
   * @param coinPower  技能的硬幣威力（碎幣會自動視為 +1）
   * @param label      顯示用名稱
   *
   * yield：
   *   { type:"damageMultiplier", label }  → next(數字) 傷害乘數骰（整把技能共用，只問一次）
   *   { type:"concentration1d20", coinIndex } → next(1~20) 僅在攻擊方有凝神級數時才問
   *
   * return { hits[], totalDamage, events[] }
   */
  function* resolveDamage(attacker, target, coinRuntime, basePower, coinPower, label, opts) {
    opts = opts || {};
    const rng = opts.rng;
    const events = [];
    const hits = [];
    const E = global.Effects;

    // fx = { skill, battle, runtime } —— 有帶才跑逐枚效果鉤子。
    // 碎幣追加攻擊不帶 fx（它不是「使用技能」，不該再觸發一次逐枚效果）。
    const fx = opts.fx || null;
    const runtime = fx ? fx.runtime : null;
    function coinCtx(coin, extra) {
      return E.makeCtx(Object.assign({
        self: attacker, target: target, skill: fx.skill, battle: fx.battle,
        events: events, runtime: runtime,
        coinIndex: coin.index, coin: coin
      }, extra || {}));
    }
    function fxOf(coin) { return fx ? E.coinEffect(fx.skill, coin.index) : null; }

    const rollable = coinRuntime.filter(function (c) { return c.status !== C.LOST; });
    if (rollable.length === 0) {
      events.push(label + "：沒有未損失的硬幣，無傷害");
      return { hits: hits, totalDamage: 0, events: events };
    }

    // 傷害乘數：過技能時擲一次，整把技能所有硬幣共用
    const multiplier = opts.damageMultiplier !== undefined
      ? opts.damageMultiplier
      : yield { type: "damageMultiplier", label: label, attackerId: attacker.id };
    events.push(label + "：傷害乘數骰 = " + multiplier + "（整把技能共用），攻擊次數 = " +
      rollable.length + " 下（含碎幣，反面照打）");

    let power = basePower;   // 最終威力逐枚累加
    let total = 0;

    // 擲幣動畫用：整把技能的硬幣包成一組
    // ⚠ 這裡的擲幣是在逐枚迴圈裡 inline 做的（不走 rollAllCoins），所以要自己記。
    //   迴圈中間可能為了【凝神】1d20 而 yield → 該組會被切成兩批播，可接受。
    C.beginGroup({ kind: "damage", label: label, who: attacker.name, whoId: attacker.id,
      targetName: target.name });
    const flipLog = [];

    for (let i = 0; i < rollable.length; i++) {
      if (target.hp <= 0) { events.push(target.name + " 已倒下，停止後續硬幣結算"); break; }
      if (runtime && runtime.stop) break;   // 逐枚鉤子要求中止（例：子彈不足）
      const coin = rollable[i];
      const ce = fxOf(coin);

      // 0. 逐枚 [使用時]：該枚開打前（扣資源、對目標預先施加狀態）
      if (ce && ce.onUse) {
        yield* E.call(ce.onUse, coinCtx(coin));
        if (runtime && runtime.stop) break;
      }

      // 1. 擲該枚硬幣。正面 → 把「該枚的有效幣威」加進最終威力。
      const d100 = S.rollD100(attacker.focus, rng);
      const isHead = d100.head;
      let effPower = C.effectiveCoinPower(coin, coinPower);

      // 【恍惚】：使用技能擲硬幣時，該枚硬幣的硬幣威力歸零（每枚觸發，層 −1）
      if (S.layerOf(attacker, "恍惚") > 0) {
        effPower = 0;
        S.addLayer(attacker, "恍惚", -1);
        events.push("【恍惚】觸發：" + attacker.name + " 這枚硬幣的幣威歸零（恍惚層 −1）");
      }
      if (isHead) power += effPower;
      const finalPower = Math.max(0, power); // 最終威力下限 0
      flipLog.push({ type: coin.type, status: coin.status, head: isHead, effPower: effPower,
        roll: d100.roll, threshold: d100.threshold });

      // 2. 凝神判定：1D20 < 級數 → 該枚 +30%，然後級數 −2、層數 −1
      let concentrationHit = false;
      const conLevel = S.levelOf(attacker, "凝神");
      if (conLevel > 0) {
        const d20 = opts.concentrationRolls
          ? opts.concentrationRolls[i]
          : yield { type: "concentration1d20", coinIndex: i, attackerId: attacker.id, level: conLevel };
        if (d20 < conLevel) {
          concentrationHit = true;
          S.addLevel(attacker, "凝神", -2);
          S.addLayer(attacker, "凝神", -1);
          events.push("【凝神】觸發！(1d20=" + d20 + " < " + conLevel + " 級) 這枚 +30%，凝神級數 −2、層數 −1");
        } else {
          events.push("【凝神】未觸發 (1d20=" + d20 + " ≥ " + conLevel + " 級)");
        }
      }

      // 2.5 逐枚 [硬幣正面時]：⚠ 排在凝神判定「之後」
      //     → 這枚剛上的凝神，這枚自己吃不到（裁決 14：給後續的重用吃）
      if (isHead && ce && ce.onHead) {
        yield* E.call(ce.onHead, coinCtx(coin, { isHead: true }));
      }

      // 3. 分組相乘 → 無條件退位
      const atkCoef = S.attackerCoefficient(attacker, concentrationHit);
      const tgtCoef = S.targetCoefficient(target);  // ⚠ 每枚重新讀（混亂可能中途生效）
      const dmg = Math.floor(finalPower * multiplier * atkCoef * tgtCoef);

      // 4. 先扣臨時生命值，扣完才扣真實血量
      const hpBefore = target.hp, tempBefore = target.tempHp;
      let remain = dmg;
      if (target.tempHp > 0) {
        const fromTemp = Math.min(target.tempHp, remain);
        target.tempHp -= fromTemp;
        remain -= fromTemp;
      }
      target.hp = Math.max(0, target.hp - remain);
      total += dmg;

      hits.push({
        index: i, type: coin.type, status: coin.status, head: isHead,
        effPower: effPower, finalPower: finalPower,
        atkCoef: atkCoef, tgtCoef: tgtCoef, damage: dmg
      });

      events.push("第 " + (i + 1) + " 下（" + coinLabel(coin) + "・" + (isHead ? "正面" : "反面") +
        "）最終威力 " + finalPower + " × 乘數 " + multiplier +
        " × 攻方 " + atkCoef.toFixed(2) + " × 目標 " + tgtCoef.toFixed(2) +
        " = " + dmg + "　→ HP " + hpBefore + " → " + target.hp +
        (tempBefore > 0 ? "（臨時HP " + tempBefore + " → " + target.tempHp + "）" : ""));

      // 被攻擊時觸發：萎靡（專注力−級數）、開裂（血量−級數）—— 每枚硬幣各一次
      S.onHitTriggers(target, events);

      // 5. 每扣完一次血，重新檢查黃金交叉（含開裂造成的扣血）
      if (S.crossedConfusion(target, hpBefore, target.hp)) {
        S.enterConfusion(target, events);
        events.push("→ 同一次攻擊剩餘的硬幣立即吃 +80%");
      }

      // 6. 逐枚 [命中時] → [命中後]
      //    ⚠ 反面照樣算命中（反面只是不加威力，硬幣仍然打出去了）—— 裁決 33
      if (ce) {
        const hitCtx = coinCtx(coin, { isHead: isHead });
        hitCtx.damage = dmg;
        if (ce.onHit) yield* E.call(ce.onHit, hitCtx);
        if (ce.afterHit) yield* E.call(ce.afterHit, hitCtx);
      }
    }

    if (flipLog.length) {
      // 擲幣摘要（裁決 53：log 只寫摘要）—— 玩家事後可自行驗算機率
      events.push(label + "：門檻 " + flipLog[0].threshold + "｜擲 " +
        flipLog.map(function (f) { return f.roll; }).join("、") +
        " → 正面 " + flipLog.filter(function (f) { return f.head; }).length + "／" + flipLog.length);
      C.recordRoll({
        who: attacker.name, whoId: attacker.id,
        basePower: basePower, coinPower: coinPower,
        power: hits.length ? hits[hits.length - 1].finalPower : basePower,
        heads: flipLog.filter(function (f) { return f.head; }).length,
        threshold: flipLog[0].threshold,
        coins: flipLog
      });
    }
    C.endGroup();
    return { hits: hits, totalDamage: total, events: events };
  }
  Damage.resolveDamage = resolveDamage;

  function coinLabel(coin) {
    const t = coin.type === "red" ? "紅" : coin.type === "green" ? "綠" : "普通";
    return t + (coin.status === C.SHATTERED ? "・已碎" : "");
  }

  /**
   * 碎幣追加攻擊：只有拚輸方觸發。
   * 基礎威力視同 1、每枚硬幣威力視同 +1、傷害乘數照常套用。
   */
  function* resolveShatteredFollowUp(attacker, target, coinRuntime, opts) {
    const shattered = C.shatteredCoins(coinRuntime);
    if (!shattered.length) return { hits: [], totalDamage: 0, events: [] };
    // 追加攻擊的硬幣視為「完好」以套用幣威 +1（避免 effectiveCoinPower 又壓成 1 以外的值）
    const rt = shattered.map(function (c) { return { type: c.type, status: C.INTACT }; });
    return yield* resolveDamage(attacker, target, rt, 1, 1, "碎幣追加攻擊", opts);
  }
  Damage.resolveShatteredFollowUp = resolveShatteredFollowUp;

  /**
   * 【防守】：增加「最終威力 × 5」的臨時生命值。
   * 防守的硬幣數量為 1；最終威力 = 基礎威力（＋正面則加幣威）。
   */
  function* resolveGuard(entity, skill, coinRuntime, basePower, opts) {
    opts = opts || {};
    const events = [];
    const cp = opts.coinPower !== undefined ? opts.coinPower : skill.coinPower;
    const roll = C.rollAllCoins(coinRuntime, basePower, cp, entity.focus, opts.rng, entity, events);
    const gain = Math.max(0, roll.power) * 5;
    entity.tempHp = (entity.tempHp || 0) + gain;
    events.push("【防守】" + entity.name + "：最終威力 " + roll.power + " × 5 = 臨時生命值 +" + gain +
      "（現 " + entity.tempHp + "）");
    return { gain: gain, events: events };
  }
  Damage.resolveGuard = resolveGuard;

  /**
   * 「以友方為目標、不造成傷害」的技能結算（和真的技能A：外科醫生的堅定守護）。
   * 逐枚擲幣並跑效果鉤子，但完全不結算傷害。
   *
   * ⚠ 「命中」的定義（裁決 33）：該枚硬幣有打出去就算，正反面都算
   *    → 每一枚未損失的硬幣都會跑 onHit／afterHit；onHead 只有正面才跑。
   *    這正好把「[硬幣正面時]」與「[命中時]」兩種措辭區分開來。
   */
  function* resolveSupport(actor, ally, skill, coinRuntime, opts) {
    opts = opts || {};
    const events = [];
    const E = global.Effects;
    const fx = opts.fx || null;
    const runtime = fx ? fx.runtime : null;

    const rollable = coinRuntime.filter(function (c) { return c.status !== C.LOST; });

    events.push("《" + skill.name + "》" + actor.name + " → " + (ally ? ally.name : "（無對象）") +
      "：不造成傷害，逐枚結算 " + rollable.length + " 枚硬幣");

    function mkCtx(coin, extra) {
      return E.makeCtx(Object.assign({
        self: actor, target: ally, skill: skill, battle: fx ? fx.battle : null,
        events: events, runtime: runtime, coinIndex: coin.index, coin: coin
      }, extra || {}));
    }

    for (let i = 0; i < rollable.length; i++) {
      if (runtime && runtime.stop) break;
      const coin = rollable[i];
      const ce = fx ? E.coinEffect(skill, coin.index) : null;
      if (ce && ce.onUse) {
        yield* E.call(ce.onUse, mkCtx(coin));
        if (runtime && runtime.stop) break;
      }
      const d100 = S.rollD100(actor.focus, opts.rng);
      const isHead = d100.head;
      events.push("　第 " + (i + 1) + " 枚：1d100 = " + d100.roll + "／門檻 " + d100.threshold +
        " → " + (isHead ? "正面" : "反面") + "（反面照樣算命中）");
      if (ce && isHead && ce.onHead) yield* E.call(ce.onHead, mkCtx(coin, { isHead: true }));
      if (ce && ce.onHit) yield* E.call(ce.onHit, mkCtx(coin, { isHead: isHead }));
      if (ce && ce.afterHit) yield* E.call(ce.afterHit, mkCtx(coin, { isHead: isHead }));
    }
    return { events: events };
  }
  Damage.resolveSupport = resolveSupport;

})(window);

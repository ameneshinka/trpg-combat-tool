// ============================================================
// 拚點引擎
// 規則來源：trpg-clash-rules skill（references/clash.md）
//
// 三個最容易寫錯的點（engine-notes.md）：
//   1. 碎幣「不是消失」：照擲、照拚點、照打，只是有效幣威視為 +1。
//   2. 最終威力必須「逐枚累加各自的有效幣威」，不可用 正面數 × 單一幣威。
//   3. 判輸條件是「沒有任何『完好』硬幣」，不是「可擲硬幣歸零」。
//
// 硬幣狀態作用域：損失與碎幣皆只限「本次技能使用」，用完全部恢復。
//   唯一例外【閃躲】—— 由呼叫端保存 coinRuntime 到回合結束（見 turn.js）。
// ============================================================
(function (global) {
  "use strict";
  const Clash = global.Clash = {};
  const S = global.States;

  const INTACT = "完好", LOST = "已損失", SHATTERED = "已碎幣";
  Clash.INTACT = INTACT; Clash.LOST = LOST; Clash.SHATTERED = SHATTERED;

  // ---------------- coinRuntime ----------------
  // 每次技能使用開始時建立全新的執行期硬幣狀態。
  // ⚠ index = 硬幣在技能序列裡的「原始位置」，用來對應 skill.coinEffects[i]。
  //   傷害結算時會濾掉已損失的硬幣，可擲序與原始序不一致 —— 逐枚效果一定要看 index。
  function makeCoinRuntime(skill) {
    return skill.coins.map(function (c, i) {
      return { index: i, type: (typeof c === "string" ? c : c.type), status: INTACT };
    });
  }
  Clash.makeCoinRuntime = makeCoinRuntime;

  // 有效硬幣威力：完好 → 技能幣威；已碎幣 → +1（本次使用期間）
  function effectiveCoinPower(coin, skillCoinPower) {
    return coin.status === SHATTERED ? 1 : skillCoinPower;
  }
  Clash.effectiveCoinPower = effectiveCoinPower;

  const notLost = function (c) { return c.status !== LOST; };       // 可擲、可打
  const isIntact = function (c) { return c.status === INTACT; };     // 判輸看這個

  Clash.rollableCoins = function (rt) { return rt.filter(notLost); };
  Clash.hasIntact = function (rt) { return rt.some(isIntact); };

  // ---------------- 擲幣記錄器（給 UI 播動畫用） ----------------
  /**
   * 硬幣是「程式自動擲」的，而且一整場拚點是在 generator 的同一步裡同步跑完
   * （resolveClash 中間不 yield）→ UI 沒辦法插在中間演動畫。
   * 所以改成「記錄後回放」：這裡把每次擲幣記下來，UI 在那一步結束後播成動畫。
   *
   * ⚠ 預設關閉 —— 沒呼叫 startRecording 就完全不收集，引擎行為與沒有這層時一模一樣。
   */
  let recorder = null;
  let pendingGroup = null;

  Clash.startRecording = function () { recorder = []; pendingGroup = null; return recorder; };
  Clash.stopRecording = function () {
    const r = recorder || [];
    recorder = null; pendingGroup = null;
    return r;
  };
  Clash.isRecording = function () { return !!recorder; };
  /** 開一個顯示群組：同一次拚點交換的雙方兩筆會合成一組，UI 才能並排對比。 */
  Clash.beginGroup = function (meta) {
    if (!recorder) return;
    pendingGroup = Object.assign({ rolls: [] }, meta || {});
    recorder.push(pendingGroup);
  };
  Clash.endGroup = function () { pendingGroup = null; };
  /** 記一筆擲幣。沒有明確分組時自成一組（例如【防守】的單筆擲幣）。 */
  function recordRoll(entry) {
    if (!recorder) return;
    if (!pendingGroup) { pendingGroup = { rolls: [] }; recorder.push(pendingGroup); }
    pendingGroup.rolls.push(entry);
  }
  Clash.recordRoll = recordRoll;

  // ---------------- 擲幣 ----------------
  // 可注入 rng 以利測試（預設 Math.random）
  function flip(prob, rng) { return (rng || Math.random)() < prob; }

  /**
   * 一次擲完當前所有「未損失」的硬幣，回傳最終威力。
   * ⚠ 逐枚累加各自的有效幣威（碎幣 +1、完好 = 幣威）。
   * ⚠ 最終威力下限為 0（基礎威力可為負）。
   */
  function rollAllCoins(coinRuntime, basePower, skillCoinPower, focus, rng, entity, events) {
    const prob = S.headsProbability(focus);
    let power = basePower;
    let heads = 0;
    const detail = [];
    coinRuntime.forEach(function (c, i) {
      if (c.status === LOST) return;
      const isHead = flip(prob, rng);
      let eff = effectiveCoinPower(c, skillCoinPower);
      // 【恍惚】「使用技能擲硬幣時」該枚幣威歸零 —— 拚點的擲幣也算（裁決 8）。
      // ⚠ 觸發粒度是「每枚各一次、每次層 −1」→ 1 層恍惚只廢掉 1 枚，
      //   而拚點比傷害早，所以恍惚通常會在拚點階段就被消耗掉。
      if (entity && S.layerOf(entity, "恍惚") > 0) {
        eff = 0;
        S.addLayer(entity, "恍惚", -1);
        if (events) events.push("【恍惚】觸發：" + entity.name + " 這枚硬幣的幣威歸零（恍惚層 −1）");
      }
      if (isHead) { power += eff; heads++; }
      detail.push({ index: i, type: c.type, status: c.status, head: isHead, effPower: eff });
    });
    const result = { power: Math.max(0, power), heads: heads, detail: detail };
    recordRoll({
      who: entity ? entity.name : "", whoId: entity ? entity.id : null,
      basePower: basePower, coinPower: skillCoinPower,
      power: result.power, heads: heads,
      coins: detail.map(function (d) {
        return { type: d.type, status: d.status, head: d.head, effPower: d.effPower };
      })
    });
    return result;
  }
  Clash.rollAllCoins = rollAllCoins;

  // ---------------- 綠幣對消（拚點開始前） ----------------
  /**
   * 我方綠幣 × 對方紅幣互相對消，數量 = min(我方綠, 對方紅)，雙方各損該數量。
   * ⚠ 被對消掉的紅幣是「損失」（消失），不是碎幣 → 不參與後續攻擊、不觸發追加攻擊。
   */
  function greenCancel(rtA, rtB, events, nameA, nameB) {
    const greensA = rtA.filter(function (c) { return c.type === "green" && c.status === INTACT; });
    const redsA = rtA.filter(function (c) { return c.type === "red" && c.status === INTACT; });
    const greensB = rtB.filter(function (c) { return c.type === "green" && c.status === INTACT; });
    const redsB = rtB.filter(function (c) { return c.type === "red" && c.status === INTACT; });

    const aCancels = Math.min(greensA.length, redsB.length); // A 的綠消 B 的紅
    const bCancels = Math.min(greensB.length, redsA.length); // B 的綠消 A 的紅

    for (let i = 0; i < aCancels; i++) { greensA[i].status = LOST; redsB[i].status = LOST; }
    for (let i = 0; i < bCancels; i++) { greensB[i].status = LOST; redsA[i].status = LOST; }

    if (aCancels > 0 && events) events.push("綠幣對消：" + nameA + " 綠幣 ×" + aCancels + " 抵銷 " + nameB + " 紅幣 ×" + aCancels + "（雙方皆為損失，紅幣不算碎幣）");
    if (bCancels > 0 && events) events.push("綠幣對消：" + nameB + " 綠幣 ×" + bCancels + " 抵銷 " + nameA + " 紅幣 ×" + bCancels + "（雙方皆為損失，紅幣不算碎幣）");
    return { aCancels: aCancels, bCancels: bCancels };
  }
  Clash.greenCancel = greenCancel;

  // ---------------- 輸掉一次交換的處理 ----------------
  /**
   * 處理「序列中第一枚完好的硬幣」：普通／綠 → 損失；紅 → 碎幣。
   */
  function degradeFirstIntact(coinRuntime) {
    const c = coinRuntime.find(isIntact);
    if (!c) return null;
    c.status = (c.type === "red") ? SHATTERED : LOST;
    return c;
  }
  Clash.degradeFirstIntact = degradeFirstIntact;

  // ---------------- 主流程 ----------------
  /**
   * 執行一場拚點。純函式風格：不改 entity（除了 States 的失血觸發會扣血），
   * 硬幣狀態改在傳入的 coinRuntime 上。
   *
   * side = { entity, skill, coinRuntime, basePower }
   *   basePower 已由呼叫端套用強壯／虛弱／屏息／遲鈍（States.effectiveBasePower）
   *
   * 回傳 { winner: "A"|"B"|null, exchanges: k, focusDelta, events[] }
   */
  function resolveClash(sideA, sideB, opts) {
    opts = opts || {};
    const rng = opts.rng;
    const events = [];
    const nameA = sideA.entity.name, nameB = sideB.entity.name;
    // 幣威可被技能層級的 [使用時] 修改（旭的閃躲、威爾技能C）→ 呼叫端算好後傳進來
    const cpA = sideA.coinPower !== undefined ? sideA.coinPower : sideA.skill.coinPower;
    const cpB = sideB.coinPower !== undefined ? sideB.coinPower : sideB.skill.coinPower;

    // 拚點全程使用「拚點開始前」的專注力值擲幣
    const focusA = sideA.entity.focus, focusB = sideB.entity.focus;

    greenCancel(sideA.coinRuntime, sideB.coinRuntime, events, nameA, nameB);

    // 開局即無完好硬幣（多半來自綠幣對消）→ 直接判定，不計交換次數
    const aIntact = Clash.hasIntact(sideA.coinRuntime);
    const bIntact = Clash.hasIntact(sideB.coinRuntime);
    if (!aIntact || !bIntact) {
      let winner = null;
      if (aIntact && !bIntact) winner = "A";
      else if (!aIntact && bIntact) winner = "B";
      events.push("拚點開始前已有一方沒有完好硬幣，直接判定（不計交換次數，專注力不變）");
      return { winner: winner, exchanges: 0, focusDelta: 0, events: events };
    }

    let k = 0;
    let winner = null;
    const MAX_EXCHANGES = 200; // 防呆：平手重擲理論上可無限

    while (k < MAX_EXCHANGES) {
      k++;
      // ⚠ 失血：進行拚點時，每次交換各觸發一次（雙方各自）
      S.onExchangeTriggers(sideA.entity, events);
      S.onExchangeTriggers(sideB.entity, events);

      // 同一次交換的雙方兩筆合成一組 → UI 才能並排對比、看出誰的最終威力比較高
      Clash.beginGroup({ kind: "clash", exchange: k, aName: nameA, bName: nameB });
      const rollA = rollAllCoins(sideA.coinRuntime, sideA.basePower, cpA, focusA, rng, sideA.entity, events);
      const rollB = rollAllCoins(sideB.coinRuntime, sideB.basePower, cpB, focusB, rng, sideB.entity, events);
      Clash.endGroup();

      events.push("交換 #" + k + "：" + nameA + " 正面 " + rollA.heads + "／" + rollA.detail.length +
        " → 最終威力 " + rollA.power + "　vs　" + nameB + " 正面 " + rollB.heads + "／" + rollB.detail.length +
        " → 最終威力 " + rollB.power);

      if (rollA.power === rollB.power) {
        events.push("→ 平手，重擲這次交換（不損幣，但計入交換次數 k）");
        continue;
      }

      const loserSide = rollA.power > rollB.power ? sideB : sideA;
      const loserName = rollA.power > rollB.power ? nameB : nameA;
      const degraded = degradeFirstIntact(loserSide.coinRuntime);
      if (degraded) {
        events.push("→ " + loserName + " 輸掉這次交換，第一枚完好硬幣" +
          (degraded.status === SHATTERED ? "【碎幣】（仍留在序列中，幣威視為 +1）" : "【損失】（退出本次使用）"));
      }

      if (!Clash.hasIntact(loserSide.coinRuntime)) {
        winner = (loserSide === sideA) ? "B" : "A";
        events.push((winner === "A" ? nameA : nameB) + " 的技能通過拚點！（共 " + k + " 次交換）");
        break;
      }
    }

    // 專注力：拚點結束後一次結算 ±(2k+2)，僅雙方皆攻擊型技能才變動
    let focusDelta = 0;
    const bothAttack = sideA.skill.type === "attack" && sideB.skill.type === "attack";
    if (winner && bothAttack) {
      focusDelta = 2 * k + 2;
      const winEnt = winner === "A" ? sideA.entity : sideB.entity;
      const loseEnt = winner === "A" ? sideB.entity : sideA.entity;
      winEnt.focus = S.clampFocus(winEnt.focus + focusDelta);
      loseEnt.focus = S.clampFocus(loseEnt.focus - focusDelta);
      events.push("專注力結算：" + winEnt.name + " +" + focusDelta + "（現 " + winEnt.focus + "）、" +
        loseEnt.name + " −" + focusDelta + "（現 " + loseEnt.focus + "）");
    } else if (winner) {
      events.push("專注力不變（非雙方皆使用攻擊型技能）");
    }

    return { winner: winner, exchanges: k, focusDelta: focusDelta, events: events };
  }
  Clash.resolveClash = resolveClash;

  // ---------------- 碎幣追加攻擊的取用 ----------------
  // 只有「拚輸」的一方才觸發；把所有碎掉的紅幣做一次單方面追加攻擊。
  // 追加攻擊：基礎威力視同 1、每枚硬幣威力視同 +1、傷害乘數照常套用。
  function shatteredCoins(coinRuntime) {
    return coinRuntime.filter(function (c) { return c.status === SHATTERED; });
  }
  Clash.shatteredCoins = shatteredCoins;

})(window);

// ============================================================
// 狀態管線（層數／級數、持續狀態、觸發、混亂／恐慌、震顫／瀑）
// 規則來源：trpg-clash-rules skill（references/states.md, terminology.md）
// 純邏輯，無 DOM 依賴。掛在全域 window.States
// ============================================================
(function (global) {
  "use strict";
  const States = global.States = {};

  // ---------------- 狀態目錄 ----------------
  // 持續生效（全部層數驅動）
  const LAYER_DRIVEN = [
    "守護", "易損", "傷害強化", "傷害弱化", "迅捷", "綁縛",
    "強壯", "虛弱", "屏息", "遲鈍", "恍惚"
  ];
  // 級數驅動（真正用到級數）
  const LEVEL_DRIVEN = [
    "凝神", "震顫", "萎靡", "延燒", "失血", "開裂"
  ];
  // 瀑系列：純標籤，靠對應「殘響」效果引爆
  const BURST_TAGS = ["血瀑", "炎瀑", "荊棘瀑"];
  const BURST_PARTNER = { "血瀑": "失血", "炎瀑": "延燒", "荊棘瀑": "開裂" };

  const LAYER_CAPS = {
    "守護": 16, "易損": 16, "傷害強化": 16, "傷害弱化": 16,
    "迅捷": 10, "綁縛": 10
  };
  const LEVEL_CAP_DEFAULT = 99; // 未明定上限的級數統一 99（含震顫、凝神）

  States.LAYER_DRIVEN = LAYER_DRIVEN;
  States.LEVEL_DRIVEN = LEVEL_DRIVEN;
  States.BURST_TAGS = BURST_TAGS;
  States.BURST_PARTNER = BURST_PARTNER;
  States.LAYER_CAPS = LAYER_CAPS;
  States.isBurstTag = function (n) { return BURST_TAGS.indexOf(n) !== -1; };
  States.isLevelDriven = function (n) { return LEVEL_DRIVEN.indexOf(n) !== -1; };
  States.isLayerDriven = function (n) { return LAYER_DRIVEN.indexOf(n) !== -1; };

  /**
   * 這個狀態「有沒有級數」這個概念？
   * 依 states.md 與 rulings #7：只有 LEVEL_DRIVEN 那六個是級數驅動；
   * 持續生效那批與【恍惚】只有層數；瀑系列是純標籤；
   * 自訂印記依 authoring.md 也是「純標籤、只有層數」→ 一律沒有級數。
   * 供 UI 決定要不要開放「級」欄位，也供 addLevel 擋掉無意義的資料。
   */
  function hasLevel(name) { return LEVEL_DRIVEN.indexOf(name) !== -1; }
  States.hasLevel = hasLevel;

  // ---------------- 基本存取 ----------------
  function get(entity, name) {
    return entity.states[name] || { layer: 0, level: 0 };
  }
  function ensure(entity, name) {
    if (!entity.states[name]) entity.states[name] = { layer: 0, level: 0 };
    return entity.states[name];
  }
  function layerOf(entity, name) { return get(entity, name).layer || 0; }
  function levelOf(entity, name) { return get(entity, name).level || 0; }
  States.get = get;
  States.layerOf = layerOf;
  States.levelOf = levelOf;

  /**
   * 加減層數。
   * ⚠ 層數從 ≥1 掉到 0 時，級數同步歸零（terminology.md「級數依附層數」）。
   * opts.exemptThisTurn: 階段六步驟1 才新增的狀態，豁免該次的回合結束層 −1。
   */
  function addLayer(entity, name, delta, opts) {
    opts = opts || {};
    const st = ensure(entity, name);
    const before = st.layer || 0;
    let next = before + delta;
    const cap = LAYER_CAPS[name];
    if (cap !== undefined && next > cap) next = cap;
    if (next < 0) next = 0;
    st.layer = next;
    if (before >= 1 && next === 0) st.level = 0; // 級數同步歸零
    if (opts.exemptThisTurn) st.addedThisTurn = true;
    if (States.isBurstTag(name)) { st.isMark = true; st.isBurstTag = true; }
    return st;
  }

  /**
   * 加減級數。兩道防呆：
   * ⚠ ① 這個狀態必須「有級數」這個概念（只有 LEVEL_DRIVEN 六個有）。
   *      對層數驅動狀態／瀑標記／自訂印記加級數是無意義的資料 → 直接丟棄並回報。
   * ⚠ ② 級數必須依附層數：層數為 0 時，「增加」級數的效果直接丟棄（不能預存）。
   */
  function addLevel(entity, name, delta, opts) {
    opts = opts || {};
    const st = ensure(entity, name);
    if (delta > 0 && !hasLevel(name)) {
      return {
        dropped: true,
        reason: States.isBurstTag(name) ? "【" + name + "】是純標籤，沒有級數"
          : States.isLayerDriven(name) ? "【" + name + "】是層數驅動狀態，沒有級數"
          : "【" + name + "】是印記（純標籤），沒有級數",
        state: st
      };
    }
    if (delta > 0 && (st.layer || 0) <= 0) {
      return { dropped: true, reason: "層數為 0，級數無法預存", state: st };
    }
    let next = (st.level || 0) + delta;
    if (next < 0) next = 0;
    if (next > LEVEL_CAP_DEFAULT) next = LEVEL_CAP_DEFAULT;
    st.level = next;
    if (opts.exemptThisTurn) st.addedThisTurn = true;
    return { dropped: false, state: st };
  }

  /**
   * 施加狀態的統一入口（技能／被動都走這裡）。
   * 先加層再加級 —— 順序重要：同一次效果若同時給層與級，層要先存在級才進得去。
   * 回傳事件字串陣列供 log。
   */
  function apply(entity, name, layerDelta, levelDelta, opts) {
    opts = opts || {};
    const events = [];
    if (layerDelta) {
      addLayer(entity, name, layerDelta, opts);
      events.push(entity.name + " 的【" + name + "】層數 " + (layerDelta > 0 ? "+" : "") + layerDelta +
        "（現 " + layerOf(entity, name) + " 層）");
    }
    if (levelDelta) {
      const r = addLevel(entity, name, levelDelta, opts);
      if (r.dropped) {
        events.push("⚠ " + entity.name + " 的【" + name + "】級數 " +
          (levelDelta > 0 ? "+" : "") + levelDelta + " 無效：" + r.reason);
      } else {
        events.push(entity.name + " 的【" + name + "】級數 " + (levelDelta > 0 ? "+" : "") + levelDelta +
          "（現 " + levelOf(entity, name) + " 級）");
      }
    }
    if (opts.isMark) ensure(entity, name).isMark = true;
    return events;
  }

  function clearZero(entity) {
    Object.keys(entity.states).forEach(function (k) {
      const st = entity.states[k];
      if (st.isBurstTag) return; // 瀑標記持續存在
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) delete entity.states[k];
    });
  }

  States.ensure = ensure;
  States.addLayer = addLayer;
  States.addLevel = addLevel;
  States.apply = apply;
  States.clearZero = clearZero;

  // ---------------- 持續生效狀態的讀值 ----------------
  function effectiveDex(entity) {
    const swift = layerOf(entity, "迅捷");
    const bind = layerOf(entity, "綁縛");
    return entity.dex * (1 + 0.05 * swift - 0.05 * bind);
  }

  // 強壯／虛弱改基礎威力（拚點與傷害都吃）；屏息／遲鈍只改防禦型
  // ⚠ 基礎威力可以為負（虛弱持續累積代價，不在 0 處封頂）
  function effectiveBasePower(entity, skill) {
    let base = skill.basePower;
    if (skill.type === "defense") {
      base += layerOf(entity, "屏息") - layerOf(entity, "遲鈍");
    } else {
      base += layerOf(entity, "強壯") - layerOf(entity, "虛弱");
    }
    return base;
  }

  function attackerCoefficient(attacker, concentrationHit) {
    let c = 1 + 0.05 * layerOf(attacker, "傷害強化") - 0.05 * layerOf(attacker, "傷害弱化");
    if (concentrationHit) c += 0.30;
    return c;
  }
  function targetCoefficient(target) {
    let c = 1 + 0.05 * layerOf(target, "易損") - 0.05 * layerOf(target, "守護");
    if (target.isConfused) c += 0.80;
    return c;
  }

  States.effectiveDex = effectiveDex;
  States.effectiveBasePower = effectiveBasePower;
  States.attackerCoefficient = attackerCoefficient;
  States.targetCoefficient = targetCoefficient;

  // ---------------- 混亂值 ----------------
  function defaultThresholds(entity) {
    return [Math.floor(entity.maxHp * 0.6), 0];
  }
  function thresholds(entity) {
    if (!entity.confusionThresholds || !entity.confusionThresholds.length) {
      entity.confusionThresholds = defaultThresholds(entity);
    }
    return entity.confusionThresholds;
  }

  /**
   * 黃金交叉：血量「低於或等於」任一混亂值的瞬間即進入混亂。
   * 已在混亂中（或鎖定中）不重複觸發。
   */
  function crossedConfusion(entity, hpBefore, hpAfter) {
    if (entity.isConfused || entity.confusionLockTurns > 0) return false;
    const th = thresholds(entity);
    for (let i = 0; i < th.length; i++) {
      if (hpBefore > th[i] && hpAfter <= th[i]) return true;
    }
    return false;
  }

  function enterConfusion(entity, events) {
    entity.isConfused = true;
    entity.confusionLockTurns = 2;
    entity.cantActRestOfTurn = true;
    if (events) events.push("⚠ " + entity.name + " 血量跨過混亂值，立即進入混亂！本回合剩餘行動作廢（鎖定 2 回合）");
  }

  /**
   * 把「距離當前血量最近」的混亂值向上增加 amount（震顫爆發／瀑系列共用）。
   * ⚠ 0% 處的混亂值被向上增加後，要在 0% 處額外新增一條（states.md）。
   * 上推後若門檻追上當前血量，立即進入混亂。
   */
  function raiseNearestThreshold(entity, amount, events) {
    amount = Math.floor(amount || 0);
    if (amount <= 0) return;
    const th = thresholds(entity);
    let idx = 0, best = Infinity;
    for (let i = 0; i < th.length; i++) {
      const d = Math.abs(entity.hp - th[i]);
      if (d < best) { best = d; idx = i; }
    }
    const wasZeroThreshold = (th[idx] === 0);
    th[idx] += amount;
    if (events) events.push("混亂值上升：" + entity.name + " 最接近血量的混亂值 +" + amount + " → " + th[idx]);
    if (wasZeroThreshold) {
      th.push(0); // 0% 處補回一條
      if (events) events.push("（0% 處的混亂值被上推，於 0% 額外新增一條）");
    }
    if (!entity.isConfused && entity.confusionLockTurns <= 0 && entity.hp <= th[idx]) {
      enterConfusion(entity, events);
    }
  }

  States.thresholds = thresholds;
  States.crossedConfusion = crossedConfusion;
  States.enterConfusion = enterConfusion;
  States.raiseNearestThreshold = raiseNearestThreshold;

  // ---------------- 直接扣血（非逐枚攻擊用） ----------------
  // 先扣臨時生命值、再扣真實血量，並重檢黃金交叉。
  function dealDirectDamage(entity, amount, label, events) {
    amount = Math.max(0, Math.floor(amount || 0));
    if (amount <= 0) return 0;
    const hpBefore = entity.hp;
    const tempBefore = entity.tempHp || 0;
    let remain = amount;
    let fromTemp = 0;
    if (entity.tempHp > 0) {
      fromTemp = Math.min(entity.tempHp, remain);
      entity.tempHp -= fromTemp;
      remain -= fromTemp;
    }
    entity.hp = Math.max(0, entity.hp - remain);
    if (events) {
      // 明確標出「臨時生命值吸收了多少、真實血量掉了多少」，否則桌邊會看不懂
      const split = fromTemp > 0
        ? "（臨時HP 吸收 " + fromTemp + "：" + tempBefore + " → " + entity.tempHp +
          "；真實血量 −" + remain + "：" + hpBefore + " → " + entity.hp + "）"
        : "（HP " + hpBefore + " → " + entity.hp + "）";
      events.push((label || "傷害") + "：" + entity.name + " 共 −" + amount + " " + split);
    }
    if (crossedConfusion(entity, hpBefore, entity.hp)) enterConfusion(entity, events);
    return amount;
  }
  States.dealDirectDamage = dealDirectDamage;

  // ---------------- 觸發時機 ----------------
  // 被攻擊時：萎靡（專注力−級數）、開裂（血量−級數）。每枚硬幣各觸發一次，各自層 −1。
  function onHitTriggers(target, events) {
    const wither = get(target, "萎靡");
    if ((wither.layer || 0) > 0 && (wither.level || 0) > 0) {
      target.focus = clampFocus(target.focus - wither.level);
      if (events) events.push("【萎靡】觸發：" + target.name + " 專注力 −" + wither.level + "（現 " + target.focus + "）");
      addLayer(target, "萎靡", -1);
    }
    const crack = get(target, "開裂");
    if ((crack.layer || 0) > 0 && (crack.level || 0) > 0) {
      dealDirectDamage(target, crack.level, "【開裂】觸發", events);
      addLayer(target, "開裂", -1);
    }
  }

  // 進行拚點時：失血（血量−級數）。每次交換各觸發一次。
  function onExchangeTriggers(entity, events) {
    const bleed = get(entity, "失血");
    if ((bleed.layer || 0) > 0 && (bleed.level || 0) > 0) {
      dealDirectDamage(entity, bleed.level, "【失血】觸發", events);
      addLayer(entity, "失血", -1);
    }
  }

  // 回合結束：延燒（血量−級數，先扣臨時HP）。
  // ⚠ 這裡「只扣血、不扣層」—— 延燒的層 −1 與階段六通則的層 −1 視為同一次，
  //   由 turn.js 步驟 3 統一扣（否則會變成扣兩次或完全不扣）。
  function onTurnEndBurn(entity, events) {
    const burn = get(entity, "延燒");
    if ((burn.layer || 0) > 0 && (burn.level || 0) > 0) {
      dealDirectDamage(entity, burn.level, "【延燒】觸發", events);
      return true;
    }
    return false;
  }

  States.onHitTriggers = onHitTriggers;
  States.onExchangeTriggers = onExchangeTriggers;
  States.onTurnEndBurn = onTurnEndBurn;

  // ---------------- 震顫爆發／瀑系列 ----------------
  /**
   * 震顫爆發：最接近血量的混亂值 + 震顫級數 → 然後震顫【級數歸零、層數 −1】。
   */
  function tremorBurst(target, events) {
    const lv = levelOf(target, "震顫");
    if (lv <= 0) { if (events) events.push("【震顫爆發】：" + target.name + " 無累積的震顫級數，無效果"); return 0; }
    if (events) events.push("【震顫爆發】：" + target.name + " 引爆 " + lv + " 級震顫");
    raiseNearestThreshold(target, lv, events);
    const st = ensure(target, "震顫");
    st.level = 0;
    addLayer(target, "震顫", -1);
    return lv;
  }

  /**
   * 瀑殘響：量 = ⌊(震顫級數 ＋ 夥伴級數) × 50%⌋，
   * 同時「扣血」與「混亂值上升」相同的量；然後夥伴與震顫【層數歸零】。
   * 夥伴：血瀑↔失血、炎瀑↔延燒、荊棘瀑↔開裂。
   */
  function burstResonance(target, burstName, events) {
    const tag = target.states[burstName];
    if (!(tag && tag.isBurstTag)) {
      if (events) events.push("【" + burstName + "殘響】：" + target.name + " 沒有〈" + burstName + "〉標記，無效果");
      return 0;
    }
    const partner = BURST_PARTNER[burstName];
    const tremorLv = levelOf(target, "震顫");
    const partnerLv = levelOf(target, partner);
    const amount = Math.floor((tremorLv + partnerLv) * 0.5);
    if (events) events.push("【" + burstName + "殘響】：震顫 " + tremorLv + " 級 ＋ " + partner + " " +
      partnerLv + " 級 → ⌊" + (tremorLv + partnerLv) + " × 50%⌋ = " + amount);
    if (amount > 0) {
      raiseNearestThreshold(target, amount, events);          // 先推混亂值
      dealDirectDamage(target, amount, "【" + burstName + "】", events); // 再扣血
    }
    // 夥伴與震顫層數歸零（層 →0 會連帶把級數歸零）
    const ps = ensure(target, partner); ps.layer = 0; ps.level = 0;
    const ts = ensure(target, "震顫"); ts.layer = 0; ts.level = 0;
    if (events) events.push("（〈" + burstName + "〉標記保留，【" + partner + "】與【震顫】層數歸零）");
    return amount;
  }

  States.tremorBurst = tremorBurst;
  States.burstResonance = burstResonance;

  // ---------------- 專注力 ----------------
  function clampFocus(v) { return Math.max(-40, Math.min(40, v)); }
  States.clampFocus = clampFocus;
  // 正面機率 = 50% + 專注力%，夾在 10%~90%
  function headsProbability(focus) {
    return Math.max(0.10, Math.min(0.90, 0.5 + (focus || 0) / 100));
  }
  States.headsProbability = headsProbability;

})(window);

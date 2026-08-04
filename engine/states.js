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
  /**
   * 取得（必要時建立）狀態物件。
   * 旗標存在狀態物件上（沿用 isBurstTag 的做法），新增印記不必改引擎：
   *   noDecay   不因回合結束而減少（〈櫻之香〉〈勁足〉〈仁心〉〈茶乃的秘方藥〉）
   *   maxLayer  自訂層數上限（〈爆裂綻放〉1、〈仁心〉4、〈秘方藥〉5）
   * 來源有兩個：角色資料的 entity.markMeta（宣告一次、永遠生效），
   * 或 apply() 的 opts（臨時指定）。
   */
  function ensure(entity, name) {
    if (!entity.states[name]) {
      const st = { layer: 0, level: 0 };
      const meta = (entity.markMeta || {})[name];
      if (meta) {
        st.isMark = true;
        if (meta.noDecay) st.noDecay = true;
        if (meta.maxLayer !== undefined) st.maxLayer = meta.maxLayer;
      }
      entity.states[name] = st;
    }
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
  /**
   * 本回合的狀態變化流水帳。
   *
   * 為什麼需要：規則的「回合中貼上的狀態，回合結束層數 −1」讓 1 層的狀態
   * 在同一個回合結束時就整個消失（lifecycle.md 的記憶法明講「1 層當場消失」）。
   * KP 在「開始下一回合」畫面看板子時，剛才貼上的東西早就褪光了，
   * 看起來就像「技能沒生效」—— 這一區就是要讓那個過程看得見。
   *
   * ⚠ 記在 addLayer／addLevel 這兩個唯一關口，所以技能、被動、震顫爆發、
   *   記帳收回、延遲債務、階段六衰減全部會被記到。
   * ⚠ 要能 JSON 序列化進 Firebase → 只放短鍵的純值。
   */
  function journal(entity, name, dLayer, dLevel, note) {
    if (!dLayer && !dLevel && !note) return;
    entity._turnLog = entity._turnLog || [];
    const e = { n: name };
    if (dLayer) e.dl = dLayer;
    if (dLevel) e.dv = dLevel;
    if (note) e.note = note;
    entity._turnLog.push(e);
  }
  States.journal = journal;
  States.resetTurnLog = function (entity) { entity._turnLog = []; };

  /**
   * 把一個狀態整個歸零，並記進本回合流水帳。
   * ⚠ 不要直接寫 `st.layer = 0` —— 那會繞過流水帳，「本回合變化」就會漏記，
   *   桌邊看到的數字對不起來（例如震顫被引爆卻看不到級數是怎麼消失的）。
   */
  function zeroState(entity, name, note) {
    const st = ensure(entity, name);
    const dl = -(st.layer || 0), dv = -(st.level || 0);
    st.layer = 0; st.level = 0;
    journal(entity, name, dl, dv, note || null);
    return st;
  }
  States.zeroState = zeroState;

  function addLayer(entity, name, delta, opts) {
    opts = opts || {};
    const st = ensure(entity, name);
    const before = st.layer || 0;
    let next = before + delta;
    // 自訂上限（印記）優先於通用上限表
    const cap = st.maxLayer !== undefined ? st.maxLayer : LAYER_CAPS[name];
    if (cap !== undefined && next > cap) next = cap;
    if (next < 0) next = 0;
    const levelBefore = st.level || 0;
    st.layer = next;
    if (before >= 1 && next === 0) st.level = 0; // 級數同步歸零
    if (opts.exemptThisTurn) st.addedThisTurn = true;
    if (States.isBurstTag(name)) { st.isMark = true; st.isBurstTag = true; }
    journal(entity, name, next - before, (st.level || 0) - levelBefore,
      (before >= 1 && next === 0 && levelBefore > 0) ? "層數歸零 → 級數同步歸零" : null);
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
      // ⚠ 這是桌邊最容易誤會成「技能沒生效」的情況 → 一定要記進流水帳
      journal(entity, name, 0, 0, "＋" + delta + " 級被丟棄（層數為 0，級數無法預存）");
      return { dropped: true, reason: "層數為 0，級數無法預存", state: st };
    }
    const before = st.level || 0;
    let next = before + delta;
    if (next < 0) next = 0;
    if (next > LEVEL_CAP_DEFAULT) next = LEVEL_CAP_DEFAULT;
    st.level = next;
    if (opts.exemptThisTurn) st.addedThisTurn = true;
    journal(entity, name, 0, next - before, opts.note || null);
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
    if (opts.isMark || opts.noDecay || opts.maxLayer !== undefined) {
      const st = ensure(entity, name);
      if (opts.isMark) st.isMark = true;
      if (opts.noDecay) st.noDecay = true;
      if (opts.maxLayer !== undefined) st.maxLayer = opts.maxLayer;
    }
    return events;
  }

  function clearZero(entity) {
    Object.keys(entity.states).forEach(function (k) {
      const st = entity.states[k];
      if (st.isBurstTag) return; // 瀑標記持續存在
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) delete entity.states[k];
    });
  }

  // ---------------- 記帳式臨時增益 ----------------
  /**
   * 「給多少就收多少」的臨時增益（裁決 21、28）。
   *
   * 為什麼不能整個歸零：結月的爆裂綻放在回合開始給一批凝神／傷害強化／強壯，
   * 但她回合中用技能還會自己疊 —— 回合結束若整個清掉，會連她自己疊的一起吃掉。
   * 所以施加時記下「實際給進去多少」（吃過上限之後的真實增量），回合結束只扣這些。
   *
   * 帳本存在「施予者」身上：granter._grants[key] = [{ targetId, name, layer, level }]
   * ⚠ 存 targetId 而不是物件參照 —— 戰鬥狀態會被 JSON 序列化送進 Firebase。
   */
  function grant(granter, target, key, name, layerDelta, levelDelta, events) {
    const beforeL = layerOf(target, name), beforeV = levelOf(target, name);
    apply(target, name, layerDelta || 0, levelDelta || 0).forEach(function (m) {
      if (events) events.push(m);
    });
    const gotL = layerOf(target, name) - beforeL;
    const gotV = levelOf(target, name) - beforeV;
    if (gotL === 0 && gotV === 0) return { layer: 0, level: 0 };
    granter._grants = granter._grants || {};
    (granter._grants[key] = granter._grants[key] || []).push({
      targetId: target.id, name: name, layer: gotL, level: gotV
    });
    return { layer: gotL, level: gotV };
  }

  /** 收回某本帳記過的全部增益，然後清空帳本。 */
  function revoke(granter, battle, key, events) {
    const list = (granter._grants || {})[key];
    if (!list || !list.length) return 0;
    let n = 0;
    list.forEach(function (g) {
      const t = battle.entities.find(function (x) { return x.id === g.targetId; });
      if (!t) return;
      // ⚠ 先收級數再收層數 —— 層數掉到 0 會連帶把級數歸零，順序反了會多扣
      if (g.level) addLevel(t, g.name, -g.level);
      if (g.layer) addLayer(t, g.name, -g.layer);
      if (events) {
        events.push("（臨時增益收回）" + t.name + " 的【" + g.name + "】" +
          (g.layer ? "層 −" + g.layer : "") + (g.layer && g.level ? "、" : "") +
          (g.level ? "級 −" + g.level : ""));
      }
      n++;
    });
    delete granter._grants[key];
    return n;
  }

  // ---------------- 延遲債務 ----------------
  /**
   * 記在「別人」身上、之後才結算的效果（和真被動4：兩回合後扣 8 層守護）。
   * 掛在承受者身上，於階段一開頭統一結算。
   * ⚠ 承受者倒下 → 債務取消（裁決 40）。
   */
  function addPendingDebt(entity, debt) {
    entity.pendingDebts = entity.pendingDebts || [];
    entity.pendingDebts.push(debt);   // { name, layer, level, label }
  }

  function runPendingDebts(entity, events) {
    const list = entity.pendingDebts || [];
    if (!list.length) return 0;
    entity.pendingDebts = [];
    if (entity.hp <= 0) {
      if (events) events.push(entity.name + " 已倒下，" + list.length + " 筆延遲債務取消");
      return 0;
    }
    list.forEach(function (d) {
      const beforeL = layerOf(entity, d.name);
      if (d.level) addLevel(entity, d.name, d.level);
      if (d.layer) addLayer(entity, d.name, d.layer);
      if (events) {
        events.push("〈" + (d.label || "延遲效果") + "〉" + entity.name + " 的【" + d.name + "】" +
          "層 " + beforeL + " → " + layerOf(entity, d.name) +
          (d.layer < 0 && beforeL < -d.layer ? "（不足，扣到 0 為止）" : ""));
      }
    });
    return list.length;
  }

  States.ensure = ensure;
  States.addLayer = addLayer;
  States.addLevel = addLevel;
  States.apply = apply;
  States.clearZero = clearZero;
  States.grant = grant;
  States.revoke = revoke;
  States.addPendingDebt = addPendingDebt;
  States.runPendingDebts = runPendingDebts;

  // ---------------- 持續生效狀態的讀值 ----------------
  // 【迅捷】【綁縛】每層 ±5「點」DEX（裁決 54）。
  // ⚠ trpg-clash-rules 的 states.md 寫的是「DEX ± 層×5%」—— 那是受 COC 角色卡書寫
  //   習慣影響的筆誤，設計原意是定值加減。工具以此為準，見 README 的裁決清單。
  // ⚠ 定值加減對「低 DEX 角色」的相對影響大得多：
  //   旭 90 吃 5 層迅捷 舊 112.5／新 115（差不多）；
  //   哥布林 40 吃 10 層綁縛 舊 20／新 −10 → 所以要有下限。
  const DEX_PER_LAYER = 5;
  const DEX_FLOOR = 1;        // 裁決 55：再怎麼壓也不會變成 0 或負數
  States.DEX_PER_LAYER = DEX_PER_LAYER;
  States.DEX_FLOOR = DEX_FLOOR;

  function effectiveDex(entity) {
    const swift = layerOf(entity, "迅捷");
    const bind = layerOf(entity, "綁縛");
    return Math.max(DEX_FLOOR, entity.dex + DEX_PER_LAYER * (swift - bind));
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
  function tremorBurst(target, events, opts) {
    opts = opts || {};
    const lv = levelOf(target, "震顫");
    if (lv <= 0) { if (events) events.push("【震顫爆發】：" + target.name + " 無累積的震顫級數，無效果"); return 0; }
    if (events) events.push("【震顫爆發】：" + target.name + " 引爆 " + lv + " 級震顫");
    raiseNearestThreshold(target, lv, events);
    // opts.keepLevel：旭技能D 前三枚「此次爆發不會導致級數歸零」（裁決 29）
    // ⚠ 層數照減 −1；層數若因此掉到 0，級數仍會依「級數依附層數」同步歸零
    if (opts.keepLevel) {
      if (events) events.push("（此次爆發不歸零【震顫】級數，保留 " + lv + " 級）");
    } else {
      // 走 addLevel 而不是直接指派 → 才會記進「本回合變化」
      addLevel(target, "震顫", -lv, { note: "引爆" });
    }
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
    zeroState(target, partner, "【" + burstName + "】殘響");
    zeroState(target, "震顫", "【" + burstName + "】殘響");
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

  /**
   * 擲一次 1d100 決定硬幣正反面（COC 式呈現，裁決 53）。
   *
   * 為什麼要這樣呈現：玩家連續看到反面時會懷疑系統寫錯，而只顯示「正／反」
   * 事後無從驗證。給出數字與門檻，玩家自己就能確認機率確實對應當前專注力。
   *
   * ⚠ 機率與舊寫法「完全相同」，不是近似：
   *   專注力是 −40~+40 的整數 → 門檻 = 50 + 專注力，恆為 10~90 的整數
   *   → 「擲 1~62」共 62 個數字 = 62%，等同於 Math.random() < 0.62
   * ⚠ 門檻要 Math.round —— 0.5 + 12/100 在浮點下是 0.6200000000000001
   */
  function rollD100(focus, rng) {
    const threshold = Math.round(headsProbability(focus) * 100);
    const roll = 1 + Math.floor((rng || Math.random)() * 100);
    return { roll: roll, threshold: threshold, head: roll <= threshold };
  }
  States.rollD100 = rollD100;

})(window);

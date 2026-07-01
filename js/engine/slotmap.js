// ============================================================
// Engine 共用工具 + 技能對照表(slotMap) + 技能抽選  (規格書 §4, §5 step3-4)
// ============================================================
(function (global) {
  "use strict";
  const Engine = global.Engine = global.Engine || {};

  // ---------------- 條件直譯器（slotMapRule.condition / skill.conditions 共用） ----------------
  function evaluateCondition(cond, ctx) {
    if (!cond) return true;
    const who = cond.who === "target" ? ctx.target : ctx.self;
    switch (cond.type) {
      case "always": return true;
      case "hasState": {
        if (!who) return false;
        const st = who.states[cond.state];
        if (!st) return false;
        if (cond.minLayer !== undefined && (st.layer || 0) < cond.minLayer) return false;
        if (cond.minLevel !== undefined && (st.level || 0) < cond.minLevel) return false;
        return true;
      }
      case "stateLayerEquals":
        return !!(who && who.states[cond.state] && (who.states[cond.state].layer || 0) === cond.value);
      case "stateLevelEquals":
        return !!(who && who.states[cond.state] && (who.states[cond.state].level || 0) === cond.value);
      case "not": return !evaluateCondition(cond.cond, ctx);
      case "and": return (cond.conds || []).every(function (c) { return evaluateCondition(c, ctx); });
      case "or": return (cond.conds || []).some(function (c) { return evaluateCondition(c, ctx); });
      default: return false;
    }
  }
  Engine.evaluateCondition = evaluateCondition;

  // ---------------- 狀態層級存取（含上限夾住） ----------------
  function getState(entity, name) {
    return entity.states[name] || { layer: 0, level: 0 };
  }
  function ensureState(entity, name) {
    if (!entity.states[name]) entity.states[name] = { layer: 0, level: 0, isMark: false };
    return entity.states[name];
  }
  function addStateLayer(entity, name, delta, opts) {
    const st = ensureState(entity, name);
    st.layer = (st.layer || 0) + delta;
    const cap = global.Data.LAYER_CAPS[name];
    if (cap !== undefined && st.layer > cap) st.layer = cap;
    if (st.layer < 0) st.layer = 0;
    if (opts && opts.justAdded) st.justAddedThisTurn = true;
    if (st.layer === 0) st.level = 0; // §2: 層數歸零，級數同步歸零
    return st;
  }
  function addStateLevel(entity, name, delta, opts) {
    const st = ensureState(entity, name);
    st.level = (st.level || 0) + delta;
    if (st.level < 0) st.level = 0;
    if (opts && opts.justAdded) st.justAddedThisTurn = true;
    return st;
  }
  // opts.exemptThisTurn: 只有「階段六步驟2（回合結束被動）」新加的狀態才設 true，
  // 使其豁免同階段步驟3的層-1（§5 phase6 例外）。回合中(技能命中/KP手動)貼上的
  // 狀態「不」豁免——會在回合結束照常-1（§5 line222 記憶法）。
  function applyState(entity, name, layerDelta, levelDelta, opts) {
    opts = opts || {};
    const exempt = !!opts.exemptThisTurn;
    if (layerDelta) addStateLayer(entity, name, layerDelta, { justAdded: exempt });
    if (levelDelta) addStateLevel(entity, name, levelDelta, { justAdded: exempt });
    if (opts.isMark) ensureState(entity, name).isMark = true;
    return entity.states[name];
  }
  function clearZeroStates(entity) {
    Object.keys(entity.states).forEach(function (k) {
      const st = entity.states[k];
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) delete entity.states[k];
    });
  }
  Engine.getState = getState;
  Engine.ensureState = ensureState;
  Engine.addStateLayer = addStateLayer;
  Engine.addStateLevel = addStateLevel;
  Engine.applyState = applyState;
  Engine.clearZeroStates = clearZeroStates;

  // ---------------- 有效 DEX（§5 step7, §8 迅捷/綁縛） ----------------
  function computeEffectiveDex(entity) {
    const swift = getState(entity, "迅捷").layer || 0;
    const bind = getState(entity, "綁縛").layer || 0;
    const mod = 1 + 0.05 * swift - 0.05 * bind;
    entity.effectiveDex = entity.dex * mod;
    return entity.effectiveDex;
  }
  Engine.computeEffectiveDex = computeEffectiveDex;

  // ---------------- 技能查找 ----------------
  function findSkill(entity, skillId) {
    return entity.skillLibrary.find(function (s) { return s.id === skillId; }) || null;
  }
  Engine.findSkill = findSkill;

  // ---------------- §7/§8/§11 有效威力：強壯/虛弱/屏息/遲鈍 + 技能條件式(印記讀取) ----------------
  // 回傳 { basePower, coinPower }，供拚點與傷害共用（規格 §8「無觸發、持續生效」+ §11 印記讀取）。
  function computeEffectivePower(entity, skill, target) {
    let base = skill.basePower;
    let coin = skill.coinPower;
    if (skill.type === "attack") {
      base += (getState(entity, "強壯").layer || 0);
      base -= (getState(entity, "虛弱").layer || 0);
    } else if (skill.type === "defense") {
      base += (getState(entity, "屏息").layer || 0);
      base -= (getState(entity, "遲鈍").layer || 0);
    }
    // 技能條件式：[{ condition, basePowerDelta, coinPowerDelta }]，condition 以 §4.3 直譯器判定
    const ctx = { self: entity, target: target || null };
    (skill.conditions || []).forEach(function (c) {
      if (evaluateCondition(c.condition, ctx)) {
        base += (c.basePowerDelta || 0);
        coin += (c.coinPowerDelta || 0);
      }
    });
    if (base < 0) base = 0;
    return { basePower: base, coinPower: coin };
  }
  Engine.computeEffectivePower = computeEffectivePower;

  // ---------------- §4.3 技能對照表結算 ----------------
  function resolveSlotMap(entity) {
    entity.slotMap = Object.assign({}, entity.defaultSlotMap);
    const ctx = { self: entity, target: null };
    const applicable = (entity.slotMapRules || []).filter(function (r) {
      return evaluateCondition(r.condition, ctx);
    });
    applicable.sort(function (a, b) { return (a.priority || 0) - (b.priority || 0); });
    applicable.forEach(function (r) { entity.slotMap[r.slot] = r.setSkillId; });
    return entity.slotMap;
  }
  Engine.resolveSlotMap = resolveSlotMap;

  // ---------------- §5 step4 技能抽選 ----------------
  function diceFaceToSlotLetter(face) {
    face = Number(face);
    if (face >= 1 && face <= 3) return "A";
    if (face === 4 || face === 5) return "B";
    if (face === 6) return "C";
    throw new Error("1d6 數值必須是 1~6，收到：" + face);
  }
  Engine.diceFaceToSlotLetter = diceFaceToSlotLetter;

  function drawSkillMenu(entity, die1, die2) {
    const letter1 = diceFaceToSlotLetter(die1);
    const letter2 = diceFaceToSlotLetter(die2);
    const skill1 = entity.slotMap[letter1];
    const skill2 = entity.slotMap[letter2];
    const rolls = [
      { letter: letter1, skillId: skill1, die: die1 },
      { letter: letter2, skillId: skill2, die: die2 }
    ];
    const options = [];
    const seen = {};
    rolls.forEach(function (r) {
      if (!r.skillId) return; // 該槽位無技能指向（未解鎖）
      if (!seen[r.skillId]) { seen[r.skillId] = true; options.push(r); }
    });
    return { rolls: rolls, options: options };
  }
  Engine.drawSkillMenu = drawSkillMenu;

})(window);

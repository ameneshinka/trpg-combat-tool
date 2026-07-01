// ============================================================
// 資料模型工廠 + 狀態目錄 + 範例名單  (規格書 §3, §10)
// 純資料層，不依賴 DOM。掛在全域 window.Data
// ============================================================
(function (global) {
  "use strict";

  // ---- §10 狀態目錄：引擎需要知道哪些狀態是「層數驅動」、哪些是「級數驅動」 ----
  const LAYER_DRIVEN_STATES = [
    "守護", "易損", "傷害強化", "傷害弱化", "迅捷", "綁縛",
    "強壯", "虛弱", "屏息", "遲鈍", "恍惚"
  ];
  const LEVEL_DRIVEN_STATES = [
    "凝神", "震顫", "萎靡", "延燒", "失血", "開裂", "血瀑", "炎瀑", "荊棘瀑"
  ];
  const LAYER_CAPS = {
    "守護": 16, "易損": 16, "傷害強化": 16, "傷害弱化": 16,
    "迅捷": 10, "綁縛": 10
  };

  function isLayerDriven(name) { return LAYER_DRIVEN_STATES.indexOf(name) !== -1; }
  function isLevelDriven(name) { return LEVEL_DRIVEN_STATES.indexOf(name) !== -1; }

  // ---- 工廠函式 ----
  function makeCoin(type) {
    // type: "normal" | "red" | "green"
    return { type: type || "normal" };
  }

  function makeSkill(opts) {
    opts = opts || {};
    return {
      id: opts.id,
      name: opts.name || opts.id,
      type: opts.type || "attack", // "attack" | "defense"
      drawable: opts.drawable !== undefined ? opts.drawable : true,
      basePower: opts.basePower || 0,
      coinPower: opts.coinPower || 0,
      coins: (opts.coins || []).map(function (c) {
        return typeof c === "string" ? makeCoin(c) : makeCoin(c.type);
      }),
      useEffects: opts.useEffects || [],
      hitEffects: opts.hitEffects || [],
      conditions: opts.conditions || []
    };
  }

  function makeEntity(opts) {
    opts = opts || {};
    return {
      id: opts.id,
      name: opts.name || opts.id,
      isPC: !!opts.isPC,
      isControlledByKP: opts.isControlledByKP !== undefined ? opts.isControlledByKP : !opts.isPC,
      hp: opts.hp !== undefined ? opts.hp : 30,
      maxHp: opts.maxHp !== undefined ? opts.maxHp : (opts.hp !== undefined ? opts.hp : 30),
      dex: opts.dex !== undefined ? opts.dex : 10,
      attributes: Object.assign({ STR: 10, INT: 10, CON: 10, SIZ: 10, LUK: 10 }, opts.attributes || {}),
      focus: 0,
      tempHp: 0,
      slots: opts.slots !== undefined ? opts.slots : 0,
      skillLibrary: (opts.skillLibrary || []).map(makeSkill),
      slotMap: opts.slotMap ? Object.assign({}, opts.slotMap) : { A: null, B: null, C: null },
      defaultSlotMap: opts.slotMap ? Object.assign({}, opts.slotMap) : { A: null, B: null, C: null },
      slotMapRules: opts.slotMapRules || [],
      passives: opts.passives || [],
      states: opts.states ? JSON.parse(JSON.stringify(opts.states)) : {},
      confusionThresholds: opts.confusionThresholds || null, // null => 用預設 maxHp*0.6 與 0 計算
      confusionLockTurns: 0,
      panicNextTurn: false,
      panicRecovering: false,
      isConfused: false,
      effectiveDex: opts.dex !== undefined ? opts.dex : 10,
      // 執行期欄位（每回合重建）
      drawnSkillInstances: [], // [{slotLetter, options:[skillId,skillId], chosenSkillId, used:false}]
      declarations: [] // 宣告：{instanceId, skillId, targetId, isIntercept}
    };
  }

  function cloneRoster(roster) {
    return JSON.parse(JSON.stringify(roster));
  }

  // ---- 條件 / 效果 微型直譯器在 engine 內實作，這裡只放資料 ----

  // ============================================================
  // 範例名單（驗證用：兩名 PC + 一名 NPC，含 slotMapRule 與紅/綠幣）
  // ============================================================
  const SAMPLE_ROSTER = {
    pcGrowthOrder: ["pc_a", "pc_b"],
    entities: [
      {
        id: "pc_a", name: "薇拉", isPC: true, hp: 40, dex: 14,
        attributes: { STR: 12, INT: 10, CON: 12, SIZ: 10, LUK: 10 },
        skillLibrary: [
          {
            id: "skill_a1", name: "斬擊", type: "attack",
            basePower: 10, coinPower: 3,
            coins: ["normal", "normal", "normal"]
          },
          {
            id: "skill_a2", name: "防禦架式", type: "defense",
            basePower: 8, coinPower: 2,
            coins: ["normal", "normal"]
          },
          {
            id: "skill_a3", name: "焰刃", type: "attack",
            basePower: 8, coinPower: 3,
            coins: ["red", "normal", "normal"]
          }
        ],
        slotMap: { A: "skill_a1", B: "skill_a2", C: "skill_a3" },
        slotMapRules: [],
        states: {}
      },
      {
        id: "pc_b", name: "凱", isPC: true, hp: 35, dex: 16,
        attributes: { STR: 11, INT: 10, CON: 10, SIZ: 10, LUK: 12 },
        skillLibrary: [
          {
            id: "skill_b1", name: "迅擊", type: "attack",
            basePower: 9, coinPower: 3,
            coins: ["normal", "normal"]
          },
          {
            id: "skill_b2", name: "格擋", type: "defense",
            basePower: 10, coinPower: 2,
            coins: ["normal", "normal", "normal"]
          },
          {
            id: "skill_b3", name: "風刃", type: "attack",
            basePower: 7, coinPower: 3,
            coins: ["green", "normal"]
          }
        ],
        slotMap: { A: "skill_b1", B: "skill_b2", C: "skill_b3" },
        slotMapRules: [],
        states: {}
      },
      {
        id: "npc_goblin", name: "哥布林頭目", isPC: false, hp: 50, dex: 10,
        attributes: { STR: 13, INT: 8, CON: 12, SIZ: 12, LUK: 8 },
        skillLibrary: [
          {
            id: "skill_g1", name: "棍擊", type: "attack",
            basePower: 12, coinPower: 4,
            coins: ["normal", "normal", "normal", "normal"]
          },
          {
            id: "skill_g2", name: "重劈", type: "attack",
            basePower: 10, coinPower: 3,
            coins: ["red", "normal", "normal"]
          },
          {
            id: "skill_g3", name: "蠻力固守", type: "defense",
            basePower: 9, coinPower: 3,
            coins: ["normal", "normal"]
          },
          {
            id: "skill_g4", name: "狂暴突刺", type: "attack", drawable: false,
            basePower: 16, coinPower: 5,
            coins: ["red", "red", "normal"]
          }
        ],
        slotMap: { A: "skill_g1", B: "skill_g2", C: "skill_g3" },
        slotMapRules: [
          {
            condition: { type: "hasState", who: "self", state: "狂暴", minLayer: 1 },
            slot: "A",
            setSkillId: "skill_g4",
            priority: 10
          }
        ],
        states: {}
      }
    ]
  };

  global.Data = {
    LAYER_DRIVEN_STATES: LAYER_DRIVEN_STATES,
    LEVEL_DRIVEN_STATES: LEVEL_DRIVEN_STATES,
    LAYER_CAPS: LAYER_CAPS,
    isLayerDriven: isLayerDriven,
    isLevelDriven: isLevelDriven,
    makeCoin: makeCoin,
    makeSkill: makeSkill,
    makeEntity: makeEntity,
    cloneRoster: cloneRoster,
    SAMPLE_ROSTER: SAMPLE_ROSTER
  };
})(window);

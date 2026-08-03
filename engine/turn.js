// ============================================================
// 六階段回合控制器
// 規則來源：trpg-clash-rules skill（references/lifecycle.md）
//
// 以 generator 實作：需要手動骰或 KP 裁定時 yield 請求，呼叫端 next(值) 餵回。
// 純計算與 UI 完全分離 —— 本檔不碰 DOM。
// ============================================================
(function (global) {
  "use strict";
  const Turn = global.Turn = {};
  const S = global.States;
  const C = global.Clash;
  const D = global.Damage;

  // ---------------- 有效 DEX 與結算順序 ----------------
  /**
   * 依有效 DEX 由高到低排序，敵我混排。
   * ⚠ 回合開始定序一次，回合中途即使 DEX 被改變也不重排
   *    → 回傳的是「當下快照的陣列」，之後不再重算。
   */
  function computeTurnOrder(entities) {
    return entities
      .filter(function (e) { return e.hp > 0; })
      .map(function (e) { return { entity: e, id: e.id, dex: S.effectiveDex(e) }; })
      .sort(function (a, b) { return b.dex - a.dex; })
      .map(function (x) { return x.entity; });
  }
  Turn.computeTurnOrder = computeTurnOrder;

  // 攔截資格：攔截者有效 DEX「嚴格大於」被攔技能當前目標
  function canIntercept(interceptor, currentTarget) {
    return S.effectiveDex(interceptor) > S.effectiveDex(currentTarget);
  }
  Turn.canIntercept = canIntercept;

  // 方向限制：敵方不能攔玩家；例外 —— 帶「攔截例外」被動者可覆寫
  function mayInterceptPlayerSide(entity, passiveRegistry) {
    if (entity.isPC) return true;
    const reg = passiveRegistry || global.Passives;
    return (entity.passives || []).some(function (pid) {
      const p = reg && reg.get ? reg.get(pid) : null;
      return p && p.allowsInterceptingPlayers;
    });
  }
  Turn.mayInterceptPlayerSide = mayInterceptPlayerSide;

  // ---------------- PC 槽位成長 ----------------
  /**
   * 只有 PC 共用總和上限 8；友方 NPC 不計入（其槽位由 KP 手填）。
   * R1 全體 PC = 1；R2 起依 growthOrder 輪流每人 +1；總和達 8 封頂。
   * 4 名 PC → R1 各1(總4)、R2–R4 依序+1、R5 起各 2（總8 封頂）。
   */
  function updatePcSlots(battle, events) {
    const pcs = battle.entities.filter(function (e) { return e.isPC; });
    if (!pcs.length) return;
    if (battle.turnNumber === 1) {
      pcs.forEach(function (e) { e.slots = 1; });
      if (events) events.push("PC 槽位：第一回合全體 = 1（總和 " + pcs.length + "）");
      return;
    }
    const total = pcs.reduce(function (s, e) { return s + (e.slots || 0); }, 0);
    if (total >= 8) {
      if (events) events.push("PC 槽位總和已達上限 8，封頂不再成長");
      return;
    }
    const order = (battle.pcGrowthOrder || []).length ? battle.pcGrowthOrder : pcs.map(function (e) { return e.id; });
    // 第 N 回合成長順序中的第 (N-2) 位（R2 → 第1位）
    const idx = (battle.turnNumber - 2) % order.length;
    const target = battle.entities.find(function (e) { return e.id === order[idx] && e.isPC; });
    if (target && target.hp > 0) {
      target.slots = (target.slots || 0) + 1;
      if (events) events.push("PC 槽位成長：" + target.name + " → " + target.slots + " 槽（總和 " + (total + 1) + "／8）");
    }
  }
  Turn.updatePcSlots = updatePcSlots;

  // ---------------- slotMap 結算 ----------------
  function resolveSlotMap(entity, ctx) {
    entity.slotMap = Object.assign({}, entity.defaultSlotMap || entity.slotMap);
    const rules = (entity.slotMapRules || []).filter(function (r) {
      return typeof r.condition === "function" ? r.condition(entity, ctx) : !!r.condition;
    });
    rules.sort(function (a, b) { return (a.priority || 0) - (b.priority || 0); });
    rules.forEach(function (r) { entity.slotMap[r.slot] = r.setSkillId; });
    return entity.slotMap;
  }
  Turn.resolveSlotMap = resolveSlotMap;

  // ---------------- 抽技能 ----------------
  // 骰面對應：1/2/3 → A、4/5 → B、6 → C（永遠固定）
  function dieToSlot(die) {
    die = Number(die);
    if (die >= 1 && die <= 3) return "A";
    if (die === 4 || die === 5) return "B";
    if (die === 6) return "C";
    throw new Error("1d6 必須是 1~6，收到 " + die);
  }
  Turn.dieToSlot = dieToSlot;

  /**
   * 兩次 1d6 → 兩個骰面群組 → 經 slotMap 換成技能。
   * ⚠ 骰到重複不重骰；兩次指向同一技能 → 只有一個選項（被迫單選，設計如此）。
   */
  function buildSkillMenu(entity, die1, die2) {
    const s1 = dieToSlot(die1), s2 = dieToSlot(die2);
    const ids = [entity.slotMap[s1], entity.slotMap[s2]];
    const menu = [];
    ids.forEach(function (id) {
      if (id && menu.indexOf(id) === -1) menu.push(id);
    });
    return { slots: [s1, s2], skillIds: menu };
  }
  Turn.buildSkillMenu = buildSkillMenu;

  function findSkill(entity, id) {
    return (entity.skillLibrary || []).find(function (s) { return s.id === id; }) || null;
  }
  Turn.findSkill = findSkill;

  // 防禦型技能：不受抽選限制，想用就能用（各佔一槽，同回合可多次）
  function defenseSkills(entity) {
    return (entity.skillLibrary || []).filter(function (s) { return s.type === "defense"; });
  }
  Turn.defenseSkills = defenseSkills;

  /**
   * 一個槽位的完整可選清單（抽技能當下就用這個）。
   * ＝ 1d6 骰出的攻擊技（經 slotMap，最多 2 個相異）
   *   ＋ 全部防禦技（【防守】【閃躲】不受抽選限制，想用就能用）
   *
   * ⚠ 「被迫單選」只是指「骰出的攻擊選項只有一個」，
   *    不代表沒得選 —— 玩家永遠可以改用防禦技。
   */
  function buildDrawMenu(entity, die1, die2) {
    const menu = buildSkillMenu(entity, die1, die2);
    const options = [];
    menu.skillIds.forEach(function (id) {
      const sk = findSkill(entity, id);
      options.push({ id: id, name: sk ? sk.name : id, kind: "attack" });
    });
    const attackCount = options.length;
    defenseSkills(entity).forEach(function (sk) {
      if (!options.some(function (o) { return o.id === sk.id; })) {
        options.push({ id: sk.id, name: sk.name, kind: "defense" });
      }
    });
    return {
      slots: menu.slots,
      options: options,
      attackCount: attackCount,
      forcedSingleAttack: attackCount === 1
    };
  }
  Turn.buildDrawMenu = buildDrawMenu;

  // 1d6（NPC 的抽選骰由工具代擲；rng 可注入以利測試）
  function rollD6(rng) { return 1 + Math.floor((rng || Math.random)() * 6); }
  Turn.rollD6 = rollD6;

  /**
   * 「KP 自由選」的候選清單 —— 無視抽選限制，直接從技能表挑。
   *
   * 為什麼是逃生門而不是預設：規則 skill 的 KP 權限表把「NPC 技能選擇」列為
   * KP 每回合的臨場權限（authoring.md），但抽選的機率結構（A 75%／B 55.6%／C 30.6%）
   * 本身是設計的一部分 ——「這回合抽不到大招」是敵人也要承受的代價。
   * 所以預設仍照抽，用了自由選會在事件紀錄留下 ⚠ 標記。
   *
   * ⚠ 隱藏技（drawable === false，只能被「喚出」打出）不列入，
   *   否則「喚出」的設計會被自由選整個繞過。
   */
  function freePickOptions(entity, exclude) {
    const skip = (exclude || []).map(function (o) { return o.id; });
    return (entity.skillLibrary || [])
      .filter(function (s) { return s.drawable !== false && skip.indexOf(s.id) === -1; })
      .map(function (s) {
        return { id: s.id, name: s.name, kind: s.type === "defense" ? "defense" : "attack", free: true };
      });
  }
  Turn.freePickOptions = freePickOptions;

  // ---------------- 硬幣執行期狀態的作用域 ----------------
  /**
   * 取得某技能本次使用的 coinRuntime。
   * 通則：每次使用都是全新的滿硬幣狀態。
   * ⚠ 唯一例外【閃躲】：損失持續到回合結束 → 存在 entity.dodgeRuntime，
   *   同一回合內重複使用同一個閃躲時沿用（拚贏沒損失就能一直擋；拚輸後本回合再也擋不住）。
   */
  function acquireCoinRuntime(entity, skill) {
    if (skill.isDodge) {
      if (!entity.dodgeRuntime || entity.dodgeRuntimeSkillId !== skill.id) {
        entity.dodgeRuntime = C.makeCoinRuntime(skill);
        entity.dodgeRuntimeSkillId = skill.id;
      }
      return entity.dodgeRuntime;
    }
    return C.makeCoinRuntime(skill);
  }
  Turn.acquireCoinRuntime = acquireCoinRuntime;

  function resetDodgeRuntime(entity) {
    entity.dodgeRuntime = null;
    entity.dodgeRuntimeSkillId = null;
  }
  Turn.resetDodgeRuntime = resetDodgeRuntime;

  // ---------------- 階段六：回合結束（依序，順序關鍵） ----------------
  /**
   * 1. 回合結束觸發的被動與狀態結算（延燒等）—— 傷害先扣臨時生命值
   * 2. 臨時生命值歸零（在上述傷害結算完之後才清）
   * 3. 全體狀態層數 −1（步驟1 才新增的狀態豁免這一次）
   * 4. 更新混亂／恐慌計時
   */
  function runTurnEndPhase(entities, events, ctx) {
    events = events || [];
    const alive = entities.filter(function (e) { return e.hp > 0; });

    // --- 步驟 1：回合結束傷害／被動（打在臨時生命值上） ---
    // ⚠ 延燒只在此扣血，不在此扣層 —— 其層 −1 與步驟 3 的通則「視為同一次」，
    //   交給步驟 3 統一扣，才不會變成扣兩次（也不會變成完全不扣）。
    alive.forEach(function (e) { S.onTurnEndBurn(e, events); });
    if (ctx && ctx.runTurnEndPassives) ctx.runTurnEndPassives(alive, events);

    // --- 步驟 2：臨時生命值歸零 ---
    entities.forEach(function (e) {
      if (e.tempHp > 0) {
        events.push(e.name + " 的臨時生命值歸零（" + e.tempHp + " → 0）");
        e.tempHp = 0;
      }
    });

    // --- 步驟 3：全體狀態層數 −1（豁免旗標） ---
    entities.forEach(function (e) {
      Object.keys(e.states).forEach(function (name) {
        const st = e.states[name];
        if (st.isBurstTag) return;                      // 瀑標記持續存在
        if (st.noDecay) return;                         // 〈櫻之香〉〈勁足〉〈仁心〉〈秘方藥〉
        if (st.addedThisTurn) { st.addedThisTurn = false; return; } // 步驟1 新增 → 豁免
        if ((st.layer || 0) > 0) S.addLayer(e, name, -1);
      });
      S.clearZero(e);
    });

    // --- 步驟 4：混亂／恐慌 ---
    entities.forEach(function (e) {
      if (e.confusionLockTurns > 0) {
        e.confusionLockTurns -= 1;
        if (e.confusionLockTurns === 0) {
          e.isConfused = false;
          events.push(e.name + " 混亂解除，恢復行動（血量不動）");
        }
      }
      // 恐慌進入：本回合專注力「跨越到」−40（門鈴式）
      if (e._focusAtTurnStart > -40 && e.focus <= -40 && !e.panicNextTurn && !e.isPanicking) {
        e.panicNextTurn = true;
        events.push(e.name + " 專注力跨越 −40，下回合進入恐慌");
      }
      if (e.isPanicking) {
        e.isPanicking = false;
        e.panicRecovering = true;
        events.push(e.name + " 恐慌結束，下回合開始時專注力歸 0");
      }
      // 閃躲的硬幣損失在回合結束恢復
      resetDodgeRuntime(e);
      e.cantActRestOfTurn = false;
    });

    return events;
  }
  Turn.runTurnEndPhase = runTurnEndPhase;

  // ---------------- 階段一：回合開始 ----------------
  function* runTurnStartPhase(battle, events, opts) {
    const entities = battle.entities;
    const rng = (opts || {}).rng;

    // 0. 恐慌恢復（先於一切）
    entities.forEach(function (e) {
      if (e.panicRecovering) {
        e.focus = 0;
        e.panicRecovering = false;
        events.push(e.name + "：恐慌恢復，專注力歸 0");
      }
      e._focusAtTurnStart = e.focus;
      e.cantActRestOfTurn = false;
      e.drawnSkills = [];
      e.declarations = [];
      // 別人記在我身上、之後才結算的效果（和真被動4 的守護債務）
      S.runPendingDebts(e, events);
    });

    // 1. 更新槽位：PC 自動、NPC 讀 KP 填入值
    updatePcSlots(battle, events);
    // 同一款 NPC 的所有實例共用一次提問（放 5 隻哥布林時不用被問 5 遍）
    const npcs = entities.filter(function (e) { return !e.isPC && e.hp > 0; });
    const npcGroups = [];
    npcs.forEach(function (e) {
      const key = e.blueprintId || e.id;
      let g = npcGroups.find(function (x) { return x.key === key; });
      if (!g) { g = { key: key, members: [] }; npcGroups.push(g); }
      g.members.push(e);
    });
    for (const g of npcGroups) {
      const first = g.members[0];
      const n = yield {
        type: "npcSlots",
        entityId: first.id,                 // 沿用 ownerOf（玩家端據此判斷可否填 → NPC 一律不可）
        blueprintId: g.key,
        name: first.baseName || first.name,
        names: g.members.map(function (m) { return m.name; }),
        count: g.members.length,
        current: first.slots || 1
      };
      const slots = Math.max(0, Number(n) || 0);
      g.members.forEach(function (m) { m.slots = slots; });
      events.push((first.baseName || first.name) +
        (g.members.length > 1 ? " ×" + g.members.length : "") +
        " 槽位（KP 手填）= " + slots +
        (g.members.length > 1 ? "（套用到 " + g.members.map(function (m) { return m.name; }).join("／") + "）" : ""));
    }

    // 2. 判定無法行動者
    entities.forEach(function (e) {
      if (e.hp <= 0) { e.canAct = false; return; }
      if (e.confusionLockTurns > 0) {
        e.canAct = false;
        events.push(e.name + " 混亂中（剩 " + e.confusionLockTurns + " 回合），本回合無法行動");
        return;
      }
      if (e.panicNextTurn) {
        e.panicNextTurn = false;
        e.isPanicking = true;
        e.canAct = false;
        events.push(e.name + " 進入恐慌，本回合無法行動");
        return;
      }
      e.canAct = true;
    });

    // 3. 結算技能對照表（在抽技能之前）
    entities.filter(function (e) { return e.canAct; }).forEach(function (e) {
      resolveSlotMap(e, battle);
    });

    // 4. 抽技能：每個可行動者依槽位數重複 N 次
    for (const e of entities) {
      if (!e.canAct || !e.slots) continue;
      for (let i = 0; i < e.slots; i++) {
        // PC 的 1d6 由玩家手擲（Discord 骰子機器人）；NPC 由工具代骰，骰值照樣寫進事件紀錄
        const dice = e.isPC
          ? yield { type: "skillDraw1d6", entityId: e.id, name: e.name, slotIndex: i }
          : { die1: rollD6(rng), die2: rollD6(rng), auto: true };
        // 菜單＝骰出的攻擊技 ＋ 防禦技（防守／閃躲不受抽選限制，抽選當下就能選）
        const menu = buildDrawMenu(e, dice.die1, dice.die2);
        // KP 自由選：只給 NPC，且只列出菜單以外的技能（否則是空區塊）
        const freeOpts = e.isPC ? [] : freePickOptions(e, menu.options);
        const diceText = "1d6 = " + dice.die1 + "／" + dice.die2 + (dice.auto ? "（工具代骰）" : "");
        let chosen;
        if (!menu.options.length && !freeOpts.length) {
          events.push(e.name + " 第 " + (i + 1) + " 槽：" + diceText +
            " 骰到的槽位無技能指向，且無防禦技可用 → 視為空槽");
          continue;
        }
        if (menu.options.length === 1 && !freeOpts.length) {
          chosen = menu.options[0].id;
          events.push(e.name + " 第 " + (i + 1) + " 槽：" + diceText +
            "（唯一選項）→ " + menu.options[0].name);
        } else {
          chosen = yield {
            type: "chooseSkill", entityId: e.id, name: e.name, slotIndex: i,
            options: menu.options, dice: [dice.die1, dice.die2],
            attackCount: menu.attackCount, forcedSingleAttack: menu.forcedSingleAttack,
            canFreePick: freeOpts.length > 0, freePickOptions: freeOpts
          };
          let pick = menu.options.find(function (x) { return x.id === chosen; });
          const isFree = !pick;
          if (!pick) pick = freeOpts.find(function (x) { return x.id === chosen; });
          events.push(e.name + " 第 " + (i + 1) + " 槽：" + diceText +
            (menu.forcedSingleAttack ? "（攻擊選項只有一個，但可改用防禦技）" : "") +
            " → 選擇 " + (pick ? pick.name : chosen) +
            (pick && pick.kind === "defense" ? "（防禦技）" : "") +
            (isFree ? "　⚠ KP 自由選，無視抽選限制" : ""));
        }
        // 存下菜單與骰值 → 階段二若要「改技能」可用同一份菜單重選
        e.drawnSkills.push({
          slotIndex: i, skillId: chosen,
          menuOptions: menu.options, freePickOptions: freeOpts,
          dice: [dice.die1, dice.die2], autoRolled: !!dice.auto
        });
      }
    }

    // 5. 回合開始被動：先結算「給予增益」的，再結算「消耗資源」的
    if (global.Passives && global.Passives.runTurnStart) {
      yield* global.Passives.runTurnStart(battle, events);
    }

    // 6. 不動專注力（只有戰鬥輪開始才歸 0）

    // 7. 重算有效 DEX，並依此定出本回合的結算順序（定序一次，中途不重排）
    battle.turnOrder = computeTurnOrder(entities);
    events.push("本回合結算順序（依有效 DEX）：" + battle.turnOrder.map(function (e) {
      return e.name + "(" + S.effectiveDex(e).toFixed(1) + ")";
    }).join(" → "));

    return battle.turnOrder;
  }
  Turn.runTurnStartPhase = runTurnStartPhase;

  // ---------------- 階段二：宣告與配對 ----------------
  /**
   * 依宣告建立配對草案。
   * 攔截：把攻擊的目標轉移到攔截者身上（資格：有效 DEX 嚴格大於原目標）。
   * 配對結果三種：clash（雙方拚點）／unilateral（單方面攻擊）／defenseOnly（防禦技無對手）
   */
  // ⚠ 這個函式會在階段二被「反覆呼叫」做預覽（KP 改宣告後要重算），
  //   所以它不能寫 log、也不能留下狀態：攔截判定訊息改為回傳 notes，
  //   由呼叫端決定要不要寫進事件紀錄。rec 物件每次都重新建立，天然無殘留。
  function buildPairing(battle) {
    const notes = [];
    const byId = {};
    battle.entities.forEach(function (e) { byId[e.id] = e; });

    const attacks = [], defenses = [], intercepts = [];
    battle.entities.forEach(function (e) {
      if (!e.canAct) return;
      (e.declarations || []).forEach(function (d) {
        const rec = { entity: e, decl: d };
        if (d.action === "attack") attacks.push(rec);
        else if (d.action === "intercept") intercepts.push(rec);
        else defenses.push(rec); // guard / dodge / defend
      });
    });

    // 攔截判定
    attacks.forEach(function (atk) {
      const origTarget = byId[atk.decl.targetId];
      if (!origTarget) return;
      const candidates = intercepts.filter(function (ic) {
        if (ic.consumed) return false;
        if (ic.decl.protectId !== atk.decl.targetId) return false;
        if (!mayInterceptPlayerSide(ic.entity)) {
          notes.push({ ok: false, text: "攔截被拒：" + ic.entity.name + " 非玩家方，依規則不能攔截打向玩家的攻擊（且無攔截例外被動）" });
          return false;
        }
        if (!canIntercept(ic.entity, origTarget)) {
          notes.push({ ok: false, text: "攔截被拒：" + ic.entity.name + " 的有效 DEX 未「嚴格大於」" + origTarget.name });
          return false;
        }
        return true;
      });
      if (candidates.length) {
        // 多人搶攔：DEX 最高者優先（實務上由玩家協調、KP 確認）
        candidates.sort(function (a, b) { return S.effectiveDex(b.entity) - S.effectiveDex(a.entity); });
        const win = candidates[0];
        win.consumed = true;
        atk.redirectTo = win.entity.id;
        atk.pairedWith = win;
        notes.push({ ok: true, text: "攔截成立：" + win.entity.name + "（DEX " + S.effectiveDex(win.entity).toFixed(1) +
          "）把 " + atk.entity.name + " 對 " + origTarget.name + "（DEX " +
          S.effectiveDex(origTarget).toFixed(1) + "）的攻擊搶到自己身上" });
      }
    });

    const entries = [];
    const usedDecl = {};
    function declKey(rec) { return rec.entity.id + "#" + rec.decl.slotIndex; }

    attacks.forEach(function (atk) {
      if (usedDecl[declKey(atk)]) return;
      const finalTargetId = atk.redirectTo || atk.decl.targetId;
      const target = byId[finalTargetId];
      if (!target) return;

      // 對手可用的應對：攔截者本身的技能 → 目標的防禦技 → 目標對我的攻擊（互拚）
      let opponent = null;
      if (atk.pairedWith) {
        opponent = atk.pairedWith;
      } else {
        opponent = defenses.find(function (d) {
          return !usedDecl[declKey(d)] && d.entity.id === finalTargetId &&
            (!d.decl.targetId || d.decl.targetId === atk.entity.id);
        }) || attacks.find(function (a2) {
          return a2 !== atk && !usedDecl[declKey(a2)] && a2.entity.id === finalTargetId &&
            (a2.redirectTo || a2.decl.targetId) === atk.entity.id;
        }) || null;
      }

      usedDecl[declKey(atk)] = true;
      if (opponent) {
        usedDecl[declKey(opponent)] = true;
        entries.push({
          kind: "clash",
          aEntityId: atk.entity.id, aSkillId: atk.decl.skillId, aSlot: atk.decl.slotIndex,
          bEntityId: opponent.entity.id, bSkillId: opponent.decl.skillId, bSlot: opponent.decl.slotIndex,
          targetId: finalTargetId
        });
      } else {
        entries.push({
          kind: "unilateral",
          aEntityId: atk.entity.id, aSkillId: atk.decl.skillId, aSlot: atk.decl.slotIndex,
          targetId: finalTargetId
        });
      }
    });

    // 沒被配對到的防禦技：單獨結算（防守照樣給臨時生命值）
    defenses.concat(intercepts).forEach(function (d) {
      if (usedDecl[declKey(d)] || d.consumed) return;
      entries.push({
        kind: "defenseOnly",
        aEntityId: d.entity.id, aSkillId: d.decl.skillId, aSlot: d.decl.slotIndex
      });
    });

    return { entries: entries, notes: notes };
  }
  Turn.buildPairing = buildPairing;

  // ---------------- 技能使用的效果鉤子外殼 ----------------
  /**
   * 開始一次技能使用：建立 runtime，跑技能層級的 [使用時]。
   * ⚠ 這一段在「拚點之前」跑 —— 威力修正（威爾技能C 的條件式加成、旭閃躲的勁足加成）
   *   必須吃得到拚點，否則加成形同虛設。
   * 資源消耗不放在這裡（拚輸不該扣）—— 放在逐枚的 coin.onUse 或技能成功後的路徑。
   *
   * 回傳 { runtime, basePower, coinPower }
   */
  function* beginSkillUse(entity, skill, target, battle, events, reuseRuntime) {
    const E = global.Effects;
    // reuseRuntime：技能C 遞迴重用時沿用同一份（裁決 12：條件式加成只算一次）
    const runtime = reuseRuntime || E.makeRuntime();
    if (!reuseRuntime && skill.onUse) {
      yield* E.call(skill.onUse, E.makeCtx({
        self: entity, target: target, skill: skill,
        battle: battle, events: events, runtime: runtime
      }));
    }
    return {
      runtime: runtime,
      basePower: S.effectiveBasePower(entity, skill) + (runtime.basePowerBonus || 0),
      coinPower: skill.coinPower + (runtime.coinPowerBonus || 0)
    };
  }
  Turn.beginSkillUse = beginSkillUse;

  const MAX_SKILL_REPEATS = 20;   // 保險絲：任何 afterUse 迴圈的硬上限

  /**
   * 跑一次攻擊的傷害結算，並處理技能層級的 [使用後]。
   * afterUse 可以把 runtime.repeat 設為 true 要求「重複使用」（威爾技能C）：
   *   ⚠ 重用一律是單方面攻擊，不重新拚點（裁決 10）
   *   ⚠ 重用時硬幣重置為全新狀態，但 runtime 沿用（加成不重算）
   */
  function* runAttackDamage(attacker, target, skill, coinRuntime, use, battle, events) {
    const E = global.Effects;
    let rt = coinRuntime;
    let repeats = 0;
    while (true) {
      const res = yield* D.resolveDamage(attacker, target, rt, use.basePower, use.coinPower,
        skill.name, { fx: { skill: skill, battle: battle, runtime: use.runtime } });
      res.events.forEach(function (m) { events.push(m); });

      // 整把技能的 [命中後]（與逐枚的 afterHit 不同：這是全部硬幣跑完才一次）
      if (skill.onHit && target.hp >= 0) {
        yield* E.call(skill.onHit, E.makeCtx({
          self: attacker, target: target, skill: skill,
          battle: battle, events: events, runtime: use.runtime
        }));
      }

      // 技能層級 [使用後]
      use.runtime.repeat = false;
      if (skill.afterUse) {
        yield* E.call(skill.afterUse, E.makeCtx({
          self: attacker, target: target, skill: skill,
          battle: battle, events: events, runtime: use.runtime
        }));
      }
      if (!use.runtime.repeat) break;
      if (target.hp <= 0) { events.push(target.name + " 已倒下，停止重複使用"); break; }
      if (++repeats >= MAX_SKILL_REPEATS) {
        events.push("⚠ " + skill.name + " 重複使用次數達上限 " + MAX_SKILL_REPEATS + "，強制中止");
        break;
      }
      events.push("↻ " + attacker.name + "《" + skill.name + "》重複使用第 " + repeats +
        " 次（單方面攻擊，不重新拚點）");
      rt = C.makeCoinRuntime(skill);   // 重用＝全新的硬幣狀態
      use.runtime.stop = false;
    }
  }

  Turn.runAttackDamage = runAttackDamage;

  // ---------------- 階段三～五：依 DEX 序列結算 ----------------
  function* resolveEntry(battle, entry, events) {
    const byId = {};
    battle.entities.forEach(function (e) { byId[e.id] = e; });
    const a = byId[entry.aEntityId];
    if (!a || a.hp <= 0) return;
    if (a.cantActRestOfTurn) {
      events.push(a.name + " 本回合剩餘行動已作廢（混亂），跳過");
      return;
    }
    const skillA = findSkill(a, entry.aSkillId);
    if (!skillA) { events.push("找不到技能 " + entry.aSkillId); return; }

    // --- 只有防禦技，沒有對手 ---
    if (entry.kind === "defenseOnly") {
      const rtA = acquireCoinRuntime(a, skillA);
      const baseA = S.effectiveBasePower(a, skillA);
      if (skillA.isGuard) {
        const r = yield* D.resolveGuard(a, skillA, rtA, baseA, {});
        r.events.forEach(function (m) { events.push(m); });
      } else {
        events.push(a.name + " 使用《" + skillA.name + "》但無人攻擊，無事發生");
      }
      return;
    }

    // --- 單方面攻擊 ---
    if (entry.kind === "unilateral") {
      const target = byId[entry.targetId];
      if (!target || target.hp <= 0) { events.push("單方面攻擊的目標已倒下，跳過"); return; }
      if (skillA.type !== "attack") { events.push(a.name + " 的防禦型技能無對手，無事發生"); return; }
      events.push("── " + a.name + "《" + skillA.name + "》單方面攻擊 " + target.name + "（無人抵擋）");
      const rtA = acquireCoinRuntime(a, skillA);
      const use = yield* beginSkillUse(a, skillA, target, battle, events);
      yield* runAttackDamage(a, target, skillA, rtA, use, battle, events);
      return;
    }

    // --- 拚點 ---
    const b = byId[entry.bEntityId];
    if (!b || b.hp <= 0) { events.push("拚點對手已倒下，跳過"); return; }
    if (b.cantActRestOfTurn) {
      events.push(b.name + " 行動已作廢（混亂）→ 改為 " + a.name + " 單方面攻擊");
      yield* resolveEntry(battle, {
        kind: "unilateral", aEntityId: a.id, aSkillId: entry.aSkillId, targetId: b.id
      }, events);
      return;
    }
    const skillB = findSkill(b, entry.bSkillId);
    if (!skillB) { events.push("找不到技能 " + entry.bSkillId); return; }

    const rtA = acquireCoinRuntime(a, skillA);
    const rtB = acquireCoinRuntime(b, skillB);

    events.push("── 拚點：" + a.name + "《" + skillA.name + "》 vs " + b.name + "《" + skillB.name + "》");
    // 技能層級 [使用時]：在拚點之前跑，威力修正才吃得到拚點
    const useA = yield* beginSkillUse(a, skillA, b, battle, events);
    const useB = yield* beginSkillUse(b, skillB, a, battle, events);
    const baseA = useA.basePower, baseB = useB.basePower;

    // 【防守】不論拚點輸贏都給臨時生命值（它的作用就是吸收這次傷害）
    // ⚠ 規則未明訂「防守是否需拚贏才生效」—— 採此裁決，見 README 的未定義裁決清單
    for (const side of [{ e: a, sk: skillA, rt: rtA, base: baseA }, { e: b, sk: skillB, rt: rtB, base: baseB }]) {
      if (side.sk.isGuard) {
        const r = yield* D.resolveGuard(side.e, side.sk, side.rt, side.base, {});
        r.events.forEach(function (m) { events.push(m); });
      }
    }

    const result = global.Clash.resolveClash(
      { entity: a, skill: skillA, coinRuntime: rtA, basePower: baseA, coinPower: useA.coinPower },
      { entity: b, skill: skillB, coinRuntime: rtB, basePower: baseB, coinPower: useB.coinPower },
      {}
    );
    result.events.forEach(function (m) { events.push(m); });

    if (!result.winner) { events.push("無效拚點（雙方開局皆無完好硬幣）"); return; }

    const winIsA = result.winner === "A";
    const winner = winIsA ? a : b, loser = winIsA ? b : a;
    const winSkill = winIsA ? skillA : skillB, loseSkill = winIsA ? skillB : skillA;
    const winRt = winIsA ? rtA : rtB, loseRt = winIsA ? rtB : rtA;
    const winBase = winIsA ? baseA : baseB;

    // 通過方結算傷害（防禦型通過 → 無傷害）
    if (winSkill.type === "attack") {
      const res = yield* D.resolveDamage(winner, loser, winRt, winBase, winSkill.coinPower, winSkill.name, {});
      res.events.forEach(function (m) { events.push(m); });
      if (winSkill.onHit && loser.hp >= 0) winSkill.onHit({ self: winner, target: loser, events: events, S: S });
    } else {
      events.push(winner.name + " 的防禦型技能《" + winSkill.name + "》通過拚點" +
        (winSkill.isDodge ? "（成功閃躲，攻擊無法命中；硬幣未損失 → 本回合還能繼續擋）" : "（防禦成功）"));
      if (winSkill.onHit) winSkill.onHit({ self: winner, target: loser, events: events, S: S });
    }

    // 碎幣追加攻擊：只有拚輸方觸發
    if (global.Clash.shatteredCoins(loseRt).length) {
      events.push("── " + loser.name + " 拚輸且有碎掉的紅幣 → 碎幣追加攻擊（基威視同 1、每枚幣威視同 +1）");
      const fu = yield* D.resolveShatteredFollowUp(loser, winner, loseRt, {});
      fu.events.forEach(function (m) { events.push(m); });
    }
    if (loseSkill.isDodge) {
      events.push("⚠ " + loser.name + " 閃躲失敗，硬幣損失持續到回合結束 → 本回合剩下的攻擊都會命中");
    }
  }

  // ---------------- 階段二的宣告輔助 ----------------
  /**
   * 問一個槽位的宣告（動作／目標）並寫回 entity.declarations。
   * isRedo=true 時是「重新宣告」：先清掉該槽位舊的宣告，避免同一槽位留下兩筆。
   */
  function* askDeclare(battle, e, drawn, isRedo, events) {
    const sk = findSkill(e, drawn.skillId);
    const prev = (e.declarations || []).find(function (d) { return d.slotIndex === drawn.slotIndex; });
    if (isRedo) {
      e.declarations = (e.declarations || []).filter(function (d) { return d.slotIndex !== drawn.slotIndex; });
    }
    const decl = yield {
      type: "declare", entityId: e.id, name: e.name,
      slotIndex: drawn.slotIndex, skillId: drawn.skillId,
      skillName: sk ? sk.name : drawn.skillId,
      skillType: sk ? sk.type : "attack",
      isDodge: !!(sk && sk.isDodge), isGuard: !!(sk && sk.isGuard),
      isRedo: !!isRedo,
      previous: prev ? { action: prev.action, targetId: prev.targetId, protectId: prev.protectId } : null
    };
    e.declarations.push({
      slotIndex: drawn.slotIndex, skillId: drawn.skillId,
      action: decl.action, targetId: decl.targetId, protectId: decl.protectId
    });
    if (isRedo && events) {
      const t = battle.entities.find(function (x) { return x.id === decl.targetId; });
      const actionText = decl.action === "attack" ? "攻擊" : decl.action === "intercept" ? "攔截" : "防禦";
      events.push("↺ " + e.name + " 第 " + (drawn.slotIndex + 1) + " 槽重新宣告：" +
        actionText + (t ? " → " + t.name : ""));
    }
    return decl;
  }

  /**
   * 一鍵指定敵方的初始目標（規則 skill 的 KP 權限表：「NPC 初始目標（可覆寫）」）。
   *
   * 只作用在 skill.type === "attack" 的槽位 —— 攔截與防禦一定要逐一裁定，不能批次。
   * 填好的宣告標上 batched，之後在確認板上按［改宣告］就能逐一訂正
   * （玩家宣告攔截時必改，所以這條路徑一定要留著）。
   */
  function* askBatchTarget(battle, events) {
    const candidates = [];
    (battle.turnOrder || battle.entities).forEach(function (e) {
      if (e.isPC || !e.canAct) return;
      (e.drawnSkills || []).forEach(function (d) {
        const sk = findSkill(e, d.skillId);
        if (!sk || sk.type !== "attack") return;
        candidates.push({
          entityId: e.id, name: e.name,
          slotIndex: d.slotIndex, skillId: d.skillId, skillName: sk.name
        });
      });
    });
    if (candidates.length < 2) return false;   // 只有一個攻擊行動 → 批次沒有意義

    const targets = battle.entities
      .filter(function (x) { return x.isPC && x.hp > 0; })
      .map(function (x) { return { id: x.id, name: x.name, hp: x.hp, maxHp: x.maxHp }; });
    if (!targets.length) return false;

    const ans = yield { type: "batchTarget", candidates: candidates, targets: targets };
    if (!ans || !ans.targetId) {
      events.push("（未使用一鍵指定 → 敵方目標逐一宣告）");
      return false;
    }
    const t = battle.entities.find(function (x) { return x.id === ans.targetId; });
    candidates.forEach(function (c) {
      const e = battle.entities.find(function (x) { return x.id === c.entityId; });
      if (!e) return;
      e.declarations = (e.declarations || []).filter(function (d) { return d.slotIndex !== c.slotIndex; });
      e.declarations.push({
        slotIndex: c.slotIndex, skillId: c.skillId,
        action: "attack", targetId: ans.targetId, batched: true
      });
    });
    events.push("⇉ 一鍵指定：敵方 " + candidates.length + " 個攻擊行動全部指向 " +
      (t ? t.name : ans.targetId) + "（可在確認板上逐一訂正）");
    return true;
  }
  Turn.askBatchTarget = askBatchTarget;

  /**
   * 「改技能」可選的清單。
   * ＝ 當初骰出的菜單 ＋ 所有防禦型技能。
   * 依規則（lifecycle.md / authoring.md）：【防守】【閃躲】不受抽選限制、想用就能用，
   * 所以任何一個槽位都可以改成用防禦技 —— 這正是 KP 訂正錯誤宣告最常需要的路徑。
   */
  function rechooseOptions(entity, drawn) {
    const opts = (drawn.menuOptions || []).map(function (o) {
      return { id: o.id, name: o.name, kind: o.kind || "attack" };
    });
    defenseSkills(entity).forEach(function (sk) {
      if (!opts.some(function (o) { return o.id === sk.id; })) {
        opts.push({ id: sk.id, name: sk.name, kind: "defense" });
      }
    });
    // NPC：確認板上也保留「KP 自由選」這條逃生門（與抽選當下同一份清單）
    if (!entity.isPC) {
      freePickOptions(entity, opts).forEach(function (o) { opts.push(o); });
    }
    return opts;
  }
  Turn.rechooseOptions = rechooseOptions;

  // 還沒被任何槽位使用的最小槽位編號（新增行動時用）
  function nextFreeSlotIndex(entity) {
    const used = (entity.drawnSkills || []).map(function (d) { return d.slotIndex; });
    for (let i = 0; i < (entity.slots || 0); i++) {
      if (used.indexOf(i) === -1) return i;
    }
    return null;
  }
  Turn.nextFreeSlotIndex = nextFreeSlotIndex;

  /**
   * 每個可行動者的槽位使用狀況 —— 供確認畫面顯示「還能不能新增行動」。
   * 槽位是硬上限：一個槽位＝一次行動，防禦技也佔一個槽位。
   */
  function slotUsage(battle) {
    return (battle.turnOrder || battle.entities)
      .filter(function (e) { return e.canAct && e.hp > 0; })
      .map(function (e) {
        const used = (e.drawnSkills || []).length;
        return {
          entityId: e.id, entityName: e.name, isPC: !!e.isPC,
          slots: e.slots || 0, used: used, free: Math.max(0, (e.slots || 0) - used),
          hasDefenseSkill: defenseSkills(e).length > 0
        };
      });
  }
  Turn.slotUsage = slotUsage;

  /**
   * 供 KP 確認畫面用的「行動一覽」：依 DEX 序列列出每個 actor 的每個槽位與其宣告。
   * canRechoose = 改技能的可選項多於 1 個（含防禦技，所以幾乎總是可以訂正）。
   */
  function buildDeclarationBoard(battle) {
    const byId = {};
    battle.entities.forEach(function (x) { byId[x.id] = x; });
    const rows = [];
    (battle.turnOrder || battle.entities).forEach(function (e) {
      if (!e.canAct) return;
      (e.drawnSkills || []).forEach(function (drawn) {
        const sk = findSkill(e, drawn.skillId);
        const d = (e.declarations || []).find(function (x) { return x.slotIndex === drawn.slotIndex; });
        const tgt = d && byId[d.targetId], pro = d && byId[d.protectId];
        rows.push({
          entityId: e.id, entityName: e.name, isPC: !!e.isPC,
          dex: S.effectiveDex(e),
          slotIndex: drawn.slotIndex,
          skillId: drawn.skillId,
          skillName: sk ? sk.name : drawn.skillId,
          skillType: sk ? sk.type : "attack",
          isDodge: !!(sk && sk.isDodge), isGuard: !!(sk && sk.isGuard),
          action: d ? d.action : null,
          targetId: d ? d.targetId : null,
          targetName: tgt ? tgt.name : null,
          protectId: d ? d.protectId : null,
          protectName: pro ? pro.name : null,
          canRechoose: rechooseOptions(e, drawn).length > 1,
          batched: !!(d && d.batched),
          autoRolled: !!drawn.autoRolled,
          dice: drawn.dice || []
        });
      });
    });
    return rows;
  }
  Turn.buildDeclarationBoard = buildDeclarationBoard;

  Turn.resolveEntry = resolveEntry;

  // ---------------- 完整一回合（六階段） ----------------
  function* runTurn(battle, events, opts) {
    events.push("═══ 回合 " + battle.turnNumber + " ═══");

    // 階段一
    events.push("【階段一】回合開始");
    if (global.Passives && global.Passives.resetPerTurnCounters) {
      global.Passives.resetPerTurnCounters(battle.entities);
    }
    yield* runTurnStartPhase(battle, events, opts);

    // 階段二：宣告 → 確認（可回頭改）
    events.push("【階段二】宣告與配對");
    yield* askBatchTarget(battle, events);   // 先給一鍵指定，已填的槽位下面就跳過
    for (const e of battle.turnOrder) {
      if (!e.canAct || !e.drawnSkills.length) continue;
      for (const drawn of e.drawnSkills) {
        const already = (e.declarations || []).some(function (d) { return d.slotIndex === drawn.slotIndex; });
        if (already) continue;   // 一鍵指定已經填好
        yield* askDeclare(battle, e, drawn, false, events);
      }
      // 防禦技不受抽選限制：KP／玩家可額外宣告（各佔一槽，同回合可多次）
    }

    // 確認迴圈：KP 若發現宣告有誤，可改宣告／改技能／移除，改完重算配對再確認
    let finalEntries = null;
    let lastNotes = [];
    while (true) {
      const pairing = buildPairing(battle);   // 純預覽：不寫 log、可反覆呼叫
      lastNotes = pairing.notes;
      const ans = yield {
        type: "confirmPairing",
        proposed: pairing.entries,
        notes: pairing.notes,
        board: buildDeclarationBoard(battle),
        slotUsage: slotUsage(battle)
      };

      // ［改技能］可選：當初骰出的菜單 ＋ 防禦技（不受抽選限制）→ 換完重問宣告
      if (ans && ans.rechoose) {
        const e = battle.entities.find(function (x) { return x.id === ans.rechoose.entityId; });
        const drawn = e && (e.drawnSkills || []).find(function (d) { return d.slotIndex === ans.rechoose.slotIndex; });
        if (e && drawn) {
          const options = rechooseOptions(e, drawn);
          if (options.length > 1) {
            const picked = yield {
              type: "chooseSkill", entityId: e.id, name: e.name, slotIndex: drawn.slotIndex,
              options: options, dice: drawn.dice || [], isRedo: true
            };
            if (picked && picked !== drawn.skillId) {
              const oldSk = findSkill(e, drawn.skillId), newSk = findSkill(e, picked);
              drawn.skillId = picked;
              events.push("↺ " + e.name + " 第 " + (drawn.slotIndex + 1) + " 槽改用技能：《" +
                (oldSk ? oldSk.name : "?") + "》→《" + (newSk ? newSk.name : picked) + "》");
            }
            yield* askDeclare(battle, e, drawn, true, events);   // 技能換了，宣告一併重設
          }
        }
        continue;
      }

      // ［＋新增行動］用一個空閒槽位打出防禦技（規則：防禦技不受抽選限制、想用就能用）
      if (ans && ans.addAction) {
        const e = battle.entities.find(function (x) { return x.id === ans.addAction.entityId; });
        if (e) {
          const idx = nextFreeSlotIndex(e);
          const defs = defenseSkills(e).map(function (sk) { return { id: sk.id, name: sk.name, kind: "defense" }; });
          if (idx === null) {
            events.push("⚠ " + e.name + " 沒有空閒槽位（共 " + (e.slots || 0) + " 槽、已用 " +
              (e.drawnSkills || []).length + "），無法新增行動");
          } else if (!defs.length) {
            events.push("⚠ " + e.name + " 沒有防禦型技能可用於新增行動");
          } else {
            const picked = yield {
              type: "chooseSkill", entityId: e.id, name: e.name, slotIndex: idx,
              options: defs, dice: [], isAdd: true
            };
            const sk = findSkill(e, picked);
            const drawn = { slotIndex: idx, skillId: picked, menuOptions: defs, dice: [] };
            e.drawnSkills.push(drawn);
            events.push("＋ " + e.name + " 新增行動：第 " + (idx + 1) + " 槽使用《" +
              (sk ? sk.name : picked) + "》（防禦技不受抽選限制）");
            yield* askDeclare(battle, e, drawn, false, events);
          }
        }
        continue;
      }

      // ［刪除此行動］把該槽位的宣告與抽到的技能一起清掉，讓它變回空閒槽位可重新新增
      if (ans && ans.removeAction) {
        const e = battle.entities.find(function (x) { return x.id === ans.removeAction.entityId; });
        if (e) {
          const si = ans.removeAction.slotIndex;
          const drawn = (e.drawnSkills || []).find(function (d) { return d.slotIndex === si; });
          const sk = drawn && findSkill(e, drawn.skillId);
          e.drawnSkills = (e.drawnSkills || []).filter(function (d) { return d.slotIndex !== si; });
          e.declarations = (e.declarations || []).filter(function (d) { return d.slotIndex !== si; });
          events.push("－ " + e.name + " 刪除第 " + (si + 1) + " 槽的行動" +
            (sk ? "（原本是《" + sk.name + "》）" : "") + "，該槽位可重新新增");
        }
        continue;
      }

      // ［改宣告］只重問動作與目標
      if (ans && ans.redeclare) {
        const e = battle.entities.find(function (x) { return x.id === ans.redeclare.entityId; });
        const drawn = e && (e.drawnSkills || []).find(function (d) { return d.slotIndex === ans.redeclare.slotIndex; });
        if (e && drawn) yield* askDeclare(battle, e, drawn, true, events);
        continue;
      }

      finalEntries = (ans && ans.entries) ? ans.entries : pairing.entries;
      break;
    }
    // 確認之後才把攔截判定寫進事件紀錄（預覽階段反覆重算，不該汙染 log）
    lastNotes.forEach(function (n) { events.push((n.ok ? "" : "⚠ ") + n.text); });

    // 階段三～五：依有效 DEX 序列結算
    events.push("【階段三～五】依有效 DEX 序列結算拚點、傷害與狀態觸發");
    for (const actor of battle.turnOrder) {
      const mine = finalEntries.filter(function (en) { return en.aEntityId === actor.id; });
      for (const entry of mine) {
        if (entry._resolved) continue;
        entry._resolved = true;
        yield* resolveEntry(battle, entry, events);
      }
    }
    // 保險：任何未被 turnOrder 涵蓋的殘留配對（例如已倒下者的宣告）
    for (const entry of finalEntries) {
      if (entry._resolved) continue;
      entry._resolved = true;
      yield* resolveEntry(battle, entry, events);
    }

    // 階段六
    events.push("【階段六】回合結束");
    runTurnEndPhase(battle.entities, events, {
      runTurnEndPassives: function (alive, ev) {
        if (global.Passives && global.Passives.runTurnEnd) {
          global.Passives.runTurnEnd(alive, battle, ev);
        }
      }
    });

    battle.turnNumber += 1;
    return battle;
  }
  Turn.runTurn = runTurn;

  // ---------------- 戰鬥輪開始 ----------------
  function startBattleRound(battle, events) {
    battle.roundNumber = (battle.roundNumber || 0) + 1;
    battle.turnNumber = 1;
    battle.entities.forEach(function (e) {
      e.focus = 0;                    // 專注力只在戰鬥輪開始歸 0
      e.tempHp = 0;
      e.slots = 0;
      resetDodgeRuntime(e);
    });
    if (events) events.push("===== 戰鬥輪 " + battle.roundNumber + " 開始（全體專注力歸 0）=====");
  }
  Turn.startBattleRound = startBattleRound;

})(window);

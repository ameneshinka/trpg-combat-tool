// ============================================================
// 回合生命週期控制器 (規格書 §5, §9) —— 六階段 generator
// 以 yield 暫停等待手動輸入／UI選擇；其餘自動往下算。
// ============================================================
(function (global) {
  "use strict";
  const Engine = global.Engine = global.Engine || {};

  function aliveEntities(battleState) {
    return battleState.entities.filter(function (e) { return e.hp > 0; });
  }
  Engine.aliveEntities = aliveEntities;

  // ---------------- §4.1 PC 槽位成長 ----------------
  function growPcSlots(battleState, log) {
    const order = battleState.pcGrowthOrder || [];
    const pcs = battleState.entities.filter(function (e) { return e.isPC; });
    if (battleState.turnNumber === 1) {
      pcs.forEach(function (e) { e.slots = 1; });
      log("PC 槽位初始化：全體 1（第一回合）。");
      return;
    }
    const total = pcs.reduce(function (s, e) { return s + e.slots; }, 0);
    if (total >= 8 || order.length === 0) {
      log("PC 槽位總和已達上限或無成長順序設定，維持不變（總和=" + total + "）。");
      return;
    }
    const idx = (battleState.turnNumber - 2) % order.length;
    const growId = order[idx];
    const growEntity = battleState.entities.find(function (e) { return e.id === growId; });
    if (growEntity) {
      growEntity.slots += 1;
      log("PC 槽位成長（順序第 " + (idx + 1) + " 位）：" + growEntity.name + " → " + growEntity.slots + " 槽。");
    }
  }

  // ---------------- 主 generator：跑完一個完整回合（六階段） ----------------
  function* runTurn(battleState, log) {
    log = log || function () {};
    const turnNo = battleState.turnNumber;
    log("===== 回合 " + turnNo + " 開始 =====", "phase");

    // ============ 階段一：回合開始 ============
    log("階段一：回合開始", "phase");
    const entities = battleState.entities;

    // 0. 恐慌恢復
    entities.forEach(function (e) {
      if (e.panicRecovering) {
        e.focus = 0;
        e.panicRecovering = false;
        log(e.name + "：恐慌恢復，專注力歸 0。");
      }
      e._focusAtTurnStart = e.focus;
      e.cantActRestOfTurn = false;
      e.drawnSkillInstances = [];
      e.declarations = [];
    });

    // 1. 更新槽位
    growPcSlots(battleState, log);
    const npcs = entities.filter(function (e) { return !e.isPC && e.hp > 0; });
    for (const npc of npcs) {
      const n = yield { type: "npcSlots", entityId: npc.id, currentSlots: npc.slots };
      npc.slots = Number(n) || 0;
      log(npc.name + " 槽位（KP手填）= " + npc.slots);
    }

    // 2. 判定無法行動者
    entities.forEach(function (e) {
      if (e.hp <= 0) { e.canAct = false; return; }
      if (e.confusionLockTurns > 0) {
        e.canAct = false;
        log(e.name + " 處於混亂鎖定中（剩 " + e.confusionLockTurns + " 回合），本回合無法行動。");
        return;
      }
      if (e.panicNextTurn) {
        e.panicNextTurn = false;
        e.isPanickingThisTurn = true;
        e.canAct = false;
        log(e.name + " 進入恐慌，本回合無法行動。");
        return;
      }
      e.canAct = true;
    });

    // 3. 結算技能對照表
    entities.filter(function (e) { return e.canAct; }).forEach(function (e) {
      Engine.resolveSlotMap(e);
    });

    // 4. 抽技能
    for (const e of entities) {
      if (!e.canAct || e.slots <= 0) continue;
      for (let i = 0; i < e.slots; i++) {
        const dice = yield { type: "d6pair", entityId: e.id, slotIndex: i };
        const menu = Engine.drawSkillMenu(e, dice.die1, dice.die2);
        let chosenId;
        if (menu.options.length === 0) {
          log(e.name + " 第" + (i + 1) + "槽：兩次骰到的槽位皆無技能指向，視同空槽。");
          continue;
        } else if (menu.options.length === 1) {
          chosenId = menu.options[0].skillId;
          log(e.name + " 第" + (i + 1) + "槽：1d6=" + dice.die1 + "," + dice.die2 + "（兩次同槽位，被迫單選）→ " +
            Engine.findSkill(e, chosenId).name);
        } else {
          const choice = yield { type: "chooseSkill", entityId: e.id, slotIndex: i, options: menu.options.map(function (o) { return { skillId: o.skillId, name: Engine.findSkill(e, o.skillId).name }; }) };
          chosenId = choice;
          log(e.name + " 第" + (i + 1) + "槽：1d6=" + dice.die1 + "," + dice.die2 + " → 選擇 " + Engine.findSkill(e, chosenId).name);
        }
        e.drawnSkillInstances.push({ instanceId: e.id + "_s" + i, slotIndex: i, skillId: chosenId, used: false });
      }
    }

    // 5. 回合開始被動結算（宣告式被動：turnStart）
    for (const e of entities) {
      if (e.hp <= 0) continue;
      yield* Engine.runPassives(battleState, e, "turnStart", log);
    }

    // 7. 重算有效 DEX
    entities.forEach(function (e) { Engine.computeEffectiveDex(e); });

    // ============ 階段二：宣告與配對 ============
    log("階段二：宣告與配對", "phase");
    for (const e of entities) {
      if (!e.canAct) continue;
      for (const inst of e.drawnSkillInstances) {
        const skill = Engine.findSkill(e, inst.skillId);
        const decl = yield {
          type: "declareTarget", entityId: e.id, instanceId: inst.instanceId,
          skillId: inst.skillId, skillName: skill.name, skillType: skill.type
        };
        e.declarations.push({
          instanceId: inst.instanceId, skillId: inst.skillId, skill: skill,
          action: decl.action, targetId: decl.targetId, protectId: decl.protectId
        });
      }
    }

    // §9 攔截資格判定 + 自動配對草案
    const proposed = buildProposedPairing(entities, log);

    const finalPairing = yield { type: "confirmPairing", proposed: proposed };

    // ============ 階段三 + 四：拚點結算 + 傷害結算（逐配對處理） ============
    log("階段三：拚點結算 / 階段四：傷害結算", "phase");
    for (const pair of finalPairing.clashes) {
      yield* resolveClashPair(battleState, pair, log);
      if (aliveEntities(battleState).filter(function(e){return e.isPC;}).length === 0 ||
          aliveEntities(battleState).filter(function(e){return !e.isPC;}).length === 0) {
        log("一方已全滅，戰鬥可能已分出勝負。", "info");
      }
    }
    for (const uni of finalPairing.unilaterals) {
      yield* resolveUnilateral(battleState, uni, log);
    }

    // ============ 階段五：狀態觸發 ============
    log("階段五：狀態觸發（萎靡/開裂/失血/恍惚/凝神已於拚點與傷害結算中即時觸發）", "phase");

    // ============ 階段六：回合結束（依序） ============
    log("階段六：回合結束", "phase");
    // 1. 臨時生命值歸零
    entities.forEach(function (e) { if (e.tempHp > 0) { e.tempHp = 0; } });
    // 2. 回合結束觸發：延燒 + 宣告式被動（turnEnd）。此處讀取的是本回合完整、未扣層的狀態。
    entities.filter(function (e) { return e.hp > 0; }).forEach(function (e) {
      Engine.applyEndOfTurnBurn(e, log);
    });
    for (const e of entities) {
      if (e.hp <= 0) continue;
      yield* Engine.runPassives(battleState, e, "turnEnd", log); // turnEnd 施加的狀態已標豁免
    }
    // 3. 全體狀態層數 -1（步驟2剛加上的狀態豁免）
    entities.forEach(function (e) {
      Object.keys(e.states).forEach(function (name) {
        const st = e.states[name];
        if (st.justAddedThisTurn) { st.justAddedThisTurn = false; return; }
        if ((st.layer || 0) > 0) Engine.addStateLayer(e, name, -1);
      });
      Engine.clearZeroStates(e);
    });
    // 4. 更新持續時間與恢復
    entities.forEach(function (e) {
      if (e.confusionLockTurns > 0) {
        e.confusionLockTurns -= 1;
        if (e.confusionLockTurns === 0) {
          e.isConfused = false;
          log(e.name + " 混亂解除，恢復行動（血量不動）。");
        }
      }
      // 恐慌進入判定：本回合 focus 跨越到 -40（門鈴式）
      if (e._focusAtTurnStart > -40 && e.focus <= -40 && !e.panicNextTurn && !e.isPanickingThisTurn) {
        e.panicNextTurn = true;
        log(e.name + " 專注力跨越 -40，下回合進入恐慌。");
      }
      // 恐慌結束 → 設 panicRecovering
      if (e.isPanickingThisTurn) {
        e.isPanickingThisTurn = false;
        e.panicRecovering = true;
        log(e.name + " 本回合恐慌結束，下回合開始專注力將歸 0。");
      }
    });

    log("===== 回合 " + turnNo + " 結束 =====", "phase");
    battleState.turnNumber += 1;
    return { battleState: battleState };
  }
  Engine.runTurn = runTurn;

  // ---------------- §9 攔截資格判定 + 配對草案 ----------------
  function buildProposedPairing(entities, log) {
    const byId = {};
    entities.forEach(function (e) { byId[e.id] = e; });

    const attacks = [];
    const defends = [];
    const intercepts = [];
    entities.forEach(function (e) {
      if (!e.canAct) return;
      e.declarations.forEach(function (d) {
        if (d.action === "attack") attacks.push({ entity: e, decl: d });
        else if (d.action === "defend") defends.push({ entity: e, decl: d });
        else if (d.action === "intercept") intercepts.push({ entity: e, decl: d });
      });
    });

    // 處理攔截：把符合資格的攔截，重導攻擊目標
    attacks.forEach(function (atk) {
      const candidates = intercepts.filter(function (ic) {
        if (ic.decl.protectId !== atk.decl.targetId) return false;
        // §9 方向限制：非PC方原則上不能攔截玩家方向的攻擊；例外：帶「攔截例外被動」者可覆寫
        if (!ic.entity.isPC && !Engine.canInterceptPlayers(ic.entity)) {
          log("（攔截被拒：" + ic.entity.name + " 為非PC方，依規則不能攔截，且無攔截例外被動）");
          return false;
        }
        const protectedEntity = byId[atk.decl.targetId];
        if (!protectedEntity) return false;
        return ic.entity.effectiveDex > protectedEntity.effectiveDex; // 嚴格大於
      });
      if (candidates.length > 0) {
        candidates.sort(function (a, b) { return b.entity.effectiveDex - a.entity.effectiveDex; });
        const winner = candidates[0];
        log(winner.entity.name + "（DEX " + winner.entity.effectiveDex.toFixed(1) + "）攔截了 " +
          atk.entity.name + " 對 " + byId[atk.decl.targetId].name + " 的攻擊（DEX " + byId[atk.decl.targetId].effectiveDex.toFixed(1) + "）。");
        atk.redirectedTo = winner.entity.id;
        winner.consumedAsDefense = true;
        winner.matchedAttacker = atk.entity.id;
      }
    });

    const clashes = [];
    const unilaterals = [];
    const usedDefendInstance = {};

    attacks.forEach(function (atk) {
      const finalTargetId = atk.redirectedTo || atk.decl.targetId;
      const finalTargetEntity = byId[finalTargetId];

      // 找出攔截者本身的技能去對抗（若是被攔截）
      let defenderRef = null;
      if (atk.redirectedTo) {
        const ic = intercepts.find(function (x) { return x.entity.id === atk.redirectedTo && x.matchedAttacker === atk.entity.id; });
        if (ic) defenderRef = { entity: ic.entity, decl: ic.decl };
      } else {
        // 找一個尚未使用、targetId 對應攻擊者的 defend 宣告
        defenderRef = defends.find(function (d) {
          return !usedDefendInstance[d.decl.instanceId] && d.entity.id === finalTargetId &&
            (d.decl.targetId === atk.entity.id || !d.decl.targetId);
        }) || null;
      }

      if (defenderRef) {
        usedDefendInstance[defenderRef.decl.instanceId] = true;
        clashes.push({
          aEntityId: atk.entity.id, aInstanceId: atk.decl.instanceId, aSkillId: atk.decl.skillId,
          bEntityId: defenderRef.entity.id, bInstanceId: defenderRef.decl.instanceId, bSkillId: defenderRef.decl.skillId
        });
      } else {
        unilaterals.push({
          attackerId: atk.entity.id, instanceId: atk.decl.instanceId, skillId: atk.decl.skillId,
          targetId: finalTargetId
        });
      }
    });

    return { clashes: clashes, unilaterals: unilaterals };
  }

  // ---------------- 拚點配對的執行（含 §6 + §7 + 碎幣追加攻擊） ----------------
  function* resolveClashPair(battleState, pair, log) {
    const byId = {};
    battleState.entities.forEach(function (e) { byId[e.id] = e; });
    const a = byId[pair.aEntityId], b = byId[pair.bEntityId];
    if (!a || !b || a.hp <= 0 || b.hp <= 0) { log("配對中有一方已倒下，跳過此拚點。"); return; }

    if (a.cantActRestOfTurn) { log(a.name + " 本回合行動已作廢（混亂），此拚點取消。"); return; }
    if (b.cantActRestOfTurn) {
      log(b.name + " 本回合行動已作廢（混亂），改為 " + a.name + " 單方面攻擊。");
      yield* resolveUnilateral(battleState, { attackerId: a.id, skillId: pair.aSkillId, targetId: b.id }, log);
      return;
    }

    const skillA = Engine.findSkill(a, pair.aSkillId);
    const skillB = Engine.findSkill(b, pair.bSkillId);
    log(a.name + "《" + skillA.name + "》 拚點 vs " + b.name + "《" + skillB.name + "》", "info");

    // §3.2 [使用時] useEffects：雙方技能都「被使用」，各自觸發（不論勝負）
    yield* Engine.applySkillEffects(a, b, skillA.useEffects, "使用時", log);
    yield* Engine.applySkillEffects(b, a, skillB.useEffects, "使用時", log);

    const result = Engine.runClash({ entity: a, skill: skillA }, { entity: b, skill: skillB }, log);

    if (result.winnerSide) {
      const winnerEntity = result.winnerSide === "A" ? a : b;
      const loserEntity = result.winnerSide === "A" ? b : a;
      const winnerSideData = result.winnerSide === "A" ? result.sideA : result.sideB;
      const loserSideData = result.winnerSide === "A" ? result.sideB : result.sideA;
      const winnerSkill = result.winnerSide === "A" ? skillA : skillB;

      winnerEntity.focus += result.focusDeltaWinner;
      loserEntity.focus += result.focusDeltaLoser;

      if (winnerSkill.type === "attack") {
        const aliveCoins = winnerSideData.coins.filter(function (c) { return c.status === "alive"; });
        // 使用拚點時已算好的有效威力（含強壯/虛弱 + 印記條件），與拚點一致
        yield* Engine.damageResolution(winnerEntity, loserEntity, aliveCoins, winnerSideData.basePower, winnerSideData.coinPower, winnerSkill.name, log);
        // §3.2 [命中時] hitEffects：攻擊命中後觸發（施加印記等）
        if (loserEntity.hp >= 0) yield* Engine.applySkillEffects(winnerEntity, loserEntity, winnerSkill.hitEffects, "命中時", log);
      } else {
        log(winnerEntity.name + " 的防禦型技能《" + winnerSkill.name + "》拚點成功，無傷害結算（防禦成功）。");
        yield* Engine.applySkillEffects(winnerEntity, loserEntity, winnerSkill.hitEffects, "防禦成功時", log);
      }

      // 碎幣追加攻擊：只有「拚輸」的一方，紅幣碎了才觸發
      const shattered = loserSideData.coins.filter(function (c) { return c.status === "shattered"; });
      if (shattered.length > 0) {
        log(loserEntity.name + " 拚輸但有 " + shattered.length + " 枚碎掉的紅幣，觸發單方面追加攻擊！", "info");
        yield* Engine.damageResolution(loserEntity, winnerEntity, shattered, 1, 1, "碎幣追加攻擊", log);
      }
    } else {
      log("雙方一開局即無可擲硬幣，視為無效拚點。");
    }
  }
  Engine.resolveClashPair = resolveClashPair;

  function* resolveUnilateral(battleState, uni, log) {
    const byId = {};
    battleState.entities.forEach(function (e) { byId[e.id] = e; });
    const attacker = byId[uni.attackerId];
    const target = byId[uni.targetId];
    if (!attacker || !target || attacker.hp <= 0 || target.hp <= 0) { log("單方面攻擊的一方已倒下，跳過。"); return; }
    if (attacker.cantActRestOfTurn) { log(attacker.name + " 本回合行動已作廢（混亂），此單方面攻擊取消。"); return; }

    const skill = Engine.findSkill(attacker, uni.skillId);
    log(attacker.name + "《" + skill.name + "》 對 " + target.name + " 單方面攻擊（無人抵擋）", "info");
    if (skill.type !== "attack") {
      log("（此為防禦型技能且無人可拚，無事發生）");
      return;
    }
    yield* Engine.applySkillEffects(attacker, target, skill.useEffects, "使用時", log);
    const allCoins = skill.coins.map(function (c) { return { type: c.type }; });
    const eff = Engine.computeEffectivePower(attacker, skill, target);
    yield* Engine.damageResolution(attacker, target, allCoins, eff.basePower, eff.coinPower, skill.name, log);
    yield* Engine.applySkillEffects(attacker, target, skill.hitEffects, "命中時", log);
  }
  Engine.resolveUnilateral = resolveUnilateral;

})(window);

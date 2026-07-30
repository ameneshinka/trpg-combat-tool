// ============================================================
// UI：戰鬥流程驅動
// 把 Turn.runTurn 這個 generator 推進，並在它 yield 的地方渲染對應表單。
// 需要手動骰的點（engine-notes.md）：技能抽選 1d6×2、傷害乘數、凝神 1d20。
// 工具自動處理：加權硬幣擲幣、隨機目標（KP 可覆寫）。
// ============================================================
(function (global) {
  "use strict";
  const Battle = global.Battle = {};
  const S = global.States, T = global.Turn, P = global.Panels;
  const el = function (t, o) { return P.el(t, o); };
  const $ = function (s) { return document.querySelector(s); };

  let battle = null;
  let iter = null;
  let pending = null;
  let allEvents = [];
  let mode = "solo";     // solo | kp | player
  let onPublish = null;  // KP 廣播回呼（由 app.js 注入）
  let advancing = false;

  const PHASE_TITLE = {
    npcSlots: "階段一・回合開始 — NPC 槽位（KP 手填，不做上限檢查）",
    skillDraw1d6: "階段一・回合開始 — 技能抽選（手動輸入 1d6 兩次）",
    chooseSkill: "階段一・回合開始 — 從菜單選一個技能",
    declare: "階段二・宣告與配對",
    confirmPairing: "階段二・KP 確認最終配對",
    damageMultiplier: "階段四・傷害乘數骰（整把技能共用）",
    concentration1d20: "階段四・凝神判定（1d20）"
  };

  Battle.init = function (opts) {
    battle = opts.battle;
    mode = opts.mode || "solo";
    onPublish = opts.onPublish || null;
    allEvents = [];
    iter = null; pending = null;
    T.startBattleRound(battle, allEvents);
    render();
    nextTurn();
  };
  Battle.getState = function () {
    return { battle: battle, pending: pending, events: allEvents, turnNumber: battle && battle.turnNumber };
  };
  Battle.setMode = function (m) { mode = m; };

  function nextTurn() {
    const alivePc = battle.entities.filter(function (e) { return e.isPC && e.hp > 0; }).length;
    const aliveNpc = battle.entities.filter(function (e) { return !e.isPC && e.hp > 0; }).length;
    if (!alivePc || !aliveNpc) {
      pending = null;
      setPhase("戰鬥結束");
      const box = $("#actionArea");
      box.innerHTML = "";
      box.appendChild(el("h4", { text: "戰鬥結束 — " + (alivePc ? "玩家方獲勝" : "敵方獲勝") }));
      render();
      publish();
      return;
    }
    iter = T.runTurn(battle, allEvents);
    advance();
  }
  Battle.nextTurn = nextTurn;

  function advance(input) {
    if (advancing) return;
    advancing = true;
    let res;
    try {
      res = iter.next(input);
    } catch (err) {
      allEvents.push("⚠ 引擎錯誤：" + err.message);
      console.error(err);
      render();
      advancing = false;
      return;
    }
    if (res.done) {
      pending = null;
      setPhase("回合結束，準備下一回合");
      const box = $("#actionArea");
      box.innerHTML = "";
      const btn = el("button", { cls: "primary", text: "開始下一回合（回合 " + battle.turnNumber + "）" });
      btn.type = "button";
      btn.onclick = nextTurn;
      box.appendChild(btn);
      render();
      publish();
      advancing = false;
      return;
    }
    pending = res.value;
    render();
    renderPrompt(pending);
    publish();
    advancing = false;
  }

  // 送出去向可被替換：
  //   KP／單機 → 直接推進引擎（Battle 持有 generator，是唯一的權威）
  //   玩家端   → 由 app.js 換成「寫入 Firebase /inputs」，等 KP 採用
  let submitSink = function (v) { advance(v); };
  Battle.setSubmitSink = function (fn) { submitSink = fn; };
  function submit(v) { submitSink(v); }
  Battle.submitRemote = function (v) { advance(v); };

  function setPhase(t) { $("#phaseTitle").textContent = t; }

  function render() {
    if (!battle) return;
    P.renderPanels($("#panels"), battle, {
      kpControls: mode !== "player",
      showActions: true,
      onChange: function () { render(); publish(); }
    });
    P.renderTurnOrder($("#turnOrder"), battle);
    P.renderLog($("#eventLog"), allEvents);
    $("#turnIndicator").textContent = "戰鬥輪 " + (battle.roundNumber || 1) + " ／ 回合 " + battle.turnNumber;
  }
  Battle.render = render;

  function publish() {
    if (mode === "kp" && onPublish) onPublish(Battle.getState());
  }

  // ---------------- 玩家端：哪些請求可由玩家自己填 ----------------
  // KP 專屬：NPC 槽位、最終配對確認。其餘（自己角色的骰與宣告）玩家可填。
  function ownerOf(req) { return req && (req.entityId || req.attackerId) || null; }
  Battle.ownerOf = ownerOf;
  Battle.isPlayerFillable = function (req) {
    if (!req) return false;
    if (req.type === "npcSlots" || req.type === "confirmPairing") return false;
    const id = ownerOf(req);
    if (!id) return false;
    const e = battle && battle.entities.find(function (x) { return x.id === id; });
    return !!(e && e.isPC);
  };

  // ---------------- 表單 ----------------
  function renderPrompt(req) {
    setPhase(PHASE_TITLE[req.type] || req.type);
    const box = $("#actionArea");
    box.innerHTML = "";
    const ent = req.entityId ? battle.entities.find(function (e) { return e.id === req.entityId; }) : null;

    if (req.type === "npcSlots") {
      box.appendChild(el("h4", { text: req.name + " 本回合槽位數" }));
      box.appendChild(el("p", { cls: "hint", text: "由 KP 手動填入；工具不做上限檢查（8 的約束只適用於 PC）。" }));
      const i = el("input"); i.type = "number"; i.min = 0; i.value = req.current;
      i.setAttribute("aria-label", "槽位數");
      const b = el("button", { cls: "primary", text: "送出" });
      b.type = "button";
      b.onclick = function () { submit(Number(i.value) || 0); };
      box.appendChild(row([i, b]));
      i.focus();
      return;
    }

    if (req.type === "skillDraw1d6") {
      box.appendChild(el("h4", { text: req.name + "　第 " + (req.slotIndex + 1) + " 槽 — 骰 1d6 兩次" }));
      box.appendChild(el("p", { cls: "hint", text: "骰面 1–3 → 槽位A、4–5 → 槽位B、6 → 槽位C。骰到重複不重骰（會變成被迫單選）。" }));
      const i1 = el("input"); i1.type = "number"; i1.min = 1; i1.max = 6; i1.placeholder = "第一次"; i1.setAttribute("aria-label", "第一次 1d6");
      const i2 = el("input"); i2.type = "number"; i2.min = 1; i2.max = 6; i2.placeholder = "第二次"; i2.setAttribute("aria-label", "第二次 1d6");
      const b = el("button", { cls: "primary", text: "送出" });
      b.type = "button";
      b.onclick = function () {
        const d1 = Number(i1.value), d2 = Number(i2.value);
        if (!(d1 >= 1 && d1 <= 6) || !(d2 >= 1 && d2 <= 6)) { alert("1d6 必須是 1~6"); return; }
        submit({ die1: d1, die2: d2 });
      };
      box.appendChild(row([i1, i2, b]));
      i1.focus();
      return;
    }

    if (req.type === "chooseSkill") {
      box.appendChild(el("h4", { text: req.name + "　第 " + (req.slotIndex + 1) + " 槽 — 選一個技能" }));
      box.appendChild(el("p", { cls: "hint", text: "1d6 骰出 " + req.dice.join(" 與 ") + "，指向以下技能：" }));
      const r = el("div", { cls: "row" });
      req.options.forEach(function (o) {
        const b = el("button", { text: o.name });
        b.type = "button";
        b.onclick = function () { submit(o.id); };
        r.appendChild(b);
      });
      box.appendChild(r);
      return;
    }

    if (req.type === "declare") {
      box.appendChild(el("h4", {
        text: req.name + "《" + req.skillName + "》（" +
          (req.isGuard ? "防守" : req.isDodge ? "閃躲" : req.skillType === "defense" ? "防禦型" : "攻擊型") + "）"
      }));
      const actionSel = el("select");
      actionSel.setAttribute("aria-label", "動作");
      const acts = req.skillType === "defense"
        ? [["defend", "用來防禦／閃躲"], ["intercept", "攔截（把隊友被打的攻擊搶過來）"]]
        : [["attack", "攻擊"], ["intercept", "攔截（把隊友被打的攻擊搶過來）"]];
      acts.forEach(function (a) { const o = el("option", { text: a[1] }); o.value = a[0]; actionSel.appendChild(o); });

      const alive = battle.entities.filter(function (x) { return x.hp > 0; });
      const targetSel = el("select"); targetSel.setAttribute("aria-label", "目標");
      alive.forEach(function (x) {
        const o = el("option", { text: x.name + (x.isPC ? "（PC）" : "（NPC）") + " DEX " + S.effectiveDex(x).toFixed(1) });
        o.value = x.id; targetSel.appendChild(o);
      });
      const protectSel = el("select"); protectSel.setAttribute("aria-label", "保護對象");
      alive.forEach(function (x) { const o = el("option", { text: x.name }); o.value = x.id; protectSel.appendChild(o); });

      const rTarget = row([el("span", { text: "目標／對手：" }), targetSel]);
      const rProtect = row([el("span", { text: "保護誰：" }), protectSel]);
      rProtect.style.display = "none";
      actionSel.onchange = function () {
        const ic = actionSel.value === "intercept";
        rProtect.style.display = ic ? "flex" : "none";
        rTarget.querySelector("span").textContent = ic ? "攔誰的攻擊：" : "目標／對手：";
      };

      box.appendChild(row([el("span", { text: "動作：" }), actionSel]));
      box.appendChild(rTarget);
      box.appendChild(rProtect);
      if (req.isDodge) box.appendChild(el("p", { cls: "hint warn-text", text: "⚠ 閃躲失敗會使硬幣損失持續到回合結束 —— 本回合剩下的攻擊都會命中。" }));
      if (req.isGuard) box.appendChild(el("p", { cls: "hint", text: "防守：增加「最終威力 × 5」的臨時生命值（回合結束的傷害結算完之後才歸零）。" }));

      const b = el("button", { cls: "primary", text: "送出宣告" });
      b.type = "button";
      b.onclick = function () {
        submit({ action: actionSel.value, targetId: targetSel.value, protectId: protectSel.value });
      };
      box.appendChild(b);
      return;
    }

    if (req.type === "confirmPairing") {
      box.appendChild(el("h4", { text: "KP 確認最終配對" }));
      const entries = req.proposed.map(function (e) { return Object.assign({}, e); });
      const list = el("div");
      if (!entries.length) list.appendChild(el("p", { cls: "hint", text: "（本回合沒有任何行動）" }));
      entries.forEach(function (en, i) {
        const a = byId(en.aEntityId), b2 = en.bEntityId ? byId(en.bEntityId) : null;
        const t = en.targetId ? byId(en.targetId) : null;
        let text;
        if (en.kind === "clash") text = a.name + "《" + skName(a, en.aSkillId) + "》 ⚔ " + b2.name + "《" + skName(b2, en.bSkillId) + "》";
        else if (en.kind === "unilateral") text = a.name + "《" + skName(a, en.aSkillId) + "》 → " + (t ? t.name : "?") + "（單方面攻擊）";
        else text = a.name + "《" + skName(a, en.aSkillId) + "》（無對手的防禦技）";
        const rowEl = el("div", { cls: "pair-block" });
        rowEl.appendChild(el("span", { text: text }));
        const rm = el("button", { cls: "danger", text: "移除" });
        rm.type = "button";
        rm.onclick = function () { en._removed = true; rowEl.style.opacity = "0.35"; rm.disabled = true; };
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
      box.appendChild(list);
      const b = el("button", { cls: "primary", text: "確認配對，進入結算" });
      b.type = "button";
      b.onclick = function () {
        submit({ entries: entries.filter(function (e) { return !e._removed; }) });
      };
      box.appendChild(b);
      return;
    }

    if (req.type === "damageMultiplier") {
      box.appendChild(el("h4", { text: "《" + req.label + "》傷害乘數骰" }));
      box.appendChild(el("p", { cls: "hint", text: "該技能武器的傷害骰，過技能時擲一次，整把技能所有硬幣共用。" }));
      const i = el("input"); i.type = "number"; i.min = 0; i.value = 1; i.setAttribute("aria-label", "傷害乘數");
      const b = el("button", { cls: "primary", text: "送出" });
      b.type = "button";
      b.onclick = function () { submit(Number(i.value) || 0); };
      box.appendChild(row([i, b]));
      i.focus(); i.select();
      return;
    }

    if (req.type === "concentration1d20") {
      box.appendChild(el("h4", { text: "凝神判定（第 " + (req.coinIndex + 1) + " 枚硬幣）" }));
      box.appendChild(el("p", { cls: "hint", text: "1d20 小於凝神級數（" + req.level + "）則該枚 +30%，然後級數 −2、層數 −1。" }));
      const i = el("input"); i.type = "number"; i.min = 1; i.max = 20; i.value = 10; i.setAttribute("aria-label", "1d20");
      const b = el("button", { cls: "primary", text: "送出" });
      b.type = "button";
      b.onclick = function () {
        const v = Number(i.value);
        if (!(v >= 1 && v <= 20)) { alert("1d20 必須是 1~20"); return; }
        submit(v);
      };
      box.appendChild(row([i, b]));
      i.focus(); i.select();
      return;
    }

    box.appendChild(el("p", { text: "未知請求：" + req.type }));
  }
  Battle.renderPrompt = renderPrompt;

  // 玩家端唯讀鏡像用
  Battle.renderMirror = function (state) {
    battle = state.battle;
    allEvents = state.events || [];
    pending = state.pending || null;
    render();
    const box = $("#actionArea");
    if (!pending) { box.innerHTML = ""; box.appendChild(el("p", { cls: "hint", text: "（等待 KP 推進…）" })); return; }
    if (Battle.isPlayerFillable(pending) && Battle.myPcIds && Battle.myPcIds.indexOf(ownerOf(pending)) !== -1) {
      renderPrompt(pending);
    } else {
      box.innerHTML = "";
      box.appendChild(el("p", { cls: "hint", text: "（此步驟由 KP 或其他玩家處理…）" }));
    }
  };

  function row(children) {
    const r = el("div", { cls: "row" });
    children.forEach(function (c) { r.appendChild(c); });
    return r;
  }
  function byId(id) { return battle.entities.find(function (e) { return e.id === id; }) || { name: id }; }
  function skName(entity, id) {
    const s = (entity.skillLibrary || []).find(function (x) { return x.id === id; });
    return s ? s.name : id;
  }

})(window);

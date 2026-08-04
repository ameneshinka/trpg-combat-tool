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
    turnAction: "階段一・回合開始 — 整回合動作（選了就放棄本回合全部槽位）",
    passiveChoice: "被動觸發 — 需要玩家／KP 決定",
    batchTarget: "階段二・一鍵指定敵方目標（之後仍可逐一訂正）",
    declare: "階段二・宣告與配對",
    confirmPairing: "階段二・KP 確認本回合行動（可改宣告／改技能／新增／刪除）",
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
    // KP 專屬：NPC 槽位、最終配對確認、一鍵指定。
    // turnAction 與 passiveChoice 屬於「該角色自己的決定」→ 由該 PC 的玩家填（下面的 isPC 判斷）。
    if (req.type === "npcSlots" || req.type === "confirmPairing" || req.type === "batchTarget") return false;
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
      const many = (req.count || 1) > 1;
      box.appendChild(el("h4", { text: req.name + (many ? " ×" + req.count : "") + " 本回合槽位數" }));
      box.appendChild(el("p", {
        cls: "hint",
        text: "由 KP 手動填入；工具不做上限檢查（8 的約束只適用於 PC）。" +
          (many ? "　此值會套用到 " + (req.names || []).join("／") + "。" : "")
      }));
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
      const title = req.isAdd ? "　第 " + (req.slotIndex + 1) + " 槽 — 新增行動：選一個防禦技"
        : req.isRedo ? "　第 " + (req.slotIndex + 1) + " 槽 — 改用哪個技能"
        : "　第 " + (req.slotIndex + 1) + " 槽 — 選一個技能";
      box.appendChild(el("h4", { text: req.name + title }));
      if (req.isAdd) {
        box.appendChild(el("p", { cls: "hint", text: "使用一個空閒槽位。【防守】【閃躲】不受 1d6 抽選限制，想用就能用（各佔一槽，同回合可多次）。" }));
      } else if (req.isRedo) {
        box.appendChild(el("p", { cls: "hint", text: "可選：當初 1d6 骰出的菜單" + ((req.dice || []).length ? "（" + req.dice.join(" 與 ") + "）" : "") + "，加上不受抽選限制的防禦技。" }));
      } else {
        box.appendChild(el("p", {
          cls: "hint",
          text: "1d6 骰出 " + (req.dice || []).join(" 與 ") +
            (req.forcedSingleAttack ? "（兩次指向同一個槽位 → 攻擊選項只有一個，但仍可改用防禦技）" : "")
        }));
      }
      // 攻擊技與防禦技分組顯示：防禦技不受骰選限制，任何時候都能挑
      const atk = req.options.filter(function (o) { return (o.kind || "attack") === "attack"; });
      const def = req.options.filter(function (o) { return o.kind === "defense"; });
      function optionRow(list, cls) {
        const r = el("div", { cls: "row" });
        list.forEach(function (o) {
          const b = el("button", { cls: cls, text: o.name });
          b.type = "button";
          b.onclick = function () { submit(o.id); };
          r.appendChild(b);
        });
        return r;
      }
      if (atk.length) {
        box.appendChild(el("div", { cls: "sub-label", text: "骰出的攻擊技" }));
        box.appendChild(optionRow(atk, "primary"));
      }
      if (def.length) {
        box.appendChild(el("div", { cls: "sub-label", text: "防禦技（不受抽選限制，想用就能用・各佔一槽）" }));
        box.appendChild(optionRow(def, ""));
        box.appendChild(el("p", { cls: "hint", text: "【防守】臨時生命值 = 最終威力 × 5　│　【閃躲】躲掉攻擊，但拚輸後本回合再也擋不住" }));
      }
      // KP 自由選（只有 NPC 有）：摺疊起來，展開才列 —— 預設仍走抽選，這只是逃生門
      const free = (req.freePickOptions || []).concat(
        req.options.filter(function (o) { return o.free; }));
      if (req.canFreePick && free.length) {
        const det = el("details", { cls: "free-pick" });
        const sum = el("summary", { text: "KP 自由選（無視抽選限制）" });
        det.appendChild(sum);
        det.appendChild(el("p", {
          cls: "hint",
          text: "抽選的機率結構（A 75%／B 55.6%／C 30.6%）是設計的一部分 —— 用了會在事件紀錄留下 ⚠ 標記。" +
            "隱藏技（只能被喚出的）不在此列。"
        }));
        det.appendChild(optionRow(free, "warn-btn"));
        box.appendChild(det);
      }
      return;
    }

    if (req.type === "batchTarget") {
      box.appendChild(el("h4", { text: "一鍵指定敵方目標" }));
      box.appendChild(el("p", {
        cls: "hint",
        text: "把下列 " + req.candidates.length + " 個敵方攻擊行動全部指向同一個人。" +
          "攔截與防禦技不在此列（一定要逐一裁定）。指定完之後，仍可在確認板上逐一改目標。"
      }));
      const list = el("div", { cls: "batch-list" });
      req.candidates.forEach(function (c) {
        list.appendChild(el("div", {
          cls: "hint",
          text: "・" + c.name + "　第 " + (c.slotIndex + 1) + " 槽《" + c.skillName + "》"
        }));
      });
      box.appendChild(list);

      box.appendChild(el("div", { cls: "sub-label", text: "全部攻擊誰" }));
      const r = el("div", { cls: "row" });
      req.targets.forEach(function (t) {
        const b = el("button", { cls: "primary", text: t.name + "（HP " + t.hp + "/" + t.maxHp + "）" });
        b.type = "button";
        b.onclick = function () { submit({ targetId: t.id }); };
        r.appendChild(b);
      });
      box.appendChild(r);
      const skip = el("button", { text: "略過，我要逐一宣告" });
      skip.type = "button";
      skip.onclick = function () { submit(null); };
      box.appendChild(row([skip]));
      return;
    }

    if (req.type === "declare") {
      box.appendChild(el("h4", {
        text: req.name + "《" + req.skillName + "》（" +
          (req.isGuard ? "防守" : req.isDodge ? "閃躲" : req.skillType === "defense" ? "防禦型" : "攻擊型") + "）"
      }));
      const isSupport = req.targetSide === "ally";
      const self = battle.entities.find(function (x) { return x.id === req.entityId; });
      const alive = battle.entities.filter(function (x) { return x.hp > 0; });
      const enemies = alive.filter(function (x) { return self && x.isPC !== self.isPC; });
      const allies = alive.filter(function (x) { return self && x.isPC === self.isPC && x.id !== self.id; });

      // 只列「真的攔得到」的攻擊者 —— 條件與 buildPairing 同源（Turn.interceptableAttackers）
      const interceptable = T.interceptableAttackers(self, alive);
      const canDoIntercept = interceptable.length > 0;

      const actionSel = el("select");
      actionSel.setAttribute("aria-label", "動作");
      const ICEPT = ["intercept", "攔截（把隊友被打的攻擊搶過來）"];
      const acts = isSupport
        ? [["support", "治療／支援友方"]]
        : req.skillType === "defense"
          ? [["defend", "用來防禦／閃躲"]].concat(canDoIntercept ? [ICEPT] : [])
          : [["attack", "攻擊"]].concat(canDoIntercept ? [ICEPT] : []);
      acts.forEach(function (a) { const o = el("option", { text: a[1] }); o.value = a[0]; actionSel.appendChild(o); });

      const targetSel = el("select"); targetSel.setAttribute("aria-label", "目標");
      const protectSel = el("select"); protectSel.setAttribute("aria-label", "保護對象");
      // 攔截是「把隊友被打的攻擊搶過來」→ 保護對象只列隊友（沒有隊友就列自己以免空選單）
      (allies.length ? allies : [self]).forEach(function (x) {
        if (!x) return;
        const o = el("option", { text: x.name }); o.value = x.id; protectSel.appendChild(o);
      });

      const rTarget = row([el("span", { text: "目標／對手：" }), targetSel]);
      const rProtect = row([el("span", { text: "保護誰：" }), protectSel]);
      rProtect.style.display = "none";
      const icHint = el("p", {
        cls: "hint",
        text: "攔截資格：攔截者的有效 DEX 必須「嚴格大於攻擊者」（相等不行）。" +
          "指名攻擊者就只攔他；留空則攔任何打這位隊友的人。"
      });
      icHint.style.display = "none";

      /**
       * 目標選單依動作重建 —— 三種動作的「目標」語意完全不同：
       *   attack    → 我要打誰（預設敵方）
       *   intercept → 我要攔誰的攻擊（預設敵方）
       *   defend    → 我要應對誰的攻擊；預設「任何攻擊我的人」（值為空字串），
       *               對應引擎 buildPairing 的 !decl.targetId 分支 → 誰打我都能擋。
       *               若預設成自己，配對會失敗、防禦技變成「無對手」——這是實測抓到的坑。
       */
      function syncTargetOptions(keepValue) {
        const act = actionSel.value;
        const prevVal = keepValue !== undefined ? keepValue : targetSel.value;
        targetSel.innerHTML = "";
        // 治療技：targetId 的語意變成「若有敵人攻擊我，要跟哪一個拚點」（裁決 35）
        if (isSupport) {
          const anyOpt = el("option", { text: "（由 KP 當場指定／任何攻擊我的人）" });
          anyOpt.value = ""; targetSel.appendChild(anyOpt);
        }
        if (act === "defend") {
          const anyOpt = el("option", { text: "（任何攻擊我的人）" });
          anyOpt.value = ""; targetSel.appendChild(anyOpt);
        }
        // 攔截：指名攻擊者 → 只攔他；留空 → 攔任何打這位隊友的人（裁決 45）
        if (act === "intercept") {
          const anyOpt = el("option", { text: "（任何攻擊他的人）" });
          anyOpt.value = ""; targetSel.appendChild(anyOpt);
        }
        const list = act === "intercept" ? interceptable
          : act === "attack"
            ? enemies.concat(alive.filter(function (x) { return enemies.indexOf(x) === -1; }))
            : alive;
        list.forEach(function (x) {
          const o = el("option", {
            text: x.name + (x.isPC ? "（PC）" : "（NPC）") + " DEX " + S.effectiveDex(x).toFixed(1)
          });
          o.value = x.id; targetSel.appendChild(o);
        });
        if (prevVal !== undefined && prevVal !== null &&
            Array.prototype.some.call(targetSel.options, function (o) { return o.value === prevVal; })) {
          targetSel.value = prevVal;
        }
        const ic = act === "intercept";
        rProtect.style.display = ic ? "flex" : "none";
        icHint.style.display = ic ? "" : "none";
        rTarget.querySelector("span").textContent = ic ? "攔誰的攻擊：" :
          isSupport ? "若被攻擊，跟誰拚點：" :
          act === "defend" ? "應對誰的攻擊：" : "目標／對手：";
      }
      actionSel.onchange = function () { syncTargetOptions(); };

      // 重新宣告時把上次的選擇帶回來，KP 只要改要改的那一項
      let restoreTarget;
      if (req.isRedo) {
        box.insertBefore(el("p", { cls: "hint warn-text", text: "↺ 重新宣告這個槽位（原本的宣告已清除）" }), box.firstChild.nextSibling);
        if (req.previous) {
          if (req.previous.action) actionSel.value = req.previous.action;
          if (req.previous.protectId) protectSel.value = req.previous.protectId;
          restoreTarget = req.previous.targetId;
        }
        // ⚠ 上次選的是攔截、但這回合已經沒有攔得到的人 → 該選項不存在，
        //   指派會靜默失敗（value 變成空字串）→ 退回第一個選項，避免送出空動作
        if (!actionSel.value) {
          actionSel.value = acts[0][0];
          restoreTarget = undefined;
        }
      }
      syncTargetOptions(restoreTarget);

      // 治療技：另外選「治療誰」（存進 supportId，與拚點對手分開）
      const supportSel = el("select"); supportSel.setAttribute("aria-label", "治療對象");
      const rSupport = row([el("span", { text: "治療誰：" }), supportSel]);
      if (isSupport) {
        allies.forEach(function (x) {
          const o = el("option", { text: x.name + "　HP " + x.hp + "／" + x.maxHp });
          o.value = x.id; supportSel.appendChild(o);
        });
        if (!allies.length) {
          const o = el("option", { text: "（沒有其他存活的友方，這把技能無效）" });
          o.value = ""; supportSel.appendChild(o);
        }
        if (req.isRedo && req.previous && req.previous.supportId) supportSel.value = req.previous.supportId;
      }

      box.appendChild(row([el("span", { text: "動作：" }), actionSel]));
      // 攔不到任何人時，說明為什麼沒有「攔截」這個選項（不然會以為是 bug）
      if (!isSupport && !canDoIntercept && self) {
        box.appendChild(el("p", {
          cls: "hint",
          text: T.mayInterceptPlayerSide(self)
            ? "（沒有「攔截」選項：" + self.name + " 的有效 DEX " + S.effectiveDex(self).toFixed(1) +
              " 未嚴格大於場上任何一名敵人，攔不到任何攻擊）"
            : "（沒有「攔截」選項：非玩家方依規則不能攔截打向玩家的攻擊，且此角色無「攔截例外」被動）"
        }));
      }
      if (isSupport) box.appendChild(rSupport);
      box.appendChild(rTarget);
      box.appendChild(rProtect);
      if (isSupport) {
        box.appendChild(el("p", {
          cls: "hint",
          text: "這是特殊的防禦型技能：不造成傷害，只作用在友方身上。" +
            "若有敵方指定攻擊使用者，必須先拚贏才能繼續使用（拚輸則改為對該敵人施加【恍惚】）。"
        }));
      }
      box.appendChild(icHint);
      if (req.isDodge) box.appendChild(el("p", { cls: "hint warn-text", text: "⚠ 閃躲失敗會使硬幣損失持續到回合結束 —— 本回合剩下的攻擊都會命中。" }));
      if (req.isGuard) box.appendChild(el("p", { cls: "hint", text: "防守：增加「最終威力 × 5」的臨時生命值（回合結束的傷害結算完之後才歸零）。" }));

      const b = el("button", { cls: "primary", text: "送出宣告" });
      b.type = "button";
      b.onclick = function () {
        submit({
          action: actionSel.value, targetId: targetSel.value,
          protectId: protectSel.value,
          supportId: isSupport ? supportSel.value : undefined
        });
      };
      box.appendChild(b);
      return;
    }

    if (req.type === "turnAction") {
      box.appendChild(el("h4", { text: req.name + " —— 本回合要不要改做別的事？" }));
      box.appendChild(el("p", {
        cls: "hint",
        text: "⚠ 這裡選了就會放棄本回合的全部槽位（連【防守】【閃躲】都不能用）。" +
          "問在抽技能之前，是為了避免抽完才發現要做這件事、白抽一輪。"
      }));
      const r = el("div", { cls: "row" });
      req.options.forEach(function (o) {
        const b2 = el("button", { cls: "warn-btn", text: o.label });
        b2.type = "button";
        if (o.hint) b2.title = o.hint;
        b2.onclick = function () { submit(o.id); };
        r.appendChild(b2);
        if (o.hint) box.appendChild(el("p", { cls: "hint", text: "・" + o.label + "：" + o.hint }));
      });
      box.appendChild(r);
      const no = el("button", { cls: "primary", text: "照常行動" });
      no.type = "button";
      no.onclick = function () { submit(null); };
      box.appendChild(row([no]));
      return;
    }

    if (req.type === "passiveChoice") {
      box.appendChild(el("h4", {
        text: req.name + (req.passiveName ? "〈" + req.passiveName + "〉" : "") + "　" + req.title
      }));
      if (req.detail) box.appendChild(el("p", { cls: "hint", text: req.detail }));
      const r = el("div", { cls: "row" });
      (req.options || []).forEach(function (o) {
        const isSuggested = req.suggested && o.id === req.suggested;
        const b2 = el("button", {
          cls: isSuggested ? "primary" : "",
          text: o.label + (isSuggested ? "　◀ 工具隨機挑出" : "")
        });
        b2.type = "button";
        b2.onclick = function () { submit(o.id); };
        r.appendChild(b2);
      });
      box.appendChild(r);
      if (req.suggested) {
        box.appendChild(el("p", { cls: "hint", text: "隨機結果由工具擲出，KP 可以覆寫（authoring.md 的擲骰處理表）。" }));
      }
      return;
    }

    if (req.type === "confirmPairing") {
      box.appendChild(el("h4", { text: "KP 確認本回合行動" }));
      box.appendChild(el("p", { cls: "hint", text: "確認前可以改任何一個槽位的宣告或技能；改完會立刻重算配對與攔截判定。" }));

      // ---- 行動一覽（依有效 DEX 序列）----
      const board = req.board || [];
      const boardBox = el("div", { cls: "action-board" });
      if (!board.length) boardBox.appendChild(el("p", { cls: "hint", text: "（本回合沒有人能行動）" }));
      board.forEach(function (r) {
        const row = el("div", { cls: "board-row" });

        const who = el("div", { cls: "br-who" });
        who.appendChild(el("span", { cls: "badge " + (r.isPC ? "pc" : "npc"), text: r.isPC ? "PC" : "NPC" }));
        who.appendChild(el("span", { cls: "br-name", text: r.entityName }));
        who.appendChild(el("span", { cls: "hint", text: "DEX " + r.dex.toFixed(1) + "　第 " + (r.slotIndex + 1) + " 槽" }));
        row.appendChild(who);

        const what = el("div", { cls: "br-what" });
        const skTag = el("span", { cls: "br-skill", text: "《" + r.skillName + "》" });
        what.appendChild(skTag);
        if (r.isGuard) what.appendChild(el("span", { cls: "tag order", text: "防守" }));
        if (r.isDodge) what.appendChild(el("span", { cls: "tag order", text: "閃躲" }));
        if (r.dice && r.dice.length) {
          what.appendChild(el("span", {
            cls: "hint",
            text: "1d6=" + r.dice.join("／") + (r.autoRolled ? "（代骰）" : "")
          }));
        }
        if (r.batched) {
          const bt = el("span", { cls: "tag warn", text: "批次指定" });
          bt.title = "由「一鍵指定敵方目標」填入 —— 按［改宣告］即可單獨訂正這一隻";
          what.appendChild(bt);
        }
        const actionText = r.action === "attack" ? "攻擊 → " + (r.targetName || "?")
          : r.action === "intercept" ? "攔截 " + (r.targetName || "?") + " 的攻擊（保護 " + (r.protectName || "?") + "）"
          : r.action === "support" ? "治療 → " + (r.supportName || "?") +
              (r.targetName ? "（若被攻擊則跟 " + r.targetName + " 拚點）" : "")
          : r.action === "defend" ? "防禦／應對 " + (r.targetName || "?")
          : "（尚未宣告）";
        what.appendChild(el("span", { cls: "br-action", text: actionText }));
        row.appendChild(what);

        const ops = el("div", { cls: "br-ops" });
        const reBtn = el("button", { text: "改宣告" });
        reBtn.type = "button";
        reBtn.setAttribute("aria-label", "重新宣告 " + r.entityName + " 第 " + (r.slotIndex + 1) + " 槽");
        reBtn.onclick = function () { submit({ redeclare: { entityId: r.entityId, slotIndex: r.slotIndex } }); };
        ops.appendChild(reBtn);
        if (r.canRechoose) {
          const skBtn = el("button", { text: "改技能" });
          skBtn.type = "button";
          skBtn.setAttribute("aria-label", "重新選擇 " + r.entityName + " 第 " + (r.slotIndex + 1) + " 槽的技能");
          skBtn.title = "可選：當初骰出的菜單 ＋ 防禦技（防守／閃躲不受抽選限制）";
          skBtn.onclick = function () { submit({ rechoose: { entityId: r.entityId, slotIndex: r.slotIndex } }); };
          ops.appendChild(skBtn);
        }
        const delBtn = el("button", { cls: "danger", text: "刪除" });
        delBtn.type = "button";
        delBtn.setAttribute("aria-label", "刪除 " + r.entityName + " 第 " + (r.slotIndex + 1) + " 槽的行動");
        delBtn.title = "整筆清掉，該槽位變回空閒 → 可用下方「新增行動」重新指定";
        delBtn.onclick = function () { submit({ removeAction: { entityId: r.entityId, slotIndex: r.slotIndex } }); };
        ops.appendChild(delBtn);
        row.appendChild(ops);
        boardBox.appendChild(row);
      });
      box.appendChild(boardBox);

      // ---- 新增行動（用空閒槽位打防禦技）----
      const usage = req.slotUsage || [];
      const addable = usage.filter(function (u) { return u.free > 0 && u.hasDefenseSkill; });
      const usageLine = usage.map(function (u) {
        return u.entityName + " " + u.used + "/" + u.slots + " 槽";
      }).join("　│　");
      if (usage.length) box.appendChild(el("p", { cls: "hint", text: "槽位使用狀況：" + usageLine }));
      if (addable.length) {
        box.appendChild(el("div", { cls: "sub-label", text: "新增行動（防禦技不受抽選限制，想用就能用）" }));
        const addRow = el("div", { cls: "row" });
        addable.forEach(function (u) {
          const b2 = el("button", { text: "＋ " + u.entityName + "（剩 " + u.free + " 槽）" });
          b2.type = "button";
          b2.setAttribute("aria-label", "為 " + u.entityName + " 新增一個行動");
          b2.onclick = function () { submit({ addAction: { entityId: u.entityId } }); };
          addRow.appendChild(b2);
        });
        box.appendChild(addRow);
      } else if (usage.length) {
        box.appendChild(el("p", { cls: "hint", text: "（所有人的槽位都已用完 —— 想換內容請用上方的「改技能／改宣告」，或先「刪除」再新增）" }));
      }

      // ---- 攔截判定結果 ----
      if ((req.notes || []).length) {
        box.appendChild(el("div", { cls: "sub-label", text: "攔截判定" }));
        req.notes.forEach(function (n) {
          box.appendChild(el("p", { cls: "hint" + (n.ok ? "" : " warn-text"), text: (n.ok ? "✓ " : "✗ ") + n.text }));
        });
      }

      // ---- 衍生出的配對（可個別移除）----
      const entries = req.proposed.map(function (e) { return Object.assign({}, e); });
      box.appendChild(el("div", { cls: "sub-label", text: "將要結算的配對" }));
      const list = el("div");
      if (!entries.length) list.appendChild(el("p", { cls: "hint", text: "（沒有任何要結算的行動）" }));
      entries.forEach(function (en) {
        const a = byId(en.aEntityId), b2 = en.bEntityId ? byId(en.bEntityId) : null;
        const t = en.targetId ? byId(en.targetId) : null;
        let text;
        if (en.kind === "clash") text = a.name + "《" + skName(a, en.aSkillId) + "》 ⚔ " + b2.name + "《" + skName(b2, en.bSkillId) + "》";
        else if (en.kind === "unilateral") text = a.name + "《" + skName(a, en.aSkillId) + "》 → " + (t ? t.name : "?") + "（單方面攻擊，無人抵擋）";
        else text = a.name + "《" + skName(a, en.aSkillId) + "》（無對手的防禦技）";
        const rowEl = el("div", { cls: "pair-block" });
        rowEl.appendChild(el("span", { text: text }));
        const rm = el("button", { cls: "danger", text: "移除" });
        rm.type = "button";
        rm.onclick = function () {
          en._removed = !en._removed;
          rowEl.style.opacity = en._removed ? "0.35" : "";
          rm.textContent = en._removed ? "已移除（點此復原）" : "移除";
        };
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
      box.appendChild(list);

      const b = el("button", { cls: "primary", text: "確認，進入結算" });
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

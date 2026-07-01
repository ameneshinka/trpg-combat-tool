// ============================================================
// UI 層：渲染面板、戰鬥紀錄、驅動 turncycle generator 的表單
// 支援三種模式：
//   solo   — 單機（引擎在本機跑，本機填所有輸入）
//   kp     — 建立房間；引擎在本機跑（權威），每步廣播 state 到 Firebase
//   player — 加入房間；不跑引擎，訂閱 state 做唯讀鏡像（+ 2c 的輸入通道）
// ============================================================
(function (global) {
  "use strict";
  const UI = global.UI = {};

  const $ = function (sel) { return document.querySelector(sel); };
  const el = function (tag, opts) {
    const e = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) e.className = opts.cls;
    if (opts.text !== undefined) e.textContent = opts.text;
    if (opts.html !== undefined) e.innerHTML = opts.html;
    return e;
  };

  // ---- 模式與連線狀態 ----
  let mode = "solo";          // solo | kp | player
  let roomCode = null;
  let clientId = null;
  let myPcIds = [];           // player：本玩家控制的實體 id
  let playerName = "";        // player：暱稱
  let hasChosenPc = false;    // player：是否已選好要控制的 PC
  let kpPlayersMap = {};      // kp：clientId -> { pcIds, displayName }
  let unsubState = null;
  let unsubInputs = null;
  let unsubPlayers = null;

  // ---- 戰鬥狀態 ----
  let battleState = null;
  let genIterator = null;     // 僅 kp / solo
  let pendingReq = null;
  let stepId = 0;             // kp 每個 pending request +1；player 由 state 讀入
  let advancing = false;      // 防止 remote/local 同時推進的重入保護

  // ============================================================
  // log：KP/solo 由引擎呼叫，逐條 push 到 battleState.log 並增量顯示
  // ============================================================
  function log(msg, cls) {
    if (!battleState) return;
    battleState.log.push({ msg: msg, cls: cls || "" });
    const entry = el("div", { cls: "log-entry " + (cls || ""), text: msg });
    const box = $("#battleLog");
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;
  }
  UI.log = log;

  // player：整份 log 陣列重建
  function rebuildLog(logArr) {
    const box = $("#battleLog");
    box.innerHTML = "";
    (logArr || []).forEach(function (e) {
      box.appendChild(el("div", { cls: "log-entry " + (e.cls || ""), text: e.msg }));
    });
    box.scrollTop = box.scrollHeight;
  }

  function updateConn(text) {
    const c = $("#connState");
    if (c) c.textContent = text;
  }

  // ---- 連線工作階段持久化（供重整後重連） ----
  function saveSession() {
    if (mode === "solo") return;
    try {
      localStorage.setItem("trpg_session", JSON.stringify({
        roomCode: roomCode, role: mode, clientId: clientId,
        name: playerName, myPcIds: myPcIds
      }));
    } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem("trpg_session"); } catch (e) {}
  }
  function saveKpState() {
    if (mode !== "kp" || !battleState) return;
    try { localStorage.setItem("trpg_kp_state_" + roomCode, JSON.stringify(battleState)); } catch (e) {}
  }
  UI.getSavedSession = function () {
    try { return JSON.parse(localStorage.getItem("trpg_session") || "null"); } catch (e) { return null; }
  };
  UI.getSavedKpState = function (code) {
    try { return JSON.parse(localStorage.getItem("trpg_kp_state_" + code) || "null"); } catch (e) { return null; }
  };

  function enterBattleScreen() {
    $("#setupScreen").classList.add("hidden");
    $("#battleScreen").classList.remove("hidden");
    $("#battleLog").innerHTML = "";
  }

  function setupBattleState(rosterData, order) {
    const entities = rosterData.entities.map(function (e) { return global.Data.makeEntity(e); });
    battleState = { turnNumber: 1, pcGrowthOrder: order, entities: entities, log: [] };
  }

  // ============================================================
  // 進場：三種模式
  // ============================================================
  function startBattleSolo(rosterData, order) {
    mode = "solo"; roomCode = null;
    updateConn("單機");
    setupBattleState(rosterData, order);
    enterBattleScreen();
    renderEntities();
    beginNextTurn();
  }
  UI.startBattleSolo = startBattleSolo;
  // 向下相容舊呼叫名
  UI.startBattle = startBattleSolo;

  function startBattleAsKP(rosterData, order, code, cid) {
    mode = "kp"; roomCode = code; clientId = cid;
    updateConn("KP・房號 " + code);
    setupBattleState(rosterData, order);
    enterBattleScreen();
    // 監聽玩家提交的輸入（2c）與玩家名冊（2b）
    if (unsubInputs) unsubInputs();
    unsubInputs = global.Sync.subscribeInputs(roomCode, onRemoteInput);
    if (unsubPlayers) unsubPlayers();
    unsubPlayers = global.Sync.subscribePlayers(roomCode, onPlayersUpdate);
    saveSession();
    saveKpState();
    renderEntities();
    beginNextTurn();
  }
  UI.startBattleAsKP = startBattleAsKP;

  // KP 重整後重連：還原「回合之間」的乾淨 battleState，按鈕繼續下一回合
  function resumeAsKP(code, cid, savedState) {
    mode = "kp"; roomCode = code; clientId = cid; battleState = savedState;
    updateConn("KP・房號 " + code + "（已重連）");
    enterBattleScreen();
    if (unsubInputs) unsubInputs();
    unsubInputs = global.Sync.subscribeInputs(roomCode, onRemoteInput);
    if (unsubPlayers) unsubPlayers();
    unsubPlayers = global.Sync.subscribePlayers(roomCode, onPlayersUpdate);
    saveSession();
    renderEntities();
    $("#phaseIndicator").textContent = "已重連，準備從回合 " + battleState.turnNumber + " 繼續";
    const box = $("#phaseAction"); box.innerHTML = "";
    box.appendChild(el("p", { cls: "hint", text: "（重整前若正處於回合進行中，該回合進度會遺失，將從回合 " + battleState.turnNumber + " 重新開始）" }));
    const btn = el("button", { cls: "primary", text: "繼續戰鬥（回合 " + battleState.turnNumber + "）" });
    btn.onclick = beginNextTurn;
    box.appendChild(btn);
    publish();
  }
  UI.resumeAsKP = resumeAsKP;

  // KP：玩家名冊更新 → 標註每個 PC 的控制者，重繪並重新廣播
  function onPlayersUpdate(playersMap) {
    kpPlayersMap = playersMap || {};
    if (mode !== "kp" || !battleState) return;
    const controllerOf = {};
    Object.keys(kpPlayersMap).forEach(function (cid) {
      const p = kpPlayersMap[cid];
      (p && p.pcIds || []).forEach(function (pid) { controllerOf[pid] = p.displayName || cid; });
    });
    battleState.entities.forEach(function (e) {
      if (!e.isPC) return;
      e.controllerLabel = controllerOf[e.id] ? ("🎮 " + controllerOf[e.id]) : "KP代管";
    });
    renderEntities();
    publish();
  }

  function startAsPlayer(code, cid, pcIds) {
    mode = "player"; roomCode = code; clientId = cid; myPcIds = pcIds || [];
    updateConn("玩家・房號 " + code);
    enterBattleScreen();
    $("#phaseIndicator").textContent = "等待 KP 開始戰鬥…";
    if (unsubState) unsubState();
    unsubState = global.Sync.subscribeState(roomCode, onStateMirror);
    saveSession();
  }
  UI.startAsPlayer = startAsPlayer;

  // 加入房間後：記住暱稱，等第一份 state 到達再讓玩家選 PC
  UI.beginPlayerJoin = function (code, cid, name) {
    playerName = name || "玩家";
    myPcIds = [];
    hasChosenPc = false;
  };

  // 玩家重整後重連：直接帶回先前選好的 PC，跳過重選
  UI.resumeAsPlayer = function (code, cid, name, pcIds) {
    playerName = name || "玩家";
    myPcIds = pcIds || [];
    hasChosenPc = myPcIds.length > 0;
    startAsPlayer(code, cid, myPcIds);
  };
  UI.setMyPcIds = function (ids) { myPcIds = ids || []; };
  UI.getBattleEntities = function () { return battleState ? battleState.entities : null; };

  function leave() {
    if (unsubState) { unsubState(); unsubState = null; }
    if (unsubInputs) { unsubInputs(); unsubInputs = null; }
    if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
    battleState = null; genIterator = null; pendingReq = null; mode = "solo";
    hasChosenPc = false; myPcIds = [];
    clearSession();
    updateConn("單機");
  }
  UI.leave = leave;

  // ============================================================
  // KP 廣播
  // ============================================================
  function publish() {
    if (mode !== "kp" || !global.Sync) return;
    global.Sync.publishState(roomCode, {
      stepId: stepId,
      battleState: battleState,
      pendingReq: pendingReq,
      phaseLabel: $("#phaseIndicator").textContent
    });
  }

  // ============================================================
  // 回合推進（kp / solo）
  // ============================================================
  function beginNextTurn() {
    const alivePc = battleState.entities.filter(function (e) { return e.isPC && e.hp > 0; }).length;
    const aliveNpc = battleState.entities.filter(function (e) { return !e.isPC && e.hp > 0; }).length;
    if (alivePc === 0 || aliveNpc === 0) {
      pendingReq = null;
      $("#phaseIndicator").textContent = "戰鬥結束";
      $("#phaseAction").innerHTML = "<h4>戰鬥結束</h4><p>" + (alivePc === 0 ? "NPC 方獲勝" : "PC 方獲勝") + "</p>";
      publish();
      return;
    }
    genIterator = Engine.runTurn(battleState, log);
    $("#turnRoundIndicator").textContent = "戰鬥輪 1 / 回合 " + battleState.turnNumber;
    advance();
  }

  function advance(inputValue) {
    if (advancing) return;
    advancing = true;
    let res;
    try {
      res = genIterator.next(inputValue);
    } catch (err) {
      log("引擎錯誤：" + err.message, "dmg");
      console.error(err);
      advancing = false;
      return;
    }
    renderEntities();
    if (res.done) {
      pendingReq = null;
      $("#phaseIndicator").textContent = "回合結束，準備下一回合";
      $("#phaseAction").innerHTML = "";
      const btn = el("button", { cls: "primary", text: "開始下一回合" });
      btn.onclick = beginNextTurn;
      $("#phaseAction").appendChild(btn);
      $("#turnRoundIndicator").textContent = "戰鬥輪 1 / 回合 " + battleState.turnNumber;
      publish();
      saveKpState(); // 回合邊界快照：供 KP 重整後從此處安全繼續
      advancing = false;
      return;
    }
    pendingReq = res.value;
    stepId++;
    renderRequest(pendingReq);
    publish();
    advancing = false;
    // 玩家可能已先於此 step 提交過輸入（罕見）；主動掃一次
    if (mode === "kp") pollExistingInput();
  }

  // KP/solo 本機送出
  function submit(value) { advance(value); }

  // ============================================================
  // 玩家遠端輸入（kp 端消化）
  // ============================================================
  let latestInputs = {};
  function onRemoteInput(inputsMap) {
    latestInputs = inputsMap || {};
    if (mode !== "kp") return;
    pollExistingInput();
  }
  function pollExistingInput() {
    if (mode !== "kp" || !pendingReq || advancing) return;
    if (!isPlayerFillable(pendingReq)) return;
    const ownerId = requestOwnerEntityId(pendingReq);
    const keys = Object.keys(latestInputs);
    for (let i = 0; i < keys.length; i++) {
      const cid = keys[i];
      const inp = latestInputs[cid];
      if (!inp || inp.stepId !== stepId) continue;
      // 提交者必須實際控制本 request 的 owner 實體（依名冊）
      const p = kpPlayersMap[cid];
      const controls = p && p.pcIds && p.pcIds.indexOf(ownerId) !== -1;
      if (!controls) continue;
      global.Sync.clearInput(roomCode, cid);
      log("（採用 " + (p.displayName || cid) + " 對「" + (findEntity(ownerId) ? findEntity(ownerId).name : ownerId) + "」提交的輸入）", "info");
      advance(inp.value);
      return;
    }
  }

  function requestOwnerEntityId(req) {
    if (!req) return null;
    if (req.entityId) return req.entityId;         // npcSlots/d6pair/chooseSkill/declareTarget
    if (req.attackerId) return req.attackerId;     // damageDie/concentrationD20
    return null;
  }
  function isPlayerFillable(req) {
    if (!req) return false;
    if (req.type === "confirmPairing") return false;  // 永遠 KP 裁定
    if (req.type === "passiveResolve") return false;  // 被動隨機結算 KP 裁定
    if (req.type === "npcSlots") return false;        // NPC 槽位 KP 手填
    const ownerId = requestOwnerEntityId(req);
    if (!ownerId) return false;
    const ent = findEntity(ownerId);
    return !!(ent && ent.isPC);
  }
  UI.isPlayerFillable = isPlayerFillable;
  UI.requestOwnerEntityId = requestOwnerEntityId;

  // ============================================================
  // 玩家端：訂閱 state 做鏡像
  // ============================================================
  function onStateMirror(payload) {
    if (!payload) { $("#phaseIndicator").textContent = "等待 KP 開始戰鬥…"; return; }
    battleState = payload.battleState;
    pendingReq = payload.pendingReq || null;
    stepId = payload.stepId || 0;
    renderEntities();
    rebuildLog(battleState.log);
    $("#phaseIndicator").textContent = payload.phaseLabel || "";
    $("#turnRoundIndicator").textContent = "戰鬥輪 1 / 回合 " + (battleState.turnNumber || "-");
    if (mode === "player" && !hasChosenPc) { renderPcPicker(); return; }
    maybeRenderPlayerInput();
  }

  // 玩家選擇要控制哪些 PC（可複選）
  function renderPcPicker() {
    const box = $("#phaseAction");
    box.innerHTML = "";
    box.appendChild(el("h4", { text: "選擇你要控制的角色（可複選）" }));
    const pcs = battleState.entities.filter(function (e) { return e.isPC; });
    const chosen = {};
    pcs.forEach(function (e) {
      const label = el("label", { cls: "row" });
      const cb = el("input"); cb.type = "checkbox"; cb.value = e.id;
      cb.onchange = function () { chosen[e.id] = cb.checked; };
      label.appendChild(cb);
      label.appendChild(el("span", { text: " " + e.name + (e.controllerLabel ? "（目前：" + e.controllerLabel + "）" : "") }));
      box.appendChild(label);
    });
    const btn = el("button", { cls: "primary", text: "確認角色" });
    btn.onclick = function () {
      myPcIds = Object.keys(chosen).filter(function (k) { return chosen[k]; });
      if (myPcIds.length === 0) { alert("請至少選一個角色。"); return; }
      hasChosenPc = true;
      global.Sync.setPlayer(roomCode, clientId, {
        pcIds: myPcIds, displayName: playerName, lastSeen: Date.now()
      });
      saveSession();
      maybeRenderPlayerInput();
    };
    box.appendChild(btn);
  }

  // 2a 佔位；2c 會填入「若 pendingReq 屬於我的 PC → 顯示輸入表單」
  function maybeRenderPlayerInput() {
    const box = $("#phaseAction");
    if (!pendingReq) { box.innerHTML = "<p class='hint'>（等待 KP 推進…）</p>"; return; }
    const ownerId = requestOwnerEntityId(pendingReq);
    if (isPlayerFillable(pendingReq) && myPcIds.indexOf(ownerId) !== -1) {
      renderRequest(pendingReq); // submit 會走 player 分支寫回 Firebase
    } else {
      box.innerHTML = "<p class='hint'>（此步驟由 KP／其他玩家處理…）</p>";
    }
  }

  // 統一送出：依模式決定去向
  function dispatchSubmit(value) {
    if (mode === "player") {
      global.Sync.submitInput(roomCode, clientId, { stepId: stepId, value: value });
      $("#phaseAction").innerHTML = "<p class='hint'>（已送出，等待 KP 採用…）</p>";
    } else {
      submit(value);
    }
  }

  // ============================================================
  // 表單渲染（依 yield request 類型分派）
  // ============================================================
  const PHASE_LABEL = {
    npcSlots: "階段一：回合開始 — NPC 槽位",
    d6pair: "階段一：回合開始 — 技能抽選（1d6 ×2）",
    chooseSkill: "階段一：回合開始 — 選擇技能",
    declareTarget: "階段二：宣告與配對",
    confirmPairing: "階段二：宣告與配對 — KP 確認最終配對",
    passiveResolve: "被動結算 — KP 裁定隨機效果",
    damageDie: "階段三/四：傷害骰",
    concentrationD20: "階段四：凝神判定（1d20）"
  };

  function findEntity(id) { return battleState.entities.find(function (e) { return e.id === id; }); }

  function renderRequest(req) {
    $("#phaseIndicator").textContent = PHASE_LABEL[req.type] || req.type;
    const box = $("#phaseAction");
    box.innerHTML = "";

    if (req.type === "npcSlots") {
      const e = findEntity(req.entityId);
      box.appendChild(el("h4", { text: e.name + " 本回合槽位數（KP手填）" }));
      const input = el("input"); input.type = "number"; input.min = "0"; input.value = req.currentSlots || 1;
      const btn = el("button", { cls: "primary", text: "送出" });
      btn.onclick = function () { dispatchSubmit(Number(input.value) || 0); };
      box.appendChild(input); box.appendChild(btn);
      return;
    }

    if (req.type === "d6pair") {
      const e = findEntity(req.entityId);
      box.appendChild(el("h4", { text: e.name + " 第 " + (req.slotIndex + 1) + " 槽 — 骰 1d6 兩次" }));
      const i1 = el("input"); i1.type = "number"; i1.min = "1"; i1.max = "6"; i1.placeholder = "第一次";
      const i2 = el("input"); i2.type = "number"; i2.min = "1"; i2.max = "6"; i2.placeholder = "第二次";
      const btn = el("button", { cls: "primary", text: "送出" });
      btn.onclick = function () {
        const d1 = Number(i1.value), d2 = Number(i2.value);
        if (!(d1 >= 1 && d1 <= 6) || !(d2 >= 1 && d2 <= 6)) { alert("1d6 必須是 1~6"); return; }
        dispatchSubmit({ die1: d1, die2: d2 });
      };
      box.appendChild(i1); box.appendChild(i2); box.appendChild(btn);
      return;
    }

    if (req.type === "chooseSkill") {
      const e = findEntity(req.entityId);
      box.appendChild(el("h4", { text: e.name + " 第 " + (req.slotIndex + 1) + " 槽 — 從菜單選一個" }));
      req.options.forEach(function (o) {
        const btn = el("button", { text: o.name });
        btn.onclick = function () { dispatchSubmit(o.skillId); };
        box.appendChild(btn);
      });
      return;
    }

    if (req.type === "declareTarget") {
      const e = findEntity(req.entityId);
      box.appendChild(el("h4", { text: e.name + "《" + req.skillName + "》（" + (req.skillType === "attack" ? "攻擊型" : "防禦型") + "）— 宣告" }));

      const actionSel = el("select");
      ["attack", "defend", "intercept"].forEach(function (a) {
        const o = el("option", { text: a === "attack" ? "攻擊" : a === "defend" ? "防禦／應對特定對象" : "攔截（搶過隊友的被攻擊目標）" });
        o.value = a; actionSel.appendChild(o);
      });
      if (req.skillType === "defense") actionSel.value = "defend"; else actionSel.value = "attack";

      const targetSel = el("select");
      battleState.entities.filter(function (x) { return x.hp > 0; }).forEach(function (x) {
        const o = el("option", { text: x.name + (x.isPC ? "（PC）" : "（NPC）") });
        o.value = x.id; targetSel.appendChild(o);
      });

      const protectWrap = el("div", { cls: "row" });
      protectWrap.appendChild(el("span", { text: "保護對象：" }));
      const protectSel = el("select");
      battleState.entities.filter(function (x) { return x.hp > 0; }).forEach(function (x) {
        const o = el("option", { text: x.name }); o.value = x.id; protectSel.appendChild(o);
      });
      protectWrap.appendChild(protectSel);
      protectWrap.style.display = "none";

      actionSel.onchange = function () {
        protectWrap.style.display = actionSel.value === "intercept" ? "flex" : "none";
      };

      const row1 = el("div", { cls: "row" });
      row1.appendChild(el("span", { text: "動作：" })); row1.appendChild(actionSel);
      row1.appendChild(el("span", { text: req.skillType === "attack" ? "目標：" : "預期對象（攻擊者，可任意）：" })); row1.appendChild(targetSel);
      box.appendChild(row1);
      box.appendChild(protectWrap);

      const btn = el("button", { cls: "primary", text: "送出宣告" });
      btn.onclick = function () {
        dispatchSubmit({ action: actionSel.value, targetId: targetSel.value, protectId: protectSel.value });
      };
      box.appendChild(btn);
      return;
    }

    if (req.type === "confirmPairing") {
      box.appendChild(el("h4", { text: "KP 確認最終配對（可移除不合理的配對）" }));
      const clashes = req.proposed.clashes.slice();
      const unilaterals = req.proposed.unilaterals.slice();

      const clashList = el("div");
      clashList.appendChild(el("div", { text: "拚點配對：", cls: "hint" }));
      clashes.forEach(function (c, idx) {
        const a = findEntity(c.aEntityId), b = findEntity(c.bEntityId);
        const row = el("div", { cls: "pair-block" });
        row.appendChild(el("span", {
          text: a.name + "《" + Engine.findSkill(a, c.aSkillId).name + "》 vs " +
            b.name + "《" + Engine.findSkill(b, c.bSkillId).name + "》"
        }));
        const rm = el("button", { text: "移除此配對" });
        rm.onclick = function () { clashes.splice(idx, 1); rm.parentElement.remove(); };
        row.appendChild(rm);
        clashList.appendChild(row);
      });
      box.appendChild(clashList);

      const uniList = el("div");
      uniList.appendChild(el("div", { text: "單方面攻擊：", cls: "hint" }));
      unilaterals.forEach(function (u, idx) {
        const atk = findEntity(u.attackerId), tgt = findEntity(u.targetId);
        const row = el("div", { cls: "pair-block" });
        row.appendChild(el("span", { text: atk.name + "《" + Engine.findSkill(atk, u.skillId).name + "》 → " + tgt.name }));
        const rm = el("button", { text: "取消此攻擊" });
        rm.onclick = function () { unilaterals.splice(idx, 1); row.remove(); };
        row.appendChild(rm);
        uniList.appendChild(row);
      });
      box.appendChild(uniList);

      const btn = el("button", { cls: "primary", text: "確認配對，進入拚點" });
      btn.onclick = function () { dispatchSubmit({ clashes: clashes, unilaterals: unilaterals }); };
      box.appendChild(btn);
      return;
    }

    if (req.type === "passiveResolve") {
      const e = findEntity(req.entityId);
      box.appendChild(el("h4", { text: (e ? e.name : req.entityId) + " 被動〈" + req.passiveName + "〉— 隨機結算（工具已自動選，可覆寫）" }));
      const fireWrap = el("label", { cls: "row" });
      const fireCb = el("input"); fireCb.type = "checkbox"; fireCb.checked = !!req.autoFire;
      fireWrap.appendChild(fireCb); fireWrap.appendChild(el("span", { text: " 觸發此被動" }));
      box.appendChild(fireWrap);

      let targetSel = null;
      const choices = req.targetChoices || [];
      if (!req.allowMulti && choices.length > 0) {
        const row = el("div", { cls: "row" });
        row.appendChild(el("span", { text: "目標：" }));
        targetSel = el("select");
        choices.forEach(function (c) { const o = el("option", { text: c.name }); o.value = c.id; targetSel.appendChild(o); });
        if (req.autoTargetId) targetSel.value = req.autoTargetId;
        row.appendChild(targetSel);
        box.appendChild(row);
      } else if (req.allowMulti) {
        box.appendChild(el("div", { cls: "hint", text: "目標：全體敵方（" + choices.map(function (c) { return c.name; }).join("、") + "）" }));
      }

      const btn = el("button", { cls: "primary", text: "確認" });
      btn.onclick = function () {
        let targetIds;
        if (req.allowMulti) targetIds = choices.map(function (c) { return c.id; });
        else targetIds = targetSel ? [targetSel.value] : [];
        dispatchSubmit({ fire: fireCb.checked, targetIds: targetIds });
      };
      box.appendChild(btn);
      return;
    }

    if (req.type === "damageDie") {
      box.appendChild(el("h4", { text: "《" + req.skillLabel + "》傷害骰（整把技能共用，手動輸入）" }));
      const input = el("input"); input.type = "number"; input.min = "0"; input.value = "1";
      const btn = el("button", { cls: "primary", text: "送出" });
      btn.onclick = function () { dispatchSubmit(Number(input.value) || 0); };
      box.appendChild(input); box.appendChild(btn);
      return;
    }

    if (req.type === "concentrationD20") {
      box.appendChild(el("h4", { text: "凝神判定：1d20" }));
      const input = el("input"); input.type = "number"; input.min = "1"; input.max = "20"; input.value = "20";
      const btn = el("button", { cls: "primary", text: "送出" });
      btn.onclick = function () {
        const v = Number(input.value);
        if (!(v >= 1 && v <= 20)) { alert("1d20 必須是 1~20"); return; }
        dispatchSubmit(v);
      };
      box.appendChild(input); box.appendChild(btn);
      return;
    }

    box.appendChild(el("p", { text: "未知請求類型：" + req.type }));
  }

  // ============================================================
  // 實體面板渲染
  // ============================================================
  function renderEntities() {
    const box = $("#entityPanels");
    box.innerHTML = "";
    const readOnly = (mode === "player");
    battleState.entities.forEach(function (e) {
      box.appendChild(renderEntityCard(e, readOnly));
    });
  }

  function renderEntityCard(e, readOnly) {
    const card = el("div", { cls: "entity-card " + (e.isPC ? "pc" : "npc") + (e.hp <= 0 ? " dead" : "") + (e.canAct === false ? " cant-act" : "") });

    const head = el("div");
    head.appendChild(el("span", { cls: "name", text: e.name }));
    head.appendChild(el("span", { cls: "tag", text: e.isPC ? "PC" : "NPC" }));
    if (e.controllerLabel) head.appendChild(el("span", { cls: "tag", text: e.controllerLabel }));
    if (e.hp <= 0) head.appendChild(el("span", { cls: "tag", text: "倒下" }));
    if (e.confusionLockTurns > 0) head.appendChild(el("span", { cls: "tag", text: "混亂中(" + e.confusionLockTurns + ")" }));
    if (e.panicNextTurn) head.appendChild(el("span", { cls: "tag", text: "下回合恐慌" }));
    card.appendChild(head);

    const hpPct = Math.max(0, Math.min(100, (e.hp / e.maxHp) * 100));
    const tempPct = Math.max(0, Math.min(100, (e.tempHp / e.maxHp) * 100));
    const hpBar = el("div", { cls: "bar-wrap" });
    const hpFill = el("div", { cls: "bar-fill" + (hpPct < 30 ? " hp-low" : "") });
    hpFill.style.width = hpPct + "%";
    hpBar.appendChild(hpFill);
    if (e.tempHp > 0) {
      const tempFill = el("div", { cls: "bar-fill temp" }); tempFill.style.width = tempPct + "%";
      hpBar.appendChild(tempFill);
    }
    hpBar.appendChild(el("div", { cls: "bar-label", text: "HP " + e.hp + "/" + e.maxHp + (e.tempHp > 0 ? "（臨時+" + e.tempHp + "）" : "") }));
    card.appendChild(hpBar);

    const stats = el("div");
    stats.appendChild(statLine("專注力", e.focus));
    stats.appendChild(statLine("DEX（有效）", e.dex + " (" + (e.effectiveDex !== undefined ? Number(e.effectiveDex).toFixed(1) : e.dex) + ")"));
    stats.appendChild(statLine("槽位", e.slots));
    card.appendChild(stats);

    const states = el("div", { cls: "states-list" });
    Object.keys(e.states).forEach(function (name) {
      const st = e.states[name];
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) return;
      const chip = el("span", {
        cls: "state-chip" + (st.isMark ? " mark" : ""),
        text: name + " 層" + (st.layer || 0) + (global.Data.isLevelDriven(name) ? "/級" + (st.level || 0) : "")
      });
      states.appendChild(chip);
    });
    card.appendChild(states);

    if (readOnly) return card; // 玩家端：唯讀，不顯示 KP 手動調整面板

    // KP 手動調整面板
    const editor = el("div", { cls: "row" });
    const hpInput = el("input"); hpInput.type = "number"; hpInput.placeholder = "設定HP"; hpInput.style.width = "70px";
    const hpBtn = el("button", { text: "設HP" });
    hpBtn.onclick = function () { e.hp = Math.max(0, Math.min(e.maxHp, Number(hpInput.value) || 0)); renderEntities(); publish(); };
    const focusInput = el("input"); focusInput.type = "number"; focusInput.placeholder = "設定專注力"; focusInput.style.width = "70px";
    const focusBtn = el("button", { text: "設專注" });
    focusBtn.onclick = function () { e.focus = Math.max(-40, Math.min(40, Number(focusInput.value) || 0)); renderEntities(); publish(); };
    editor.appendChild(hpInput); editor.appendChild(hpBtn);
    editor.appendChild(focusInput); editor.appendChild(focusBtn);
    card.appendChild(editor);

    const stateEditor = el("div", { cls: "row" });
    const nameInput = el("input"); nameInput.type = "text"; nameInput.placeholder = "狀態名"; nameInput.style.width = "70px";
    const layerInput = el("input"); layerInput.type = "number"; layerInput.placeholder = "Δ層"; layerInput.style.width = "55px";
    const levelInput = el("input"); levelInput.type = "number"; levelInput.placeholder = "Δ級"; levelInput.style.width = "55px";
    const applyBtn = el("button", { text: "套用狀態" });
    applyBtn.onclick = function () {
      const name = nameInput.value.trim();
      if (!name) return;
      Engine.applyState(e, name, Number(layerInput.value) || 0, Number(levelInput.value) || 0);
      nameInput.value = ""; layerInput.value = ""; levelInput.value = "";
      renderEntities(); publish();
    };
    stateEditor.appendChild(nameInput); stateEditor.appendChild(layerInput); stateEditor.appendChild(levelInput); stateEditor.appendChild(applyBtn);
    card.appendChild(stateEditor);

    return card;
  }

  function statLine(label, value) {
    const line = el("div", { cls: "stat-line" });
    line.appendChild(el("span", { text: label }));
    line.appendChild(el("span", { cls: "v", text: String(value) }));
    return line;
  }

  UI._internal = { renderEntities: renderEntities };
})(window);

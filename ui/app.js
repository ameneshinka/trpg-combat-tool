// ============================================================
// UI：啟動與連線模式
// 架構（trpg-combat-webapp skill）：GitHub Pages 靜態前端 ＋ Firebase 即時同步、
// KP 端權威（玩家只送宣告／骰值，KP 裁定後才寫入正式狀態）。
// ⚠ 不使用 localStorage／sessionStorage：KP 重整改由 Firebase /state 還原。
// ============================================================
(function (global) {
  "use strict";
  const $ = function (s) { return document.querySelector(s); };
  const el = function (t, o) { return global.Panels.el(t, o); };

  let mode = "solo";
  let roomCode = null;
  let clientId = null;
  let unsubState = null, unsubInputs = null, unsubPlayers = null;
  let latestInputs = {}, playersMap = {};
  let battle = null;

  // ---------------- 名單建構 ----------------
  function buildBattle() {
    const entities = global.Characters.roster();
    return {
      roundNumber: 0,
      turnNumber: 1,
      pcGrowthOrder: global.Characters.pcGrowthOrder(),
      entities: entities,
      turnOrder: []
    };
  }

  function showScreen(which) {
    $("#setupScreen").classList.toggle("hidden", which !== "setup");
    $("#battleScreen").classList.toggle("hidden", which !== "battle");
  }

  function setConn(text) { $("#connState").textContent = text; }

  // ---------------- 單機 ----------------
  function startSolo() {
    mode = "solo";
    setConn("單機");
    battle = buildBattle();
    showScreen("battle");
    global.Battle.init({ battle: battle, mode: "solo" });
  }

  // ---------------- KP 建房 ----------------
  function startAsKp() {
    if (!global.Sync.available()) { alert("Firebase 未設定（js/firebase-config.js 的 databaseURL 為空）"); return; }
    if (!roomCode) { alert("請先產生房號"); return; }
    mode = "kp";
    clientId = global.Sync.clientId();
    setConn("KP・房號 " + roomCode);
    battle = buildBattle();
    showScreen("battle");

    global.Sync.createRoom(roomCode, { createdAt: Date.now(), kpClientId: clientId, mode: "prototype" })
      .catch(function (e) {
        alert("建立房間失敗：" + (e && e.message ? e.message : e) +
          "\n（若為 Permission denied，請確認 database.rules.json 已發布）");
      });

    if (unsubInputs) unsubInputs();
    unsubInputs = global.Sync.subscribeInputs(roomCode, function (map) {
      latestInputs = map || {};
      consumePlayerInput();
    });
    if (unsubPlayers) unsubPlayers();
    unsubPlayers = global.Sync.subscribePlayers(roomCode, function (map) {
      playersMap = map || {};
      renderPlayerRoster();
    });

    global.Battle.init({
      battle: battle, mode: "kp",
      onPublish: function (state) {
        global.Sync.publishState(roomCode, {
          stepId: ++stepId,
          turnNumber: state.turnNumber,
          battleState: state.battle,
          pendingReq: state.pending,
          events: state.events.slice(-400),   // 只帶最近事件，避免超過同步負載
          phaseLabel: $("#phaseTitle").textContent
        });
      }
    });
  }
  let stepId = 0;

  // KP 端消化玩家送來的輸入（權威模型：玩家只送請求，KP 決定要不要採用）
  function consumePlayerInput() {
    const st = global.Battle.getState();
    const req = st.pending;
    if (!req || !global.Battle.isPlayerFillable(req)) return;
    const ownerId = global.Battle.ownerOf(req);
    const keys = Object.keys(latestInputs);
    for (let i = 0; i < keys.length; i++) {
      const cid = keys[i];
      const inp = latestInputs[cid];
      if (!inp || inp.stepId !== stepId) continue;
      const p = playersMap[cid];
      const controls = p && p.pcIds && p.pcIds.indexOf(ownerId) !== -1;
      if (!controls) continue;
      global.Sync.clearInput(roomCode, cid);
      global.Battle.submitRemote(inp.value);
      return;
    }
  }

  function renderPlayerRoster() {
    const box = $("#playerRoster");
    if (!box) return;
    box.innerHTML = "";
    const cids = Object.keys(playersMap);
    if (!cids.length) { box.appendChild(el("span", { cls: "hint", text: "尚無玩家加入" })); return; }
    cids.forEach(function (cid) {
      const p = playersMap[cid];
      const names = (p.pcIds || []).map(function (id) {
        const e = battle && battle.entities.find(function (x) { return x.id === id; });
        return e ? e.name : id;
      });
      box.appendChild(el("span", { cls: "res-chip", text: (p.displayName || cid) + "：" + (names.join("、") || "未選角") }));
    });
  }

  // ---------------- 玩家加入 ----------------
  function joinAsPlayer() {
    if (!global.Sync.available()) { alert("Firebase 未設定"); return; }
    const code = ($("#joinCode").value || "").trim().toUpperCase();
    if (!code) { $("#joinStatus").textContent = "請輸入房號"; return; }
    const name = ($("#joinName").value || "玩家").trim();
    roomCode = code;
    clientId = global.Sync.clientId();
    $("#joinStatus").textContent = "連線中…";

    global.Sync.getRoomMeta(code).then(function (meta) {
      if (!meta) { $("#joinStatus").textContent = "找不到房間 " + code; return; }
      mode = "player";
      setConn("玩家・房號 " + code);
      showScreen("battle");
      global.Battle.setMode("player");
      global.Battle.myPcIds = [];
      if (unsubState) unsubState();
      unsubState = global.Sync.subscribeState(code, function (payload) {
        if (!payload) { $("#phaseTitle").textContent = "等待 KP 開始戰鬥…"; return; }
        stepId = payload.stepId || 0;
        battle = payload.battleState;
        const state = { battle: payload.battleState, pending: payload.pendingReq, events: payload.events || [] };
        // 玩家端：先選角，再進鏡像
        if (!global.Battle.myPcIds.length && !playerPicked) { renderPcPicker(state); return; }
        global.Battle.renderMirror(state);
        $("#phaseTitle").textContent = payload.phaseLabel || "";
      });
      // 玩家端的送出改寫成寫入 Firebase /inputs
      patchPlayerSubmit();
    }).catch(function (e) {
      $("#joinStatus").textContent = "連線失敗：" + (e && e.message ? e.message : e);
    });
  }

  let playerPicked = false;
  function renderPcPicker(state) {
    const box = $("#actionArea");
    box.innerHTML = "";
    global.Panels.renderPanels($("#panels"), state.battle, { kpControls: false, showActions: true });
    box.appendChild(el("h4", { text: "選擇你要操作的角色（可複選）" }));
    const chosen = {};
    state.battle.entities.filter(function (e) { return e.isPC; }).forEach(function (e) {
      const lab = el("label", { cls: "row" });
      const cb = el("input"); cb.type = "checkbox"; cb.value = e.id;
      cb.onchange = function () { chosen[e.id] = cb.checked; };
      lab.appendChild(cb);
      lab.appendChild(el("span", { text: " " + e.name }));
      box.appendChild(lab);
    });
    const b = el("button", { cls: "primary", text: "確認" });
    b.type = "button";
    b.onclick = function () {
      const ids = Object.keys(chosen).filter(function (k) { return chosen[k]; });
      if (!ids.length) { alert("請至少選一個角色"); return; }
      global.Battle.myPcIds = ids;
      playerPicked = true;
      global.Sync.setPlayer(roomCode, clientId, {
        pcIds: ids, displayName: ($("#joinName").value || "玩家").trim(), lastSeen: Date.now()
      });
      global.Battle.renderMirror(state);
    };
    box.appendChild(b);
  }

  // 玩家端：把表單的送出導向 Firebase /inputs（KP 端才真正推進引擎 —— KP 端權威）
  function patchPlayerSubmit() {
    global.Battle.setSubmitSink(function (value) {
      global.Sync.submitInput(roomCode, clientId, { stepId: stepId, value: value });
      const box = $("#actionArea");
      box.innerHTML = "";
      box.appendChild(el("p", { cls: "hint", text: "（已送出，等待 KP 採用…）" }));
    });
  }

  // ---------------- 設定畫面 ----------------
  function applyMode(m) {
    $("#kpRow").classList.toggle("hidden", m !== "kp");
    $("#joinRow").classList.toggle("hidden", m !== "player");
    $("#soloRow").classList.toggle("hidden", m === "player");
    $("#startBtn").classList.toggle("hidden", m === "player");
    $("#startBtn").textContent = m === "kp" ? "建立房間並開始戰鬥" : "開始戰鬥（單機）";
  }

  function genRoom() {
    if (!global.Sync.available()) { alert("Firebase 未設定"); return; }
    global.Sync.init();
    roomCode = global.Sync.genRoomCode();
    $("#roomCode").textContent = roomCode;
  }

  document.addEventListener("DOMContentLoaded", function () {
    // 名單摘要
    const list = $("#rosterPreview");
    global.Characters.roster().forEach(function (e) {
      list.appendChild(el("div", {
        cls: "roster-line",
        text: (e.isPC ? "【PC】" : "【NPC】") + e.name + "　HP " + e.maxHp + "　DEX " + e.dex +
          "　技能 " + e.skillLibrary.length + " 個"
      }));
    });
    const pcs = global.Characters.PC_TEMPLATES.filter(function (t) { return !t.skillLibrary || !t.skillLibrary.length; });
    if (pcs.length) {
      $("#pcPending").textContent = "尚未填寫技能組的 PC：" + pcs.map(function (t) { return t.name; }).join("、") +
        "（在 data/characters.js 的 PC_TEMPLATES 補上後即可加入名單）";
    }

    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.addEventListener("change", function () { applyMode(this.value); });
    });
    $("#genRoomBtn").addEventListener("click", genRoom);
    $("#joinBtn").addEventListener("click", joinAsPlayer);
    $("#startBtn").addEventListener("click", function () {
      const m = (document.querySelector('input[name="mode"]:checked') || {}).value || "solo";
      if (m === "kp") startAsKp(); else startSolo();
    });
    $("#backBtn").addEventListener("click", function () {
      if (unsubState) { unsubState(); unsubState = null; }
      if (unsubInputs) { unsubInputs(); unsubInputs = null; }
      if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
      playerPicked = false;
      setConn("單機");
      showScreen("setup");
    });

    if (!global.Sync || !global.Sync.available()) {
      $("#syncWarn").classList.remove("hidden");
      document.querySelectorAll('input[name="mode"]').forEach(function (r) {
        if (r.value !== "solo") r.disabled = true;
      });
    }
    applyMode("solo");
  });

})(window);

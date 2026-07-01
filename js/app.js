// ============================================================
// 啟動程式：設定畫面 + 三種連線模式（solo / kp / player）
// ============================================================
(function () {
  "use strict";
  const $ = function (sel) { return document.querySelector(sel); };

  let currentMode = "solo";
  let kpRoomCode = null;

  // ---------------- 名單 JSON ----------------
  function loadSample() {
    $("#rosterJson").value = JSON.stringify(window.Data.SAMPLE_ROSTER.entities, null, 2);
    $("#pcGrowthOrder").value = window.Data.SAMPLE_ROSTER.pcGrowthOrder.join(",");
    $("#rosterError").textContent = "";
  }

  function validate() {
    const raw = $("#rosterJson").value;
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error("最外層必須是陣列（entities 清單）");
      data.forEach(function (e, i) {
        if (!e.id) throw new Error("第 " + (i + 1) + " 個實體缺少 id");
        if (!Array.isArray(e.skillLibrary) || e.skillLibrary.length === 0) throw new Error(e.id + " 缺少 skillLibrary");
      });
      $("#rosterError").style.color = "#4caf7d";
      $("#rosterError").textContent = "JSON 驗證通過，共 " + data.length + " 個實體。";
      return data;
    } catch (err) {
      $("#rosterError").style.color = "";
      let msg = err.message;
      const m = /position (\d+)/.exec(msg);
      if (m) {
        const pos = Number(m[1]);
        const upto = raw.slice(0, pos);
        const line = upto.split("\n").length;
        const col = pos - upto.lastIndexOf("\n");
        msg += "（約第 " + line + " 行、第 " + col + " 欄）";
      }
      $("#rosterError").textContent = "JSON 錯誤：" + msg;
      return null;
    }
  }

  // ---------------- 建資料輔助（輕量） ----------------
  const NPC_TEMPLATE = {
    id: "npc_new", name: "新角色", isPC: false, hp: 40, dex: 10,
    attributes: { STR: 10, INT: 10, CON: 10, SIZ: 10, LUK: 10 },
    skillLibrary: [
      { id: "skill_1", name: "技能一", type: "attack", basePower: 8, coinPower: 3, coins: ["normal", "normal"] }
    ],
    slotMap: { A: "skill_1", B: "skill_1", C: "skill_1" }
  };
  const SKILL_SNIPPET =
    '{ "id": "skill_x", "name": "技能名", "type": "attack", "basePower": 8, "coinPower": 3, "coins": ["normal"], "hitEffects": [] }';
  const PASSIVE_SNIPPET =
    '{ "id": "passive_x", "name": "被動名", "trigger": "turnStart", "target": "self", "effects": [ { "type": "focus", "who": "self", "amount": 3 } ] }';

  function insertAtCursor(text) {
    const ta = $("#rosterJson");
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
  }

  function addNpcTemplate() {
    try {
      const arr = JSON.parse($("#rosterJson").value);
      if (!Array.isArray(arr)) throw new Error("not array");
      arr.push(JSON.parse(JSON.stringify(NPC_TEMPLATE)));
      $("#rosterJson").value = JSON.stringify(arr, null, 2);
      $("#rosterError").style.color = "#4caf7d";
      $("#rosterError").textContent = "已加入一個 NPC 範本（記得改 id 與內容）。";
    } catch (e) {
      $("#rosterError").style.color = "";
      $("#rosterError").textContent = "目前 JSON 無法解析，無法自動加入；請先修正，或手動貼上範本。";
    }
  }

  function loadGuide() {
    fetch("examples/npc-guide.json")
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (t) {
        $("#rosterJson").value = t;
        $("#rosterError").style.color = "#4caf7d";
        $("#rosterError").textContent = "已載入進階範例（印記／形態轉換／喚出／被動／殘響）。";
      })
      .catch(function () {
        $("#rosterError").style.color = "";
        $("#rosterError").textContent = "載入範例失敗（請確認以伺服器開啟，非 file://）。";
      });
  }

  function getRoster() {
    const data = validate();
    if (!data) return null;
    const order = $("#pcGrowthOrder").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return { data: data, order: order };
  }

  // ---------------- 模式切換 ----------------
  function applyMode(m) {
    currentMode = m;
    const setup = $("#battleSetupBlock");
    const kpRow = $("#kpRoomRow");
    const joinRow = $("#playerJoinRow");
    setup.classList.toggle("hidden", m === "player");
    kpRow.classList.toggle("hidden", m !== "kp");
    joinRow.classList.toggle("hidden", m !== "player");
    $("#btnStartBattle").textContent = m === "kp" ? "建立房間並開始戰鬥" : "開始戰鬥";
  }

  // ---------------- 開始戰鬥（solo / kp） ----------------
  function startBattle() {
    const roster = getRoster();
    if (!roster) return;

    if (currentMode === "solo") {
      window.UI.startBattleSolo({ entities: roster.data }, roster.order);
      return;
    }

    if (currentMode === "kp") {
      if (!window.Sync.available()) { alert("Firebase 未設定，無法建立房間。"); return; }
      if (!kpRoomCode) { alert("請先產生房號。"); return; }
      const cid = window.Sync.clientId();
      window.Sync.createRoom(kpRoomCode, {
        createdAt: Date.now(), kpClientId: cid, mode: "prototype"
      }).then(function () {
        window.UI.startBattleAsKP({ entities: roster.data }, roster.order, kpRoomCode, cid);
      });
    }
  }

  // ---------------- 加入房間（player） ----------------
  function joinRoom() {
    if (!window.Sync.available()) { alert("Firebase 未設定，無法加入房間。"); return; }
    const code = ($("#joinRoomCode").value || "").trim().toUpperCase();
    if (!code) { $("#joinStatus").textContent = "請輸入房號。"; return; }
    const name = ($("#playerName").value || "玩家").trim();
    const cid = window.Sync.clientId();
    $("#joinStatus").textContent = "連線中…";
    window.Sync.getRoomMeta(code).then(function (meta) {
      if (!meta) { $("#joinStatus").textContent = "找不到房間 " + code + "。"; return; }
      $("#joinStatus").textContent = "已連上房間 " + code + "。";
      window.UI.startAsPlayer(code, cid, []);
      // 2b：加入後選擇要控制的 PC，會在戰鬥畫面上呈現選單
      if (window.UI.beginPlayerJoin) window.UI.beginPlayerJoin(code, cid, name);
    });
  }

  // ---------------- 產生房號 ----------------
  function genRoom() {
    if (!window.Sync.available()) { alert("Firebase 未設定，無法建立房間。"); return; }
    window.Sync.init();
    kpRoomCode = window.Sync.genRoomCode();
    $("#kpRoomCode").textContent = kpRoomCode;
  }

  function backToSetup() {
    if (window.UI.leave) window.UI.leave();
    $("#battleScreen").classList.add("hidden");
    $("#setupScreen").classList.remove("hidden");
  }

  // ---------------- 重整後重連 ----------------
  function offerReconnect() {
    const sess = window.UI.getSavedSession && window.UI.getSavedSession();
    if (!sess || !window.Sync || !window.Sync.available()) return;
    const banner = $("#reconnectBanner");
    $("#reconnectText").textContent =
      "偵測到先前的連線（" + (sess.role === "kp" ? "KP" : "玩家") + "・房號 " + sess.roomCode + "）。是否重連？";
    banner.classList.remove("hidden");
    $("#btnReconnect").onclick = function () {
      if (sess.role === "kp") {
        const saved = window.UI.getSavedKpState(sess.roomCode);
        if (!saved) { alert("找不到 KP 的戰鬥存檔，無法重連（可能是換了瀏覽器）。"); return; }
        window.UI.resumeAsKP(sess.roomCode, sess.clientId, saved);
      } else {
        window.UI.resumeAsPlayer(sess.roomCode, sess.clientId, sess.name, sess.myPcIds || []);
      }
    };
    $("#btnDiscardSession").onclick = function () {
      if (window.UI.leave) window.UI.leave();
      banner.classList.add("hidden");
    };
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("#btnLoadSample").addEventListener("click", loadSample);
    $("#btnLoadGuide").addEventListener("click", loadGuide);
    $("#btnValidateRoster").addEventListener("click", validate);
    $("#btnTplNpc").addEventListener("click", addNpcTemplate);
    $("#btnTplSkill").addEventListener("click", function () { insertAtCursor(SKILL_SNIPPET); });
    $("#btnTplPassive").addEventListener("click", function () { insertAtCursor(PASSIVE_SNIPPET); });
    $("#btnStartBattle").addEventListener("click", startBattle);
    $("#btnBackToSetup").addEventListener("click", backToSetup);
    $("#btnGenRoom").addEventListener("click", genRoom);
    $("#btnJoinRoom").addEventListener("click", joinRoom);

    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.addEventListener("change", function () { applyMode(this.value); });
    });

    // Firebase 不可用 → 停用連線模式
    if (!window.Sync || !window.Sync.available()) {
      $("#syncUnavailable").style.display = "block";
      document.querySelectorAll('input[name="mode"]').forEach(function (r) {
        if (r.value !== "solo") r.disabled = true;
      });
    }

    loadSample();
    applyMode("solo");
    offerReconnect();
  });
})();

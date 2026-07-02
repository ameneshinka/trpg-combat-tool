// ============================================================
// 啟動程式：設定畫面 + 三種連線模式（solo / kp / player）
// 名單資料來源 = 表單編輯器（window.Editor）；JSON 為進階模式
// ============================================================
(function () {
  "use strict";
  const $ = function (sel) { return document.querySelector(sel); };

  let currentMode = "solo";
  let kpRoomCode = null;

  // ---------------- 範例載入 ----------------
  function loadSample() {
    window.Editor.loadRoster(window.Data.SAMPLE_ROSTER.entities, window.Data.SAMPLE_ROSTER.pcGrowthOrder);
  }

  function loadGuide() {
    fetch("examples/npc-guide.json")
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        window.Editor.loadRoster(data);
      })
      .catch(function () {
        alert("載入進階範例失敗（請確認以伺服器開啟，非 file://）。");
      });
  }

  function clearRoster() {
    if (!confirm("清空整份名單？（進階 JSON 與草稿也會被清除）")) return;
    window.Editor.loadRoster([]);
  }

  // ---------------- 模式切換 ----------------
  function applyMode(m) {
    currentMode = m;
    $("#battleSetupBlock").classList.toggle("hidden", m === "player");
    $("#kpRoomRow").classList.toggle("hidden", m !== "kp");
    $("#playerJoinRow").classList.toggle("hidden", m !== "player");
    $("#btnStartBattle").textContent = m === "kp" ? "建立房間並開始戰鬥" : "開始戰鬥";
  }

  // ---------------- 開始戰鬥（solo / kp） ----------------
  function startBattle() {
    const errBox = $("#startBattleError");
    errBox.textContent = "";
    const errs = window.Editor.validateAll();
    if (errs.length) {
      errBox.textContent = "名單有 " + errs.length + " 個問題（見右側驗證清單），請先修正。";
      return;
    }
    const rosterData = window.Editor.getRoster();
    if (!rosterData.length) { errBox.textContent = "名單是空的，請先新增角色或載入範例。"; return; }
    const order = window.Editor.getPcOrder();

    if (currentMode === "solo") {
      window.UI.startBattleSolo({ entities: rosterData }, order);
      return;
    }
    if (currentMode === "kp") {
      if (!window.Sync.available()) { alert("Firebase 未設定，無法建立房間。"); return; }
      if (!kpRoomCode) { alert("請先產生房號。"); return; }
      const cid = window.Sync.clientId();
      window.Sync.createRoom(kpRoomCode, {
        createdAt: Date.now(), kpClientId: cid, mode: "prototype"
      }).then(function () {
        window.UI.startBattleAsKP({ entities: rosterData }, order, kpRoomCode, cid);
      }).catch(function (e) {
        alert("建立房間失敗：" + (e && e.message ? e.message : e) + "\n（若顯示 Permission denied，請確認 Firebase 安全規則已發布，見 README）");
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
      if (window.UI.beginPlayerJoin) window.UI.beginPlayerJoin(code, cid, name);
    }).catch(function (e) {
      $("#joinStatus").textContent = "連線失敗：" + (e && e.message ? e.message : e) + "（請確認 Firebase 規則已發布）";
    });
  }

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
    window.Editor.init();

    $("#btnLoadSample").addEventListener("click", loadSample);
    $("#btnLoadGuide").addEventListener("click", loadGuide);
    $("#btnClearRoster").addEventListener("click", clearRoster);
    $("#btnStartBattle").addEventListener("click", startBattle);
    $("#btnBackToSetup").addEventListener("click", backToSetup);
    $("#btnGenRoom").addEventListener("click", genRoom);
    $("#btnJoinRoom").addEventListener("click", joinRoom);

    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.addEventListener("change", function () { applyMode(this.value); });
    });

    if (!window.Sync || !window.Sync.available()) {
      $("#syncUnavailable").style.display = "block";
      document.querySelectorAll('input[name="mode"]').forEach(function (r) {
        if (r.value !== "solo") r.disabled = true;
      });
    }

    applyMode("solo");
    offerReconnect();
  });
})();

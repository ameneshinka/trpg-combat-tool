// ============================================================
// 同步層：封裝 Firebase Realtime Database（compat SDK，用到才動態載入）
// 設計要點：
//   - 頁面載入時「不」拉取 Firebase SDK（避免離線/無 config 時卡住頁面）。
//   - 只有真的要建/加房間時，才透過 loadSdk() 動態插入 SDK <script>。
//   - Firebase 不可用時所有方法安全降級（回傳 false / 空 unsub），單機完全不受影響。
// 資料結構：
//   /rooms/{code}/meta     房間資訊
//   /rooms/{code}/state    { stepId, battleState, pendingReq, phaseLabel }
//   /rooms/{code}/players  { clientId: { pcIds[], displayName, lastSeen } }
//   /rooms/{code}/inputs   { clientId: { stepId, value } }
// ============================================================
(function (global) {
  "use strict";
  const Sync = global.Sync = {};

  const SDK_VERSION = "10.12.2";
  const SDK_BASE = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";
  const LOAD_TIMEOUT_MS = 10000;

  let db = null;
  let initialized = false;
  let sdkPromise = null;

  // available = 「使用者有填 databaseURL」；不要求 SDK 已載入（供頁面載入時判斷是否啟用連線模式）
  function available() {
    return global.FIREBASE_CONFIG &&
      typeof global.FIREBASE_CONFIG.databaseURL === "string" &&
      global.FIREBASE_CONFIG.databaseURL.trim() !== "";
  }
  Sync.available = available;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      let done = false;
      const timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error("載入逾時：" + src)); }
      }, LOAD_TIMEOUT_MS);
      s.onload = function () { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      s.onerror = function () { if (!done) { done = true; clearTimeout(timer); reject(new Error("載入失敗：" + src)); } };
      document.head.appendChild(s);
    });
  }

  // 依序載入 app-compat 再 database-compat（database 依賴 app）
  function loadSdk() {
    if (typeof firebase !== "undefined" && firebase.database) return Promise.resolve(true);
    if (sdkPromise) return sdkPromise;
    sdkPromise = loadScript(SDK_BASE + "firebase-app-compat.js")
      .then(function () { return loadScript(SDK_BASE + "firebase-database-compat.js"); })
      .then(function () { return true; })
      .catch(function (e) { console.error("Firebase SDK 載入失敗：", e); sdkPromise = null; return false; });
    return sdkPromise;
  }

  // 確保 SDK 已載入且 app 已初始化；回傳 Promise<bool>
  function ensureReady() {
    if (initialized) return Promise.resolve(true);
    if (!available()) return Promise.resolve(false);
    return loadSdk().then(function (ok) {
      if (!ok) return false;
      try {
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
        db = firebase.database();
        initialized = true;
        return true;
      } catch (e) {
        console.error("Firebase 初始化失敗：", e);
        return false;
      }
    });
  }
  Sync.init = ensureReady; // 對外沿用 init 名稱（現為非同步）

  // ⚠ 依 trpg-combat-webapp skill：不使用 localStorage／sessionStorage。
  // clientId 只存在記憶體 → 重整會拿到新 id（玩家需重選角色；KP 的戰鬥狀態
  // 從 Firebase /state 還原，不依賴本機儲存）。
  let _clientId = null;
  function clientId() {
    if (!_clientId) _clientId = "c_" + Math.random().toString(36).slice(2, 10);
    return _clientId;
  }
  Sync.clientId = clientId;

  function genRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 I/O/0/1
    let s = "";
    for (let i = 0; i < 4; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  }
  Sync.genRoomCode = genRoomCode;

  function roomRef(code, sub) { return db.ref("rooms/" + code + (sub ? "/" + sub : "")); }
  function clean(obj) { return JSON.parse(JSON.stringify(obj)); } // RTDB 不接受 undefined

  Sync.createRoom = function (code, meta) {
    return ensureReady().then(function (ok) {
      if (!ok) return false;
      return roomRef(code, "meta").set(clean(meta)).then(function () { return true; });
    });
  };

  Sync.getRoomMeta = function (code) {
    return ensureReady().then(function (ok) {
      if (!ok) return null;
      return roomRef(code, "meta").once("value").then(function (s) { return s.val(); });
    });
  };

  Sync.publishState = function (code, payload) {
    return ensureReady().then(function (ok) {
      if (!ok) return false;
      return roomRef(code, "state").set(clean(payload)).then(function () { return true; });
    });
  };

  Sync.setPlayer = function (code, cid, data) {
    return ensureReady().then(function (ok) {
      if (!ok) return false;
      return roomRef(code, "players/" + cid).set(clean(data)).then(function () { return true; });
    });
  };

  Sync.submitInput = function (code, cid, data) {
    return ensureReady().then(function (ok) {
      if (!ok) return false;
      return roomRef(code, "inputs/" + cid).set(clean(data)).then(function () { return true; });
    });
  };

  Sync.clearInput = function (code, cid) {
    return ensureReady().then(function (ok) {
      if (!ok) return false;
      return roomRef(code, "inputs/" + cid).remove().then(function () { return true; });
    });
  };

  // 訂閱類：同步回傳 unsubscribe，內部非同步註冊
  function makeSubscribe(sub) {
    return function (code, cb) {
      let ref = null, handler = null, cancelled = false;
      ensureReady().then(function (ok) {
        if (!ok || cancelled) return;
        ref = roomRef(code, sub);
        handler = ref.on("value", function (s) { cb(s.val()); });
      });
      return function () { cancelled = true; if (ref && handler) ref.off("value", handler); };
    };
  }
  Sync.subscribeState = makeSubscribe("state");
  Sync.subscribePlayers = function (code, cb) {
    return makeSubscribe("players")(code, function (v) { cb(v || {}); });
  };
  Sync.subscribeInputs = function (code, cb) {
    return makeSubscribe("inputs")(code, function (v) { cb(v || {}); });
  };

})(window);

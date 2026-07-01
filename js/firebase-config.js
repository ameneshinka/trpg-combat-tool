// ============================================================
// Firebase 專案設定（使用者自行填入）
// ------------------------------------------------------------
// 步驟：
//   1. 到 https://console.firebase.google.com 建立一個專案
//   2. 建立 → Realtime Database（測試模式即可）
//   3. 專案設定 → 你的應用程式（Web）→ 複製 SDK config
//   4. 把下面各欄位填上，特別是 databaseURL（Realtime Database 的網址）
//
// 若留空 / 未填 databaseURL，程式會自動停用連線功能，單機模式照常可用。
// ⚠ 原型階段安全規則寬鬆（有房號即可讀寫），請勿放真實隱私資料。
// ============================================================
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDN7pAurE-t-aKXtc-3fgJdG7cOp8OSg5E",
  authDomain: "trpg-battle.firebaseapp.com",
  databaseURL: "https://trpg-battle-default-rtdb.asia-southeast1.firebasedatabase.app",          // 例：https://your-project-default-rtdb.firebaseio.com
  projectId: "trpg-battle",
  storageBucket: "trpg-battle.firebasestorage.app",
  messagingSenderId: "1034565520467",
  appId: "1:1034565520467:web:5bc01313c9bc997495caa6"
};

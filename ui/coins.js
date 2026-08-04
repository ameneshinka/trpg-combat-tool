// ============================================================
// UI：擲硬幣動畫
// ------------------------------------------------------------
// 硬幣是「程式自動擲」的（規則：機率加權硬幣由工具擲），而且一整場拚點是在
// generator 的同一步裡同步跑完 —— UI 沒辦法插在中間演。
// 所以 engine/clash.js 有一個預設關閉的記錄器，這裡負責把它「回放」成動畫。
//
// 節奏（裁決 49/50）：一組擲幣一段動畫，自動接下一段，右上角可跳過。
//   拚點的一次交換 = 雙方硬幣並排同時翻，看得出誰的最終威力比較高。
// ============================================================
(function (global) {
  "use strict";
  const Coins = global.Coins = {};
  const el = function (t, o) { return global.Panels.el(t, o); };

  // 調節奏就改這三個（一組約 1.07 秒；5 次交換的拚點約 5.4 秒）
  const FLIP_MS = 500;    // 翻轉
  const HOLD_MS = 450;    // 停留看結果
  const GAP_MS = 120;     // 組間空隙

  // ⚠ 不使用 localStorage（webapp skill）→ 開關只存在記憶體，重整回到預設開啟
  let enabled = true;
  Coins.setEnabled = function (v) { enabled = !!v; };
  Coins.isEnabled = function () { return enabled; };

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function coinLabel(c) {
    const t = c.type === "red" ? "紅" : c.type === "green" ? "綠" : "普通";
    return t + (c.status === "已碎幣" ? "・碎" : "");
  }

  /** 一枚硬幣。顏色由 CSS 的 data-type / data-face 決定（色號寫在 style.css）。 */
  function coinEl(c, reveal) {
    const wrap = el("div", { cls: "coin-flip" });
    wrap.setAttribute("data-type", c.type || "normal");
    wrap.setAttribute("data-face", c.head ? "head" : "tail");
    if (c.status === "已碎幣") wrap.setAttribute("data-shattered", "1");
    if (!reveal) wrap.setAttribute("data-spinning", "1");
    wrap.setAttribute("aria-label", coinLabel(c) + "：" + (c.head ? "正面" : "反面"));
    wrap.appendChild(el("span", { cls: "coin-face", text: c.head ? "正" : "反" }));
    // 碎幣的有效幣威已經變成 1 —— 視覺上要看得出來（裁決 51）
    if (c.status === "已碎幣") wrap.appendChild(el("span", { cls: "coin-badge", text: "+1" }));
    return wrap;
  }

  function rollEl(roll, reveal, highlight) {
    const box = el("div", { cls: "coin-side" + (highlight ? " win" : "") });
    box.appendChild(el("div", { cls: "coin-who", text: roll.who || "" }));
    const row = el("div", { cls: "coin-row" });
    (roll.coins || []).forEach(function (c) { row.appendChild(coinEl(c, reveal)); });
    box.appendChild(row);
    box.appendChild(el("div", {
      cls: "coin-power",
      text: reveal ? "最終威力 " + roll.power + "（正面 " + roll.heads + "／" + (roll.coins || []).length + "）" : "擲幣中…"
    }));
    return box;
  }

  function groupTitle(g) {
    if (g.kind === "clash") return "拚點・交換 #" + (g.exchange || 1);
    if (g.kind === "damage") return "傷害結算　" + (g.label || "") +
      (g.targetName ? " → " + g.targetName : "");
    return "擲幣";
  }

  function sleep(ms) { return new Promise(function (r) { global.setTimeout(r, ms); }); }

  /**
   * 播放一串擲幣群組。播完或被「跳過」才 resolve。
   * ⚠ 呼叫端（battle.js 的 advance）會 await 它，所以一定要 resolve —— 用 finally 收尾。
   */
  Coins.play = function (groups) {
    if (!enabled || !groups || !groups.length) return Promise.resolve();
    const reduced = prefersReducedMotion();

    const overlay = el("div", { cls: "coin-overlay" });
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    const panel = el("div", { cls: "coin-panel" });
    const head = el("div", { cls: "coin-head" });
    const title = el("div", { cls: "coin-title", text: "" });
    const skip = el("button", { cls: "coin-skip", text: "跳過 ▶▶" });
    skip.type = "button";
    skip.setAttribute("aria-label", "跳過擲幣動畫");
    head.appendChild(title);
    head.appendChild(skip);
    const body = el("div", { cls: "coin-body" });
    const counter = el("div", { cls: "coin-counter" });
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(counter);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let skipped = false;
    skip.onclick = function () { skipped = true; };
    function onKey(ev) { if (ev.key === "Escape" || ev.key === " ") { ev.preventDefault(); skipped = true; } }
    document.addEventListener("keydown", onKey);
    skip.focus();

    function renderGroup(g, reveal) {
      title.textContent = groupTitle(g);
      body.innerHTML = "";
      const rolls = g.rolls || [];
      // 拚點：贏的那一側高亮（最終威力較高者；平手不亮）
      let winIdx = -1;
      if (reveal && g.kind === "clash" && rolls.length === 2) {
        if (rolls[0].power > rolls[1].power) winIdx = 0;
        else if (rolls[1].power > rolls[0].power) winIdx = 1;
      }
      rolls.forEach(function (r, i) {
        if (i > 0) body.appendChild(el("div", { cls: "coin-vs", text: "VS" }));
        body.appendChild(rollEl(r, reveal, i === winIdx));
      });
    }

    return (async function () {
      try {
        for (let i = 0; i < groups.length; i++) {
          if (skipped) break;
          const g = groups[i];
          counter.textContent = (i + 1) + " / " + groups.length;
          if (reduced) {
            renderGroup(g, true);
            await sleep(HOLD_MS);
          } else {
            renderGroup(g, false);
            await sleep(FLIP_MS);
            if (skipped) break;
            renderGroup(g, true);
            await sleep(HOLD_MS);
          }
          if (i < groups.length - 1) await sleep(GAP_MS);
        }
      } finally {
        document.removeEventListener("keydown", onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    })();
  };

})(window);

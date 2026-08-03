// ============================================================
// UI：NPC 倉庫與本場編成
// ------------------------------------------------------------
// 倉庫的「內容」寫在 data/characters.js 的 NPC_LIBRARY（依 trpg-combat-webapp skill：
// 不做資料輸入介面）。這裡只負責「瀏覽 → 選 → ×N 投放」。
//
// 兩層概念：
//   藍圖（本體）＝ 一款 NPC 的設計，同款所有實例共用一份 → 調平衡只改一處
//   實例（戰場）＝ 這場的第 1 隻／第 2 隻 → HP／狀態／資源全部各算各的
// ============================================================
(function (global) {
  "use strict";
  const Library = global.Library = {};
  const el = function (t, o) { return global.Panels.el(t, o); };

  // [{ blueprintId, count }] —— 依加入順序；同款只會有一筆（重複加入 = 累加數量）
  let picks = [];
  let hosts = null;

  Library.picks = function () {
    return picks.map(function (p) { return { blueprintId: p.blueprintId, count: p.count }; });
  };
  Library.totalCount = function () {
    return picks.reduce(function (s, p) { return s + p.count; }, 0);
  };

  function blueprint(id) {
    return global.Characters.NPC_LIBRARY.find(function (b) { return b.id === id; });
  }

  // 預覽實例名，與 Characters.spawn 的規則一致（count > 1 才加後綴）
  function instanceNames(bp, count) {
    if (count <= 1) return [bp.name];
    const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const out = [];
    for (let i = 0; i < count; i++) out.push(bp.name + " " + (i < 26 ? L[i] : String(i + 1)));
    return out;
  }

  function addPick(id, count) {
    const n = Math.max(1, Number(count) || 1);
    const found = picks.find(function (p) { return p.blueprintId === id; });
    if (found) found.count += n; else picks.push({ blueprintId: id, count: n });
    renderLineup();
  }

  function setCount(id, n) {
    const i = picks.findIndex(function (p) { return p.blueprintId === id; });
    if (i === -1) return;
    if (n <= 0) picks.splice(i, 1); else picks[i].count = n;
    renderLineup();
  }

  // ---------------- 數量選擇器 ----------------
  function stepper(initial, onValue) {
    const wrap = el("div", { cls: "qty" });
    const dec = el("button", { text: "−" }); dec.type = "button";
    dec.setAttribute("aria-label", "減少數量");
    const inp = el("input"); inp.type = "number"; inp.min = 1; inp.value = initial;
    inp.setAttribute("aria-label", "數量");
    const inc = el("button", { text: "＋" }); inc.type = "button";
    inc.setAttribute("aria-label", "增加數量");
    function val() { return Math.max(1, Number(inp.value) || 1); }
    dec.onclick = function () { inp.value = Math.max(1, val() - 1); if (onValue) onValue(val()); };
    inc.onclick = function () { inp.value = val() + 1; if (onValue) onValue(val()); };
    inp.onchange = function () { inp.value = val(); if (onValue) onValue(val()); };
    wrap.appendChild(dec); wrap.appendChild(inp); wrap.appendChild(inc);
    wrap.value = val;
    return wrap;
  }

  // ---------------- 倉庫 ----------------
  function renderShelf() {
    const host = hosts.shelf;
    host.innerHTML = "";
    const lib = global.Characters.NPC_LIBRARY;
    if (!lib.length) {
      host.appendChild(el("p", { cls: "hint", text: "倉庫是空的（在 data/characters.js 的 NPC_LIBRARY 加入）" }));
      return;
    }

    // 依 category 分組，維持宣告順序
    const groups = [];
    lib.forEach(function (bp) {
      const key = bp.category || "未分類";
      let g = groups.find(function (x) { return x.key === key; });
      if (!g) { g = { key: key, items: [] }; groups.push(g); }
      g.items.push(bp);
    });

    groups.forEach(function (g) {
      host.appendChild(el("div", { cls: "sub-label", text: g.key }));
      const grid = el("div", { cls: "lib-grid" });
      g.items.forEach(function (bp) { grid.appendChild(shelfCard(bp)); });
      host.appendChild(grid);
    });
  }

  function shelfCard(bp) {
    const card = el("div", { cls: "lib-card" });

    const head = el("div", { cls: "lc-head" });
    head.appendChild(el("span", { cls: "name", text: bp.name }));
    const detail = el("button", { cls: "link-btn", text: "查看詳情" });
    detail.type = "button";
    detail.setAttribute("aria-label", "查看 " + bp.name + " 的技能與被動文本");
    detail.onclick = function () {
      global.Detail.open(global.Characters.preview(bp.id), { kpControls: false });
    };
    head.appendChild(detail);
    card.appendChild(head);

    card.appendChild(el("div", {
      cls: "lc-stats",
      text: "HP " + bp.hp + "　DEX " + bp.dex + "　技能 " + (bp.skillLibrary || []).length + " 個"
    }));
    if (bp.blurb) card.appendChild(el("p", { cls: "lc-blurb", text: bp.blurb }));

    const foot = el("div", { cls: "lc-foot" });
    const qty = stepper(bp.defaultCount || 1);
    foot.appendChild(qty);
    const add = el("button", { cls: "primary", text: "加入編成" });
    add.type = "button";
    add.setAttribute("aria-label", "把 " + bp.name + " 加入本場編成");
    add.onclick = function () { addPick(bp.id, qty.value()); };
    foot.appendChild(add);
    card.appendChild(foot);

    return card;
  }

  // ---------------- 本場編成 ----------------
  function renderLineup() {
    const host = hosts.lineup;
    host.innerHTML = "";
    if (!picks.length) {
      host.appendChild(el("p", { cls: "hint", text: "還沒有選任何敵人 —— 可以先開一場只有 PC 的空戰鬥，但通常沒意義。" }));
      if (hosts.onChange) hosts.onChange();
      return;
    }

    picks.forEach(function (p) {
      const bp = blueprint(p.blueprintId);
      if (!bp) return;
      const row = el("div", { cls: "lineup-row" });

      const info = el("div", { cls: "lr-info" });
      info.appendChild(el("span", { cls: "name", text: bp.name + " ×" + p.count }));
      info.appendChild(el("span", { cls: "hint", text: instanceNames(bp, p.count).join("／") }));
      row.appendChild(info);

      const ops = el("div", { cls: "lr-ops" });
      const dec = el("button", { text: "−" }); dec.type = "button";
      dec.setAttribute("aria-label", "減少一隻 " + bp.name);
      dec.onclick = function () { setCount(p.blueprintId, p.count - 1); };
      const inc = el("button", { text: "＋" }); inc.type = "button";
      inc.setAttribute("aria-label", "增加一隻 " + bp.name);
      inc.onclick = function () { setCount(p.blueprintId, p.count + 1); };
      const rm = el("button", { cls: "danger", text: "移除" }); rm.type = "button";
      rm.setAttribute("aria-label", "從編成移除 " + bp.name);
      rm.onclick = function () { setCount(p.blueprintId, 0); };
      ops.appendChild(dec); ops.appendChild(inc); ops.appendChild(rm);
      row.appendChild(ops);

      host.appendChild(row);
    });

    host.appendChild(el("p", {
      cls: "hint",
      text: "本場敵方共 " + Library.totalCount() + " 隻　│　每一隻的 HP、狀態、資源、宣告都各算各的。"
    }));
    if (hosts.onChange) hosts.onChange();
  }

  // ---------------- 對外 ----------------
  Library.init = function (opts) {
    hosts = opts;                       // { shelf, lineup, onChange }
    renderShelf();
    renderLineup();
  };

  // 生成本場的 NPC 實例
  Library.spawnAll = function () {
    const out = [];
    picks.forEach(function (p) {
      global.Characters.spawn(p.blueprintId, p.count).forEach(function (e) { out.push(e); });
    });
    return out;
  };

})(window);

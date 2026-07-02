// ============================================================
// 表單式名單編輯器（window.Editor）
// - 資料源 = 記憶體 roster 陣列（parsed 物件）；表單只讀寫已知欄位，
//   不動未知欄位（保 JSON roundtrip 相容）。
// - 即時預覽重用 UI.renderEntityCard；JSON drawer 雙向同步。
// - 驗證：blur 觸發、錯誤緊貼欄位（role=alert）、跨欄檢查。
// ============================================================
(function (global) {
  "use strict";
  const Editor = global.Editor = {};

  const $ = function (sel) { return document.querySelector(sel); };
  function el(tag, opts) {
    const e = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) e.className = opts.cls;
    if (opts.text !== undefined) e.textContent = opts.text;
    if (opts.html !== undefined) e.innerHTML = opts.html;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { e.setAttribute(k, opts.attrs[k]); });
    return e;
  }
  // SVG icon buttons（不用 emoji）
  const ICONS = {
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
  };
  function iconBtn(icon, label, onClick, extraCls) {
    const b = el("button", { cls: "icon-btn" + (extraCls ? " " + extraCls : ""), html: ICONS[icon] });
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.onclick = onClick;
    return b;
  }

  // ---------------- 詞彙 ----------------
  const WHO_OPTS = [{ v: "self", t: "自身" }, { v: "target", t: "目標" }];
  const EFFECT_TYPES = {
    applyState: { label: "施加狀態" },
    invokeSkill: { label: "喚出技能" },
    burstResonance: { label: "瀑殘響（引爆）" },
    tremorBurst: { label: "震顫爆發" },
    heal: { label: "回復 HP" },
    tempHp: { label: "臨時生命值" },
    focus: { label: "專注力增減" }
  };
  const COND_TYPES = {
    hasState: "帶有狀態",
    stateLayerEquals: "狀態層數等於",
    stateLevelEquals: "狀態級數等於",
    always: "永遠成立"
  };
  const TRIGGER_OPTS = [
    { v: "turnStart", t: "回合開始" },
    { v: "turnEnd", t: "回合結束" },
    { v: "interceptOverride", t: "攔截例外（可攔玩家）" }
  ];
  const TARGET_OPTS = [
    { v: "self", t: "自身" },
    { v: "randomEnemy", t: "隨機敵人" },
    { v: "randomEnemyWithout", t: "隨機『無某狀態』敵人" },
    { v: "lowestHpEnemy", t: "血量最低敵人" },
    { v: "allEnemies", t: "全體敵人" },
    { v: "randomAlly", t: "隨機隊友" }
  ];

  // ---------------- 狀態 ----------------
  let roster = [];
  let pcOrder = [];
  let selected = -1;
  const openKeys = {};       // <details> 展開狀態記憶
  let saveTimer = null, syncTimer = null;

  // ---------------- 工具 ----------------
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function uniqueId(prefix, taken) {
    let n = 1;
    while (taken.indexOf(prefix + "_" + n) !== -1) n++;
    return prefix + "_" + n;
  }
  function allEntityIds() { return roster.map(function (e) { return e.id; }); }
  function knownStates() {
    const D = global.Data;
    return [].concat(D.LAYER_DRIVEN_STATES, D.LEVEL_DRIVEN_STATES, D.BURST_TAGS);
  }

  // ---------------- init ----------------
  Editor.init = function () {
    // datalist：狀態名
    const dl = el("datalist"); dl.id = "dl-states";
    knownStates().forEach(function (s) { const o = el("option"); o.value = s; dl.appendChild(o); });
    document.body.appendChild(dl);

    $("#btnAddEntity").onclick = addEntity;
    $("#btnApplyJson").onclick = applyJsonToForm;
    $("#btnValidateRoster").onclick = function () { validateJsonText(true); };
    $("#rosterJson").addEventListener("input", function () { /* 手改中不自動覆蓋 */ });

    // 還原草稿；無草稿 → 載入範例
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem("trpg_roster_draft") || "null"); } catch (e) {}
    if (draft && Array.isArray(draft.roster) && draft.roster.length) {
      roster = draft.roster; pcOrder = draft.pcOrder || [];
    } else {
      roster = deepClone(global.Data.SAMPLE_ROSTER.entities);
      pcOrder = deepClone(global.Data.SAMPLE_ROSTER.pcGrowthOrder);
    }
    selected = roster.length ? 0 : -1;
    renderAll();
  };

  Editor.loadRoster = function (arr, order) {
    roster = deepClone(arr);
    pcOrder = order ? deepClone(order) : [];
    syncPcOrder();
    selected = roster.length ? 0 : -1;
    renderAll();
    changed(false);
  };
  Editor.getRoster = function () { return deepClone(roster); };
  Editor.getPcOrder = function () { syncPcOrder(); return deepClone(pcOrder); };
  Editor.validateAll = validateAll;

  // ---------------- 變更管線 ----------------
  // structural=true 時重建編輯表單（新增/刪除/搬移子項）；false 只更新周邊
  function changed(structural) {
    if (structural) renderEditor();
    renderRosterList();
    renderPreview();
    renderValidation();
    renderPcOrder();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem("trpg_roster_draft", JSON.stringify({ roster: roster, pcOrder: pcOrder })); } catch (e) {}
    }, 300);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      const ta = $("#rosterJson");
      if (ta && document.activeElement !== ta) ta.value = JSON.stringify(roster, null, 2);
    }, 300);
  }

  function renderAll() {
    renderRosterList(); renderEditor(); renderPreview(); renderValidation(); renderPcOrder();
    const ta = $("#rosterJson"); if (ta) ta.value = JSON.stringify(roster, null, 2);
  }

  // ---------------- 綁定欄位小工具 ----------------
  function bindText(obj, key, opts) {
    opts = opts || {};
    const i = el("input"); i.type = "text";
    i.value = obj[key] !== undefined && obj[key] !== null ? obj[key] : "";
    if (opts.list) i.setAttribute("list", opts.list);
    if (opts.placeholder) i.placeholder = opts.placeholder;
    i.addEventListener("input", function () {
      if (i.value === "" && opts.deleteWhenEmpty) delete obj[key]; else obj[key] = i.value;
      changed(false);
      if (opts.onInput) opts.onInput(i.value);
    });
    return i;
  }
  function bindNum(obj, key, opts) {
    opts = opts || {};
    const i = el("input"); i.type = "number";
    if (opts.min !== undefined) i.min = opts.min;
    if (opts.max !== undefined) i.max = opts.max;
    if (opts.step !== undefined) i.step = opts.step;
    i.value = obj[key] !== undefined && obj[key] !== null ? obj[key] : "";
    if (opts.placeholder) i.placeholder = opts.placeholder;
    i.addEventListener("input", function () {
      if (i.value === "") {
        if (opts.deleteWhenEmpty) delete obj[key]; else obj[key] = 0;
      } else obj[key] = Number(i.value);
      changed(false);
    });
    return i;
  }
  function bindSelect(obj, key, options, opts) {
    opts = opts || {};
    const s = el("select");
    options.forEach(function (o) {
      const op = el("option", { text: o.t }); op.value = o.v; s.appendChild(op);
    });
    // def 僅供顯示，不寫回模型（render 不落痕跡；使用者變更才寫入）
    if (obj[key] !== undefined && obj[key] !== null) s.value = String(obj[key]);
    else if (opts.def !== undefined) s.value = opts.def;
    s.addEventListener("change", function () {
      obj[key] = s.value === "__null__" ? null : s.value;
      changed(!!opts.structural);
      if (opts.onChange) opts.onChange(s.value);
    });
    return s;
  }
  function bindCheck(obj, key, labelText, opts) {
    opts = opts || {};
    const lab = el("label", { cls: "row" }); lab.style.margin = "4px 0";
    const c = el("input"); c.type = "checkbox";
    c.checked = !!obj[key];
    c.addEventListener("change", function () {
      if (!c.checked && opts.deleteWhenFalse) delete obj[key]; else obj[key] = c.checked;
      changed(!!opts.structural);
      if (opts.onChange) opts.onChange(c.checked);
    });
    lab.appendChild(c);
    lab.appendChild(el("span", { text: " " + labelText }));
    return lab;
  }
  function fieldWrap(labelText, inputEl, hint) {
    const w = el("div", { cls: "field" });
    const lab = el("label", { text: labelText });
    const fid = "f_" + Math.random().toString(36).slice(2, 8);
    inputEl.id = fid; lab.setAttribute("for", fid);
    w.appendChild(lab); w.appendChild(inputEl);
    const err = el("div", { cls: "field-error" }); err.setAttribute("role", "alert");
    w.appendChild(err);
    if (hint) w.appendChild(el("div", { cls: "hint", text: hint }));
    return w;
  }
  function setFieldError(wrapEl, msg) {
    wrapEl.classList.toggle("invalid", !!msg);
    wrapEl.querySelector(".field-error").textContent = msg || "";
  }
  // <details> 展開狀態記憶
  function detailsSec(key, summaryText, countText, defOpen) {
    const d = el("details", { cls: "editor-section" });
    d.open = openKeys[key] !== undefined ? openKeys[key] : !!defOpen;
    d.addEventListener("toggle", function () { openKeys[key] = d.open; });
    const s = el("summary");
    s.appendChild(el("span", { text: summaryText }));
    if (countText) s.appendChild(el("span", { cls: "sec-count", text: countText }));
    d.appendChild(s);
    const body = el("div", { cls: "sec-body" });
    d.appendChild(body);
    return { root: d, body: body };
  }

  // ---------------- 左欄：角色清單 ----------------
  function renderRosterList() {
    const box = $("#rosterList");
    box.innerHTML = "";
    roster.forEach(function (e, i) {
      const item = el("button", { cls: "roster-item" + (i === selected ? " selected" : "") });
      item.type = "button";
      item.appendChild(el("span", { cls: "badge " + (e.isPC ? "pc" : "npc"), text: e.isPC ? "PC" : "NPC" }));
      item.appendChild(el("span", { cls: "ri-name", text: e.name || "(未命名)" }));
      item.appendChild(el("span", { cls: "ri-sub", text: "HP" + (e.hp !== undefined ? e.hp : "?") + " D" + (e.dex !== undefined ? e.dex : "?") }));
      item.onclick = function () { selected = i; renderEditor(); renderRosterList(); renderPreview(); };
      box.appendChild(item);
    });
    if (!roster.length) box.appendChild(el("p", { cls: "preview-empty", text: "尚無角色" }));
  }

  function addEntity() {
    const id = uniqueId("npc", allEntityIds());
    const sk = { id: "skill_1", name: "技能一", type: "attack", basePower: 8, coinPower: 3, coins: ["normal", "normal"] };
    roster.push({
      id: id, name: "新角色", isPC: false, hp: 40, dex: 10,
      attributes: { STR: 10, INT: 10, CON: 10, SIZ: 10, LUK: 10 },
      skillLibrary: [sk],
      slotMap: { A: "skill_1", B: "skill_1", C: "skill_1" }
    });
    selected = roster.length - 1;
    renderAll(); changed(false);
  }

  // ---------------- 中欄：角色編輯表單 ----------------
  function renderEditor() {
    const box = $("#entityEditor");
    box.innerHTML = "";
    if (selected < 0 || !roster[selected]) {
      box.appendChild(el("p", { cls: "preview-empty", text: "左側選擇或新增一個角色開始編輯" }));
      return;
    }
    const e = roster[selected];

    // 頂列：複製/刪除
    const top = el("div", { cls: "row" });
    const dup = el("button", { text: "複製此角色" });
    dup.onclick = function () {
      const copy = deepClone(e);
      copy.id = uniqueId(copy.id.replace(/_\d+$/, "") || "npc", allEntityIds());
      copy.name = (copy.name || "") + "（複本）";
      roster.splice(selected + 1, 0, copy);
      selected = selected + 1;
      renderAll(); changed(false);
    };
    const del = el("button", { cls: "danger", text: "刪除此角色" });
    del.onclick = function () {
      if (!confirm("確定刪除「" + (e.name || e.id) + "」？此動作無法復原。")) return;
      roster.splice(selected, 1);
      selected = Math.min(selected, roster.length - 1);
      renderAll(); changed(false);
    };
    top.appendChild(dup); top.appendChild(del);
    box.appendChild(top);

    box.appendChild(renderBasicsSection(e));
    box.appendChild(renderSkillsSection(e));
    box.appendChild(renderSlotMapSection(e));
    box.appendChild(renderSlotMapRulesSection(e));
    box.appendChild(renderPassivesSection(e));
    box.appendChild(renderStatesSection(e));
  }

  // ---- 基本資料 ----
  function renderBasicsSection(e) {
    const sec = detailsSec("basics", "基本資料", "", true);

    const grid = el("div", { cls: "field-grid" });
    const nameF = fieldWrap("名稱 *", bindText(e, "name"));
    nameF.querySelector("input").addEventListener("blur", function () {
      setFieldError(nameF, e.name ? "" : "名稱必填");
    });
    grid.appendChild(nameF);

    const idF = fieldWrap("ID *（唯一）", bindText(e, "id"));
    idF.querySelector("input").addEventListener("blur", function () {
      if (!e.id) return setFieldError(idF, "ID 必填");
      const dup = roster.filter(function (x) { return x.id === e.id; }).length > 1;
      setFieldError(idF, dup ? "ID 與其他角色重複" : "");
    });
    grid.appendChild(idF);

    grid.appendChild(fieldWrap("HP", bindNum(e, "hp", { min: 0 })));
    grid.appendChild(fieldWrap("HP 上限（留空=同HP）", bindNum(e, "maxHp", { min: 0, deleteWhenEmpty: true, placeholder: "同 HP" })));
    grid.appendChild(fieldWrap("DEX", bindNum(e, "dex", { min: 0 })));
    sec.body.appendChild(grid);

    sec.body.appendChild(bindCheck(e, "isPC", "此角色為 PC（槽位自動成長；NPC 由 KP 每回合手填）", { deleteWhenFalse: true }));

    // attributes 惰性建立：render 不動模型，首次輸入才生成（保 roundtrip 乾淨）
    const attrGrid = el("div", { cls: "field-grid" });
    ["STR", "INT", "CON", "SIZ", "LUK"].forEach(function (a) {
      const i = el("input"); i.type = "number"; i.min = 0; i.placeholder = "10";
      i.value = (e.attributes && e.attributes[a] !== undefined) ? e.attributes[a] : "";
      i.addEventListener("input", function () {
        if (!e.attributes) e.attributes = { STR: 10, INT: 10, CON: 10, SIZ: 10, LUK: 10 };
        if (i.value === "") delete e.attributes[a]; else e.attributes[a] = Number(i.value);
        changed(false);
      });
      attrGrid.appendChild(fieldWrap(a, i));
    });
    sec.body.appendChild(el("div", { cls: "hint", text: "屬性" }));
    sec.body.appendChild(attrGrid);
    return sec.root;
  }

  // ---- 技能庫 ----
  function renderSkillsSection(e) {
    const lib = e.skillLibrary || [];
    const sec = detailsSec("skills", "技能庫", "（" + lib.length + "）", true);

    lib.forEach(function (sk, si) {
      sec.body.appendChild(renderSkillCard(e, sk, si));
    });

    const add = el("button", { cls: "primary", text: "＋ 新增技能" });
    add.onclick = function () {
      if (!e.skillLibrary) e.skillLibrary = [];
      const taken = e.skillLibrary.map(function (s) { return s.id; });
      const nid = uniqueId("skill", taken);
      e.skillLibrary.push({ id: nid, name: "新技能", type: "attack", basePower: 8, coinPower: 3, coins: ["normal", "normal"] });
      openKeys["skill:" + nid] = true;
      changed(true);
    };
    sec.body.appendChild(add);
    return sec.root;
  }

  function renderSkillCard(e, sk, si) {
    const d = el("details", { cls: "sub-card" });
    const key = "skill:" + sk.id;
    d.open = openKeys[key] !== undefined ? openKeys[key] : false;
    d.addEventListener("toggle", function () { openKeys[key] = d.open; });

    const sum = el("summary", { cls: "sub-card-head" });
    sum.style.cursor = "pointer"; sum.style.listStyle = "none";
    sum.appendChild(el("span", { cls: "title", text: (sk.name || sk.id) + (sk.drawable === false ? "（隱藏技）" : "") }));
    sum.appendChild(el("span", { cls: "hint", text: (sk.type === "defense" ? "防禦" : "攻擊") + "・基" + (sk.basePower || 0) + "/幣+" + (sk.coinPower || 0) + "・" + (sk.coins || []).length + "枚" }));
    const dupB = iconBtn("copy", "複製技能", function (ev) {
      ev.preventDefault();
      const copy = deepClone(sk);
      copy.id = uniqueId(copy.id.replace(/_\d+$/, "") || "skill", e.skillLibrary.map(function (s) { return s.id; }));
      copy.name = (copy.name || "") + "＇";
      e.skillLibrary.splice(si + 1, 0, copy);
      changed(true);
    });
    const delB = iconBtn("x", "刪除技能", function (ev) {
      ev.preventDefault();
      if (!confirm("刪除技能「" + (sk.name || sk.id) + "」？")) return;
      e.skillLibrary.splice(si, 1);
      changed(true);
    }, "danger");
    sum.appendChild(dupB); sum.appendChild(delB);
    d.appendChild(sum);

    const body = el("div");
    const grid = el("div", { cls: "field-grid" });
    grid.appendChild(fieldWrap("技能名稱", bindText(sk, "name")));
    grid.appendChild(fieldWrap("技能 ID", bindText(sk, "id")));
    grid.appendChild(fieldWrap("類型", bindSelect(sk, "type", [{ v: "attack", t: "攻擊" }, { v: "defense", t: "防禦" }])));
    grid.appendChild(fieldWrap("基礎威力", bindNum(sk, "basePower", { min: 0 })));
    grid.appendChild(fieldWrap("硬幣威力 (+N)", bindNum(sk, "coinPower", { min: 0 })));
    body.appendChild(grid);

    // drawable 反向呈現：勾＝隱藏技
    const hid = el("label", { cls: "row" });
    const hc = el("input"); hc.type = "checkbox"; hc.checked = sk.drawable === false;
    hc.addEventListener("change", function () {
      if (hc.checked) sk.drawable = false; else delete sk.drawable;
      changed(false);
    });
    hid.appendChild(hc);
    hid.appendChild(el("span", { text: " 隱藏技（不進抽選池，只能被形態轉換解鎖或 invokeSkill 喚出）" }));
    body.appendChild(hid);

    // 硬幣（有序）
    body.appendChild(el("div", { cls: "hint", text: "硬幣（順序＝拚輸時的損幣順序）" }));
    body.appendChild(renderCoinRow(sk));

    // 條件式威力（render 不動模型）
    const condSec = el("div", { cls: "sub-sub" });
    condSec.appendChild(el("div", { cls: "hint", text: "條件式威力（例：目標有某印記 → 威力+N）" }));
    (sk.conditions || []).forEach(function (c, ci) {
      const row = el("div", { cls: "sub-card" });
      const head = el("div", { cls: "sub-card-head" });
      head.appendChild(el("span", { cls: "title", text: "條件威力 #" + (ci + 1) }));
      head.appendChild(iconBtn("x", "刪除此條件威力", function () { sk.conditions.splice(ci, 1); if (!sk.conditions.length) delete sk.conditions; changed(true); }, "danger"));
      row.appendChild(head);
      row.appendChild(renderConditionBuilder(c, "condition", { required: true }));
      const g = el("div", { cls: "field-grid" });
      g.appendChild(fieldWrap("基礎威力 Δ", bindNum(c, "basePowerDelta", { deleteWhenEmpty: true })));
      g.appendChild(fieldWrap("硬幣威力 Δ", bindNum(c, "coinPowerDelta", { deleteWhenEmpty: true })));
      row.appendChild(g);
      condSec.appendChild(row);
    });
    const addCond = el("button", { text: "＋ 條件式威力" });
    addCond.onclick = function () {
      if (!sk.conditions) sk.conditions = [];
      sk.conditions.push({ condition: { type: "hasState", who: "target", state: "", minLayer: 1 }, basePowerDelta: 0 });
      changed(true);
    };
    condSec.appendChild(addCond);
    body.appendChild(condSec);

    // 效果
    body.appendChild(renderEffectList(e, sk, "useEffects", "使用時效果（拚點前，不論命中）"));
    body.appendChild(renderEffectList(e, sk, "hitEffects", "命中時效果（攻擊命中後／防禦成功時）"));

    d.appendChild(body);
    return d;
  }

  function renderCoinRow(sk) {
    const coins = sk.coins || [];
    const wrap = el("div");
    const row = el("div", { cls: "coin-row" });
    coins.forEach(function (c, ci) {
      const type = typeof c === "string" ? c : c.type;
      const label = type === "red" ? "紅" : type === "green" ? "綠" : "普";
      const chip = el("span", { cls: "coin-chip " + type });
      chip.appendChild(el("span", { text: label + (ci + 1) }));
      const mvL = el("button", { html: ICONS.left }); mvL.type = "button"; mvL.setAttribute("aria-label", "往前移");
      mvL.onclick = function () { if (ci === 0) return; const t = sk.coins[ci - 1]; sk.coins[ci - 1] = sk.coins[ci]; sk.coins[ci] = t; changed(true); };
      const mvR = el("button", { html: ICONS.right }); mvR.type = "button"; mvR.setAttribute("aria-label", "往後移");
      mvR.onclick = function () { if (ci >= sk.coins.length - 1) return; const t = sk.coins[ci + 1]; sk.coins[ci + 1] = sk.coins[ci]; sk.coins[ci] = t; changed(true); };
      const rm = el("button", { html: ICONS.x }); rm.type = "button"; rm.setAttribute("aria-label", "移除硬幣");
      rm.onclick = function () { sk.coins.splice(ci, 1); changed(true); };
      chip.appendChild(mvL); chip.appendChild(mvR); chip.appendChild(rm);
      row.appendChild(chip);
    });
    wrap.appendChild(row);
    const addRow = el("div", { cls: "row" });
    [["normal", "＋普通"], ["red", "＋紅幣"], ["green", "＋綠幣"]].forEach(function (p) {
      const b = el("button", { text: p[1] });
      b.onclick = function () { if (!sk.coins) sk.coins = []; sk.coins.push(p[0]); changed(true); };
      addRow.appendChild(b);
    });
    wrap.appendChild(addRow);
    return wrap;
  }

  // ---- 效果建構器 ----
  function renderEffectList(entity, owner, key, title) {
    const box = el("div", { cls: "sub-sub" });
    box.appendChild(el("div", { cls: "hint", text: title }));
    const list = owner[key] || [];
    list.forEach(function (eff, i) {
      box.appendChild(renderEffectRow(entity, owner, key, eff, i));
    });
    const add = el("button", { text: "＋ 效果" });
    add.onclick = function () {
      if (!owner[key]) owner[key] = [];
      owner[key].push({ type: "applyState", who: "target", state: "", layerDelta: 1 });
      changed(true);
    };
    box.appendChild(add);
    return box;
  }

  function renderEffectRow(entity, owner, key, eff, i) {
    const card = el("div", { cls: "sub-card" });
    const head = el("div", { cls: "sub-card-head" });
    const typeSel = el("select");
    Object.keys(EFFECT_TYPES).forEach(function (t) {
      const o = el("option", { text: EFFECT_TYPES[t].label }); o.value = t; typeSel.appendChild(o);
    });
    if (EFFECT_TYPES[eff.type]) typeSel.value = eff.type;
    else { // 未知效果型別 → 進階 JSON
      card.appendChild(head);
      head.appendChild(el("span", { cls: "adv-badge", text: "進階結構" }));
      head.appendChild(el("span", { cls: "title", text: eff.type || "(未知效果)" }));
      head.appendChild(iconBtn("x", "刪除效果", function () { owner[key].splice(i, 1); if (!owner[key].length) delete owner[key]; changed(true); }, "danger"));
      card.appendChild(miniJsonEditor(owner[key], i));
      return card;
    }
    typeSel.addEventListener("change", function () {
      const keep = { type: typeSel.value };
      if (eff.who) keep.who = eff.who;
      if (eff.condition) keep.condition = eff.condition;
      // 依型別給預設值
      if (typeSel.value === "applyState") { keep.state = ""; keep.layerDelta = 1; }
      if (typeSel.value === "invokeSkill") { keep.skillId = (entity.skillLibrary[0] || {}).id || ""; keep.targetRef = "target"; }
      if (typeSel.value === "burstResonance") { keep.burst = "血瀑"; }
      if (typeSel.value === "heal" || typeSel.value === "tempHp" || typeSel.value === "focus") { keep.amount = 1; }
      owner[key][i] = keep;
      changed(true);
    });
    head.appendChild(typeSel);
    head.appendChild(el("span", { cls: "title", text: "" }));
    head.appendChild(iconBtn("x", "刪除效果", function () { owner[key].splice(i, 1); if (!owner[key].length) delete owner[key]; changed(true); }, "danger"));
    card.appendChild(head);

    const g = el("div", { cls: "field-grid" });
    const t = eff.type;
    // who 顯示預設須對齊引擎預設：瀑/震顫爆發缺 who＝目標，其餘缺 who＝自身
    const whoDef = (t === "burstResonance" || t === "tremorBurst") ? "target" : "self";
    g.appendChild(fieldWrap("對象", bindSelect(eff, "who", WHO_OPTS, { def: whoDef })));
    if (t === "applyState") {
      g.appendChild(fieldWrap("狀態名", bindText(eff, "state", { list: "dl-states", placeholder: "守護／延燒／自訂印記…" })));
      g.appendChild(fieldWrap("層數 Δ", bindNum(eff, "layerDelta", { deleteWhenEmpty: true })));
      g.appendChild(fieldWrap("級數 Δ", bindNum(eff, "levelDelta", { deleteWhenEmpty: true })));
      card.appendChild(g);
      card.appendChild(bindCheck(eff, "isMark", "標記為印記（純標籤；瀑標記會自動視為印記）", { deleteWhenFalse: true }));
    } else if (t === "invokeSkill") {
      const opts = entity.skillLibrary.map(function (s) { return { v: s.id, t: (s.name || s.id) + (s.drawable === false ? "（隱藏）" : "") }; });
      g.appendChild(fieldWrap("喚出技能", bindSelect(eff, "skillId", opts.length ? opts : [{ v: "", t: "（無技能）" }])));
      g.appendChild(fieldWrap("打向", bindSelect(eff, "targetRef", [{ v: "target", t: "原目標／對手" }, { v: "self", t: "自身" }], { def: "target" })));
      card.appendChild(g);
    } else if (t === "burstResonance") {
      g.appendChild(fieldWrap("引爆哪種瀑", bindSelect(eff, "burst", global.Data.BURST_TAGS.map(function (b) { return { v: b, t: b + "（夥伴：" + global.Data.BURST_PARTNER[b] + "）" }; }))));
      card.appendChild(g);
    } else if (t === "tremorBurst") {
      card.appendChild(g);
    } else { // heal/tempHp/focus
      g.appendChild(fieldWrap("數量", bindNum(eff, "amount")));
      card.appendChild(g);
    }

    // 附加條件（可選）
    const hasCond = !!eff.condition;
    const condToggle = el("label", { cls: "row" });
    const cc = el("input"); cc.type = "checkbox"; cc.checked = hasCond;
    cc.addEventListener("change", function () {
      if (cc.checked) eff.condition = { type: "hasState", who: "target", state: "", minLayer: 1 };
      else delete eff.condition;
      changed(true);
    });
    condToggle.appendChild(cc);
    condToggle.appendChild(el("span", { text: " 附加條件（條件成立才觸發）" }));
    card.appendChild(condToggle);
    if (hasCond) card.appendChild(renderConditionBuilder(eff, "condition", {}));

    return card;
  }

  function miniJsonEditor(arrOrObj, idx) {
    const wrap = el("div");
    const ta = el("textarea", { cls: "mini-json" });
    ta.value = JSON.stringify(idx !== undefined ? arrOrObj[idx] : arrOrObj, null, 1);
    const err = el("div", { cls: "field-error" }); err.setAttribute("role", "alert");
    const apply = el("button", { text: "套用" });
    apply.onclick = function () {
      try {
        const v = JSON.parse(ta.value);
        if (idx !== undefined) arrOrObj[idx] = v;
        err.textContent = "";
        changed(true);
      } catch (ex) { err.textContent = "JSON 錯誤：" + ex.message; }
    };
    wrap.appendChild(ta); wrap.appendChild(err); wrap.appendChild(apply);
    return wrap;
  }

  // ---- 條件建構器 ----
  function isSimpleCond(c) {
    return c && (c.type === "hasState" || c.type === "stateLayerEquals" || c.type === "stateLevelEquals" || c.type === "always");
  }
  function isRepresentable(c) {
    if (!c) return true;
    let core = c;
    if (core.type === "not") core = core.cond;
    if (!core) return false;
    if (isSimpleCond(core)) return true;
    if ((core.type === "and" || core.type === "or") && Array.isArray(core.conds)) {
      return core.conds.every(isSimpleCond);
    }
    return false;
  }

  function renderConditionBuilder(owner, key, opts) {
    opts = opts || {};
    const wrap = el("div", { cls: "sub-sub" });
    const c = owner[key];

    if (!isRepresentable(c)) {
      const h = el("div", { cls: "row" });
      h.appendChild(el("span", { cls: "adv-badge", text: "進階結構（巢狀條件）" }));
      wrap.appendChild(h);
      wrap.appendChild(miniJsonEditor(owner, key === "condition" ? "condition" : key));
      // miniJsonEditor 以 index 存取；物件 key 用替代寫法：
      wrap.lastChild.querySelector("button").onclick = (function (ta, err) {
        return function () {
          try { owner[key] = JSON.parse(ta.value); err.textContent = ""; changed(true); }
          catch (ex) { err.textContent = "JSON 錯誤：" + ex.message; }
        };
      })(wrap.lastChild.querySelector("textarea"), wrap.lastChild.querySelector(".field-error"));
      return wrap;
    }

    // 解出 not 外殼與核心
    let negated = false, core = c;
    if (core && core.type === "not") { negated = true; core = core.cond; }
    let mode = "single", simples;
    if (core && (core.type === "and" || core.type === "or")) { mode = core.type; simples = core.conds; }
    else simples = [core || { type: "hasState", who: "self", state: "", minLayer: 1 }];

    function commit() {
      let result;
      if (mode === "single") result = simples[0];
      else result = { type: mode, conds: simples };
      if (negated) result = { type: "not", cond: result };
      owner[key] = result;
      changed(true);
    }

    const ctrlRow = el("div", { cls: "row" });
    const modeSel = el("select");
    [["single", "單一條件"], ["and", "全部成立 (and)"], ["or", "任一成立 (or)"]].forEach(function (p) {
      const o = el("option", { text: p[1] }); o.value = p[0]; modeSel.appendChild(o);
    });
    modeSel.value = mode;
    modeSel.addEventListener("change", function () {
      mode = modeSel.value;
      if (mode === "single" && simples.length > 1) simples = [simples[0]];
      commit();
    });
    const negLab = el("label", { cls: "row" }); negLab.style.margin = "0";
    const negC = el("input"); negC.type = "checkbox"; negC.checked = negated;
    negC.addEventListener("change", function () { negated = negC.checked; commit(); });
    negLab.appendChild(negC); negLab.appendChild(el("span", { text: " 反轉 (not)" }));
    ctrlRow.appendChild(modeSel); ctrlRow.appendChild(negLab);
    wrap.appendChild(ctrlRow);

    simples.forEach(function (sc, i) {
      wrap.appendChild(renderSimpleCondRow(sc, simples, i, mode, commit));
    });
    if (mode !== "single") {
      const add = el("button", { text: "＋ 子條件" });
      add.onclick = function () { simples.push({ type: "hasState", who: "self", state: "", minLayer: 1 }); commit(); };
      wrap.appendChild(add);
    }
    return wrap;
  }

  function renderSimpleCondRow(sc, arr, i, mode, commit) {
    const g = el("div", { cls: "field-grid" });
    const typeSel = el("select");
    Object.keys(COND_TYPES).forEach(function (t) {
      const o = el("option", { text: COND_TYPES[t] }); o.value = t; typeSel.appendChild(o);
    });
    typeSel.value = sc.type || "hasState";
    typeSel.addEventListener("change", function () {
      const nc = { type: typeSel.value };
      if (typeSel.value !== "always") { nc.who = sc.who || "self"; nc.state = sc.state || ""; }
      if (typeSel.value === "hasState") nc.minLayer = 1;
      if (typeSel.value === "stateLayerEquals" || typeSel.value === "stateLevelEquals") nc.value = 0;
      arr[i] = nc;
      commit();
    });
    g.appendChild(fieldWrap("條件類型", typeSel));

    if (sc.type !== "always") {
      g.appendChild(fieldWrap("誰身上", (function () {
        const s = el("select");
        WHO_OPTS.forEach(function (o) { const op = el("option", { text: o.t }); op.value = o.v; s.appendChild(op); });
        s.value = sc.who || "self";
        s.addEventListener("change", function () { sc.who = s.value; commit(); });
        return s;
      })()));
      g.appendChild(fieldWrap("狀態名", (function () {
        const inp = el("input"); inp.type = "text"; inp.setAttribute("list", "dl-states");
        inp.value = sc.state || "";
        inp.addEventListener("input", function () { sc.state = inp.value; });
        inp.addEventListener("blur", function () { commit(); });
        return inp;
      })()));
      if (sc.type === "hasState") {
        g.appendChild(fieldWrap("最低層數", numQuick(sc, "minLayer", commit)));
        g.appendChild(fieldWrap("最低級數（可空）", numQuick(sc, "minLevel", commit, true)));
      } else {
        g.appendChild(fieldWrap("等於值", numQuick(sc, "value", commit)));
      }
    }
    if (mode !== "single") {
      const rm = iconBtn("x", "刪除子條件", function () { arr.splice(i, 1); if (!arr.length) arr.push({ type: "always" }); commit(); }, "danger");
      const w = el("div", { cls: "field" }); w.appendChild(el("label", { text: " " })); w.appendChild(rm);
      g.appendChild(w);
    }
    return g;
  }
  function numQuick(obj, key, commit, deleteWhenEmpty) {
    const i = el("input"); i.type = "number";
    i.value = obj[key] !== undefined ? obj[key] : "";
    i.addEventListener("input", function () {
      if (i.value === "" && deleteWhenEmpty) delete obj[key];
      else obj[key] = Number(i.value || 0);
    });
    i.addEventListener("blur", function () { commit(); });
    return i;
  }

  // ---- slotMap ----
  function renderSlotMapSection(e) {
    const sec = detailsSec("slotmap", "技能對照表（slotMap）", "1d6：1-3→A、4-5→B、6→C", true);
    const sm = e.slotMap || {};
    const g = el("div", { cls: "field-grid" });
    ["A", "B", "C"].forEach(function (slot) {
      const s = el("select");
      const none = el("option", { text: "（空）" }); none.value = "__null__"; s.appendChild(none);
      (e.skillLibrary || []).forEach(function (sk) {
        const o = el("option", { text: (sk.name || sk.id) + (sk.drawable === false ? "（隱藏）" : "") });
        o.value = sk.id; s.appendChild(o);
      });
      s.value = sm[slot] || "__null__";
      s.addEventListener("change", function () {
        if (!e.slotMap) e.slotMap = { A: null, B: null, C: null };
        e.slotMap[slot] = s.value === "__null__" ? null : s.value;
        changed(false);
      });
      g.appendChild(fieldWrap("槽位 " + slot, s));
    });
    sec.body.appendChild(g);
    return sec.root;
  }

  // ---- slotMapRules ----
  function renderSlotMapRulesSection(e) {
    const rules = e.slotMapRules || [];
    const sec = detailsSec("smrules", "形態轉換規則（slotMapRules）", "（" + rules.length + "）", rules.length > 0);
    rules.forEach(function (r, ri) {
      const card = el("div", { cls: "sub-card" });
      const head = el("div", { cls: "sub-card-head" });
      head.appendChild(el("span", { cls: "title", text: "規則 #" + (ri + 1) }));
      head.appendChild(iconBtn("x", "刪除規則", function () {
        e.slotMapRules.splice(ri, 1);
        if (!e.slotMapRules.length) delete e.slotMapRules;
        changed(true);
      }, "danger"));
      card.appendChild(head);
      card.appendChild(el("div", { cls: "hint", text: "條件成立時，把槽位改指向另一技能（回合開始結算，高 priority 後蓋低）" }));
      card.appendChild(renderConditionBuilder(r, "condition", { required: true }));
      const g = el("div", { cls: "field-grid" });
      g.appendChild(fieldWrap("改哪個槽位", bindSelect(r, "slot", [{ v: "A", t: "A" }, { v: "B", t: "B" }, { v: "C", t: "C" }])));
      const opts = (e.skillLibrary || []).map(function (sk) { return { v: sk.id, t: (sk.name || sk.id) + (sk.drawable === false ? "（隱藏）" : "") }; });
      g.appendChild(fieldWrap("改成哪個技能", bindSelect(r, "setSkillId", opts.length ? opts : [{ v: "", t: "（無技能）" }])));
      g.appendChild(fieldWrap("priority", bindNum(r, "priority", { deleteWhenEmpty: true })));
      card.appendChild(g);
      sec.body.appendChild(card);
    });
    const add = el("button", { text: "＋ 形態轉換規則" });
    add.onclick = function () {
      if (!e.slotMapRules) e.slotMapRules = [];
      e.slotMapRules.push({
        condition: { type: "hasState", who: "self", state: "", minLayer: 1 },
        slot: "C",
        setSkillId: (e.skillLibrary[0] || {}).id || "",
        priority: 10
      });
      openKeys["smrules"] = true;
      changed(true);
    };
    sec.body.appendChild(add);
    return sec.root;
  }

  // ---- 被動 ----
  function renderPassivesSection(e) {
    const ps = e.passives || [];
    const sec = detailsSec("passives", "被動", "（" + ps.length + "）", ps.length > 0);
    ps.forEach(function (p, pi) {
      sec.body.appendChild(renderPassiveCard(e, p, pi));
    });
    const add = el("button", { text: "＋ 被動" });
    add.onclick = function () {
      if (!e.passives) e.passives = [];
      const taken = e.passives.map(function (x) { return x.id; });
      e.passives.push({
        id: uniqueId("passive", taken), name: "新被動", trigger: "turnStart",
        target: "self",
        effects: [{ type: "focus", who: "self", amount: 3 }]
      });
      openKeys["passives"] = true;
      changed(true);
    };
    sec.body.appendChild(add);
    return sec.root;
  }

  function renderPassiveCard(e, p, pi) {
    const card = el("div", { cls: "sub-card" });
    const head = el("div", { cls: "sub-card-head" });
    head.appendChild(el("span", { cls: "title", text: p.name || p.id || ("被動 #" + (pi + 1)) }));
    head.appendChild(iconBtn("x", "刪除被動", function () {
      if (!confirm("刪除被動「" + (p.name || p.id) + "」？")) return;
      e.passives.splice(pi, 1);
      if (!e.passives.length) delete e.passives;
      changed(true);
    }, "danger"));
    card.appendChild(head);

    const g = el("div", { cls: "field-grid" });
    g.appendChild(fieldWrap("名稱", bindText(p, "name")));
    g.appendChild(fieldWrap("ID", bindText(p, "id")));
    g.appendChild(fieldWrap("觸發時機", bindSelect(p, "trigger", TRIGGER_OPTS, { structural: true })));
    card.appendChild(g);

    if (p.trigger !== "interceptOverride") {
      const g2 = el("div", { cls: "field-grid" });
      // chance 以 % 呈現
      const chanceInput = el("input"); chanceInput.type = "number"; chanceInput.min = 0; chanceInput.max = 100;
      chanceInput.value = p.chance !== undefined ? Math.round(p.chance * 100) : "";
      chanceInput.placeholder = "100（必定）";
      chanceInput.addEventListener("input", function () {
        if (chanceInput.value === "") delete p.chance;
        else p.chance = Math.max(0, Math.min(100, Number(chanceInput.value))) / 100;
        changed(false);
      });
      g2.appendChild(fieldWrap("觸發機率 %（留空=必定）", chanceInput));
      g2.appendChild(fieldWrap("目標", bindSelect(p, "target", TARGET_OPTS, { structural: true, def: "self" })));
      if (p.target === "randomEnemyWithout") {
        g2.appendChild(fieldWrap("排除已帶狀態", bindText(p, "targetState", { list: "dl-states" })));
      }
      card.appendChild(g2);
      card.appendChild(renderEffectList(e, p, "effects", "被動效果（turnEnd 施加的狀態自動豁免當回合層-1）"));
    } else {
      card.appendChild(el("div", { cls: "hint", text: "此被動使該 NPC 可攔截「攻擊玩家」的技能（§9 例外）。可加條件限制。" }));
    }

    // 可選條件
    const hasCond = !!p.condition;
    const lab = el("label", { cls: "row" });
    const cc = el("input"); cc.type = "checkbox"; cc.checked = hasCond;
    cc.addEventListener("change", function () {
      if (cc.checked) p.condition = { type: "hasState", who: "self", state: "", minLayer: 1 };
      else delete p.condition;
      changed(true);
    });
    lab.appendChild(cc); lab.appendChild(el("span", { text: " 附加條件（成立才生效）" }));
    card.appendChild(lab);
    if (hasCond) card.appendChild(renderConditionBuilder(p, "condition", {}));

    return card;
  }

  // ---- 初始狀態掛載 ----
  function renderStatesSection(e) {
    const names = e.states ? Object.keys(e.states) : [];
    const sec = detailsSec("states", "初始狀態掛載（§12B）", "（" + names.length + "）", names.length > 0);
    sec.body.appendChild(el("div", { cls: "hint", text: "開戰時就掛在身上的狀態（層/級）；印記與瀑標記也可在此預掛。" }));
    names.forEach(function (name) {
      const st = e.states[name];
      const row = el("div", { cls: "field-grid" });
      const nameI = el("input"); nameI.type = "text"; nameI.value = name; nameI.setAttribute("list", "dl-states");
      nameI.addEventListener("blur", function () {
        const nv = nameI.value.trim();
        if (!nv || nv === name) return;
        e.states[nv] = e.states[name]; delete e.states[name];
        changed(true);
      });
      row.appendChild(fieldWrap("狀態名", nameI));
      row.appendChild(fieldWrap("層", bindNum(st, "layer", { min: 0, deleteWhenEmpty: true })));
      row.appendChild(fieldWrap("級", bindNum(st, "level", { min: 0, deleteWhenEmpty: true })));
      const rm = iconBtn("x", "移除狀態", function () {
        delete e.states[name];
        if (!Object.keys(e.states).length) delete e.states;
        changed(true);
      }, "danger");
      const w = el("div", { cls: "field" }); w.appendChild(el("label", { text: " " })); w.appendChild(rm);
      row.appendChild(w);
      sec.body.appendChild(row);
    });
    const addRow = el("div", { cls: "row" });
    const newName = el("input"); newName.type = "text"; newName.placeholder = "狀態名"; newName.setAttribute("list", "dl-states");
    const addB = el("button", { text: "＋ 掛載狀態" });
    addB.onclick = function () {
      const nv = newName.value.trim();
      if (!nv) return;
      if (!e.states) e.states = {};
      if (!e.states[nv]) e.states[nv] = { layer: 1, level: 0 };
      newName.value = "";
      openKeys["states"] = true;
      changed(true);
    };
    addRow.appendChild(newName); addRow.appendChild(addB);
    sec.body.appendChild(addRow);
    return sec.root;
  }

  // ---------------- 右欄：即時預覽 + 驗證 ----------------
  function renderPreview() {
    const box = $("#entityPreview");
    box.innerHTML = "";
    if (selected < 0 || !roster[selected]) {
      box.appendChild(el("p", { cls: "preview-empty", text: "（尚未選擇角色）" }));
      return;
    }
    try {
      const ent = global.Data.makeEntity(deepClone(roster[selected]));
      global.Engine.computeEffectiveDex(ent);
      const card = global.UI.renderEntityCard(ent, true);
      box.appendChild(card);
      // 技能摘要
      const list = el("div");
      (roster[selected].skillLibrary || []).forEach(function (sk) {
        const line = el("div", { cls: "stat-line" });
        const left = el("span", { text: (sk.name || sk.id) + (sk.drawable === false ? "＊" : "") + "（" + (sk.type === "defense" ? "防" : "攻") + " 基" + (sk.basePower || 0) + "/+" + (sk.coinPower || 0) + "）" });
        const coins = el("span");
        (sk.coins || []).forEach(function (c) {
          const t = typeof c === "string" ? c : c.type;
          coins.appendChild(el("span", { cls: "coin " + t, text: "" }));
        });
        line.appendChild(left); line.appendChild(coins);
        list.appendChild(line);
      });
      box.appendChild(list);
    } catch (ex) {
      box.appendChild(el("p", { cls: "error", text: "預覽失敗：" + ex.message }));
    }
  }

  // ---------------- 驗證 ----------------
  function validateAll() {
    const errs = [];
    const ids = {};
    roster.forEach(function (e, i) {
      const label = e.name || e.id || ("#" + (i + 1));
      if (!e.id) errs.push({ msg: label + "：缺少 ID", idx: i });
      else if (ids[e.id]) errs.push({ msg: "ID「" + e.id + "」重複", idx: i });
      ids[e.id] = true;
      if (!e.name) errs.push({ msg: (e.id || "#" + (i + 1)) + "：缺少名稱", idx: i });
      if (!Array.isArray(e.skillLibrary) || !e.skillLibrary.length) {
        errs.push({ msg: label + "：至少要有一個技能", idx: i });
        return;
      }
      const skillIds = {};
      e.skillLibrary.forEach(function (sk) {
        if (!sk.id) errs.push({ msg: label + "：有技能缺少 ID", idx: i });
        else if (skillIds[sk.id]) errs.push({ msg: label + "：技能 ID「" + sk.id + "」重複", idx: i });
        skillIds[sk.id] = true;
        if (!sk.coins || !sk.coins.length) errs.push({ msg: label + "《" + (sk.name || sk.id) + "》：至少要有一枚硬幣", idx: i });
        ["useEffects", "hitEffects"].forEach(function (k) {
          (sk[k] || []).forEach(function (eff) {
            if (eff.type === "invokeSkill" && !skillIds[eff.skillId] && !e.skillLibrary.some(function (s) { return s.id === eff.skillId; })) {
              errs.push({ msg: label + "《" + (sk.name || sk.id) + "》喚出的技能「" + (eff.skillId || "?") + "」不存在", idx: i });
            }
            if (eff.type === "applyState" && !eff.state) {
              errs.push({ msg: label + "《" + (sk.name || sk.id) + "》有效果缺少狀態名", idx: i });
            }
          });
        });
      });
      if (e.slotMap) {
        ["A", "B", "C"].forEach(function (s) {
          const v = e.slotMap[s];
          if (v && !e.skillLibrary.some(function (sk) { return sk.id === v; })) {
            errs.push({ msg: label + "：slotMap " + s + " 指向不存在的技能「" + v + "」", idx: i });
          }
        });
      }
      (e.slotMapRules || []).forEach(function (r, ri) {
        if (r.setSkillId && !e.skillLibrary.some(function (sk) { return sk.id === r.setSkillId; })) {
          errs.push({ msg: label + "：形態規則 #" + (ri + 1) + " 指向不存在的技能", idx: i });
        }
      });
    });
    return errs;
  }

  function renderValidation() {
    const box = $("#editorValidation");
    if (!box) return;
    box.innerHTML = "";
    const errs = validateAll();
    if (!errs.length) return;
    const sum = el("div", { cls: "validation-summary" });
    sum.appendChild(el("div", { cls: "hint", text: "有 " + errs.length + " 個問題需修正：" }));
    errs.slice(0, 8).forEach(function (er) {
      const a = el("a", { text: er.msg });
      a.onclick = function () { selected = er.idx; renderEditor(); renderRosterList(); renderPreview(); };
      sum.appendChild(a);
    });
    if (errs.length > 8) sum.appendChild(el("div", { cls: "hint", text: "…以及另外 " + (errs.length - 8) + " 個" }));
    box.appendChild(sum);
  }

  // ---------------- PC 成長順序 ----------------
  function syncPcOrder() {
    const pcIds = roster.filter(function (e) { return e.isPC; }).map(function (e) { return e.id; });
    pcOrder = pcOrder.filter(function (id) { return pcIds.indexOf(id) !== -1; });
    pcIds.forEach(function (id) { if (pcOrder.indexOf(id) === -1) pcOrder.push(id); });
  }
  function renderPcOrder() {
    const box = $("#pcOrderList");
    if (!box) return;
    syncPcOrder();
    box.innerHTML = "";
    if (!pcOrder.length) { box.appendChild(el("p", { cls: "hint", text: "名單中沒有 PC。" })); return; }
    pcOrder.forEach(function (id, i) {
      const e = roster.find(function (x) { return x.id === id; });
      const item = el("div", { cls: "order-item" });
      item.appendChild(el("span", { cls: "oi-idx", text: String(i + 1) }));
      item.appendChild(el("span", { cls: "oi-name", text: e ? e.name : id }));
      item.appendChild(iconBtn("up", "往前移", function () {
        if (i === 0) return;
        const t = pcOrder[i - 1]; pcOrder[i - 1] = pcOrder[i]; pcOrder[i] = t;
        renderPcOrder(); changed(false);
      }));
      item.appendChild(iconBtn("down", "往後移", function () {
        if (i >= pcOrder.length - 1) return;
        const t = pcOrder[i + 1]; pcOrder[i + 1] = pcOrder[i]; pcOrder[i] = t;
        renderPcOrder(); changed(false);
      }));
      box.appendChild(item);
    });
  }

  // ---------------- JSON drawer ----------------
  function validateJsonText(showOk) {
    const raw = $("#rosterJson").value;
    const errBox = $("#rosterError");
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error("最外層必須是陣列（entities 清單）");
      data.forEach(function (e, i) {
        if (!e.id) throw new Error("第 " + (i + 1) + " 個實體缺少 id");
        if (!Array.isArray(e.skillLibrary) || !e.skillLibrary.length) throw new Error((e.id || "#" + (i + 1)) + " 缺少 skillLibrary");
      });
      if (showOk) { errBox.style.color = "var(--color-success)"; errBox.textContent = "JSON 驗證通過，共 " + data.length + " 個實體。"; }
      return data;
    } catch (err) {
      let msg = err.message;
      const m = /position (\d+)/.exec(msg);
      if (m) {
        const pos = Number(m[1]);
        const upto = raw.slice(0, pos);
        msg += "（約第 " + upto.split("\n").length + " 行、第 " + (pos - upto.lastIndexOf("\n")) + " 欄）";
      }
      errBox.style.color = "";
      errBox.textContent = "JSON 錯誤：" + msg;
      return null;
    }
  }
  function applyJsonToForm() {
    const data = validateJsonText(false);
    if (!data) return;
    roster = data;
    syncPcOrder();
    selected = roster.length ? Math.min(selected < 0 ? 0 : selected, roster.length - 1) : -1;
    renderAll(); changed(false);
    $("#rosterError").style.color = "var(--color-success)";
    $("#rosterError").textContent = "已套用到表單（" + roster.length + " 個角色）。";
  }

})(window);

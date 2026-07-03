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

  // ---------------- 詞彙（口語化） ----------------
  const WHO_OPTS = [{ v: "self", t: "自己" }, { v: "target", t: "對方" }];
  const EFFECT_TYPES = {
    applyState: { label: "施加狀態／印記" },
    invokeSkill: { label: "直接使出另一招" },
    burstResonance: { label: "引爆瀑（殘響）" },
    tremorBurst: { label: "引爆震顫（爆發）" },
    heal: { label: "回復 HP" },
    tempHp: { label: "給臨時生命值" },
    focus: { label: "增減專注力" }
  };
  // 條件動詞（會嵌在句子裡，位置依型別不同）
  const COND_TYPES = {
    hasState: "帶有",
    stateLayerEquals: "的層數恰好等於",
    stateLevelEquals: "的級數恰好等於",
    always: "永遠成立"
  };
  const TRIGGER_OPTS = [
    { v: "turnStart", t: "每回合開始時" },
    { v: "turnEnd", t: "每回合結束時" },
    { v: "interceptOverride", t: "攔截例外（可攔打向玩家的攻擊）" }
  ];
  const TARGET_OPTS = [
    { v: "self", t: "自己" },
    { v: "randomEnemy", t: "隨機一個敵人" },
    { v: "randomEnemyWithout", t: "隨機一個「還沒帶某狀態」的敵人" },
    { v: "lowestHpEnemy", t: "血量最低的敵人" },
    { v: "allEnemies", t: "全體敵人" },
    { v: "randomAlly", t: "隨機一個隊友" }
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

  // ---------------- 句子式建構器小工具 ----------------
  // sentence("對", sel, "施加", num, "層") → 行內混排的可讀句子
  function sentence() {
    const w = el("div", { cls: "sentence" });
    for (let i = 0; i < arguments.length; i++) {
      const p = arguments[i];
      if (p === null || p === undefined) continue;
      if (typeof p === "string") w.appendChild(el("span", { cls: "s-text", text: p }));
      else w.appendChild(p);
    }
    return w;
  }
  function inlineNum(obj, key, opts) {
    const i = bindNum(obj, key, opts);
    i.classList.add("inline-num");
    if (opts && opts.aria) i.setAttribute("aria-label", opts.aria);
    return i;
  }

  // ---------------- 印記自動蒐集 ----------------
  // 走訪整份名單，蒐集所有被引用的「自訂狀態／印記」名（不在通用清單者）
  function walkCond(c, cb) {
    if (!c) return;
    if (c.type === "not") return walkCond(c.cond, cb);
    if (c.type === "and" || c.type === "or") return (c.conds || []).forEach(function (x) { walkCond(x, cb); });
    if (c.state) cb(c.state);
  }
  function collectCustomStates() {
    const generic = knownStates();
    const byOwner = {}; // entityIndex -> Set(names)
    roster.forEach(function (e, idx) {
      const found = {};
      const add = function (name) { if (name && generic.indexOf(name) === -1) found[name] = true; };
      Object.keys(e.states || {}).forEach(add);
      (e.skillLibrary || []).forEach(function (sk) {
        ["useEffects", "hitEffects"].forEach(function (k) {
          (sk[k] || []).forEach(function (eff) {
            if (eff.type === "applyState") add(eff.state);
            walkCond(eff.condition, add);
          });
        });
        (sk.conditions || []).forEach(function (c) { walkCond(c.condition, add); });
      });
      (e.slotMapRules || []).forEach(function (r) { walkCond(r.condition, add); });
      (e.passives || []).forEach(function (p) {
        walkCond(p.condition, add);
        add(p.targetState);
        (p.effects || []).forEach(function (eff) {
          if (eff.type === "applyState") add(eff.state);
          walkCond(eff.condition, add);
        });
      });
      byOwner[idx] = Object.keys(found);
    });
    return byOwner;
  }

  // 狀態下拉：通用狀態／本角色的印記／其他角色的印記 分組 + 「＋新印記…」就地輸入
  function stateSelect(obj, key, opts) {
    opts = opts || {};
    const holder = el("span", { cls: "state-select-holder" });

    function build() {
      holder.innerHTML = "";
      const cur = obj[key] || "";
      const byOwner = collectCustomStates();
      const own = (selected >= 0 && byOwner[selected]) ? byOwner[selected] : [];
      const others = [];
      Object.keys(byOwner).forEach(function (idx) {
        if (Number(idx) === selected) return;
        byOwner[idx].forEach(function (n) {
          if (own.indexOf(n) === -1 && others.indexOf(n) === -1) others.push(n);
        });
      });

      const s = el("select");
      s.setAttribute("aria-label", opts.aria || "狀態名");
      if (!cur) {
        const ph = el("option", { text: "（選狀態…）" }); ph.value = ""; s.appendChild(ph);
      } else if (knownStates().indexOf(cur) === -1 && own.indexOf(cur) === -1 && others.indexOf(cur) === -1) {
        const o = el("option", { text: cur }); o.value = cur; s.appendChild(o);
      }
      function group(label, names) {
        if (!names.length) return;
        const g = el("optgroup"); g.label = label;
        names.forEach(function (n) { const o = el("option", { text: n }); o.value = n; g.appendChild(o); });
        s.appendChild(g);
      }
      group("通用狀態", knownStates());
      group("本角色的印記", own);
      group("其他角色的印記", others);
      const nw = el("option", { text: "＋ 新印記（自己命名）…" }); nw.value = "__new__"; s.appendChild(nw);
      s.value = cur;

      s.addEventListener("change", function () {
        if (s.value === "__new__") {
          // 換成就地輸入框
          const inp = el("input"); inp.type = "text"; inp.placeholder = "印記名（例：lady_gaze）";
          inp.setAttribute("aria-label", "新印記名稱");
          inp.classList.add("inline-text");
          holder.innerHTML = ""; holder.appendChild(inp);
          inp.focus();
          let done = false;
          function commitNew() {
            if (done) return; done = true;
            const v = inp.value.trim();
            if (v) { obj[key] = v; if (opts.onSet) opts.onSet(); else changed(true); }
            else build(); // 取消 → 還原下拉
          }
          inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); commitNew(); } });
          inp.addEventListener("blur", commitNew);
          return;
        }
        obj[key] = s.value;
        // onSet：條件列等「檢視模型」需經 commit 寫回真模型時使用
        if (opts.onSet) opts.onSet(); else changed(true); // 重繪讓其他下拉同步取得新引用
      });
      holder.appendChild(s);
    }
    build();
    return holder;
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
    sum.appendChild(el("span", { cls: "hint", text: (sk.type === "defense" ? "防禦" : "攻擊") + "｜基礎" + (sk.basePower || 0) + "｜每枚+" + (sk.coinPower || 0) + "｜" + (sk.coins || []).length + "枚硬幣" }));
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
    grid.appendChild(fieldWrap("每枚硬幣加成", bindNum(sk, "coinPower", { min: 0 }), "每擲出一枚正面，威力就加這麼多"));
    body.appendChild(grid);

    // drawable 反向呈現：勾＝隱藏技
    const hid = el("label", { cls: "row" });
    const hc = el("input"); hc.type = "checkbox"; hc.checked = sk.drawable === false;
    hc.addEventListener("change", function () {
      if (hc.checked) sk.drawable = false; else delete sk.drawable;
      changed(false);
    });
    hid.appendChild(hc);
    hid.appendChild(el("span", { text: " 隱藏技（平常骰不到；要靠「形態轉換」換上、或被「直接使出另一招」打出）" }));
    body.appendChild(hid);

    // 硬幣（有序）
    body.appendChild(el("div", { cls: "hint", text: "硬幣（順序＝拚輸時的損幣順序）" }));
    body.appendChild(renderCoinRow(sk));

    // 情境加成（render 不動模型）
    const condSec = el("div", { cls: "sub-sub" });
    condSec.appendChild(el("div", { cls: "hint", text: "情境加成——滿足條件時這招威力變化（例：對方帶有某印記時更痛）" }));
    (sk.conditions || []).forEach(function (c, ci) {
      const row = el("div", { cls: "sub-card" });
      const head = el("div", { cls: "sub-card-head" });
      head.appendChild(el("span", { cls: "title", text: "情境加成 #" + (ci + 1) }));
      head.appendChild(iconBtn("x", "刪除這條情境加成", function () { sk.conditions.splice(ci, 1); if (!sk.conditions.length) delete sk.conditions; changed(true); }, "danger"));
      row.appendChild(head);
      row.appendChild(el("div", { cls: "hint", text: "當…" }));
      row.appendChild(renderConditionBuilder(c, "condition", { required: true }));
      row.appendChild(sentence(
        "…成立時，基礎威力",
        inlineNum(c, "basePowerDelta", { deleteWhenEmpty: true, aria: "基礎威力增減" }),
        "、每枚硬幣加成",
        inlineNum(c, "coinPowerDelta", { deleteWhenEmpty: true, aria: "每枚硬幣加成增減" }),
        "（正加負減，留空＝不變）"
      ));
      condSec.appendChild(row);
    });
    const addCond = el("button", { text: "＋ 情境加成" });
    addCond.onclick = function () {
      if (!sk.conditions) sk.conditions = [];
      sk.conditions.push({ condition: { type: "hasState", who: "target", state: "", minLayer: 1 }, basePowerDelta: 0 });
      changed(true);
    };
    condSec.appendChild(addCond);
    body.appendChild(condSec);

    // 效果
    body.appendChild(renderEffectList(e, sk, "useEffects", "出招時（不論拚點輸贏都會發生）"));
    body.appendChild(renderEffectList(e, sk, "hitEffects", "命中時（打中對方／防禦成功後發生）"));

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

    const t = eff.type;
    // who 顯示預設須對齊引擎預設：瀑/震顫爆發缺 who＝對方，其餘缺 who＝自己
    const whoDef = (t === "burstResonance" || t === "tremorBurst") ? "target" : "self";
    const whoSel = bindSelect(eff, "who", WHO_OPTS, { def: whoDef });
    whoSel.setAttribute("aria-label", "效果對象");
    whoSel.classList.add("inline-sel");

    if (t === "applyState") {
      card.appendChild(sentence(
        "對", whoSel, "施加",
        inlineNum(eff, "layerDelta", { deleteWhenEmpty: true, aria: "層數" }), "層",
        inlineNum(eff, "levelDelta", { deleteWhenEmpty: true, aria: "級數" }), "級的",
        stateSelect(eff, "state", { aria: "要施加的狀態" })
      ));
      card.appendChild(bindCheck(eff, "isMark", "這是印記（純標籤，效果寫在讀取它的技能裡；瀑標記會自動視為印記）", { deleteWhenFalse: true }));
    } else if (t === "invokeSkill") {
      const opts = entity.skillLibrary.map(function (s) { return { v: s.id, t: (s.name || s.id) + (s.drawable === false ? "（隱藏技）" : "") }; });
      const skillSel = bindSelect(eff, "skillId", opts.length ? opts : [{ v: "", t: "（還沒有技能）" }]);
      skillSel.setAttribute("aria-label", "要使出的技能"); skillSel.classList.add("inline-sel");
      const dirSel = bindSelect(eff, "targetRef", [{ v: "target", t: "原本的對手" }, { v: "self", t: "自己" }], { def: "target" });
      dirSel.setAttribute("aria-label", "打向誰"); dirSel.classList.add("inline-sel");
      card.appendChild(sentence("直接使出", skillSel, "，打向", dirSel, "（不用骰選，直接結算）"));
    } else if (t === "burstResonance") {
      const burstSel = bindSelect(eff, "burst", global.Data.BURST_TAGS.map(function (b) { return { v: b, t: b }; }));
      burstSel.setAttribute("aria-label", "引爆哪種瀑"); burstSel.classList.add("inline-sel");
      const partner = global.Data.BURST_PARTNER[eff.burst || "血瀑"];
      card.appendChild(sentence(
        "引爆", whoSel, "身上的", burstSel,
        "（扣血與混亂值上修都是 ⌊(震顫＋" + partner + ")×50%⌋，之後兩者歸零、標記保留）"
      ));
    } else if (t === "tremorBurst") {
      card.appendChild(sentence(
        "引爆", whoSel, "累積的震顫（混亂值上修＝震顫級數，之後震顫歸零，不扣血）"
      ));
    } else if (t === "heal") {
      card.appendChild(sentence("讓", whoSel, "回復", inlineNum(eff, "amount", { aria: "回復量" }), "點 HP"));
    } else if (t === "tempHp") {
      card.appendChild(sentence("給", whoSel, inlineNum(eff, "amount", { aria: "臨時生命值" }), "點臨時生命值（回合結束消失）"));
    } else { // focus
      card.appendChild(sentence("讓", whoSel, "的專注力增減", inlineNum(eff, "amount", { aria: "專注力增減量" }), "點（正加負減）"));
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
    condToggle.appendChild(el("span", { text: " 只在特定條件下才觸發（加上條件）" }));
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
    modeSel.setAttribute("aria-label", "條件組合方式");
    modeSel.classList.add("inline-sel");
    [["single", "只需這一個條件"], ["and", "以下全部成立才算"], ["or", "以下任一成立就算"]].forEach(function (p) {
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
    negLab.appendChild(negC); negLab.appendChild(el("span", { text: " 反過來（上面不成立時才算成立）" }));
    ctrlRow.appendChild(modeSel); ctrlRow.appendChild(negLab);
    wrap.appendChild(ctrlRow);

    simples.forEach(function (sc, i) {
      wrap.appendChild(renderSimpleCondRow(sc, simples, i, mode, commit));
    });
    if (mode !== "single") {
      const add = el("button", { text: "＋ 再加一個條件" });
      add.onclick = function () { simples.push({ type: "hasState", who: "self", state: "", minLayer: 1 }); commit(); };
      wrap.appendChild(add);
    }
    return wrap;
  }

  function renderSimpleCondRow(sc, arr, i, mode, commit) {
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
    typeSel.setAttribute("aria-label", "條件種類");
    typeSel.classList.add("inline-sel");

    const whoSel = (function () {
      const s = el("select");
      s.setAttribute("aria-label", "誰身上");
      s.classList.add("inline-sel");
      WHO_OPTS.forEach(function (o) { const op = el("option", { text: o.t }); op.value = o.v; s.appendChild(op); });
      s.value = sc.who || "self";
      s.addEventListener("change", function () { sc.who = s.value; commit(); });
      return s;
    })();
    const stateSel = stateSelect(sc, "state", { aria: "哪個狀態", onSet: commit });

    let row;
    if (sc.type === "always") {
      row = sentence(typeSel, "（不設任何限制）");
    } else if (sc.type === "hasState") {
      const n1 = numQuick(sc, "minLayer", commit); n1.classList.add("inline-num"); n1.setAttribute("aria-label", "至少幾層");
      const n2 = numQuick(sc, "minLevel", commit, true); n2.classList.add("inline-num"); n2.setAttribute("aria-label", "至少幾級可留空");
      row = sentence(whoSel, "身上", typeSel, stateSel, "，至少", n1, "層、", n2, "級（級留空＝不限）");
    } else {
      const nv = numQuick(sc, "value", commit); nv.classList.add("inline-num"); nv.setAttribute("aria-label", "等於多少");
      row = sentence(whoSel, "身上", stateSel, typeSel, nv);
    }
    if (mode !== "single") {
      row.appendChild(iconBtn("x", "刪除這個子條件", function () { arr.splice(i, 1); if (!arr.length) arr.push({ type: "always" }); commit(); }, "danger"));
    }
    return row;
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
    const sec = detailsSec("slotmap", "骰面對應（1d6 抽技能）", "骰到 1–3 用 A、4–5 用 B、6 用 C", true);
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
    const sec = detailsSec("smrules", "形態轉換（換招規則）", "（" + rules.length + "）", rules.length > 0);
    sec.body.appendChild(el("div", { cls: "hint", text: "每回合開始時檢查：條件成立就把某個骰面槽位換成另一招（可換上隱藏技＝解鎖）。" }));
    rules.forEach(function (r, ri) {
      const card = el("div", { cls: "sub-card" });
      const head = el("div", { cls: "sub-card-head" });
      head.appendChild(el("span", { cls: "title", text: "換招規則 #" + (ri + 1) }));
      head.appendChild(iconBtn("x", "刪除這條換招規則", function () {
        e.slotMapRules.splice(ri, 1);
        if (!e.slotMapRules.length) delete e.slotMapRules;
        changed(true);
      }, "danger"));
      card.appendChild(head);
      card.appendChild(el("div", { cls: "hint", text: "當…" }));
      card.appendChild(renderConditionBuilder(r, "condition", { required: true }));
      const slotSel = bindSelect(r, "slot", [{ v: "A", t: "A（骰1–3）" }, { v: "B", t: "B（骰4–5）" }, { v: "C", t: "C（骰6）" }]);
      slotSel.setAttribute("aria-label", "改哪個槽位"); slotSel.classList.add("inline-sel");
      const opts = (e.skillLibrary || []).map(function (sk) { return { v: sk.id, t: (sk.name || sk.id) + (sk.drawable === false ? "（隱藏技）" : "") }; });
      const skillSel = bindSelect(r, "setSkillId", opts.length ? opts : [{ v: "", t: "（還沒有技能）" }]);
      skillSel.setAttribute("aria-label", "換成哪招"); skillSel.classList.add("inline-sel");
      card.appendChild(sentence(
        "…成立時，把槽位", slotSel, "換成", skillSel,
        "（優先度", inlineNum(r, "priority", { deleteWhenEmpty: true, aria: "優先度" }), "，多條同時成立時數字大的蓋過小的）"
      ));
      sec.body.appendChild(card);
    });
    const add = el("button", { text: "＋ 換招規則" });
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

  // ---- 被動能力 ----
  function renderPassivesSection(e) {
    const ps = e.passives || [];
    const sec = detailsSec("passives", "被動能力", "（" + ps.length + "）", ps.length > 0);
    ps.forEach(function (p, pi) {
      sec.body.appendChild(renderPassiveCard(e, p, pi));
    });
    const add = el("button", { text: "＋ 被動能力" });
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
    card.appendChild(g);

    const trigSel = bindSelect(p, "trigger", TRIGGER_OPTS, { structural: true });
    trigSel.setAttribute("aria-label", "觸發時機"); trigSel.classList.add("inline-sel");

    if (p.trigger !== "interceptOverride") {
      // chance 以 % 呈現
      const chanceInput = el("input"); chanceInput.type = "number"; chanceInput.min = 0; chanceInput.max = 100;
      chanceInput.classList.add("inline-num");
      chanceInput.setAttribute("aria-label", "觸發機率百分比");
      chanceInput.value = p.chance !== undefined ? Math.round(p.chance * 100) : "";
      chanceInput.placeholder = "100";
      chanceInput.addEventListener("input", function () {
        if (chanceInput.value === "") delete p.chance;
        else p.chance = Math.max(0, Math.min(100, Number(chanceInput.value))) / 100;
        changed(false);
      });
      const targetSel = bindSelect(p, "target", TARGET_OPTS, { structural: true, def: "self" });
      targetSel.setAttribute("aria-label", "被動的目標"); targetSel.classList.add("inline-sel");

      const parts = [trigSel, "，有", chanceInput, "% 的機率（留空＝必定），對", targetSel];
      if (p.target === "randomEnemyWithout") {
        parts.push("（還沒帶");
        parts.push(stateSelect(p, "targetState", { aria: "排除已帶的狀態" }));
        parts.push("的才算）");
      }
      parts.push("做以下效果：");
      card.appendChild(sentence.apply(null, parts));
      card.appendChild(renderEffectList(e, p, "effects", "（回合結束時施加的狀態，會自動撐過當回合的層數-1）"));
    } else {
      card.appendChild(sentence(trigSel, "：讓這個角色可以攔截打向玩家的攻擊（規則書 §9 的例外）。"));
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
    lab.appendChild(cc); lab.appendChild(el("span", { text: " 只在特定條件下才生效（加上條件）" }));
    card.appendChild(lab);
    if (hasCond) card.appendChild(renderConditionBuilder(p, "condition", {}));

    return card;
  }

  // ---- 開場自帶狀態 ----
  function renderStatesSection(e) {
    const names = e.states ? Object.keys(e.states) : [];
    const sec = detailsSec("states", "開場自帶狀態", "（" + names.length + "）", names.length > 0);
    sec.body.appendChild(el("div", { cls: "hint", text: "戰鬥一開始就掛在身上的狀態；印記與瀑標記也可以在這裡預掛。" }));
    names.forEach(function (name) {
      const st = e.states[name];
      // 改名走檢視模型 + onSet（下拉選別的名字＝改名）
      const tmp = { n: name };
      const nameSel = stateSelect(tmp, "n", {
        aria: "狀態名", onSet: function () {
          const nv = (tmp.n || "").trim();
          if (!nv || nv === name) { changed(true); return; }
          e.states[nv] = e.states[name]; delete e.states[name];
          changed(true);
        }
      });
      const row = sentence(
        "開場帶著", nameSel,
        "，", inlineNum(st, "layer", { min: 0, deleteWhenEmpty: true, aria: "層數" }), "層、",
        inlineNum(st, "level", { min: 0, deleteWhenEmpty: true, aria: "級數" }), "級"
      );
      row.appendChild(iconBtn("x", "移除這個開場狀態", function () {
        delete e.states[name];
        if (!Object.keys(e.states).length) delete e.states;
        changed(true);
      }, "danger"));
      sec.body.appendChild(row);
    });
    // 新增：下拉選好（或命名新印記）按加入
    const tmpNew = { n: "" };
    const addSel = stateSelect(tmpNew, "n", { aria: "要掛載的狀態", onSet: function () {} });
    const addB = el("button", { text: "＋ 掛上這個狀態" });
    addB.onclick = function () {
      const nv = (tmpNew.n || "").trim();
      if (!nv) return;
      if (!e.states) e.states = {};
      if (!e.states[nv]) e.states[nv] = { layer: 1, level: 0 };
      openKeys["states"] = true;
      changed(true);
    };
    sec.body.appendChild(sentence("讓這個角色開場帶著", addSel, addB));
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

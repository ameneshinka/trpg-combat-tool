// ============================================================
// UI：角色詳情浮窗
// 點角色卡（或設定畫面的名單列）開啟 → 查該角色的技能文本、被動文本、
// 硬幣序列、形態轉換、目前狀態；並提供 KP 的數值臨時覆寫（從卡面搬進來，
// 讓戰鬥儀表板保持乾淨）。
//
// 無障礙：role="dialog" aria-modal、Escape 關閉、點背景關閉、focus trap、
// 關閉後把焦點還回觸發元件。
// ============================================================
(function (global) {
  "use strict";
  const Detail = global.Detail = {};
  const S = global.States;
  const el = function (t, o) { return global.Panels.el(t, o); };

  let overlay = null;
  let lastFocused = null;
  let onChangeCb = null;
  let currentEntity = null;

  const COIN_LABEL = { normal: "普", red: "紅", green: "綠" };

  // ---------------- 開關 ----------------
  function open(entity, opts) {
    opts = opts || {};
    close(); // 保證只有一個
    currentEntity = entity;
    onChangeCb = opts.onChange || null;
    lastFocused = document.activeElement;

    overlay = el("div", { cls: "modal-overlay" });
    overlay.addEventListener("mousedown", function (ev) {
      if (ev.target === overlay) close(); // 只有點在背景才關
    });

    const dialog = el("div", { cls: "modal" });
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", entity.name + " 的角色詳情");
    dialog.appendChild(renderContent(entity, opts));
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");

    document.addEventListener("keydown", onKeydown, true);
    // 首個可聚焦元素（關閉鈕）
    const first = dialog.querySelector("button, input, select, [tabindex]");
    if (first) first.focus();
  }
  Detail.open = open;

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
    overlay = null;
    document.body.classList.remove("modal-open");
    currentEntity = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }
  Detail.close = close;
  Detail.isOpen = function () { return !!overlay; };

  function onKeydown(ev) {
    if (!overlay) return;
    if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
    if (ev.key !== "Tab") return;
    // focus trap
    const focusables = overlay.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  // 內容重繪（調值後即時反映，不關窗）
  function refresh() {
    if (!overlay || !currentEntity) return;
    const dialog = overlay.querySelector(".modal");
    const scroll = dialog.scrollTop;
    dialog.innerHTML = "";
    dialog.appendChild(renderContent(currentEntity, { kpControls: true }));
    dialog.scrollTop = scroll;
    if (onChangeCb) onChangeCb();
  }

  // ---------------- 內容 ----------------
  function renderContent(e, opts) {
    const frag = document.createDocumentFragment();

    // 標題列
    const head = el("div", { cls: "modal-head" });
    const titleWrap = el("div");
    titleWrap.appendChild(el("h3", { cls: "modal-title", text: e.name }));
    const sub = el("div", { cls: "hint" });
    sub.textContent = (e.isPC ? "PC" : "NPC") + "　id: " + e.id +
      (e.notes ? "　│　" + e.notes : "");
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);
    const closeBtn = el("button", { cls: "modal-close", text: "關閉" });
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "關閉角色詳情");
    closeBtn.onclick = close;
    head.appendChild(closeBtn);
    frag.appendChild(head);

    // ---- 數值總覽 ----
    const sec1 = section("數值");
    const grid = el("div", { cls: "detail-grid" });
    const dexEff = S.effectiveDex(e);
    kv(grid, "HP", e.hp + " / " + e.maxHp + (e.tempHp > 0 ? "（臨時 +" + e.tempHp + "）" : ""));
    kv(grid, "混亂值", thresholdsText(e));
    kv(grid, "有效 DEX", dexEff.toFixed(1) + (Math.abs(dexEff - e.dex) > 0.05 ? "（原 " + e.dex + "）" : ""));
    kv(grid, "專注力", (e.focus > 0 ? "+" : "") + e.focus + "　→ 正面率 " + Math.round(S.headsProbability(e.focus) * 100) + "%");
    kv(grid, "槽位", e.slots || 0);
    const a = e.attributes || {};
    kv(grid, "屬性", ["STR", "INT", "CON", "SIZ", "LUK"].map(function (k) { return k + " " + (a[k] !== undefined ? a[k] : "—"); }).join("　"));
    sec1.appendChild(grid);
    if (e.confusionLockTurns > 0) sec1.appendChild(el("p", { cls: "hint warn-text", text: "⚠ 混亂中，剩 " + e.confusionLockTurns + " 回合無法行動（恢復時血量不動）" }));
    if (e.isPanicking) sec1.appendChild(el("p", { cls: "hint warn-text", text: "⚠ 本回合恐慌，無法行動" }));
    if (e.panicNextTurn) sec1.appendChild(el("p", { cls: "hint warn-text", text: "⚠ 專注力已跨越 −40，下回合進入恐慌" }));
    if (e.panicRecovering) sec1.appendChild(el("p", { cls: "hint", text: "恐慌恢復中：下回合開始時專注力歸 0" }));
    frag.appendChild(sec1);

    // ---- 資源 ----
    const resKeys = Object.keys(e.resources || {});
    if (resKeys.length) {
      const sec = section("自訂數值資源");
      sec.appendChild(el("p", { cls: "hint", text: "彈匣類資源，與專注力並列的獨立欄位 —— 不走層數管線，不會自然衰減。" }));
      const box = el("div", { cls: "res-list" });
      resKeys.forEach(function (k) {
        const max = e.resourceMax && e.resourceMax[k];
        box.appendChild(el("span", { cls: "res-chip", text: k + " " + e.resources[k] + (max ? " / " + max : "") }));
      });
      sec.appendChild(box);
      if (opts.kpControls) sec.appendChild(resourceControls(e));
      frag.appendChild(sec);
    }

    // ---- 目前狀態 ----
    const secSt = section("目前狀態");
    const generic = [], marks = [];
    Object.keys(e.states || {}).forEach(function (name) {
      const st = e.states[name];
      if (st.isBurstTag) { marks.push({ name: name, st: st, tagOnly: true }); return; }
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) return;
      const known = S.LAYER_DRIVEN.indexOf(name) !== -1 || S.LEVEL_DRIVEN.indexOf(name) !== -1;
      (known ? generic : marks).push({ name: name, st: st, tagOnly: false });
    });
    if (!generic.length && !marks.length) {
      secSt.appendChild(el("p", { cls: "hint", text: "（目前沒有任何狀態）" }));
    }
    if (generic.length) {
      secSt.appendChild(el("div", { cls: "sub-label", text: "通用狀態" }));
      secSt.appendChild(stateRows(generic));
    }
    if (marks.length) {
      secSt.appendChild(el("div", { cls: "sub-label mark-label", text: "印記／瀑標記" }));
      secSt.appendChild(stateRows(marks));
    }
    frag.appendChild(secSt);

    // ---- 骰面對應 ----
    const secMap = section("骰面對應（1d6 抽技能）");
    secMap.appendChild(el("p", { cls: "hint", text: "骰 1–3 → 槽位A、4–5 → 槽位B、6 → 槽位C（機率 75% / 55.6% / 30.6%）。骰到重複不重骰。" }));
    const mapGrid = el("div", { cls: "detail-grid" });
    ["A", "B", "C"].forEach(function (slot) {
      const id = (e.slotMap || {})[slot];
      const sk = id ? findSkill(e, id) : null;
      const dflt = (e.defaultSlotMap || {})[slot];
      let v = sk ? sk.name : "（空）";
      if (dflt && dflt !== id) {
        const dsk = findSkill(e, dflt);
        v += "　← 已被形態轉換替換（原本：" + (dsk ? dsk.name : dflt) + "）";
      }
      kv(mapGrid, "槽位 " + slot, v);
    });
    secMap.appendChild(mapGrid);
    if ((e.slotMapRules || []).length) {
      secMap.appendChild(el("div", { cls: "sub-label", text: "形態轉換規則" }));
      e.slotMapRules.forEach(function (r, i) {
        const sk = findSkill(e, r.setSkillId);
        secMap.appendChild(el("p", {
          cls: "hint",
          text: "#" + (i + 1) + "　條件成立時把槽位 " + r.slot + " 換成《" +
            (sk ? sk.name : r.setSkillId) + "》（優先度 " + (r.priority || 0) + "，大的蓋過小的）"
        }));
      });
    }
    frag.appendChild(secMap);

    // ---- 技能 ----
    const attackSkills = (e.skillLibrary || []).filter(function (s) { return s.type !== "defense"; });
    const defenseSkills = (e.skillLibrary || []).filter(function (s) { return s.type === "defense"; });
    const secSk = section("技能文本");
    if (!attackSkills.length && !defenseSkills.length) {
      secSk.appendChild(el("p", { cls: "hint", text: "（尚未填寫技能）" }));
    }
    if (attackSkills.length) {
      secSk.appendChild(el("div", { cls: "sub-label", text: "攻擊型" }));
      attackSkills.forEach(function (sk) { secSk.appendChild(skillCard(e, sk)); });
    }
    if (defenseSkills.length) {
      secSk.appendChild(el("div", { cls: "sub-label", text: "防禦型（不受抽選限制，各佔一槽，同回合可多次）" }));
      defenseSkills.forEach(function (sk) { secSk.appendChild(skillCard(e, sk)); });
    }
    frag.appendChild(secSk);

    // ---- 被動 ----
    const secPas = section("被動文本");
    const ids = e.passives || [];
    if (!ids.length) {
      secPas.appendChild(el("p", { cls: "hint", text: "（沒有被動）" }));
    } else {
      ids.forEach(function (pid) {
        const p = global.Passives && global.Passives.get ? global.Passives.get(pid) : null;
        const card = el("div", { cls: "detail-card" });
        if (!p) {
          card.classList.add("missing");
          card.appendChild(el("div", { cls: "dc-head" },
            card.appendChild(el("span", { cls: "dc-name", text: pid }))));
          card.appendChild(el("p", { cls: "error", text: "⚠ 找不到這個被動的定義（engine/passives.js 沒有註冊 id：" + pid + "）" }));
          secPas.appendChild(card);
          return;
        }
        const h = el("div", { cls: "dc-head" });
        h.appendChild(el("span", { cls: "dc-name", text: p.name || p.id }));
        h.appendChild(el("span", {
          cls: "tag " + (p.kind === "cost" ? "warn" : ""),
          text: p.kind === "cost" ? "消耗資源類" : "給予增益類"
        }));
        if (p.allowsInterceptingPlayers) h.appendChild(el("span", { cls: "tag order", text: "攔截例外" }));
        card.appendChild(h);
        card.appendChild(el("p", { cls: "dc-text", text: p.text || "（尚未填寫被動文本）" }));
        const hooks = ["onTurnStart", "onTurnEnd", "onAllyTremorBurst", "onHit", "onClashWin", "onClashLose"]
          .filter(function (k) { return typeof p[k] === "function"; });
        if (hooks.length) card.appendChild(el("p", { cls: "hint", text: "觸發時機：" + hooks.join("、") }));
        // tuning：調平衡的數字
        const t = e.tuning || {};
        const tkeys = Object.keys(t);
        if (tkeys.length) {
          card.appendChild(el("p", { cls: "hint", text: "可調參數（tuning）：" + tkeys.map(function (k) { return k + "=" + t[k]; }).join("、") }));
        }
        secPas.appendChild(card);
      });
    }
    frag.appendChild(secPas);

    // ---- KP 操作區 ----
    if (opts.kpControls) {
      const secKp = section("KP 數值臨時覆寫");
      secKp.appendChild(el("p", { cls: "hint", text: "桌邊發現不對可當場調（只改數字、不改邏輯）；事後回頭改 data/characters.js。" }));
      secKp.appendChild(kpNumbers(e));
      secKp.appendChild(stateEditor(e));
      frag.appendChild(secKp);
    }

    return frag;
  }

  // ---------------- 小元件 ----------------
  function section(title) {
    const s = el("section", { cls: "modal-section" });
    s.appendChild(el("h4", { cls: "modal-sec-title", text: title }));
    return s;
  }
  function kv(grid, k, v) {
    grid.appendChild(el("div", { cls: "dk", text: k }));
    grid.appendChild(el("div", { cls: "dv", text: String(v) }));
  }
  function thresholdsText(e) {
    const th = (e.confusionThresholds && e.confusionThresholds.length)
      ? e.confusionThresholds.slice() : [Math.floor(e.maxHp * 0.6), 0];
    return th.sort(function (x, y) { return y - x; }).join(" / ") + "（血量低於或等於即進入混亂）";
  }
  function findSkill(e, id) {
    return (e.skillLibrary || []).find(function (s) { return s.id === id; }) || null;
  }

  function skillCard(e, sk) {
    const card = el("div", { cls: "detail-card" });
    const h = el("div", { cls: "dc-head" });
    h.appendChild(el("span", { cls: "dc-name", text: sk.name }));
    h.appendChild(el("span", { cls: "tag", text: sk.type === "defense" ? "防禦" : "攻擊" }));
    if (sk.drawable === false) h.appendChild(el("span", { cls: "tag warn", text: "隱藏技（骰不到）" }));
    if (sk.isGuard) h.appendChild(el("span", { cls: "tag order", text: "防守" }));
    if (sk.isDodge) h.appendChild(el("span", { cls: "tag order", text: "閃躲" }));
    // 這招目前掛在哪個骰面槽位
    ["A", "B", "C"].forEach(function (slot) {
      if ((e.slotMap || {})[slot] === sk.id) h.appendChild(el("span", { cls: "tag", text: "槽位 " + slot }));
    });
    card.appendChild(h);

    const nums = el("div", { cls: "dc-nums" });
    nums.appendChild(el("span", { text: "基礎威力 " + sk.basePower }));
    nums.appendChild(el("span", { text: "每枚硬幣 +" + sk.coinPower }));
    nums.appendChild(el("span", { text: (sk.coins || []).length + " 枚硬幣" }));
    card.appendChild(nums);

    // 硬幣序列視覺化（順序＝拚輸時的處理順序）
    const coinRow = el("div", { cls: "coin-seq" });
    (sk.coins || []).forEach(function (c, i) {
      const type = typeof c === "string" ? c : c.type;
      const chip = el("span", { cls: "coin " + type, text: COIN_LABEL[type] || "?" });
      chip.title = "第 " + (i + 1) + " 枚：" + (type === "red"
        ? "紅幣 —— 拚輸為「碎幣」，仍留在序列中照擲照打，幣威視為 +1"
        : type === "green"
          ? "綠幣 —— 拚輸為「損失」；拚點開始前可對消對方紅幣（被對消的紅幣算損失，不觸發追加攻擊）"
          : "普通幣 —— 拚輸為「損失」，退出本次使用");
      coinRow.appendChild(chip);
    });
    if ((sk.coins || []).length) {
      card.appendChild(el("div", { cls: "hint", text: "硬幣序列（順序＝拚輸時由前往後處理）" }));
      card.appendChild(coinRow);
    }

    card.appendChild(el("p", { cls: "dc-text", text: sk.text || "（尚未填寫技能文本）" }));
    if (sk.notes) card.appendChild(el("p", { cls: "hint", text: "設計備註：" + sk.notes }));
    return card;
  }

  function stateRows(list) {
    const box = el("div", { cls: "state-rows" });
    list.forEach(function (x) {
      const row = el("div", { cls: "state-row" });
      row.appendChild(el("span", { cls: "sr-name" + (x.tagOnly ? " mark" : ""), text: x.name }));
      if (x.tagOnly) {
        row.appendChild(el("span", { cls: "sr-val", text: "已掛上（純標籤）" }));
        row.appendChild(el("span", { cls: "hint", text: "靠對應【殘響】效果引爆；不因回合結束而消失" }));
      } else {
        row.appendChild(el("span", { cls: "sr-val", text: (x.st.layer || 0) + " 層" + (S.hasLevel(x.name) ? "　" + (x.st.level || 0) + " 級" : "") }));
        row.appendChild(el("span", { cls: "hint", text: S.hasLevel(x.name) ? "級數驅動（效果依級數）" : "只有層數（效果 = 層數 × 值）" }));
      }
      if (x.st.addedThisTurn) row.appendChild(el("span", { cls: "tag", text: "本回合豁免層 −1" }));
      box.appendChild(row);
    });
    return box;
  }

  // ---- KP 數值 ----
  function kpNumbers(e) {
    const wrap = el("div", { cls: "kp-grid" });
    function field(label, get, set, min, max) {
      const row = el("label", { cls: "kp-row" });
      row.appendChild(el("span", { text: label }));
      const i = el("input"); i.type = "number"; i.value = get();
      if (min !== undefined) i.min = min;
      if (max !== undefined) i.max = max;
      i.setAttribute("aria-label", e.name + " 的" + label);
      i.addEventListener("change", function () { set(Number(i.value)); refresh(); });
      row.appendChild(i);
      return row;
    }
    wrap.appendChild(field("HP", function () { return e.hp; },
      function (v) { e.hp = Math.max(0, Math.min(e.maxHp, v)); }, 0, e.maxHp));
    wrap.appendChild(field("臨時HP", function () { return e.tempHp || 0; },
      function (v) { e.tempHp = Math.max(0, v); }, 0));
    wrap.appendChild(field("專注力", function () { return e.focus; },
      function (v) { e.focus = S.clampFocus(v); }, -40, 40));
    wrap.appendChild(field("槽位", function () { return e.slots || 0; },
      function (v) { e.slots = Math.max(0, v); }, 0));
    return wrap;
  }

  function resourceControls(e) {
    const wrap = el("div", { cls: "kp-grid" });
    Object.keys(e.resources || {}).forEach(function (k) {
      const row = el("label", { cls: "kp-row" });
      row.appendChild(el("span", { text: k }));
      const i = el("input"); i.type = "number"; i.value = e.resources[k]; i.min = 0;
      const max = e.resourceMax && e.resourceMax[k];
      if (max) i.max = max;
      i.setAttribute("aria-label", e.name + " 的" + k);
      i.addEventListener("change", function () {
        let v = Math.max(0, Number(i.value) || 0);
        if (max) v = Math.min(max, v);
        e.resources[k] = v;
        refresh();
      });
      row.appendChild(i);
      wrap.appendChild(row);
    });
    return wrap;
  }

  // ---- 狀態微調（含級數防呆）----
  function stateEditor(e) {
    const wrap = el("div", { cls: "state-editor" });
    wrap.appendChild(el("div", { cls: "sub-label", text: "狀態微調" }));

    const row = el("div", { cls: "kp-row" });
    const nameSel = el("select");
    nameSel.setAttribute("aria-label", "狀態名");
    function group(label, names) {
      if (!names.length) return;
      const g = el("optgroup"); g.label = label;
      names.forEach(function (n) { const o = el("option", { text: n }); o.value = n; g.appendChild(o); });
      nameSel.appendChild(g);
    }
    const customNames = Object.keys(e.states || {}).filter(function (n) {
      return S.LAYER_DRIVEN.indexOf(n) === -1 && S.LEVEL_DRIVEN.indexOf(n) === -1 && S.BURST_TAGS.indexOf(n) === -1;
    });
    group("級數驅動（可填層與級）", S.LEVEL_DRIVEN);
    group("層數驅動（只有層數）", S.LAYER_DRIVEN);
    group("瀑標記（純標籤）", S.BURST_TAGS);
    group("此角色的印記（只有層數）", customNames);

    const layLabel = el("span", { text: "層" });
    const lay = el("input"); lay.type = "number"; lay.value = "1";
    lay.setAttribute("aria-label", "層數增減");
    const levLabel = el("span", { text: "級" });
    const lev = el("input"); lev.type = "number"; lev.value = "0";
    lev.setAttribute("aria-label", "級數增減");
    const applyBtn = el("button", { cls: "primary", text: "套用" });
    applyBtn.type = "button";

    const note = el("div", { cls: "hint" });
    const burstToggle = el("div", { cls: "kp-row" });

    // ★ 防呆：依所選狀態決定哪些欄位可用
    function syncFields() {
      const name = nameSel.value;
      const isBurst = S.isBurstTag(name);
      const canLevel = S.hasLevel(name);

      burstToggle.innerHTML = "";
      if (isBurst) {
        // 瀑標記是純標籤：層／級都沒有數值意義 → 改成掛上／移除
        lay.disabled = true; lev.disabled = true;
        layLabel.classList.add("disabled"); levLabel.classList.add("disabled");
        const has = !!(e.states[name] && e.states[name].isBurstTag);
        const onBtn = el("button", { cls: has ? "" : "primary", text: has ? "已掛上" : "掛上標記" });
        onBtn.type = "button"; onBtn.disabled = has;
        onBtn.onclick = function () { S.addLayer(e, name, 1); refresh(); };
        const offBtn = el("button", { cls: "danger", text: "移除標記" });
        offBtn.type = "button"; offBtn.disabled = !has;
        offBtn.onclick = function () { delete e.states[name]; refresh(); };
        burstToggle.appendChild(onBtn);
        burstToggle.appendChild(offBtn);
        applyBtn.style.display = "none";
        note.textContent = "【" + name + "】是純標籤：沒有層數／級數的數值意義，只有「有沒有掛上」。";
        return;
      }

      applyBtn.style.display = "";
      lay.disabled = false;
      layLabel.classList.remove("disabled");
      lev.disabled = !canLevel;
      levLabel.classList.toggle("disabled", !canLevel);
      if (!canLevel) {
        lev.value = "0";
        note.textContent = "【" + name + "】只有層數（效果 = 層數 × 值）→ 級數欄位已停用，避免誤填。";
      } else {
        note.textContent = "【" + name + "】是級數驅動。⚠ 級數必須依附層數：層數為 0 時加級數會被丟棄（不能預存）。";
      }
    }
    nameSel.addEventListener("change", syncFields);

    applyBtn.onclick = function () {
      const evs = S.apply(e, nameSel.value, Number(lay.value) || 0, Number(lev.value) || 0);
      // 把引擎的回報（含防呆警告）顯示出來，桌邊才知道有沒有生效
      note.textContent = evs.join("　│　") || note.textContent;
      refresh();
    };

    row.appendChild(nameSel);
    row.appendChild(layLabel); row.appendChild(lay);
    row.appendChild(levLabel); row.appendChild(lev);
    row.appendChild(applyBtn);
    wrap.appendChild(row);
    wrap.appendChild(burstToggle);
    wrap.appendChild(note);
    syncFields();
    return wrap;
  }

})(window);

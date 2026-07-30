// ============================================================
// UI：實體面板與事件 log 渲染
// 顯示需求（trpg-combat-webapp / references/ui-and-sync.md）：
//   HP、有效 DEX（已套用迅捷／綁縛）、專注力、臨時 HP、
//   每個狀態的「層數·級數」、自訂資源（子彈等）、
//   ⚠ 印記與通用狀態要視覺分開、標記無法行動者、顯示本回合結算順序、事件 log
// ============================================================
(function (global) {
  "use strict";
  const Panels = global.Panels = {};
  const S = global.States;

  function el(tag, opts) {
    const e = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) e.className = opts.cls;
    if (opts.text !== undefined) e.textContent = opts.text;
    if (opts.html !== undefined) e.innerHTML = opts.html;
    return e;
  }
  Panels.el = el;

  // ---------------- 實體卡 ----------------
  function renderEntityCard(e, opts) {
    opts = opts || {};
    const dead = e.hp <= 0;
    const cantAct = !dead && (e.confusionLockTurns > 0 || e.isPanicking || e.canAct === false);
    const card = el("div", {
      cls: "entity-card " + (e.isPC ? "pc" : "npc") + (dead ? " dead" : "") + (cantAct ? " cant-act" : "")
    });

    // 標題列
    const head = el("div", { cls: "ec-head" });
    head.appendChild(el("span", { cls: "name", text: e.name }));
    head.appendChild(el("span", { cls: "badge " + (e.isPC ? "pc" : "npc"), text: e.isPC ? "PC" : "NPC" }));
    if (dead) head.appendChild(el("span", { cls: "tag danger", text: "倒下" }));
    if (e.confusionLockTurns > 0) head.appendChild(el("span", { cls: "tag danger", text: "混亂中 " + e.confusionLockTurns }));
    if (e.isPanicking) head.appendChild(el("span", { cls: "tag danger", text: "恐慌中" }));
    if (e.panicNextTurn) head.appendChild(el("span", { cls: "tag warn", text: "下回合恐慌" }));
    if (e.panicRecovering) head.appendChild(el("span", { cls: "tag", text: "恐慌恢復中" }));
    if (opts.orderIndex !== undefined) head.appendChild(el("span", { cls: "tag order", text: "序 " + (opts.orderIndex + 1) }));
    card.appendChild(head);

    // HP 條（含臨時生命值）
    const hpPct = Math.max(0, Math.min(100, (e.hp / e.maxHp) * 100));
    const bar = el("div", { cls: "bar-wrap" });
    const fill = el("div", { cls: "bar-fill" + (hpPct < 30 ? " hp-low" : "") });
    fill.style.width = hpPct + "%";
    bar.appendChild(fill);
    if (e.tempHp > 0) {
      const t = el("div", { cls: "bar-fill temp" });
      t.style.width = Math.max(0, Math.min(100, (e.tempHp / e.maxHp) * 100)) + "%";
      bar.appendChild(t);
    }
    bar.appendChild(el("div", { cls: "bar-label", text: "HP " + e.hp + " / " + e.maxHp + (e.tempHp > 0 ? "　臨時 +" + e.tempHp : "") }));
    card.appendChild(bar);

    // 混亂值刻度
    const th = (e.confusionThresholds && e.confusionThresholds.length)
      ? e.confusionThresholds : [Math.floor(e.maxHp * 0.6), 0];
    card.appendChild(statLine("混亂值", th.slice().sort(function (x, y) { return y - x; }).join(" / ")));

    const dexEff = S.effectiveDex(e);
    card.appendChild(statLine("有效 DEX", dexEff.toFixed(1) + (Math.abs(dexEff - e.dex) > 0.05 ? "（原 " + e.dex + "）" : "")));
    card.appendChild(statLine("專注力", (e.focus > 0 ? "+" : "") + e.focus + "　正面率 " + Math.round(S.headsProbability(e.focus) * 100) + "%"));
    card.appendChild(statLine("槽位", e.slots || 0));

    // 自訂數值資源（子彈等）
    const resKeys = Object.keys(e.resources || {});
    if (resKeys.length) {
      const wrap = el("div", { cls: "res-list" });
      resKeys.forEach(function (k) {
        const max = e.resourceMax && e.resourceMax[k];
        wrap.appendChild(el("span", { cls: "res-chip", text: k + " " + e.resources[k] + (max ? " / " + max : "") }));
      });
      card.appendChild(el("div", { cls: "sub-label", text: "資源" }));
      card.appendChild(wrap);
    }

    // 狀態：通用狀態與印記分區（桌邊要能一眼分辨哪些是這場敵人專屬的威脅）
    const generic = [], marks = [];
    Object.keys(e.states || {}).forEach(function (name) {
      const st = e.states[name];
      if (st.isBurstTag) { marks.push({ name: name, st: st, tagOnly: true }); return; }
      if ((st.layer || 0) <= 0 && (st.level || 0) <= 0) return;
      const known = S.LAYER_DRIVEN.indexOf(name) !== -1 || S.LEVEL_DRIVEN.indexOf(name) !== -1;
      (known ? generic : marks).push({ name: name, st: st, tagOnly: false });
    });
    if (generic.length) {
      card.appendChild(el("div", { cls: "sub-label", text: "狀態" }));
      const box = el("div", { cls: "states-list" });
      generic.forEach(function (x) { box.appendChild(stateChip(x, false)); });
      card.appendChild(box);
    }
    if (marks.length) {
      card.appendChild(el("div", { cls: "sub-label mark-label", text: "印記" }));
      const box = el("div", { cls: "states-list" });
      marks.forEach(function (x) { box.appendChild(stateChip(x, true)); });
      card.appendChild(box);
    }

    // 本回合抽到／宣告的技能
    if (opts.showActions && e.drawnSkills && e.drawnSkills.length) {
      card.appendChild(el("div", { cls: "sub-label", text: "本回合技能" }));
      const box = el("div", { cls: "states-list" });
      e.drawnSkills.forEach(function (d) {
        const sk = (e.skillLibrary || []).find(function (s) { return s.id === d.skillId; });
        box.appendChild(el("span", { cls: "state-chip", text: (sk ? sk.name : d.skillId) }));
      });
      card.appendChild(box);
    }

    // KP 數值臨時覆寫（加分項：桌邊發現不對可當場調）
    if (opts.kpControls) card.appendChild(kpOverride(e, opts.onChange));
    return card;
  }
  Panels.renderEntityCard = renderEntityCard;

  function stateChip(x, isMark) {
    const st = x.st;
    let txt = x.name;
    if (!x.tagOnly) {
      txt += " " + (st.layer || 0) + "層";
      if (S.isLevelDriven(x.name) || (st.level || 0) > 0) txt += "·" + (st.level || 0) + "級";
    }
    const chip = el("span", { cls: "state-chip" + (isMark ? " mark" : ""), text: txt });
    if (st.addedThisTurn) chip.title = "本回合結束時豁免層數 −1";
    return chip;
  }

  function statLine(label, value) {
    const line = el("div", { cls: "stat-line" });
    line.appendChild(el("span", { text: label }));
    line.appendChild(el("span", { cls: "v", text: String(value) }));
    return line;
  }
  Panels.statLine = statLine;

  function kpOverride(e, onChange) {
    const wrap = el("div", { cls: "kp-override" });
    function numField(label, get, set, min, max) {
      const row = el("label", { cls: "kp-row" });
      row.appendChild(el("span", { text: label }));
      const i = el("input"); i.type = "number"; i.value = get();
      if (min !== undefined) i.min = min;
      if (max !== undefined) i.max = max;
      i.setAttribute("aria-label", label);
      i.addEventListener("change", function () {
        set(Number(i.value));
        if (onChange) onChange();
      });
      row.appendChild(i);
      return row;
    }
    wrap.appendChild(numField("HP", function () { return e.hp; },
      function (v) { e.hp = Math.max(0, Math.min(e.maxHp, v)); }, 0, e.maxHp));
    wrap.appendChild(numField("臨時HP", function () { return e.tempHp; },
      function (v) { e.tempHp = Math.max(0, v); }, 0));
    wrap.appendChild(numField("專注力", function () { return e.focus; },
      function (v) { e.focus = S.clampFocus(v); }, -40, 40));
    wrap.appendChild(numField("槽位", function () { return e.slots || 0; },
      function (v) { e.slots = Math.max(0, v); }, 0));

    // 狀態微調
    const st = el("div", { cls: "kp-row" });
    const nameSel = el("select");
    nameSel.setAttribute("aria-label", "狀態名");
    const allNames = [].concat(S.LAYER_DRIVEN, S.LEVEL_DRIVEN, S.BURST_TAGS,
      Object.keys(e.states || {}).filter(function (n) {
        return S.LAYER_DRIVEN.indexOf(n) === -1 && S.LEVEL_DRIVEN.indexOf(n) === -1 && S.BURST_TAGS.indexOf(n) === -1;
      }));
    allNames.forEach(function (n) { const o = el("option", { text: n }); o.value = n; nameSel.appendChild(o); });
    const lay = el("input"); lay.type = "number"; lay.value = "1"; lay.style.width = "54px"; lay.setAttribute("aria-label", "層數增減");
    const lev = el("input"); lev.type = "number"; lev.value = "0"; lev.style.width = "54px"; lev.setAttribute("aria-label", "級數增減");
    const btn = el("button", { text: "套用" });
    btn.type = "button";
    btn.onclick = function () {
      S.apply(e, nameSel.value, Number(lay.value) || 0, Number(lev.value) || 0);
      if (onChange) onChange();
    };
    st.appendChild(nameSel);
    st.appendChild(el("span", { text: "層" })); st.appendChild(lay);
    st.appendChild(el("span", { text: "級" })); st.appendChild(lev);
    st.appendChild(btn);
    wrap.appendChild(st);
    return wrap;
  }

  // ---------------- 面板群 ----------------
  function renderPanels(container, battle, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const order = battle.turnOrder || [];
    battle.entities.forEach(function (e) {
      const idx = order.indexOf(e);
      container.appendChild(renderEntityCard(e, Object.assign({}, opts, {
        orderIndex: idx >= 0 ? idx : undefined
      })));
    });
  }
  Panels.renderPanels = renderPanels;

  // ---------------- 結算順序列 ----------------
  function renderTurnOrder(container, battle) {
    container.innerHTML = "";
    if (!battle.turnOrder || !battle.turnOrder.length) {
      container.appendChild(el("span", { cls: "hint", text: "（本回合順序尚未定出）" }));
      return;
    }
    container.appendChild(el("span", { cls: "hint", text: "本回合結算順序（依有效 DEX，回合中途不重排）：" }));
    battle.turnOrder.forEach(function (e, i) {
      const chip = el("span", {
        cls: "order-chip" + (e.hp <= 0 ? " dead" : "") + (e.canAct === false ? " cant" : ""),
        text: (i + 1) + ". " + e.name + " " + S.effectiveDex(e).toFixed(1)
      });
      container.appendChild(chip);
    });
  }
  Panels.renderTurnOrder = renderTurnOrder;

  // ---------------- 事件 log ----------------
  function classify(msg) {
    if (/^═══|^【階段/.test(msg)) return "phase";
    if (/^──/.test(msg)) return "pairing";
    if (/⚠/.test(msg)) return "warn";
    if (/傷害|扣血|−\d+|通過拚點/.test(msg)) return "dmg";
    if (/專注力|臨時生命值|回復/.test(msg)) return "info";
    return "";
  }
  function appendLog(container, messages) {
    messages.forEach(function (m) {
      container.appendChild(el("div", { cls: "log-entry " + classify(m), text: m }));
    });
    container.scrollTop = container.scrollHeight;
  }
  function renderLog(container, all) {
    container.innerHTML = "";
    appendLog(container, all);
  }
  Panels.appendLog = appendLog;
  Panels.renderLog = renderLog;

})(window);

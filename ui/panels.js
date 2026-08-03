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

    // 卡片＝可點擊元件 → 開角色詳情浮窗（技能文本／被動文本／KP 調值都在裡面）
    card.appendChild(el("div", { cls: "card-more", text: "點擊查看技能與被動文本" }));
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "查看 " + e.name + " 的角色詳情");
    function openDetail() {
      if (global.Detail) global.Detail.open(e, { kpControls: opts.kpControls !== false, onChange: opts.onChange });
    }
    card.addEventListener("click", openDetail);
    card.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(); }
    });
    return card;
  }
  Panels.renderEntityCard = renderEntityCard;

  function stateChip(x, isMark) {
    const st = x.st;
    let txt = x.name;
    if (!x.tagOnly) {
      txt += " " + (st.layer || 0) + "層";
      // 只有「有級數」的狀態才顯示級數；層數驅動狀態顯示「·0級」是無意義的雜訊
      if (S.hasLevel(x.name)) txt += "·" + (st.level || 0) + "級";
    }
    const chip = el("span", { cls: "state-chip" + (isMark ? " mark" : ""), text: txt });
    const hints = [];
    if (st.addedThisTurn) hints.push("本回合結束時豁免層數 −1");
    if (x.tagOnly) hints.push("純標籤：沒有層／級的數值意義，靠對應殘響效果引爆");
    else if (!S.hasLevel(x.name)) hints.push("此狀態只有層數（效果 = 層數 × 值）");
    if (hints.length) chip.title = hints.join("；");
    return chip;
  }

  function statLine(label, value) {
    const line = el("div", { cls: "stat-line" });
    line.appendChild(el("span", { text: label }));
    line.appendChild(el("span", { cls: "v", text: String(value) }));
    return line;
  }
  Panels.statLine = statLine;
  // KP 數值覆寫與狀態微調已移入角色詳情浮窗（ui/detail.js），卡面保持唯讀、乾淨
  // ---------------- 面板群 ----------------
  function renderPanels(container, battle, opts) {
    opts = opts || {};
    container.innerHTML = "";
    // 一場放 3~6 隻小怪時自動縮排，避免面板把整個畫面吃光
    container.classList.toggle("compact", battle.entities.length > 6);
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

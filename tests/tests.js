// ============================================================
// 回歸測試（瀏覽器執行：開 tests/index.html）
// 兩個主驗算來自 trpg-clash-rules skill，是「數字對得上才能往下走」的門檻。
// 由 index.html 先載入 engine/*.js，本檔只使用全域物件。
// ============================================================
(function (global) {
  "use strict";

  global.runTests = function () {
    const S = global.States, C = global.Clash, D = global.Damage, T = global.Turn;
    let pass = 0, fail = 0;
    const failures = [];
    const lines = [];

    function eq(actual, expected, label) {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a === e) { pass++; lines.push({ ok: true, text: "✓ " + label }); }
      else {
        fail++; failures.push(label);
        lines.push({ ok: false, text: "✗ " + label + "　期望 " + e + "　實得 " + a });
      }
    }
    function section(t) { lines.push({ section: true, text: t }); }

    // ---------------- 輔助 ----------------
    function mkEntity(o) {
      return Object.assign({
        id: "e", name: "測試者", isPC: false,
        hp: 1000, maxHp: 1000, dex: 10,
        attributes: { STR: 10, INT: 10, CON: 10, SIZ: 10, LUK: 10 },
        focus: 0, tempHp: 0, slots: 1,
        skillLibrary: [], slotMap: {}, slotMapRules: [], passives: [],
        states: {}, resources: {},
        confusionThresholds: null, confusionLockTurns: 0,
        panicNextTurn: false, panicRecovering: false,
        isConfused: false, cantActRestOfTurn: false
      }, o);
    }
    function mkSkill(o) {
      return Object.assign({ id: "s", name: "技能", type: "attack", basePower: 0, coinPower: 0, coins: [] }, o);
    }
    function seqRng(list) { let i = 0; return function () { const v = list[i % list.length]; i++; return v; }; }
    const ALWAYS_HEAD = function () { return 0; };
    const ALWAYS_TAIL = function () { return 0.99; };
    function runGen(gen, answers) {
      answers = answers || [];
      let ai = 0, r = gen.next(), guard = 0;
      const asked = [];
      while (!r.done) {
        if (++guard > 500) throw new Error("generator 無法結束");
        asked.push(r.value);
        r = gen.next(answers[ai++]);
      }
      return { value: r.value, asked: asked };
    }

    // ============================================================
    // 測試 1：碎幣模型（clash.md）拚點威力 19 → 17 → 15，傷害打 4 下 8/9/12/15
    // ============================================================
    section("測試 1：碎幣模型（拚點 19 → 17 → 15；傷害 8 / 9 / 12 / 15）");
    {
      const skill = mkSkill({ basePower: 7, coinPower: 3, coins: ["red", "red", "red", "red"] });
      const rt = C.makeCoinRuntime(skill);

      const r1 = C.rollAllCoins(rt, 7, 3, 0, ALWAYS_HEAD);
      eq(r1.power, 19, "交換1 最終威力 = 19（四枚完好紅幣）");
      eq(r1.detail.length, 4, "交換1 可擲硬幣 = 4 枚");
      const d1 = C.degradeFirstIntact(rt);
      eq(d1.status, C.SHATTERED, "紅幣輸掉交換 → 碎幣（不是損失）");

      const r2 = C.rollAllCoins(rt, 7, 3, 0, ALWAYS_HEAD);
      eq(r2.power, 17, "交換2 最終威力 = 17（碎幣的幣威視為 +1）");
      eq(r2.detail.length, 4, "交換2 可擲硬幣仍為 4 枚（碎幣照擲）");
      C.degradeFirstIntact(rt);

      const r3 = C.rollAllCoins(rt, 7, 3, 0, ALWAYS_HEAD);
      eq(r3.power, 15, "交換3 最終威力 = 15");
      eq(C.hasIntact(rt), true, "仍有完好硬幣 → 尚未判輸");

      const atk = mkEntity({ name: "攻擊方" });
      const tgt = mkEntity({ name: "目標", hp: 10000, maxHp: 10000 });
      const res = runGen(D.resolveDamage(atk, tgt, rt, 7, 3, "測試技能",
        { rng: ALWAYS_HEAD, damageMultiplier: 1 })).value;
      eq(res.hits.length, 4, "傷害結算打 4 下（碎幣照打）");
      eq(res.hits.map(function (h) { return h.finalPower; }), [8, 9, 12, 15],
        "逐枚最終威力 = 8 / 9 / 12 / 15（逐枚累加各自有效幣威）");

      const fresh = C.makeCoinRuntime(skill);
      eq(fresh.every(function (c) { return c.status === C.INTACT; }), true,
        "重新使用該技能 → 四枚硬幣恢復完好（作用域只限本次使用）");
    }

    // ============================================================
    // 測試 2：傷害公式（damage.md）→ 83 / 83 / 128，合計 294
    // ============================================================
    section("測試 2：傷害公式（83 / 83 / 128，合計 294）");
    {
      const skill = mkSkill({ basePower: 7, coinPower: 9, coins: ["normal", "normal", "normal", "normal"] });
      const rt = C.makeCoinRuntime(skill);
      rt[0].status = C.LOST; // 拚點中損失 1 枚

      const atk = mkEntity({ name: "攻擊方" });
      S.addLayer(atk, "傷害強化", 3);
      S.addLayer(atk, "強壯", 1);
      S.addLayer(atk, "凝神", 5); S.addLevel(atk, "凝神", 39);
      const tgt = mkEntity({ name: "目標", hp: 1000, maxHp: 1000 });
      S.addLayer(tgt, "守護", 3);

      const base = S.effectiveBasePower(atk, skill);
      eq(base, 8, "強壯 1 層 → 基礎威力 7 + 1 = 8");

      const res = runGen(D.resolveDamage(atk, tgt, rt, base, 9, "驗算技能", {
        rng: seqRng([0, 0.99, 0]),        // 正、反、正
        damageMultiplier: 4,
        concentrationRolls: [1, 1, 1]     // 39 級 → 1d20 必定觸發
      })).value;

      eq(res.hits.length, 3, "只結算未損失的 3 枚（損失的完全跳過）");
      eq(res.hits.map(function (h) { return h.finalPower; }), [17, 17, 26],
        "最終威力 17 / 17 / 26（反面照打但不加威力）");
      eq(res.hits.map(function (h) { return h.damage; }), [83, 83, 128], "單枚傷害 83 / 83 / 128");
      eq(res.totalDamage, 294, "合計傷害 = 294");
      eq(res.hits[0].atkCoef.toFixed(2), "1.45", "攻擊方係數 = 1 + 0.15 + 0.30 = 1.45");
      eq(res.hits[0].tgtCoef.toFixed(2), "0.85", "目標方係數 = 1 − 0.15 = 0.85");
    }

    // ============================================================
    section("級數依附層數 / 上限");
    {
      const e = mkEntity({});
      const r = S.addLevel(e, "震顫", 5);
      eq(r.dropped, true, "層數為 0 時加級數 → 直接丟棄（不能預存）");
      eq(S.levelOf(e, "震顫"), 0, "級數仍為 0");

      S.addLayer(e, "震顫", 2);
      S.addLevel(e, "震顫", 5);
      eq(S.levelOf(e, "震顫"), 5, "有層數後才能累積級數");

      S.addLayer(e, "震顫", -2);
      eq(S.layerOf(e, "震顫"), 0, "層數歸零");
      eq(S.levelOf(e, "震顫"), 0, "層數 ≥1 → 0 時級數同步歸零");

      const e2 = mkEntity({});
      S.addLayer(e2, "凝神", 1); S.addLevel(e2, "凝神", 500);
      eq(S.levelOf(e2, "凝神"), 99, "未明定上限的級數統一夾在 99");

      const e3 = mkEntity({});
      S.addLayer(e3, "守護", 99); eq(S.layerOf(e3, "守護"), 16, "守護層數上限 16");
      S.addLayer(e3, "迅捷", 99); eq(S.layerOf(e3, "迅捷"), 10, "迅捷層數上限 10");
    }

    section("綠幣對消：被對消的紅幣是「損失」，不觸發追加攻擊");
    {
      const green = mkSkill({ coins: ["green", "green"] });
      const red = mkSkill({ coins: ["red", "red", "red"] });
      const rtG = C.makeCoinRuntime(green), rtR = C.makeCoinRuntime(red);
      C.greenCancel(rtG, rtR, [], "綠方", "紅方");
      eq(rtR.filter(function (c) { return c.status === C.LOST; }).length, 2, "紅幣被對消 2 枚 → 狀態為【損失】");
      eq(C.shatteredCoins(rtR).length, 0, "被對消的紅幣不算碎幣 → 追加攻擊取不到");
      eq(rtG.filter(function (c) { return c.status === C.LOST; }).length, 2, "綠幣也各損 2 枚");
    }

    section("判輸條件 = 沒有任何「完好」硬幣");
    {
      const skill = mkSkill({ coins: ["red", "red"] });
      const rt = C.makeCoinRuntime(skill);
      C.degradeFirstIntact(rt);
      eq(C.hasIntact(rt), true, "一枚碎、一枚完好 → 未判輸");
      C.degradeFirstIntact(rt);
      eq(C.hasIntact(rt), false, "兩枚全碎 → 判輸（雖然仍可擲 2 枚）");
      eq(C.rollableCoins(rt).length, 2, "全碎後可擲硬幣仍是 2 枚（碎幣不消失）");
    }

    section("最終威力下限 0（基礎威力可為負）");
    {
      const e = mkEntity({});
      S.addLayer(e, "虛弱", 10);
      const sk = mkSkill({ basePower: 3, coinPower: 2, coins: ["normal"] });
      eq(S.effectiveBasePower(e, sk), -7, "基礎威力可為負（3 − 10 = −7）");
      const rt = C.makeCoinRuntime(sk);
      eq(C.rollAllCoins(rt, -7, 2, 0, ALWAYS_TAIL).power, 0, "最終威力夾在下限 0");
    }

    section("震顫爆發與瀑殘響");
    {
      const e = mkEntity({ hp: 1000, maxHp: 1000 });
      S.addLayer(e, "震顫", 3); S.addLevel(e, "震顫", 10);
      eq(S.thresholds(e), [600, 0], "預設混亂值 = maxHp 60% 與 0%");
      S.tremorBurst(e, []);
      eq(S.thresholds(e), [610, 0], "震顫爆發：最接近血量的混亂值 600 → 610");
      eq(S.levelOf(e, "震顫"), 0, "震顫級數歸零");
      eq(S.layerOf(e, "震顫"), 2, "震顫層數 −1（3 → 2）");

      const v = mkEntity({ hp: 1000, maxHp: 1000 });
      S.addLayer(v, "血瀑", 1);
      S.addLayer(v, "失血", 3); S.addLevel(v, "失血", 6);
      S.addLayer(v, "震顫", 3); S.addLevel(v, "震顫", 4);
      const amount = S.burstResonance(v, "血瀑", []);
      eq(amount, 5, "量 = ⌊(震顫4 + 失血6) × 50%⌋ = 5");
      eq(v.hp, 995, "扣血 5");
      eq(S.thresholds(v), [605, 0], "混亂值同量上升 600 → 605");
      eq(S.layerOf(v, "失血"), 0, "夥伴【失血】層數歸零");
      eq(S.layerOf(v, "震顫"), 0, "【震顫】層數歸零");
      eq(!!(v.states["血瀑"] && v.states["血瀑"].isBurstTag), true, "〈血瀑〉標記保留，可重複引爆");

      const z = mkEntity({ hp: 5, maxHp: 1000 });
      S.addLayer(z, "震顫", 1); S.addLevel(z, "震顫", 3);
      S.tremorBurst(z, []);
      eq(z.confusionThresholds.filter(function (t) { return t === 0; }).length, 1,
        "0% 門檻被上推後，於 0% 額外補一條");
    }

    section("混亂：黃金交叉「低於或等於」即進入；目標方係數中途變動");
    {
      const e = mkEntity({ hp: 601, maxHp: 1000 });
      eq(S.crossedConfusion(e, 601, 600), true, "血量降到等於混亂值 → 觸發");
      const e2 = mkEntity({ hp: 700, maxHp: 1000 });
      eq(S.crossedConfusion(e2, 700, 601), false, "未跨過 → 不觸發");

      const atk = mkEntity({ name: "攻擊方" });
      const tgt = mkEntity({ name: "目標", hp: 100, maxHp: 100 }); // 門檻 60
      const sk = mkSkill({ basePower: 10, coinPower: 0, coins: ["normal", "normal"] });
      const rt = C.makeCoinRuntime(sk);
      const res = runGen(D.resolveDamage(atk, tgt, rt, 10, 0, "測試",
        { rng: ALWAYS_HEAD, damageMultiplier: 5 })).value;
      eq(res.hits[0].tgtCoef.toFixed(2), "1.00", "第 1 下：目標未混亂，係數 1.00");
      eq(res.hits[1].tgtCoef.toFixed(2), "1.80", "第 2 下：目標中途進混亂 → 係數 1.80（+80%）");
    }

    section("觸發粒度：萎靡／開裂每枚硬幣、失血每次交換");
    {
      const atk = mkEntity({ name: "攻擊方" });
      const tgt = mkEntity({ name: "目標", hp: 1000, maxHp: 1000 });
      S.addLayer(tgt, "開裂", 3); S.addLevel(tgt, "開裂", 5);
      S.addLayer(tgt, "萎靡", 3); S.addLevel(tgt, "萎靡", 2);
      const sk = mkSkill({ basePower: 0, coinPower: 0, coins: ["normal", "normal"] });
      const rt = C.makeCoinRuntime(sk);
      runGen(D.resolveDamage(atk, tgt, rt, 0, 0, "測試", { rng: ALWAYS_HEAD, damageMultiplier: 0 }));
      eq(S.layerOf(tgt, "開裂"), 1, "開裂每枚硬幣觸發一次，層 3 → 1（打兩下）");
      eq(tgt.hp, 990, "開裂各扣 5 血 ×2 = 10");
      eq(S.layerOf(tgt, "萎靡"), 1, "萎靡每枚硬幣觸發一次，層 3 → 1");
      eq(tgt.focus, -4, "萎靡各扣 2 專注力 ×2 = −4");

      // 失血：每次交換觸發一次
      const a2 = mkEntity({ id: "a2", name: "甲" });
      const b2 = mkEntity({ id: "b2", name: "乙" });
      S.addLayer(a2, "失血", 5); S.addLevel(a2, "失血", 3);
      const skA = mkSkill({ basePower: 10, coinPower: 0, coins: ["normal", "normal"] });
      const skB = mkSkill({ basePower: 1, coinPower: 0, coins: ["normal"] });
      const rtA = C.makeCoinRuntime(skA), rtB = C.makeCoinRuntime(skB);
      const cl = C.resolveClash(
        { entity: a2, skill: skA, coinRuntime: rtA, basePower: 10 },
        { entity: b2, skill: skB, coinRuntime: rtB, basePower: 1 },
        { rng: ALWAYS_HEAD });
      eq(cl.winner, "A", "威力高者通過拚點");
      eq(S.layerOf(a2, "失血"), 4, "失血每次交換觸發一次（1 次交換 → 層 5 → 4）");
      eq(a2.hp, 997, "失血扣 3 血");
    }

    section("專注力：拚點結束後一次結算 ±(2k+2)");
    {
      const a = mkEntity({ id: "a", name: "甲" });
      const b = mkEntity({ id: "b", name: "乙" });
      const skA = mkSkill({ basePower: 10, coinPower: 0, coins: ["normal", "normal"] });
      const skB = mkSkill({ basePower: 1, coinPower: 0, coins: ["normal"] });
      const cl = C.resolveClash(
        { entity: a, skill: skA, coinRuntime: C.makeCoinRuntime(skA), basePower: 10 },
        { entity: b, skill: skB, coinRuntime: C.makeCoinRuntime(skB), basePower: 1 },
        { rng: ALWAYS_HEAD });
      eq(cl.exchanges, 1, "1 次交換分出勝負");
      eq(a.focus, 4, "勝方 +4（2×1+2）");
      eq(b.focus, -4, "敗方 −4");

      // 一方使用防禦型 → 雙方專注力不變
      const c1 = mkEntity({ id: "c", name: "丙" });
      const d1 = mkEntity({ id: "d", name: "丁" });
      const skAtk = mkSkill({ basePower: 10, coinPower: 0, coins: ["normal"] });
      const skDef = mkSkill({ type: "defense", basePower: 1, coinPower: 0, coins: ["normal"] });
      C.resolveClash(
        { entity: c1, skill: skAtk, coinRuntime: C.makeCoinRuntime(skAtk), basePower: 10 },
        { entity: d1, skill: skDef, coinRuntime: C.makeCoinRuntime(skDef), basePower: 1 },
        { rng: ALWAYS_HEAD });
      eq([c1.focus, d1.focus], [0, 0], "一方用防禦型技能 → 雙方專注力都不變");
    }

    section("階段六順序與豁免旗標");
    {
      const e = mkEntity({ name: "延燒者", hp: 1000, maxHp: 1000, tempHp: 3 });
      S.addLayer(e, "延燒", 2); S.addLevel(e, "延燒", 5);
      T.runTurnEndPhase([e], []);
      eq(e.hp, 998, "回合結束傷害先扣臨時生命值，剩餘才打真血（5 − 3 = 2）");
      eq(e.tempHp, 0, "臨時生命值在傷害結算之後才歸零");
      eq(S.layerOf(e, "延燒"), 1, "延燒的層 −1 與通則視為同一次，不重複扣（2 → 1）");

      const e2 = mkEntity({ name: "被動獲益者" });
      S.apply(e2, "傷害強化", 2, 0, { exemptThisTurn: true });
      T.runTurnEndPhase([e2], []);
      eq(S.layerOf(e2, "傷害強化"), 2, "步驟1 新增的狀態豁免本次層 −1（維持 2 層）");
      T.runTurnEndPhase([e2], []);
      eq(S.layerOf(e2, "傷害強化"), 1, "下一回合結束才開始扣（2 → 1）");
    }

    section("結算順序：依有效 DEX、敵我混排、定序一次不重排");
    {
      const a = mkEntity({ id: "a", name: "快", isPC: true, dex: 20 });
      const b = mkEntity({ id: "b", name: "中", isPC: false, dex: 15 });
      const c = mkEntity({ id: "c", name: "慢", isPC: true, dex: 8 });
      S.addLayer(c, "迅捷", 10); // 8 × 1.5 = 12
      const order = T.computeTurnOrder([a, b, c]);
      eq(order.map(function (x) { return x.id; }), ["a", "b", "c"],
        "依有效 DEX 排序（敵我混排）：快20 > 中15 > 慢12");
      S.addLayer(a, "綁縛", 10); // 20 × 0.5 = 10
      eq(order.map(function (x) { return x.id; }), ["a", "b", "c"],
        "回合中途 DEX 改變，本回合順序不變（快照）");
    }

    section("攔截資格：有效 DEX 嚴格大於");
    {
      const guard = mkEntity({ id: "g", name: "護衛", isPC: true, dex: 15 });
      const ally = mkEntity({ id: "p", name: "隊友", isPC: true, dex: 15 });
      eq(T.canIntercept(guard, ally), false, "DEX 相等 → 不能攔截");
      guard.dex = 16;
      eq(T.canIntercept(guard, ally), true, "DEX 嚴格大於 → 可以攔截");
    }

    section("PC 槽位成長（4 名 PC：R1 各1、R5 起各2、總和封頂 8）");
    {
      const pcs = ["p1", "p2", "p3", "p4"].map(function (id, i) {
        return mkEntity({ id: id, name: "PC" + (i + 1), isPC: true });
      });
      const battle = { entities: pcs, pcGrowthOrder: ["p1", "p2", "p3", "p4"], turnNumber: 1 };
      const totals = [];
      for (let t = 1; t <= 6; t++) {
        battle.turnNumber = t;
        T.updatePcSlots(battle, []);
        totals.push(pcs.map(function (p) { return p.slots; }).join(""));
      }
      eq(totals, ["1111", "2111", "2211", "2221", "2222", "2222"],
        "R1→R6 槽位分配 1111 / 2111 / 2211 / 2221 / 2222 / 2222（封頂）");

      // 友方 NPC 不計入 PC 的 8 槽位池
      const withNpc = { entities: pcs.concat([mkEntity({ id: "n", name: "友方NPC", isPC: false, slots: 5 })]),
        pcGrowthOrder: ["p1", "p2", "p3", "p4"], turnNumber: 7 };
      T.updatePcSlots(withNpc, []);
      eq(pcs.map(function (p) { return p.slots; }).join(""), "2222", "友方 NPC 的槽位不佔 PC 的 8 上限");
    }

    section("抽技能：3:2:1 加權、骰到重複不重骰（被迫單選）");
    {
      const e = mkEntity({});
      e.slotMap = { A: "skA", B: "skB", C: "skC" };
      eq([1, 2, 3].map(T.dieToSlot), ["A", "A", "A"], "骰面 1/2/3 → 槽位 A");
      eq([4, 5].map(T.dieToSlot), ["B", "B"], "骰面 4/5 → 槽位 B");
      eq(T.dieToSlot(6), "C", "骰面 6 → 槽位 C");
      eq(T.buildSkillMenu(e, 1, 4).skillIds, ["skA", "skB"], "骰到不同槽位 → 兩個選項");
      eq(T.buildSkillMenu(e, 1, 2).skillIds, ["skA"], "兩次同槽位 → 只有一個選項（被迫單選）");
    }

    section("【閃躲】硬幣損失持續到回合結束（作用域唯一例外）");
    {
      const e = mkEntity({ name: "閃躲者" });
      const dodge = mkSkill({ id: "dodge", name: "閃躲", type: "defense", isDodge: true, basePower: 5, coinPower: 3, coins: ["normal"] });
      e.skillLibrary = [dodge];

      const rt1 = T.acquireCoinRuntime(e, dodge);
      eq(rt1[0].status, C.INTACT, "第一次取用：硬幣完好");
      const rt2 = T.acquireCoinRuntime(e, dodge);
      eq(rt2 === rt1, true, "同回合再次使用閃躲 → 沿用同一份 coinRuntime（拚贏可一直擋）");

      C.degradeFirstIntact(rt1); // 閃躲失敗
      const rt3 = T.acquireCoinRuntime(e, dodge);
      eq(C.hasIntact(rt3), false, "閃躲失敗後，本回合再取用仍是損失狀態（擋不住了）");

      T.runTurnEndPhase([e], []);
      const rt4 = T.acquireCoinRuntime(e, dodge);
      eq(rt4[0].status, C.INTACT, "回合結束後恢復完好");

      // 對照：一般技能每次使用都是全新狀態
      const normal = mkSkill({ id: "n1", coins: ["normal"] });
      const n1 = T.acquireCoinRuntime(e, normal);
      C.degradeFirstIntact(n1);
      const n2 = T.acquireCoinRuntime(e, normal);
      eq(n2[0].status, C.INTACT, "一般技能：每次使用都從滿硬幣重新開始");
    }

    section("【防守】增加 最終威力 × 5 的臨時生命值");
    {
      const e = mkEntity({ name: "防守者", tempHp: 0 });
      const guard = mkSkill({ id: "guard", name: "防守", type: "defense", basePower: 4, coinPower: 3, coins: ["normal"] });
      const rt = C.makeCoinRuntime(guard);
      runGen(D.resolveGuard(e, guard, rt, 4, { rng: ALWAYS_HEAD }));
      eq(e.tempHp, 35, "最終威力 (4+3) × 5 = 35 臨時生命值");
    }

    section("碎幣追加攻擊：基威視同 1、每枚幣威視同 +1");
    {
      const atk = mkEntity({ name: "拚輸方" });
      const tgt = mkEntity({ name: "目標", hp: 10000, maxHp: 10000 });
      const sk = mkSkill({ basePower: 7, coinPower: 9, coins: ["red", "red"] });
      const rt = C.makeCoinRuntime(sk);
      C.degradeFirstIntact(rt); C.degradeFirstIntact(rt); // 兩枚全碎 → 判輸
      eq(C.hasIntact(rt), false, "兩枚紅幣全碎 → 判輸");
      const res = runGen(D.resolveShatteredFollowUp(atk, tgt, rt,
        { rng: ALWAYS_HEAD, damageMultiplier: 1 })).value;
      eq(res.hits.map(function (h) { return h.finalPower; }), [2, 3],
        "追加攻擊：基威 1，每枚 +1 → 威力 2 / 3");
    }

    return { pass: pass, fail: fail, failures: failures, lines: lines };
  };
})(window);

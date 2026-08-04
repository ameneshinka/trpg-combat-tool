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

    section("級數防呆：只有級數驅動狀態能加級數");
    {
      // hasLevel 分類正確
      eq(["凝神", "震顫", "萎靡", "延燒", "失血", "開裂"].every(S.hasLevel), true,
        "六個級數驅動狀態 hasLevel = true");
      eq(["守護", "易損", "傷害強化", "傷害弱化", "迅捷", "綁縛", "強壯", "虛弱", "屏息", "遲鈍", "恍惚"]
        .some(S.hasLevel), false, "層數驅動狀態（含恍惚）hasLevel 全為 false");
      eq(S.BURST_TAGS.some(S.hasLevel), false, "瀑標記 hasLevel = false");
      eq(S.hasLevel("lady_gaze"), false, "自訂印記 hasLevel = false");

      // 層數驅動狀態：加級數被擋
      const e = mkEntity({});
      S.addLayer(e, "守護", 3);
      const r1 = S.addLevel(e, "守護", 5);
      eq(r1.dropped, true, "對【守護】加級數 → 丟棄");
      eq(S.levelOf(e, "守護"), 0, "【守護】級數維持 0");
      eq(/層數驅動/.test(r1.reason), true, "回報原因說明它是層數驅動狀態");

      // 自訂印記：加級數被擋
      S.addLayer(e, "lady_gaze", 2);
      const r2 = S.addLevel(e, "lady_gaze", 3);
      eq(r2.dropped, true, "對自訂印記【lady_gaze】加級數 → 丟棄");
      eq(/印記/.test(r2.reason), true, "回報原因說明它是印記");

      // 瀑標記：加級數被擋
      S.addLayer(e, "血瀑", 1);
      const r3 = S.addLevel(e, "血瀑", 4);
      eq(r3.dropped, true, "對【血瀑】加級數 → 丟棄");
      eq(/純標籤/.test(r3.reason), true, "回報原因說明它是純標籤");

      // 級數驅動狀態：正常
      S.addLayer(e, "凝神", 2);
      const r4 = S.addLevel(e, "凝神", 7);
      eq(r4.dropped, false, "對【凝神】加級數 → 正常");
      eq(S.levelOf(e, "凝神"), 7, "【凝神】級數 = 7");

      // apply() 會把防呆警告寫進事件
      const e2 = mkEntity({});
      const evs = S.apply(e2, "強壯", 2, 3);
      eq(evs.some(function (m) { return /無效/.test(m) && /強壯/.test(m); }), true,
        "apply() 對層數驅動狀態的級數推一條「無效」警告");
      eq(S.layerOf(e2, "強壯"), 2, "層數照樣生效（只有級數被丟棄）");

      // 減級數不受此限（清理用），且既有「層 0 不能預存」仍在
      const e3 = mkEntity({});
      const r5 = S.addLevel(e3, "凝神", 5);
      eq(r5.dropped, true, "級數驅動狀態但層數為 0 → 仍然不能預存");
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
      runGen(T.runTurnEndPhase([e], []));
      eq(e.hp, 998, "回合結束傷害先扣臨時生命值，剩餘才打真血（5 − 3 = 2）");
      eq(e.tempHp, 0, "臨時生命值在傷害結算之後才歸零");
      eq(S.layerOf(e, "延燒"), 1, "延燒的層 −1 與通則視為同一次，不重複扣（2 → 1）");

      const e2 = mkEntity({ name: "被動獲益者" });
      S.apply(e2, "傷害強化", 2, 0, { exemptThisTurn: true });
      runGen(T.runTurnEndPhase([e2], []));
      eq(S.layerOf(e2, "傷害強化"), 2, "步驟1 新增的狀態豁免本次層 −1（維持 2 層）");
      runGen(T.runTurnEndPhase([e2], []));
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

    section("buildPairing 可反覆呼叫做預覽（不寫 log、無殘留狀態）");
    {
      const atk = mkEntity({ id: "atk", name: "刺客", isPC: false, dex: 8, canAct: true });
      const weak = mkEntity({ id: "weak", name: "脆皮", isPC: true, dex: 6, canAct: true });
      const guard = mkEntity({ id: "grd", name: "鐵衛", isPC: true, dex: 18, canAct: true });
      const skA = mkSkill({ id: "a1", coins: ["normal"] });
      const skG = mkSkill({ id: "g1", type: "defense", coins: ["normal"] });
      atk.skillLibrary = [skA]; guard.skillLibrary = [skG]; weak.skillLibrary = [skA];
      atk.declarations = [{ slotIndex: 0, skillId: "a1", action: "attack", targetId: "weak" }];
      guard.declarations = [{ slotIndex: 0, skillId: "g1", action: "intercept", targetId: "atk", protectId: "weak" }];
      const battle = { entities: [atk, weak, guard], turnOrder: [guard, atk, weak] };

      const p1 = T.buildPairing(battle);
      const p2 = T.buildPairing(battle);
      eq(JSON.stringify(summarize(p1.entries)), JSON.stringify(summarize(p2.entries)),
        "連續呼叫兩次 → 配對結果完全相同（無殘留的攔截標記）");
      eq(p1.notes.length, p2.notes.length, "攔截判定 notes 數量也相同（不會累積）");
      eq(p1.entries.length, 1, "產生一組配對");
      eq(p1.entries[0].kind, "clash", "攔截成立 → 變成拚點");
      eq(p1.entries[0].bEntityId, "grd", "拚點對手換成攔截者鐵衛");
      eq(p1.notes.some(function (n) { return n.ok && /攔截成立/.test(n.text); }), true, "notes 記錄攔截成立");

      // DEX 不足 → 攔截被拒，且 notes 說明原因
      guard.dex = 5;
      const p3 = T.buildPairing(battle);
      eq(p3.entries[0].kind, "unilateral", "攔截被拒 → 變回單方面攻擊");
      eq(p3.notes.some(function (n) { return !n.ok && /嚴格大於/.test(n.text); }), true, "notes 說明被拒原因");
    }
    function summarize(entries) {
      return entries.map(function (en) {
        return [en.kind, en.aEntityId, en.aSkillId, en.bEntityId || "", en.targetId || ""].join("|");
      });
    }

    section("宣告一覽（行動確認板的資料來源）");
    {
      const e = mkEntity({ id: "p1", name: "測試PC", isPC: true, dex: 10, canAct: true });
      const s1 = mkSkill({ id: "s1", name: "招一", coins: ["normal"] });
      const s2 = mkSkill({ id: "s2", name: "招二", coins: ["normal"] });
      e.skillLibrary = [s1, s2];
      e.drawnSkills = [
        { slotIndex: 0, skillId: "s1", menuOptions: [{ id: "s1", name: "招一" }, { id: "s2", name: "招二" }], dice: [1, 4] },
        { slotIndex: 1, skillId: "s2", menuOptions: [{ id: "s2", name: "招二" }], dice: [4, 5] }
      ];
      e.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "p1" }];
      const battle = { entities: [e], turnOrder: [e] };
      const board = T.buildDeclarationBoard(battle);
      eq(board.length, 2, "每個槽位一列");
      eq(board[0].canRechoose, true, "菜單有兩個選項 → 可以改技能");
      eq(board[1].canRechoose, false, "被迫單選 → 不能改技能");
      eq(board[0].action, "attack", "帶出已宣告的動作");
      eq(board[1].action, null, "尚未宣告的槽位 action 為 null");
      eq(board[0].dice, [1, 4], "帶出當初骰值供 KP 核對");
    }

    section("確認板：改技能含防禦技、新增／刪除行動的槽位帳");
    {
      const e = mkEntity({ id: "p1", name: "測試PC", isPC: true, dex: 10, canAct: true, slots: 3 });
      const a1 = mkSkill({ id: "a1", name: "招一", coins: ["normal"] });
      const a2 = mkSkill({ id: "a2", name: "招二", coins: ["normal"] });
      const guard = mkSkill({ id: "guard", name: "防守", type: "defense", isGuard: true, coins: ["normal"] });
      const dodge = mkSkill({ id: "dodge", name: "閃躲", type: "defense", isDodge: true, coins: ["normal"] });
      e.skillLibrary = [a1, a2, guard, dodge];

      // 被迫單選的槽位，依舊可以改成防禦技（規則：防禦技不受抽選限制）
      const forced = { slotIndex: 0, skillId: "a1", menuOptions: [{ id: "a1", name: "招一" }], dice: [1, 2] };
      const opts = T.rechooseOptions(e, forced);
      eq(opts.map(function (o) { return o.id; }), ["a1", "guard", "dodge"],
        "改技能的選項 = 骰出的菜單 ＋ 全部防禦技");
      eq(opts.length > 1, true, "即使當初被迫單選，仍有東西可改（可改成防禦技）");
      eq(opts.map(function (o) { return o.kind; }), ["attack", "defense", "defense"],
        "每個選項標了 kind，UI 才能把攻擊技與防禦技分組顯示");

      // 槽位帳：3 槽、已用 1 → 還能新增 2 個行動
      e.drawnSkills = [forced];
      const battle = { entities: [e], turnOrder: [e] };
      let usage = T.slotUsage(battle);
      eq([usage[0].slots, usage[0].used, usage[0].free], [3, 1, 2], "槽位帳：3 槽已用 1 → 剩 2");
      eq(usage[0].hasDefenseSkill, true, "有防禦技可用於新增行動");
      eq(T.nextFreeSlotIndex(e), 1, "下一個空閒槽位編號 = 1");

      // 用滿槽位 → 不能再新增
      e.drawnSkills.push({ slotIndex: 1, skillId: "guard", menuOptions: [], dice: [] });
      e.drawnSkills.push({ slotIndex: 2, skillId: "dodge", menuOptions: [], dice: [] });
      usage = T.slotUsage(battle);
      eq(usage[0].free, 0, "3 槽全用完 → 剩 0");
      eq(T.nextFreeSlotIndex(e), null, "沒有空閒槽位 → 回 null（引擎會擋下新增）");

      // 刪掉中間那個 → 該槽位變回空閒且可被重新指派
      e.drawnSkills = e.drawnSkills.filter(function (d) { return d.slotIndex !== 1; });
      eq(T.nextFreeSlotIndex(e), 1, "刪除第 2 槽後，該槽位回到空閒");
      eq(T.slotUsage(battle)[0].free, 1, "槽位帳同步變成剩 1");

      // board 的 canRechoose 用新邏輯（含防禦技）→ 被迫單選也能改
      const board = T.buildDeclarationBoard(battle);
      eq(board.find(function (r) { return r.slotIndex === 0; }).canRechoose, true,
        "被迫單選的槽位 canRechoose 仍為 true（可改成防禦技）");

      // 沒有防禦技的角色不會被誤導可以新增
      const bare = mkEntity({ id: "bare", name: "無防禦技", canAct: true, slots: 2 });
      bare.skillLibrary = [a1];
      bare.drawnSkills = [{ slotIndex: 0, skillId: "a1", menuOptions: [], dice: [] }];
      const u2 = T.slotUsage({ entities: [bare], turnOrder: [bare] })[0];
      eq([u2.free, u2.hasDefenseSkill], [1, false], "有空槽但沒防禦技 → hasDefenseSkill=false");
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

    section("抽技能當下就能選防禦技（防守／閃躲不受抽選限制）");
    {
      const e = mkEntity({});
      const a1 = mkSkill({ id: "a1", name: "招一" });
      const a2 = mkSkill({ id: "a2", name: "招二" });
      const a3 = mkSkill({ id: "a3", name: "招三" });
      const guard = mkSkill({ id: "guard", name: "防守", type: "defense", isGuard: true, coins: ["normal"] });
      const dodge = mkSkill({ id: "dodge", name: "閃躲", type: "defense", isDodge: true, coins: ["normal"] });
      e.skillLibrary = [a1, a2, a3, guard, dodge];
      e.slotMap = { A: "a1", B: "a2", C: "a3" };

      // 骰到兩個不同槽位 → 2 攻擊 + 2 防禦
      const m1 = T.buildDrawMenu(e, 1, 4);
      eq(m1.options.map(function (o) { return o.id; }), ["a1", "a2", "guard", "dodge"],
        "骰 1／4 → 招一、招二 ＋ 防守、閃躲");
      eq(m1.attackCount, 2, "攻擊選項 2 個");
      eq(m1.forcedSingleAttack, false, "不是被迫單選");
      eq(m1.options.map(function (o) { return o.kind; }), ["attack", "attack", "defense", "defense"],
        "每個選項都標了 kind 供 UI 分組");

      // 骰到同一槽位（原本的「被迫單選」）→ 攻擊只有 1 個，但仍有防禦技可選
      const m2 = T.buildDrawMenu(e, 1, 2);
      eq(m2.attackCount, 1, "骰 1／2 指向同一槽位 → 攻擊選項只有 1 個");
      eq(m2.forcedSingleAttack, true, "標記為攻擊被迫單選");
      eq(m2.options.length, 3, "但總選項有 3 個（招一 ＋ 防守 ＋ 閃躲）→ 玩家仍有選擇");
      eq(m2.options.map(function (o) { return o.id; }), ["a1", "guard", "dodge"], "選項內容正確");

      // 骰到空的 slotMap 槽位 → 仍可用防禦技（不再是死掉的空槽）
      const e2 = mkEntity({});
      e2.skillLibrary = [guard, dodge];
      e2.slotMap = { A: null, B: null, C: null };
      const m3 = T.buildDrawMenu(e2, 1, 4);
      eq(m3.attackCount, 0, "沒有攻擊技可抽");
      eq(m3.options.map(function (o) { return o.id; }), ["guard", "dodge"], "仍可選防禦技");

      // 完全沒技能 → 才是真的空槽
      const e3 = mkEntity({});
      e3.skillLibrary = [];
      e3.slotMap = { A: null, B: null, C: null };
      eq(T.buildDrawMenu(e3, 1, 4).options.length, 0, "毫無技能 → 空槽");
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

      runGen(T.runTurnEndPhase([e], []));
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

    // ============================================================
    // NPC 倉庫：藍圖 → 實例（同款多隻，血量與狀態各算各的）
    // ============================================================
    const Ch = global.Characters;

    section("倉庫：spawn 產出互不干擾的實例");
    {
      const three = Ch.spawn("goblin_grunt", 3);
      eq(three.length, 3, "spawn(3) 產出 3 隻");
      eq(three.map(function (e) { return e.id; }),
        ["goblin_grunt#1", "goblin_grunt#2", "goblin_grunt#3"], "實例 id 互異且帶 #n");
      eq(three.map(function (e) { return e.name; }),
        ["哥布林兵 A", "哥布林兵 B", "哥布林兵 C"], "多隻時顯示名加 A/B/C 後綴");
      eq(three.every(function (e) { return e.blueprintId === "goblin_grunt"; }), true,
        "所有實例共用同一個 blueprintId（批次操作靠它分組）");
      eq(three[0].baseName, "哥布林兵", "baseName 不含後綴（批次提問顯示用）");

      const one = Ch.spawn("goblin_grunt", 1);
      eq(one[0].name, "哥布林兵", "只有一隻時不加後綴");
      eq(one[0].id, "goblin_grunt#1", "但 id 仍帶 #1（避免與藍圖 id 撞名）");

      // --- 獨立性：巢狀物件最容易被淺拷貝穿透，逐一驗 ---
      const a = three[0], b = three[1];
      a.hp = 5; a.tempHp = 12; a.focus = -20; a.slots = 3;
      S.apply(a, "失血", 2, 1);
      S.apply(a, "自訂印記", 1, 0);
      a.resources["蠻力"] = 7;
      a.skillLibrary[0].basePower = 999;
      a.slotMap.A = "gg_pierce";
      a.drawnSkills.push({ slotIndex: 0, skillId: "gg_swing" });

      eq([b.hp, b.tempHp, b.focus, b.slots], [30, 0, 0, 0], "改 A 的 HP／臨時HP／專注力／槽位，B 不受影響");
      eq(b.states, {}, "改 A 的狀態與印記，B 的 states 仍是空的");
      eq(b.resources["蠻力"], undefined, "改 A 的自訂資源，B 不受影響");
      eq(b.skillLibrary[0].basePower, 2, "改 A 的技能數值，B 的技能不受影響");
      eq(b.slotMap.A, "gg_swing", "改 A 的 slotMap，B 不受影響");
      eq(b.drawnSkills.length, 0, "A 抽到的技能不會出現在 B 身上");

      // --- 藍圖本身不能被實例污染 ---
      const fresh = Ch.spawn("goblin_grunt", 1)[0];
      eq([fresh.hp, fresh.skillLibrary[0].basePower], [30, 2], "改過實例之後，再 spawn 出來的仍是乾淨的藍圖值");
    }

    section("倉庫：cloneSpec 保住技能的 onUse／onHit 函式");
    {
      // ⚠ 這是舊版用 JSON.parse(JSON.stringify()) 深拷貝時會靜默壞掉的地方
      const hit = function () { return "hit"; };
      const spec = { id: "fn_test", name: "函式測試", hp: 10, dex: 1,
        skillLibrary: [{ id: "k", name: "招", coins: ["normal"], onHit: hit }] };
      const copy = Ch.cloneSpec(spec);
      eq(typeof copy.skillLibrary[0].onHit, "function", "cloneSpec 之後 onHit 仍是函式");
      eq(copy.skillLibrary[0].onHit === hit, true, "無狀態函式沿用同一份參照（共用安全）");
      eq(copy.skillLibrary === spec.skillLibrary, false, "陣列本身仍是全新的（不共用容器）");
      eq(typeof JSON.parse(JSON.stringify(spec)).skillLibrary[0].onHit, "undefined",
        "對照組：JSON 深拷貝會把函式吃掉（所以不能用）");
    }

    section("KP 自由選：排除隱藏技（喚出專用）");
    {
      const e = mkEntity({
        isPC: false,
        skillLibrary: [
          mkSkill({ id: "open", name: "普通招" }),
          mkSkill({ id: "def", name: "防守", type: "defense" }),
          mkSkill({ id: "hidden", name: "喚出專用招", drawable: false })
        ]
      });
      const all = T.freePickOptions(e);
      eq(all.map(function (o) { return o.id; }), ["open", "def"], "隱藏技不列入自由選（否則喚出的設計被繞過）");
      eq(all.map(function (o) { return o.kind; }), ["attack", "defense"], "自由選也標出攻擊／防禦");
      eq(T.freePickOptions(e, [{ id: "open" }]).map(function (o) { return o.id; }), ["def"],
        "已在菜單裡的技能不重複列出");
    }

    section("NPC 的 1d6 由工具代骰（rng 可注入）");
    {
      const npc = Ch.spawn("goblin_grunt", 1)[0];
      const battle = { turnNumber: 1, entities: [npc], pcGrowthOrder: [], turnOrder: [] };
      // rng 固定 → 骰面固定：0 → 1、0.9 → 6
      const r = runGen(T.runTurnStartPhase(battle, [], { rng: seqRng([0, 0.9]) }), [1]);
      const types = r.asked.map(function (q) { return q.type; });
      eq(types.indexOf("skillDraw1d6"), -1, "NPC 不會被問 1d6（工具代骰）");
      eq(types[0], "npcSlots", "仍會問 NPC 槽位");
      eq(npc.drawnSkills[0].dice, [1, 6], "代骰結果照注入的 rng（1 與 6）");
      eq(npc.drawnSkills[0].autoRolled, true, "標記為代骰，事件紀錄與確認板才看得出來");
      const chooseReq = r.asked.find(function (q) { return q.type === "chooseSkill"; });
      eq(!!chooseReq && chooseReq.canFreePick, true, "NPC 的技能菜單附帶 KP 自由選逃生門");
    }

    section("NPC 槽位：同款實例共用一次提問");
    {
      const gob = Ch.spawn("goblin_grunt", 3);
      const battle = { turnNumber: 1, entities: gob, pcGrowthOrder: [], turnOrder: [] };
      const r = runGen(T.runTurnStartPhase(battle, [], { rng: seqRng([0]) }), [2]);
      const slotReqs = r.asked.filter(function (q) { return q.type === "npcSlots"; });
      eq(slotReqs.length, 1, "三隻同款哥布林只問一次槽位");
      eq(slotReqs[0].count, 3, "提問帶著這一款有幾隻");
      eq(slotReqs[0].names, ["哥布林兵 A", "哥布林兵 B", "哥布林兵 C"], "提問列出會被套用的實例");
      eq(gob.map(function (e) { return e.slots; }), [2, 2, 2], "填一次套用到全部");
    }

    section("一鍵指定敵方目標（之後仍可逐一訂正）");
    {
      const pc = Ch.pcRoster()[0];
      const gob = Ch.spawn("goblin_grunt", 2);
      const battle = { turnNumber: 1, entities: [pc].concat(gob), pcGrowthOrder: ["test_target"], turnOrder: [] };
      battle.entities.forEach(function (e) {
        e.canAct = true; e.slots = 1; e.declarations = [];
        e.drawnSkills = [{ slotIndex: 0, skillId: e.isPC ? "tt_poke" : "gg_swing", menuOptions: [], dice: [1, 1] }];
      });
      battle.turnOrder = T.computeTurnOrder(battle.entities);

      const r = runGen(T.askBatchTarget(battle, []), [{ targetId: pc.id }]);
      const req = r.asked[0];
      eq(req.type, "batchTarget", "兩個以上敵方攻擊行動 → 會問一鍵指定");
      eq(req.candidates.length, 2, "候選只有敵方 NPC 的攻擊槽位（PC 不在內）");
      eq(req.targets.map(function (t) { return t.id; }), [pc.id], "可選目標＝存活的 PC");
      eq(gob.map(function (e) { return e.declarations[0].targetId; }), [pc.id, pc.id], "兩隻都指向同一個目標");
      eq(gob[0].declarations[0].batched, true, "填入的宣告標記為批次（確認板顯示可訂正）");
      eq(pc.declarations.length, 0, "PC 的宣告不受一鍵指定影響");

      // 確認板應該看得到批次標記，而［改宣告］會把它換成單獨宣告
      const board = T.buildDeclarationBoard(battle);
      eq(board.filter(function (x) { return x.batched; }).length, 2, "確認板上兩列標著批次指定");

      // 防禦技不批次
      gob[1].drawnSkills = [{ slotIndex: 0, skillId: "guard", menuOptions: [], dice: [] }];
      gob.forEach(function (e) { e.declarations = []; });
      const r2 = runGen(T.askBatchTarget(battle, []), [{ targetId: pc.id }]);
      eq(r2.asked.length, 0, "只剩一個攻擊行動（另一個是防守）→ 不問一鍵指定");
    }

    // ============================================================
    // 效果鉤子引擎（engine/effects.js）
    // ============================================================
    const E = global.Effects;
    function fxOpts(sk, extra) {
      return Object.assign({
        rng: ALWAYS_HEAD, damageMultiplier: 1,
        fx: { skill: sk, battle: null, runtime: E.makeRuntime() }
      }, extra || {});
    }

    section("效果鉤子：逐枚硬幣的觸發順序");
    {
      const order = [];
      const sk = mkSkill({
        coins: ["normal"], basePower: 0, coinPower: 5,
        coinEffects: [{
          onUse: function () { order.push("onUse"); },
          onHead: function () { order.push("onHead"); },
          onHit: function () { order.push("onHit"); },
          afterHit: function () { order.push("afterHit"); }
        }]
      });
      const atk = mkEntity({ name: "攻方" }), tgt = mkEntity({ name: "目標" });
      runGen(D.resolveDamage(atk, tgt, C.makeCoinRuntime(sk), 0, 5, "測試", fxOpts(sk)));
      eq(order, ["onUse", "onHead", "onHit", "afterHit"], "順序＝使用時→正面時→命中時→命中後");
    }

    section("效果鉤子：反面照樣算命中，但不觸發 [硬幣正面時]");
    {
      const order = [];
      const sk = mkSkill({
        coins: ["normal"], basePower: 0, coinPower: 5,
        coinEffects: [{
          onHead: function () { order.push("onHead"); },
          onHit: function () { order.push("onHit"); }
        }]
      });
      const atk = mkEntity(), tgt = mkEntity({ name: "目標" });
      runGen(D.resolveDamage(atk, tgt, C.makeCoinRuntime(sk), 0, 5, "測試",
        fxOpts(sk, { rng: ALWAYS_TAIL })));
      eq(order, ["onHit"], "反面：onHead 不跑，onHit 照跑（裁決 33）");
    }

    section("效果鉤子：[硬幣正面時] 排在凝神判定之後");
    {
      // 這枚剛上的凝神，這枚自己吃不到（裁決 14：給後續的重用吃）
      const sk = mkSkill({
        coins: ["normal"], basePower: 0, coinPower: 5,
        coinEffects: [{
          onHead: function (ctx) { ctx.apply(ctx.self, "凝神", 1, 6); }
        }]
      });
      const atk = mkEntity({ name: "攻方" }), tgt = mkEntity({ name: "目標" });
      const r = runGen(D.resolveDamage(atk, tgt, C.makeCoinRuntime(sk), 0, 5, "測試", fxOpts(sk)));
      const asked = r.asked.map(function (q) { return q.type; });
      eq(asked.indexOf("concentration1d20"), -1, "判定時凝神仍是 0 級 → 不問 1d20（這枚吃不到）");
      eq([S.layerOf(atk, "凝神"), S.levelOf(atk, "凝神")], [1, 6], "凝神確實有上，只是留給後續");
    }

    section("效果鉤子：coinEffects 依「原始硬幣位置」索引");
    {
      // 第一枚損失後，可擲序的第 0 枚其實是原始的第 1 枚 —— 效果不可以錯位
      const seen = [];
      const sk = mkSkill({
        coins: ["normal", "normal", "normal"], basePower: 0, coinPower: 1,
        coinEffects: [
          { onHit: function () { seen.push(0); } },
          { onHit: function () { seen.push(1); } },
          { onHit: function () { seen.push(2); } }
        ]
      });
      const rt = C.makeCoinRuntime(sk);
      rt[0].status = C.LOST;                       // 第一枚已損失
      const atk = mkEntity(), tgt = mkEntity({ name: "目標" });
      runGen(D.resolveDamage(atk, tgt, rt, 0, 1, "測試", fxOpts(sk)));
      eq(seen, [1, 2], "跳過損失的第 0 枚，跑的是原始索引 1 與 2（不是 0 與 1）");
    }

    section("效果鉤子：ctx.stop() 中止後續硬幣（威爾的子彈不足）");
    {
      const seen = [];
      const sk = mkSkill({
        coins: ["normal", "normal", "normal"], basePower: 0, coinPower: 1,
        coinEffects: [
          { onUse: function () { seen.push(0); } },
          { onUse: function (ctx) { seen.push(1); ctx.stop("資源不足，停止傷害結算"); } },
          { onUse: function () { seen.push(2); } }
        ]
      });
      const atk = mkEntity(), tgt = mkEntity({ name: "目標" });
      const res = runGen(D.resolveDamage(atk, tgt, C.makeCoinRuntime(sk), 0, 1, "測試", fxOpts(sk))).value;
      eq(seen, [0, 1], "第 2 枚要求中止 → 第 3 枚的 onUse 不跑");
      eq(res.hits.length, 1, "只有第 1 枚真的打出去（中止的那枚不結算傷害）");
    }

    section("效果鉤子：技能層級 [使用時] 的威力修正吃得到拚點");
    {
      const sk = mkSkill({
        coins: ["normal"], basePower: 5, coinPower: 5,
        onUse: function (ctx) { ctx.runtime.basePowerBonus = 4; ctx.runtime.coinPowerBonus = 3; }
      });
      const e = mkEntity({ name: "使用者" });
      const use = runGen(T.beginSkillUse(e, sk, null, null, [])).value;
      eq([use.basePower, use.coinPower], [9, 8], "基威 5+4、幣威 5+3 —— 拚點與傷害都用這組");
    }

    section("效果鉤子：afterUse 可要求重複使用（單方面攻擊、硬幣重置）");
    {
      let runs = 0;
      const sk = mkSkill({
        coins: ["normal"], basePower: 1, coinPower: 1,
        afterUse: function (ctx) { runs++; ctx.runtime.repeat = runs < 3; }
      });
      const atk = mkEntity({ name: "攻方" });
      const tgt = mkEntity({ name: "目標", hp: 10000, maxHp: 10000 });
      const use = runGen(T.beginSkillUse(atk, sk, tgt, null, [])).value;
      const events = [];
      runGen(T.runAttackDamage(atk, tgt, sk, C.makeCoinRuntime(sk), use, null, events),
        [1, 1, 1]);
      eq(runs, 3, "afterUse 連續要求兩次重用 → 共跑 3 遍");
      eq(events.filter(function (m) { return m.indexOf("重複使用第") !== -1; }).length, 2,
        "事件紀錄有兩筆重複使用");
    }

    section("效果鉤子：重複使用有硬上限（保險絲）");
    {
      const sk = mkSkill({
        coins: ["normal"], basePower: 1, coinPower: 1,
        afterUse: function (ctx) { ctx.runtime.repeat = true; }   // 故意寫成無限
      });
      const atk = mkEntity({ name: "攻方" });
      const tgt = mkEntity({ name: "目標", hp: 100000, maxHp: 100000 });
      const use = runGen(T.beginSkillUse(atk, sk, tgt, null, [])).value;
      const events = [];
      runGen(T.runAttackDamage(atk, tgt, sk, C.makeCoinRuntime(sk), use, null, events),
        new Array(60).fill(1));
      eq(events.some(function (m) { return m.indexOf("強制中止") !== -1; }), true,
        "達上限時強制中止並留下警告");
    }

    section("【恍惚】拚點也觸發，但會被提前消耗掉（裁決 8）");
    {
      const sk = mkSkill({ coins: ["normal", "normal", "normal"], basePower: 5, coinPower: 5 });
      const e = mkEntity({ name: "被上恍惚者" });
      S.apply(e, "恍惚", 1, 0);
      const rt = C.makeCoinRuntime(sk);

      const ev = [];
      const roll = C.rollAllCoins(rt, 5, 5, 0, ALWAYS_HEAD, e, ev);
      eq(roll.power, 15, "第一枚幣威歸零 → 5 + 0 + 5 + 5 = 15（未上恍惚時是 20）");
      eq(S.layerOf(e, "恍惚"), 0, "1 層恍惚只廢掉 1 枚，當場用完");

      const roll2 = C.rollAllCoins(rt, 5, 5, 0, ALWAYS_HEAD, e, ev);
      eq(roll2.power, 20, "恍惚已用完 → 之後的交換與傷害階段完全正常");
    }

    section("【恍惚】不帶 entity 時不觸發（維持舊呼叫的相容性）");
    {
      const sk = mkSkill({ coins: ["normal"], basePower: 5, coinPower: 5 });
      const e = mkEntity();
      S.apply(e, "恍惚", 3, 0);
      const roll = C.rollAllCoins(C.makeCoinRuntime(sk), 5, 5, 0, ALWAYS_HEAD);
      eq(roll.power, 10, "沒傳 entity → 不讀恍惚（純函式呼叫維持原行為）");
      eq(S.layerOf(e, "恍惚"), 3, "層數也不會被扣");
    }

    section("Effects：回血、專注力、資源");
    {
      const ev = [];
      const e = mkEntity({ name: "傷者", hp: 100, maxHp: 260, focus: 0,
        resources: { 子彈: 2 }, resourceMax: { 子彈: 9 } });
      eq(E.heal(e, 39, "秘方藥", ev), 39, "回血 39");
      eq(E.heal(e, 9999, "溢出", ev), 260 - 139, "回血封頂在 maxHp");
      eq(E.addFocus(e, -50, "測試", ev), -40, "專注力夾在 −40");
      eq(E.setFocus(e, 30, "秘方藥", ev), 30, "setFocus 是「調整至」不是相加");
      eq(E.spend(e, "子彈", 3, "射擊", ev), false, "資源不足 → 回 false 且不扣");
      eq(E.resourceOf(e, "子彈"), 2, "不足時數量不變");
      eq(E.spend(e, "子彈", 2, "射擊", ev), true, "足夠 → 扣掉");
      eq(E.gain(e, "子彈", 99, "裝填", ev), 9, "補充吃 resourceMax 上限");

      const dead = mkEntity({ hp: 0 });
      eq(E.heal(dead, 50, "", ev), 0, "倒下者不能被治療");
    }

    // ============================================================
    // 狀態管線擴充（印記旗標、記帳式增益、keepLevel、延遲債務）
    // ============================================================
    section("印記：noDecay 不因回合結束減少、maxLayer 自訂上限");
    {
      const e = mkEntity({
        name: "囤貨者",
        markMeta: { "仁心": { noDecay: true, maxLayer: 4 }, "爆裂綻放": { noDecay: true, maxLayer: 1 } }
      });
      S.apply(e, "仁心", 3, 0);
      eq(S.layerOf(e, "仁心"), 3, "先囤 3 層");
      S.apply(e, "仁心", 5, 0);
      eq(S.layerOf(e, "仁心"), 4, "maxLayer 4 封頂（不是通用上限表的值）");
      S.apply(e, "爆裂綻放", 3, 0);
      eq(S.layerOf(e, "爆裂綻放"), 1, "爆裂綻放上限 1 層");

      S.apply(e, "守護", 3, 0);   // 對照組：一般狀態照減
      runGen(T.runTurnEndPhase([e], []));
      eq(S.layerOf(e, "仁心"), 4, "noDecay：回合結束不減");
      eq(S.layerOf(e, "守護"), 2, "對照組：一般狀態照通則 −1");
    }

    section("記帳式臨時增益：給多少收多少，自己疊的完整保留");
    {
      const y = mkEntity({ id: "y", name: "結月" });
      const battle = { entities: [y] };
      // 爆發回合：綻放給 6 層傷害強化
      S.grant(y, y, "bloom", "傷害強化", 6, 0, []);
      eq(S.layerOf(y, "傷害強化"), 6, "綻放給了 6 層");
      // 她回合中自己又疊了 3 層
      S.apply(y, "傷害強化", 3, 0);
      eq(S.layerOf(y, "傷害強化"), 9, "自己再疊 3 層 → 9");
      // 回合結束收帳
      S.revoke(y, battle, "bloom", []);
      eq(S.layerOf(y, "傷害強化"), 3, "只收回綻放給的 6 層，自己疊的 3 層完整保留");
    }

    section("記帳式增益：吃過上限之後，只收回「實際給進去的量」");
    {
      const y = mkEntity({ id: "y", name: "結月" });
      const battle = { entities: [y] };
      S.apply(y, "傷害強化", 14, 0);              // 先有 14 層
      const got = S.grant(y, y, "bloom", "傷害強化", 6, 0, []);
      eq(S.layerOf(y, "傷害強化"), 16, "撞到 16 層上限");
      eq(got.layer, 2, "實際只給進去 2 層");
      S.revoke(y, battle, "bloom", []);
      eq(S.layerOf(y, "傷害強化"), 14, "只收回 2 層，不會多扣");
    }

    section("記帳式增益：可以記在別人身上（旭給敵人的傷害弱化）");
    {
      const a = mkEntity({ id: "a", name: "旭" });
      const g1 = mkEntity({ id: "g1", name: "哥布林A" });
      const g2 = mkEntity({ id: "g2", name: "哥布林B" });
      const battle = { entities: [a, g1, g2] };
      S.grant(a, g1, "killer", "傷害弱化", 3, 0, []);
      S.grant(a, g2, "killer", "傷害弱化", 3, 0, []);
      eq([S.layerOf(g1, "傷害弱化"), S.layerOf(g2, "傷害弱化")], [3, 3], "兩隻敵人各拿 3 層");
      S.revoke(a, battle, "killer", []);
      eq([S.layerOf(g1, "傷害弱化"), S.layerOf(g2, "傷害弱化")], [0, 0], "回合結束一次收乾淨");
    }

    section("震顫爆發：keepLevel 保留級數，但層數照減");
    {
      const t = mkEntity({ name: "目標", hp: 500, maxHp: 500 });
      S.apply(t, "震顫", 4, 30);
      const ev = [];
      const lv = S.tremorBurst(t, ev, { keepLevel: true });
      eq(lv, 30, "引爆 30 級");
      eq(S.levelOf(t, "震顫"), 30, "keepLevel → 級數保留（旭技能D 前三枚）");
      eq(S.layerOf(t, "震顫"), 3, "層數照減 −1");

      S.tremorBurst(t, ev);   // 第四枚：正常爆發
      eq(S.levelOf(t, "震顫"), 0, "不帶 keepLevel → 級數歸零");
      eq(S.layerOf(t, "震顫"), 2, "層數同樣 −1");
    }

    section("震顫爆發：keepLevel 但層數掉到 0 時，級數仍依附層數歸零");
    {
      const t = mkEntity({ name: "目標", hp: 500, maxHp: 500 });
      S.apply(t, "震顫", 1, 20);
      S.tremorBurst(t, [], { keepLevel: true });
      eq(S.layerOf(t, "震顫"), 0, "最後一層被扣掉");
      eq(S.levelOf(t, "震顫"), 0, "級數依附層數 → 仍然歸零（keepLevel 擋不住這條）");
    }

    section("延遲債務：記在別人身上、下個回合開始才結算");
    {
      const ally = mkEntity({ name: "隊友" });
      S.apply(ally, "守護", 10, 0);
      S.addPendingDebt(ally, { name: "守護", layer: -8, label: "緊急腎上腺素退場" });
      eq(S.layerOf(ally, "守護"), 10, "掛上債務的當下不扣");
      const ev = [];
      S.runPendingDebts(ally, ev);
      eq(S.layerOf(ally, "守護"), 2, "下回合開始才扣 8 層");
      eq(ally.pendingDebts.length, 0, "結算後清空");
    }

    section("延遲債務：不足扣到 0；倒下則取消（裁決 40）");
    {
      const a = mkEntity({ name: "薄盾者" });
      S.apply(a, "守護", 3, 0);
      S.addPendingDebt(a, { name: "守護", layer: -8, label: "退場" });
      S.runPendingDebts(a, []);
      eq(S.layerOf(a, "守護"), 0, "只有 3 層 → 扣到 0 為止，不倒欠");

      const dead = mkEntity({ name: "倒下者", hp: 0 });
      S.apply(dead, "守護", 10, 0);
      S.addPendingDebt(dead, { name: "守護", layer: -8, label: "退場" });
      const ev = [];
      eq(S.runPendingDebts(dead, ev), 0, "倒下 → 債務取消");
      eq(S.layerOf(dead, "守護"), 10, "守護不動");
    }

    section("DEX 換算到角卡尺度（1–99）");
    {
      const target = Ch.testTarget();
      const gob = Ch.spawn("goblin_grunt", 1)[0];
      eq([target.dex, gob.dex], [60, 40], "測試標靶 60、哥布林兵 40（與 PC 的 50–90 同一把尺）");
      eq(Ch.pcRoster().map(function (p) { return p.name + p.dex; }),
        ["威爾‧賽爾弗特65", "夜櫻結月60", "渡邊旭90", "霧島和真50"], "四名 PC 的 DEX");
      S.apply(gob, "迅捷", 5, 0);
      eq(S.effectiveDex(gob), 40 * 1.25, "迅捷是百分比，換尺度後照常運作");
    }

    // ============================================================
    // 四名 PC（每條裁決各一則）
    // ============================================================
    const P = global.Passives;
    function pc(id) { return Ch.pcRoster().find(function (p) { return p.id === id; }); }
    function skOf(e, id) { return e.skillLibrary.find(function (s) { return s.id === id; }); }
    function mkBattle(list) {
      list.forEach(function (e) { e.canAct = true; e.declarations = e.declarations || []; });
      return { turnNumber: 1, entities: list, pcGrowthOrder: [], turnOrder: list };
    }
    // 這些整合測試要可重現 → 暫時把 Math.random 換掉（0 = 永遠正面）
    function withRandom(value, fn) {
      const orig = Math.random;
      Math.random = function () { return value; };
      try { return fn(); } finally { Math.random = orig; }
    }
    // 跑一次完整的技能使用（單方面攻擊），硬幣一律正面
    function useSkill(actor, target, skill, battle, events, answers) {
      return withRandom(0, function () {
        const rt = C.makeCoinRuntime(skill);
        const gen = (function* () {
          const use = yield* T.beginSkillUse(actor, skill, target, battle, events);
          yield* T.runAttackDamage(actor, target, skill, rt, use, battle, events);
        })();
        return runGen(gen, answers || new Array(60).fill(1));
      });
    }

    section("威爾：技能C 從 9 發連射恰好 4 次，且過程中快速裝填不觸發");
    {
      const will = pc("pc_will");
      const dummy = mkEntity({ id: "d", name: "肉靶", hp: 99999, maxHp: 99999 });
      const battle = mkBattle([will, dummy]);
      const ev = [];
      const r = useSkill(will, dummy, skOf(will, "w_c"), battle, ev);
      eq(will.resources["子彈"], 1, "9 → 7 → 5 → 3 → 1，剛好停在 1 發");
      eq(ev.filter(function (m) { return m.indexOf("重複使用第") !== -1; }).length, 3,
        "重複使用 3 次（＋第一次＝共 4 次）");
      eq(r.asked.some(function (q) { return q.type === "passiveChoice"; }), false,
        "連鎖期間不問快速裝填（裁決 9：[使用後] 算在傷害結算期間內）");
    }

    section("威爾：技能C 的條件式加成只算一次，全程沿用（裁決 12）");
    {
      const will = pc("pc_will");
      const dummy = mkEntity({ id: "d", name: "肉靶", hp: 99999, maxHp: 99999 });
      S.apply(dummy, "震顫", 3, 12);      // 12 級 → 幣威 +5（封頂）
      S.apply(dummy, "易損", 2, 0);       // 2 層 → 基威 +2
      const battle = mkBattle([will, dummy]);
      const ev = [];
      useSkill(will, dummy, skOf(will, "w_c"), battle, ev);
      const line = ev.find(function (m) { return m.indexOf("條件式加成") !== -1; });
      eq(!!line && line.indexOf("幣威 +5") !== -1 && line.indexOf("基威 +2") !== -1, true,
        "震顫 12 級 → 幣威 +5（封頂）；易損 2 層 → 基威 +2");
      eq(ev.filter(function (m) { return m.indexOf("條件式加成") !== -1; }).length, 1,
        "四輪連射只算一次（第一輪就把震顫炸掉了，但加成不重算）");
    }

    section("威爾：拚輸 → 不重用、子彈一發都不扣（裁決 11、13）");
    {
      const will = pc("pc_will");
      const foe = mkEntity({ id: "f", name: "強敵", hp: 9999, maxHp: 9999,
        skillLibrary: [mkSkill({ id: "big", basePower: 99, coinPower: 99, coins: ["normal"] })] });
      const battle = mkBattle([will, foe]);
      will.declarations = [{ slotIndex: 0, skillId: "w_c", action: "attack", targetId: "f" }];
      foe.declarations = [{ slotIndex: 0, skillId: "big", action: "attack", targetId: will.id }];
      const ev = [];
      runGen(T.resolveEntry(battle, {
        kind: "clash", aEntityId: will.id, aSkillId: "w_c", aSlot: 0,
        bEntityId: "f", bSkillId: "big", bSlot: 0, targetId: "f"
      }, ev), new Array(40).fill(1));
      eq(will.resources["子彈"], 9, "拚輸 → 子彈一發都沒扣（[使用時] 在傷害結算才跑）");
      eq(ev.some(function (m) { return m.indexOf("重複使用第") !== -1; }), false, "也不會重複使用");
    }

    section("威爾：槍械破甲 —— 爆發落空也給易損（裁決 7）");
    {
      const will = pc("pc_will");
      const dummy = mkEntity({ id: "d", name: "乾淨目標", hp: 9999, maxHp: 9999 });
      const battle = mkBattle([will, dummy]);
      const ev = [];
      // 技能C 只有一枚硬幣、只給級數不給層 → 對乾淨目標爆發必定落空
      // （子彈壓成 2 發，打完剩 0 → 不會觸發重複使用）
      will.resources["子彈"] = 2;
      useSkill(will, dummy, skOf(will, "w_c"), battle, ev);
      eq(S.layerOf(dummy, "易損") >= 1, true, "爆發落空仍施加【易損】");
      eq(ev.some(function (m) { return m.indexOf("無累積的震顫級數") !== -1; }), true,
        "事件紀錄顯示爆發確實落空");
    }

    section("結月：技能C 第一枚的凝神級數確實蒸發（裁決 18）");
    {
      const y = pc("pc_yuzuki");
      const dummy = mkEntity({ id: "d", name: "肉靶", hp: 9999, maxHp: 9999 });
      const battle = mkBattle([y, dummy]);
      const ev = [];
      useSkill(y, dummy, skOf(y, "y_c"), battle, ev,
        [1].concat(new Array(40).fill(20)));   // 乘數1、凝神 1d20 全不觸發
      eq(ev.some(function (m) { return m.indexOf("層數為 0，級數無法預存") !== -1; }), true,
        "第一枚的 [正面時] 3 級被丟掉（層數還沒鎖上）");
      eq(S.layerOf(y, "凝神"), 4, "三枚各給層 → 1+1+2 = 4 層");
      eq(S.levelOf(y, "凝神"), 9, "存得住的只有第二、三枚的 4+5 = 9 級");
    }

    section("結月：爆裂綻放記帳收尾，自己疊的完整保留（裁決 21、22）");
    {
      const y = pc("pc_yuzuki");
      const battle = mkBattle([y]);
      S.apply(y, "爆裂綻放", 1, 0, { isMark: true, noDecay: true, maxLayer: 1 });
      S.apply(y, "虛弱", 13, 0);
      S.apply(y, "凝神", 2, 0);          // 先有凝神層，級數才存得住
      const ev = [];
      runGen(P.runTurnStart(battle, ev));
      eq(S.layerOf(y, "傷害強化"), 13, "13 層虛弱 → 傷害強化 +13");
      eq(S.layerOf(y, "強壯"), 6, "「一半」無條件捨去 → ⌊13/2⌋ = 6");
      eq(S.layerOf(y, "虛弱"), 0, "虛弱歸零");
      // 回合中她自己又疊了一些
      S.apply(y, "傷害強化", 3, 0);
      runGen(P.runTurnEnd([y], battle, ev));
      eq(S.layerOf(y, "傷害強化"), 3, "只收回綻放給的 13 層，自己疊的 3 層保留");
      eq(S.layerOf(y, "爆裂綻放"), 0, "標記歸零");
    }

    section("結月：傷害強化吃 16 層上限（裁決 22）");
    {
      const y = pc("pc_yuzuki");
      const battle = mkBattle([y]);
      S.apply(y, "爆裂綻放", 1, 0, { isMark: true, noDecay: true, maxLayer: 1 });
      S.apply(y, "虛弱", 20, 0);
      runGen(P.runTurnStart(battle, []));
      eq(S.layerOf(y, "傷害強化"), 16, "20 層虛弱也只拿得到 16 層（上限）");
      eq(S.layerOf(y, "強壯"), 10, "強壯沒有上限 → ⌊20/2⌋ = 10");
    }

    section("結月：乘勝指揮把超過 20 的凝神級數換成層數");
    {
      const y = pc("pc_yuzuki");
      const battle = mkBattle([y]);
      S.apply(y, "凝神", 1, 35);
      runGen(P.runTurnStart(battle, []));
      eq(S.levelOf(y, "凝神"), 20, "35 級 → 超過 20 的 15 級被換掉");
      eq(S.layerOf(y, "凝神"), 4, "1 + 3 層（一回合最多換 3 層）");
    }

    section("旭：被動2 與被動4 的加減剛好淨 0（裁決 25）");
    {
      const a = pc("pc_akira");
      const gob = Ch.spawn("goblin_grunt", 1)[0];
      const battle = mkBattle([a, gob]);
      S.apply(a, "勁足", 13, 0, { isMark: true, noDecay: true });  // 回合開始 +2 → 15
      runGen(P.runTurnStart(battle, []));
      eq(S.layerOf(a, "勁足"), 15, "勁足 13 → 每回合 +2 → 15");
      eq([S.layerOf(a, "守護"), S.layerOf(a, "傷害強化"), S.layerOf(a, "迅捷")], [3, 3, 5],
        "守護 +3、傷害強化 +3、迅捷 +⌊15/3⌋ = 5");
      eq(S.layerOf(gob, "傷害弱化"), 3, "勁足 ≥15 → 敵方 3 層傷害弱化（本回合限定）");

      runGen(T.runTurnEndPhase(battle.entities, [], {
        runTurnEndPassives: function* (alive, ev) { yield* P.runTurnEnd(alive, battle, ev); }
      }));
      eq([S.layerOf(a, "守護"), S.layerOf(a, "傷害強化"), S.layerOf(a, "迅捷")], [0, 0, 0],
        "被動4 的 −2/−2/−4 加上通則 −1 → 三條剛好歸零（淨 0，不會累積）");
      eq(S.layerOf(gob, "傷害弱化"), 0, "敵方的傷害弱化也一併收回（不會無限疊高）");
      eq(S.layerOf(a, "勁足"), 15, "〈勁足〉noDecay，回合結束不減");
    }

    section("旭：振刀達 17 層 → 歸零並解鎖《肉斬骨斷》（本回合限定）");
    {
      const a = pc("pc_akira");
      const battle = mkBattle([a]);
      S.apply(a, "勁足", 15, 0, { isMark: true, noDecay: true });   // +2 → 17
      runGen(P.runTurnStart(battle, []));
      eq(S.layerOf(a, "勁足"), 0, "達門檻 → 勁足歸零");
      eq(a.tempSkillIds, ["a_d"], "解鎖技能D");
      eq(T.freeUseSkills(a).map(function (s) { return s.id; }), ["guard", "dodge", "a_d"],
        "技能D 進入「不受抽選限制」清單（裁決 27）");
      // 先拿增益再歸零（lifecycle.md：buff 先於 cost）
      eq(S.layerOf(a, "守護"), 3, "殺手本位的增益在振刀歸零之前就先拿到了");

      runGen(P.runTurnEnd([a], battle, []));
      eq(a.tempSkillIds, [], "回合結束解鎖失效（沒用到就白費，裁決 31）");
    }

    section("旭：技能D 四次爆發，前三次保留級數（裁決 29）");
    {
      const a = pc("pc_akira");
      const foe = mkEntity({ id: "f", name: "敵人", hp: 5000, maxHp: 5000 });
      S.apply(foe, "震顫", 2, 30);
      const battle = mkBattle([a, foe]);
      const before = S.thresholds(foe).slice();
      const ev = [];
      useSkill(a, foe, skOf(a, "a_d"), battle, ev);
      const bursts = ev.filter(function (m) { return m.indexOf("【震顫爆發】：") !== -1; });
      eq(bursts.length, 4, "四枚硬幣各引爆一次");
      eq(ev.filter(function (m) { return m.indexOf("不歸零【震顫】級數") !== -1; }).length, 3,
        "前三次保留級數，第四次歸零");
      eq(S.levelOf(foe, "震顫"), 0, "第四次爆發後級數歸零");
      eq(S.thresholds(foe)[0] > before[0], true, "混亂值被大幅推高");
      eq(S.layerOf(a, "勁足"), 4, "技能D 只有 [使用後] 給 4 層〈勁足〉（逐枚效果不給）");
    }

    section("跨角色：旭引爆震顫 → 威爾的援護射擊自動追擊並扣子彈（裁決 16）");
    {
      const a = pc("pc_akira"), will = pc("pc_will");
      const foe = mkEntity({ id: "f", name: "敵人", hp: 9999, maxHp: 9999 });
      S.apply(foe, "震顫", 3, 20);
      const battle = mkBattle([a, will, foe]);
      const ev = [];
      useSkill(a, foe, skOf(a, "a_c"), battle, ev);   // 硬幣3 會引爆
      eq(will.pendingInvocations.length, 1, "威爾排入一次自動發動");
      runGen(T.drainInvocations(battle, ev), new Array(20).fill(1));
      eq(will.resources["子彈"], 8, "援護射擊消耗 1 發子彈");
      eq(ev.some(function (m) { return m.indexOf("援護射擊") !== -1; }), true, "事件紀錄有標註");
    }

    section("跨角色：敵方 NPC 引爆震顫，不會觸發威爾的援護射擊");
    {
      // 「其他友方單位」＝同陣營。敵人自己引爆（例如敵方也有帶爆發的技能）不該讓威爾開槍。
      const will = pc("pc_will");
      const foe = Ch.spawn("maid_veteran", 1)[0];
      const victim = pc("pc_kazuma");
      S.apply(victim, "震顫", 3, 12);
      const battle = mkBattle([will, foe, victim]);
      const ev = [];
      E.makeCtx({ self: foe, target: victim, battle: battle, events: ev }).tremorBurst(victim);
      eq((will.pendingInvocations || []).length, 0, "敵方引爆 → 威爾不追擊");

      // 對照組：友方 PC 引爆就會觸發
      S.apply(victim, "震顫", 3, 12);
      const akira = pc("pc_akira");
      battle.entities.push(akira); akira.canAct = true;
      E.makeCtx({ self: akira, target: victim, battle: battle, events: ev }).tremorBurst(victim);
      eq((will.pendingInvocations || []).length, 1, "友方引爆 → 威爾追擊");
    }

    section("跨角色：威爾混亂時，援護射擊不觸發（裁決 16）");
    {
      const a = pc("pc_akira"), will = pc("pc_will");
      const foe = mkEntity({ id: "f", name: "敵人", hp: 9999, maxHp: 9999 });
      S.apply(foe, "震顫", 3, 20);
      will.confusionLockTurns = 2;
      will.isConfused = true;
      const battle = mkBattle([a, will, foe]);
      useSkill(a, foe, skOf(a, "a_c"), battle, []);
      eq((will.pendingInvocations || []).length, 0, "混亂中 → 不觸發");
    }

    section("和真：技能A 反面也治療，且拚輸不扣仁心（裁決 33、36）");
    {
      const k = pc("pc_kazuma");
      const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, hp: 100, maxHp: 240 });
      const battle = mkBattle([k, ally]);
      S.apply(k, "仁心", 4, 0, { isMark: true, noDecay: true, maxLayer: 4 });
      k.declarations = [{ slotIndex: 0, skillId: "k_a", action: "support", supportId: "ally" }];
      const ev = [];
      runGen(T.resolveEntry(battle, {
        kind: "defenseOnly", aEntityId: k.id, aSkillId: "k_a", aSlot: 0
      }, ev), new Array(20).fill(1));
      eq(ally.hp > 100, true, "沒有敵人攻擊他 → 不用拚點，直接治療生效");
      eq(S.layerOf(ally, "檢傷分類"), 1, "[使用後] 給對象〈檢傷分類〉");
      eq(S.layerOf(k, "仁心"), 4, "[使用時] −1、[使用後] +1 → 淨 0");
    }

    section("和真：秘方藥解除混亂後本回合立刻能動（裁決 38）");
    {
      const k = pc("pc_kazuma");
      const battle = mkBattle([k]);
      S.apply(k, "茶乃的秘方藥", 5, 0, { isMark: true, noDecay: true, maxLayer: 5 });
      S.enterConfusion(k, []);
      eq([k.isConfused, k.confusionLockTurns, k.cantActRestOfTurn], [true, 2, true], "先進入混亂");
      const ev = [];
      runGen(P.fire(k, "onAfterSkillResolved", battle, ev), ["yes", "no"]);
      eq([k.isConfused, k.confusionLockTurns, k.cantActRestOfTurn], [false, 0, false],
        "全部解除，本回合立刻能動");
      eq(k.focus, 30, "專注力「調整至」30");
      eq(S.layerOf(k, "茶乃的秘方藥"), 2, "消耗 3 層");
    }

    section("和真：急救的守護債務兩回合後才結算（裁決 40）");
    {
      const k = pc("pc_kazuma");
      const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, hp: 100, maxHp: 240 });
      S.enterConfusion(ally, []);
      const battle = mkBattle([k, ally]);
      S.apply(k, "仁心", 4, 0, { isMark: true, noDecay: true, maxLayer: 4 });
      const ev = [];
      runGen(P.runTurnEnd([k], battle, ev), ["ally"]);
      eq(S.layerOf(ally, "守護"), 10, "獲救者 +10 層守護");
      eq(S.layerOf(ally, "緊急腎上腺素"), 2, "+2 層腎上腺素");
      eq(S.layerOf(k, "仁心"), 0, "消耗 4 層仁心");

      // 兩個回合之後腎上腺素從 1 掉到 0 → 掛上債務
      ally.states["緊急腎上腺素"].addedThisTurn = false;   // 模擬進入下一回合
      S.apply(ally, "緊急腎上腺素", -1, 0);   // 2 → 1
      runGen(P.runTurnEnd([k], battle, []), ["no"]);
      eq((ally.pendingDebts || []).length, 1, "腎上腺素剩 1 層 → 掛上 −8 守護的延遲債務");
      S.runPendingDebts(ally, []);
      eq(S.layerOf(ally, "守護"), 2, "下回合開始扣 8 層");
    }

    section("和真的技能A 受抽選限制，不會出現在其他槽位（裁決 34）");
    {
      const k = pc("pc_kazuma");
      eq(T.freeUseSkills(k).map(function (s) { return s.id; }), ["guard", "dodge"],
        "「不受抽選限制」只認【防守】【閃躲】—— 技能A 雖是防禦型但不在內");
      const menu = T.buildDrawMenu(k, 6, 6);   // 骰面 6/6 → 都指向 C 槽位
      eq(menu.options.map(function (o) { return o.id; }), ["k_c", "guard", "dodge"],
        "骰到 C 槽位時菜單裡沒有技能A");
    }

    // ============================================================
    // 敵方 NPC：熟練工作的女僕
    // ============================================================
    function maid() { return Ch.spawn("maid_veteran", 1)[0]; }

    section("女僕：藍圖數值與混亂值");
    {
      const m = maid();
      eq([m.hp, m.maxHp, m.dex], [1322, 1322, 65], "HP 1322、DEX 65（與威爾並列）");
      eq(S.thresholds(m), [793, 0], "混亂值 = ⌊1322×60%⌋ = 793 與 0");
      eq(m.skillLibrary.map(function (s) { return s.id; }),
        ["maid_a", "maid_b", "maid_c", "guard", "dodge"], "五把技能");
      eq(T.freeUseSkills(m).map(function (s) { return s.id; }), ["guard", "dodge"],
        "只有防守／閃躲不受抽選限制");
    }

    section("女僕被動1：目標半血以下 → 基威 +1");
    {
      const m = maid();
      const foe = mkEntity({ id: "v", name: "受害者", isPC: true, hp: 700, maxHp: 1000 });
      const battle = mkBattle([m, foe]);
      const skA = m.skillLibrary[0];

      let use = runGen(T.beginSkillUse(m, skA, foe, battle, [])).value;
      eq(use.basePower, 4, "70% 血 → 不加");

      foe.hp = 500;
      use = runGen(T.beginSkillUse(m, skA, foe, battle, [])).value;
      eq(use.basePower, 4, "剛好 50% → 「小於」不成立，仍不加");

      foe.hp = 499;
      use = runGen(T.beginSkillUse(m, skA, foe, battle, [])).value;
      eq(use.basePower, 5, "低於 50% → 基威 4 → 5");
    }

    section("女僕被動1：防禦型技能也吃得到，但無目標時不成立（裁決 43）");
    {
      const m = maid();
      const foe = mkEntity({ id: "v", name: "攻擊者", isPC: true, hp: 100, maxHp: 1000 });
      const battle = mkBattle([m, foe]);
      const guard = m.skillLibrary.find(function (s) { return s.id === "guard"; });

      // 拚點中的防禦技：target 就是攻擊者
      let use = runGen(T.beginSkillUse(m, guard, foe, battle, [])).value;
      eq(use.basePower, 5, "防守基威 4 → 5（對手已殘血）");

      // 無人攻擊的防守：target 為 null → 條件不成立
      use = runGen(T.beginSkillUse(m, guard, null, battle, [])).value;
      eq(use.basePower, 4, "沒有目標 → 不加");
    }

    section("女僕被動1：用累加，不會被技能自己的 onUse 指派蓋掉");
    {
      // 對照組：威爾技能C 的 onUse 是「指派」runtime.basePowerBonus
      const m = maid();
      const foe = mkEntity({ id: "v", name: "殘血目標", isPC: true, hp: 10, maxHp: 1000 });
      S.apply(foe, "易損", 3, 0);
      const battle = mkBattle([m, foe]);
      // 借威爾的技能C 掛到女僕身上，驗證兩者相加
      const willC = pc("pc_will").skillLibrary.find(function (s) { return s.id === "w_c"; });
      m.tuning.cFragileBonusPerLayer = 1; m.tuning.cFragileBonusCap = 5;
      m.tuning.cTremorPerStep = 4; m.tuning.cTremorBonusPerStep = 2; m.tuning.cTremorBonusCap = 5;
      const use = runGen(T.beginSkillUse(m, willC, foe, battle, [])).value;
      eq(use.basePower, 5 + 3 + 1, "技能指派 +3（易損）＋ 被動累加 +1 = 基威 9");
    }

    section("女僕被動2：恐慌回合結束 → 下回合開始才拿到【迅捷】（裁決 42）");
    {
      const m = maid();
      const battle = mkBattle([m]);
      m.isPanicking = true;
      const ev = [];
      runGen(P.runTurnEnd([m], battle, ev));
      eq(S.layerOf(m, "迅捷"), 0, "回合結束當下不加");
      eq((m.pendingDebts || []).length, 1, "掛上延遲效果");
      S.runPendingDebts(m, ev);
      eq(S.layerOf(m, "迅捷"), 1, "下回合開始才拿到 1 層【迅捷】");

      // 不在恐慌中 → 不掛
      const m2 = maid();
      runGen(P.runTurnEnd([m2], mkBattle([m2]), []));
      eq((m2.pendingDebts || []).length, 0, "沒恐慌就不掛");
    }

    section("女僕技能B／C：條件讀「有效 DEX」（裁決 41）");
    {
      const m = maid();
      const will = pc("pc_will");   // DEX 65，與她並列
      const battle = mkBattle([m, will]);
      const skB = m.skillLibrary.find(function (s) { return s.id === "maid_b"; });

      runGen(T.beginSkillUse(m, skB, will, battle, []));
      eq(m.focus, 0, "65 vs 65「不大於」→ 條件不成立，不加專注力");

      // 對方吃 2 層綁縛 → 有效 DEX 65 × 0.9 = 58.5 → 成立
      S.apply(will, "綁縛", 2, 0);
      runGen(T.beginSkillUse(m, skB, will, battle, []));
      eq(m.focus, 5, "壓了綁縛之後成立 → 專注力 +5");

      // 她自己吃 1 層迅捷也一樣能拉開
      const m2 = maid(), will2 = pc("pc_will");
      const b2 = mkBattle([m2, will2]);
      S.apply(m2, "迅捷", 1, 0);
      runGen(T.beginSkillUse(m2, skB, will2, b2, []));
      eq(m2.focus, 5, "自己疊迅捷（65×1.05）也能讓條件成立");

      // 技能C 的版本：成立時給對方 1 層傷害弱化
      const m3 = maid(), kaz = pc("pc_kazuma");   // DEX 50，穩定成立
      const b3 = mkBattle([m3, kaz]);
      const skC = m3.skillLibrary.find(function (s) { return s.id === "maid_c"; });
      runGen(T.beginSkillUse(m3, skC, kaz, b3, []));
      eq(S.layerOf(kaz, "傷害弱化"), 1, "技能C 的 [使用時] 給對方【傷害弱化】");
    }

    section("女僕技能：逐枚的綁縛／易損／傷害弱化");
    {
      const m = maid();
      const foe = mkEntity({ id: "v", name: "目標", isPC: true, hp: 9999, maxHp: 9999 });
      const battle = mkBattle([m, foe]);
      useSkill(m, foe, m.skillLibrary.find(function (s) { return s.id === "maid_c"; }), battle, []);
      eq([S.layerOf(foe, "易損"), S.layerOf(foe, "傷害弱化"), S.layerOf(foe, "綁縛")],
        [1, 2, 2], "易損 1（幣1）、傷害弱化 2（使用時 + 幣2）、綁縛 2（幣3）");
    }

    section("女僕：閃躲拚贏才回專注力");
    {
      const m = maid();
      const atk = mkEntity({ id: "a", name: "弱攻擊", isPC: true, hp: 500, maxHp: 500,
        skillLibrary: [mkSkill({ id: "weak", basePower: 0, coinPower: 0, coins: ["normal"] })] });
      const battle = mkBattle([m, atk]);
      m.declarations = [{ slotIndex: 0, skillId: "dodge", action: "defend" }];
      atk.declarations = [{ slotIndex: 0, skillId: "weak", action: "attack", targetId: m.id }];
      const ev = [];
      withRandom(0, function () {
        runGen(T.resolveEntry(battle, {
          kind: "clash", aEntityId: "a", aSkillId: "weak", aSlot: 0,
          bEntityId: m.id, bSkillId: "dodge", bSlot: 0, targetId: m.id
        }, ev), new Array(20).fill(1));
      });
      eq(ev.some(function (x) { return x.indexOf("成功閃躲") !== -1; }), true, "閃躲拚贏");
      eq(m.focus > 0, true, "拚贏 → 專注力 +5（含拚點本身的專注力結算）");
    }

    // ============================================================
    // 攔截：比攻擊者（裁決 44）＋ 照宣告綁定（裁決 45）
    // ============================================================
    function icBattle(o) {
      const atkr = mkEntity({ id: "atkr", name: "攻擊者", isPC: false, dex: o.attackerDex, canAct: true });
      const ally = mkEntity({ id: "ally", name: "被保護者", isPC: true, dex: o.allyDex, canAct: true });
      const hero = mkEntity({ id: "hero", name: "攔截者", isPC: true, dex: o.heroDex, canAct: true });
      const sk = mkSkill({ id: "s1", coins: ["normal"] });
      [atkr, ally, hero].forEach(function (e) { e.skillLibrary = [sk]; });
      atkr.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
      hero.declarations = [{ slotIndex: 0, skillId: "s1", action: "intercept",
        targetId: o.named === undefined ? "atkr" : o.named, protectId: "ally" }];
      return { entities: [atkr, ally, hero], turnOrder: [hero, atkr, ally] };
    }

    section("攔截：比的是「攻擊者」，不是被保護的隊友（裁決 44）");
    {
      // ⚠ 這兩個案例正好能區分新舊讀法 —— 舊版（比被保護者）會得到相反的結果
      const slowVsFast = T.buildPairing(icBattle({ heroDex: 65, attackerDex: 90, allyDex: 50 }));
      eq(slowVsFast.entries[0].kind, "unilateral",
        "攔截者65 < 攻擊者90（但 > 被保護者50）→ 被拒（舊讀法會成立）");
      eq(slowVsFast.notes.some(function (n) { return !n.ok && /攻擊者/.test(n.text); }), true,
        "被拒的理由指向攻擊者");

      const fastVsSlow = T.buildPairing(icBattle({ heroDex: 65, attackerDex: 50, allyDex: 90 }));
      eq(fastVsSlow.entries[0].kind, "clash",
        "攔截者65 > 攻擊者50（但 < 被保護者90）→ 成立（舊讀法會被拒）");
      eq(fastVsSlow.entries[0].bEntityId, "hero", "拚點對手換成攔截者");

      const tie = T.buildPairing(icBattle({ heroDex: 65, attackerDex: 65, allyDex: 10 }));
      eq(tie.entries[0].kind, "unilateral", "與攻擊者相等 → 被拒（嚴格大於）");
    }

    section("攔截：讀的是有效 DEX（迅捷／綁縛會改變結果）");
    {
      const b = icBattle({ heroDex: 60, attackerDex: 65, allyDex: 50 });
      eq(T.buildPairing(b).entries[0].kind, "unilateral", "60 < 65 → 被拒");

      S.apply(b.entities[2], "迅捷", 2, 0);      // 攔截者 60 × 1.10 = 66
      eq(T.buildPairing(b).entries[0].kind, "clash", "攔截者吃 2 層迅捷 → 66 > 65 → 成立");

      const b2 = icBattle({ heroDex: 60, attackerDex: 65, allyDex: 50 });
      S.apply(b2.entities[0], "綁縛", 2, 0);     // 攻擊者 65 × 0.90 = 58.5
      eq(T.buildPairing(b2).entries[0].kind, "clash", "攻擊者被壓 2 層綁縛 → 58.5 < 60 → 成立");
    }

    section("攔截：照宣告綁定，不會被綁到別的攻擊者身上（裁決 45）");
    {
      function twoAttackers(namedId) {
        const fast = mkEntity({ id: "fast", name: "快敵", isPC: false, dex: 40, canAct: true });
        const slow = mkEntity({ id: "slow", name: "慢敵", isPC: false, dex: 20, canAct: true });
        const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, dex: 10, canAct: true });
        const hero = mkEntity({ id: "hero", name: "攔截者", isPC: true, dex: 50, canAct: true });
        const sk = mkSkill({ id: "s1", coins: ["normal"] });
        [fast, slow, ally, hero].forEach(function (e) { e.skillLibrary = [sk]; });
        fast.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
        slow.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
        hero.declarations = [{ slotIndex: 0, skillId: "s1", action: "intercept",
          targetId: namedId, protectId: "ally" }];
        return { entities: [fast, slow, ally, hero], turnOrder: [hero, fast, slow, ally] };
      }
      const p = T.buildPairing(twoAttackers("slow"));
      const clash = p.entries.find(function (x) { return x.kind === "clash"; });
      eq(clash && clash.aEntityId, "slow", "宣告攔慢敵 → 綁到慢敵（舊版會綁到先處理的快敵）");
      eq(p.entries.filter(function (x) { return x.kind === "unilateral"; })[0].aEntityId, "fast",
        "快敵變成單方面攻擊");

      const p2 = T.buildPairing(twoAttackers(""));
      eq(p2.entries.some(function (x) { return x.kind === "clash"; }), true,
        "留空（任何人）→ 照樣攔得到");
    }

    section("攔截：指名的攻擊者沒出手 → 退回攔任何人");
    {
      const other = mkEntity({ id: "other", name: "沒出手的敵人", isPC: false, dex: 20, canAct: true });
      const b = icBattle({ heroDex: 90, attackerDex: 40, allyDex: 10, named: "other" });
      b.entities.push(other);
      const p = T.buildPairing(b);
      eq(p.entries[0].kind, "clash", "指名的人本回合沒攻擊 → 退回攔實際打過來的那個");
      eq(p.notes.some(function (n) { return n.ok && /未指名|任何打他的人/.test(n.text); }), true,
        "note 標明是退回行為");
    }

    section("攔截：指名的人有出手但 DEX 不夠 → 直接失敗，不會改攔別人");
    {
      const fast = mkEntity({ id: "fast", name: "快敵", isPC: false, dex: 90, canAct: true });
      const slow = mkEntity({ id: "slow", name: "慢敵", isPC: false, dex: 10, canAct: true });
      const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, dex: 5, canAct: true });
      const hero = mkEntity({ id: "hero", name: "攔截者", isPC: true, dex: 50, canAct: true });
      const sk = mkSkill({ id: "s1", coins: ["normal"] });
      [fast, slow, ally, hero].forEach(function (e) { e.skillLibrary = [sk]; });
      fast.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
      slow.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
      hero.declarations = [{ slotIndex: 0, skillId: "s1", action: "intercept",
        targetId: "fast", protectId: "ally" }];   // 指名快敵，但 50 < 90
      const p = T.buildPairing({ entities: [fast, slow, ally, hero], turnOrder: [hero, fast, slow, ally] });
      eq(p.entries.some(function (x) { return x.kind === "clash"; }), false,
        "指名了卻攔不動 → 攔截失敗，不會默默改攔慢敵");
      eq(p.entries.filter(function (x) { return x.kind === "unilateral"; }).length, 2,
        "兩個敵人都變成單方面攻擊");
    }

    section("interceptableAttackers：只列攔得到的敵方攻擊者");
    {
      const hero = mkEntity({ id: "hero", name: "攔截者", isPC: true, dex: 65 });
      const slowFoe = mkEntity({ id: "slow", name: "慢敵", isPC: false, dex: 50 });
      const tieFoe = mkEntity({ id: "tie", name: "同速敵", isPC: false, dex: 65 });
      const fastFoe = mkEntity({ id: "fast", name: "快敵", isPC: false, dex: 90 });
      const deadFoe = mkEntity({ id: "dead", name: "倒下的敵人", isPC: false, dex: 10, hp: 0 });
      const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, dex: 10 });
      const all = [hero, slowFoe, tieFoe, fastFoe, deadFoe, ally];

      eq(T.interceptableAttackers(hero, all).map(function (x) { return x.id; }), ["slow"],
        "只有比自己慢的敵人：同速（嚴格大於）、更快、倒下、隊友、自己 全部排除");

      S.apply(hero, "迅捷", 2, 0);   // 65 × 1.10 = 71.5
      eq(T.interceptableAttackers(hero, all).map(function (x) { return x.id; }), ["slow", "tie"],
        "自己吃 2 層迅捷 → 同速敵也攔得到（讀的是有效 DEX）");

      S.apply(fastFoe, "綁縛", 6, 0); // 90 × 0.70 = 63
      eq(T.interceptableAttackers(hero, all).map(function (x) { return x.id; }), ["slow", "tie", "fast"],
        "快敵被壓 6 層綁縛 → 也攔得到");
    }

    section("interceptableAttackers：非 PC 需要「攔截例外」被動");
    {
      const npc = mkEntity({ id: "npc", name: "小怪", isPC: false, dex: 90 });
      const pc = mkEntity({ id: "pc", name: "玩家", isPC: true, dex: 10 });
      eq(T.interceptableAttackers(npc, [npc, pc]).length, 0,
        "一般 NPC → 空陣列（方向限制，與 buildPairing 一致）");

      const special = mkEntity({ id: "sp", name: "守護者", isPC: false, dex: 90,
        passives: ["demo_ic_override"] });
      global.Passives.register({
        id: "demo_ic_override", name: "測試用攔截例外", kind: "buff",
        allowsInterceptingPlayers: true
      });
      eq(T.interceptableAttackers(special, [special, pc]).map(function (x) { return x.id; }), ["pc"],
        "帶「攔截例外」被動的 NPC → 列得出來");
    }

    section("⚠ 防漂移：選單列得出來的人，buildPairing 一定不會打回票");
    {
      // 這條是這次改動的核心保證 —— UI 與引擎的判斷必須同源，不能各寫一份
      const hero = mkEntity({ id: "hero", name: "攔截者", isPC: true, dex: 70, canAct: true });
      const ally = mkEntity({ id: "ally", name: "隊友", isPC: true, dex: 20, canAct: true });
      const foes = [50, 65, 70, 85].map(function (d, i) {
        return mkEntity({ id: "f" + i, name: "敵" + d, isPC: false, dex: d, canAct: true });
      });
      const sk = mkSkill({ id: "s1", coins: ["normal"] });
      const all = [hero, ally].concat(foes);
      all.forEach(function (e) { e.skillLibrary = [sk]; });

      const listed = T.interceptableAttackers(hero, all);
      eq(listed.map(function (x) { return x.dex; }), [50, 65], "70 只攔得到 50 與 65");

      listed.forEach(function (foe) {
        all.forEach(function (e) { e.declarations = []; });
        foe.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
        hero.declarations = [{ slotIndex: 0, skillId: "s1", action: "intercept",
          targetId: foe.id, protectId: "ally" }];
        const p = T.buildPairing({ entities: all, turnOrder: all });
        eq(p.notes.some(function (n) { return !n.ok; }), false,
          "對「敵" + foe.dex + "」宣告攔截 → 沒有任何被拒的 note");
        eq(p.entries[0].kind, "clash", "對「敵" + foe.dex + "」攔截成立");
      });

      // 反面：沒被列出來的人，宣告了就會被拒
      const tooFast = foes[3];   // 85
      all.forEach(function (e) { e.declarations = []; });
      tooFast.declarations = [{ slotIndex: 0, skillId: "s1", action: "attack", targetId: "ally" }];
      hero.declarations = [{ slotIndex: 0, skillId: "s1", action: "intercept",
        targetId: tooFast.id, protectId: "ally" }];
      const p2 = T.buildPairing({ entities: all, turnOrder: all });
      eq(p2.notes.some(function (n) { return !n.ok; }), true, "沒列出來的（敵85）宣告了就會被拒");
    }

    // ============================================================
    // 本回合變化（_turnLog）
    // ============================================================
    section("本回合變化：記錄層／級的變動");
    {
      const e = mkEntity({ name: "目標" });
      S.resetTurnLog(e);
      S.apply(e, "震顫", 1, 3);
      eq(e._turnLog.length, 2, "一層一級各記一筆");
      eq(e._turnLog[0], { n: "震顫", dl: 1 }, "層數變化");
      eq(e._turnLog[1], { n: "震顫", dv: 3 }, "級數變化");
    }

    section("本回合變化：級數被丟棄也要留紀錄（最容易被誤會的情況）");
    {
      const e = mkEntity({ name: "乾淨目標" });
      S.resetTurnLog(e);
      S.apply(e, "震顫", 0, 3);   // 沒有層數 → 級數被丟棄
      eq(e._turnLog.length, 1, "記了一筆");
      eq(!!e._turnLog[0].note, true, "有說明為什麼被丟棄");
      eq(/層數為 0/.test(e._turnLog[0].note), true, "理由是層數為 0");
    }

    section("本回合變化：階段六褪掉也會被記到，且回合開始才重置");
    {
      const e = mkEntity({ name: "目標" });
      S.resetTurnLog(e);
      S.apply(e, "震顫", 1, 3);
      runGen(T.runTurnEndPhase([e], []));
      eq(S.layerOf(e, "震顫"), 0, "1 層在回合結束當場褪光（規則如此）");
      const net = e._turnLog.reduce(function (a, x) { return a + (x.dl || 0); }, 0);
      eq(net, 0, "流水帳的淨層數變化為 0（貼上 +1、褪掉 −1）");
      eq(e._turnLog.length >= 3, true, "但過程有被記下來，不是一片空白");
    }

    section("本回合變化：不影響 states 本身，且可 JSON 序列化");
    {
      const e = mkEntity({ name: "目標" });
      S.resetTurnLog(e);
      S.apply(e, "易損", 2, 0);
      eq(S.layerOf(e, "易損"), 2, "狀態值不受流水帳影響");
      eq(JSON.parse(JSON.stringify(e._turnLog)), e._turnLog, "純值，可送進 Firebase");
    }

    return { pass: pass, fail: fail, failures: failures, lines: lines };
  };
})(window);

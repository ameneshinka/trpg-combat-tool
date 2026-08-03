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
      S.apply(a, "失血", { layer: 2, level: 1 }, []);
      S.apply(a, "自訂印記", { layer: 1, isMark: true }, []);
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

    return { pass: pass, fail: fail, failures: failures, lines: lines };
  };
})(window);

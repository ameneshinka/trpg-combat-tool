// ============================================================
// 效果鉤子引擎
// ------------------------------------------------------------
// 為什麼需要這一層：四名 PC 的技能幾乎「每一枚硬幣的效果都不同」
// （威爾技能B 三枚給的震顫級數各異、旭技能D 四枚各自引爆），
// 而舊的 skill.onUse / skill.onHit 是「整把技能各呼叫一次」，表達不了。
//
// 鉤子與時機（單枚硬幣的結算順序固定，不可更動）：
//   skill.onUse        技能使用開始、拚點之前（威力修正要吃到拚點）
//   ─ 逐枚 ─
//   coin.onUse         該枚開打前
//   擲幣 → 恍惚 → 累加威力 → 凝神判定（用舊級數）
//   coin.onHead        該枚正面，且在凝神判定之後（所以剛上的凝神這枚吃不到）
//   算傷害 → 扣血
//   coin.onHit         該枚傷害套用後（⚠ 反面照算 —— 反面只是不加威力，仍算命中）
//   coin.afterHit      該枚的 onHit 跑完（震顫爆發、恍惚等後續效果）
//   ─ 逐枚結束 ─
//   skill.afterUse     整把技能結算完（generator，可能再跑一輪 —— 威爾技能C 的遞迴）
//
// 通則：拚輸 → 一枚 onUse 都不跑（裁決 4）→ 資源不會被扣掉。
//
// 鉤子可以是一般函式，也可以是 generator（需要擲骰或 KP 裁定時 yield）。
// ============================================================
(function (global) {
  "use strict";
  const Effects = global.Effects = {};

  function isGeneratorFn(fn) {
    return fn && fn.constructor && fn.constructor.name === "GeneratorFunction";
  }
  Effects.isGeneratorFn = isGeneratorFn;

  /** 呼叫一個效果鉤子。generator 會被 yield* 展開，讓它能中途要求擲骰／裁定。 */
  function* call(fn, ctx) {
    if (typeof fn !== "function") return undefined;
    if (isGeneratorFn(fn)) return yield* fn(ctx);
    return fn(ctx);
  }
  Effects.call = call;

  // ---------------- 共用動作 ----------------

  /**
   * 回復生命值。
   * ⚠ 只補真實血量，不碰臨時生命值（臨時生命值只由【防守】產生、回合結束歸零）。
   * ⚠ 回血不會解除【混亂】—— 混亂是「向下跨過門檻」時進入的，補回去不會倒帶。
   */
  function heal(entity, amount, label, events) {
    amount = Math.max(0, Math.floor(amount || 0));
    if (amount <= 0 || entity.hp <= 0) return 0;
    const before = entity.hp;
    entity.hp = Math.min(entity.maxHp, entity.hp + amount);
    const gained = entity.hp - before;
    if (events && gained > 0) {
      events.push((label || "治療") + "：" + entity.name + " HP " + before + " → " + entity.hp +
        "（+" + gained + "）");
    }
    return gained;
  }
  Effects.heal = heal;

  /** 專注力增減（夾在 −40 ~ +40；跨越到 −40 的恐慌判定在階段六統一處理）。 */
  function addFocus(entity, delta, label, events) {
    const S = global.States;
    const before = entity.focus;
    entity.focus = S.clampFocus(before + delta);
    if (events && entity.focus !== before) {
      events.push((label || "專注力") + "：" + entity.name + " " + before + " → " + entity.focus +
        "（" + (delta >= 0 ? "+" : "") + delta + "）");
    }
    return entity.focus - before;
  }
  Effects.addFocus = addFocus;

  /** 專注力「調整至」指定值（和真的秘方藥解混亂時用，不是加減）。 */
  function setFocus(entity, value, label, events) {
    const S = global.States;
    const before = entity.focus;
    entity.focus = S.clampFocus(value);
    if (events && entity.focus !== before) {
      events.push((label || "專注力") + "：" + entity.name + " " + before + " → " + entity.focus +
        "（調整至 " + value + "）");
    }
    return entity.focus;
  }
  Effects.setFocus = setFocus;

  // ---------------- 自訂資源（子彈等，不走層數管線） ----------------
  function resourceOf(entity, key) { return (entity.resources || {})[key] || 0; }
  Effects.resourceOf = resourceOf;

  /** 消耗資源；不足時回傳 false 且不扣（呼叫端決定要不要中止）。 */
  function spend(entity, key, amount, label, events) {
    const have = resourceOf(entity, key);
    if (have < amount) return false;
    entity.resources[key] = have - amount;
    if (events) {
      events.push((label || "消耗") + "：" + entity.name + " " + key + " −" + amount +
        "（剩 " + entity.resources[key] + "）");
    }
    return true;
  }
  Effects.spend = spend;

  /** 補充資源，吃 resourceMax 上限。 */
  function gain(entity, key, amount, label, events) {
    const max = (entity.resourceMax || {})[key];
    const before = resourceOf(entity, key);
    let after = before + amount;
    if (max !== undefined) after = Math.min(max, after);
    entity.resources[key] = after;
    if (events && after !== before) {
      events.push((label || "補充") + "：" + entity.name + " " + key + " " + before + " → " + after);
    }
    return after - before;
  }
  Effects.gain = gain;

  // ---------------- ctx ----------------
  /**
   * 建立效果鉤子的 ctx。
   *
   * runtime = 「這一次技能使用」的共用暫存區，所有鉤子共享同一份：
   *   basePowerBonus / coinPowerBonus  skill.onUse 寫入，拚點與傷害都會讀
   *   stop                              設為 true → 中止後續硬幣的傷害結算
   *                                     （威爾被動1：子彈不足時停止該技能的傷害結算）
   *   其餘欄位由各角色自由使用（威爾技能C 的加成快取就放這裡）
   */
  function makeRuntime(extra) {
    return Object.assign({ basePowerBonus: 0, coinPowerBonus: 0, stop: false }, extra || {});
  }
  Effects.makeRuntime = makeRuntime;

  function makeCtx(o) {
    const events = o.events || [];
    const self = o.self;
    return {
      // --- 對象 ---
      self: self,
      target: o.target || null,
      skill: o.skill || null,
      battle: o.battle || null,
      events: events,
      tuning: (self && self.tuning) || {},
      runtime: o.runtime || makeRuntime(),

      // --- 逐枚鉤子才有 ---
      coinIndex: o.coinIndex,
      coin: o.coin || null,
      isHead: o.isHead,

      // --- 引擎模組 ---
      S: global.States, C: global.Clash, D: global.Damage,

      // --- 動作 ---
      log: function (msg) { events.push(msg); },
      heal: function (entity, amount, label) { return heal(entity, amount, label, events); },
      addFocus: function (entity, delta, label) { return addFocus(entity, delta, label, events); },
      setFocus: function (entity, value, label) { return setFocus(entity, value, label, events); },
      resource: function (entity, key) { return resourceOf(entity, key); },
      spend: function (entity, key, amount, label) { return spend(entity, key, amount, label, events); },
      gain: function (entity, key, amount, label) { return gain(entity, key, amount, label, events); },
      // States.apply(entity, name, 層數增減, 級數增減, opts) 的包裝：
      // 自動把它回傳的事件推進 log（角色資料裡到處都要用，少寫一行）
      apply: function (entity, name, layer, level, opts) {
        const msgs = global.States.apply(entity, name, layer || 0, level || 0, opts);
        msgs.forEach(function (m) { events.push(m); });
        return msgs;
      },
      /**
       * 施加一次【震顫爆發】，並自動廣播給全場被動。
       * 角色資料一律用這個，不要直接呼叫 States.tremorBurst —— 否則
       * 威爾的槍械破甲與援護射擊不會被觸發。
       * opts.keepLevel：此次爆發不歸零震顫級數（旭技能D 前三枚）
       */
      tremorBurst: function (target, opts) {
        const lv = global.States.tremorBurst(target, events, opts);
        const P = global.Passives;
        if (P && P.broadcastTremorBurst) {
          // ⚠ 就算 lv === 0（爆發落空）也要廣播 —— 裁決 7／16
          P.broadcastTremorBurst(o.battle, self, target, lv, o.skill, events);
        }
        return lv;
      },
      /** 記帳式臨時增益（結月的爆裂綻放、旭給敵人的傷害弱化）。 */
      grant: function (target, key, name, layer, level) {
        return global.States.grant(self, target, key, name, layer, level, events);
      },
      revoke: function (key) {
        return global.States.revoke(self, o.battle, key, events);
      },
      /** 把效果記在別人身上、之後才結算（和真被動4 的守護債務）。 */
      debt: function (target, debt) {
        return global.States.addPendingDebt(target, debt);
      },
      // 中止這把技能剩餘硬幣的傷害結算
      stop: function (reason) {
        (o.runtime || {}).stop = true;
        if (reason) events.push("⚠ " + reason);
      },
      // 存活的 PC（結月被動1／和真技能A 的「友方單位」定義，裁決 20）
      allies: function (includeSelf) {
        const b = o.battle;
        if (!b) return [];
        return b.entities.filter(function (e) {
          if (!e.isPC || e.hp <= 0) return false;
          return includeSelf ? true : e !== self;
        });
      },
      enemies: function () {
        const b = o.battle;
        if (!b) return [];
        return b.entities.filter(function (e) { return !e.isPC && e.hp > 0; });
      }
    };
  }
  Effects.makeCtx = makeCtx;

  /** 取某枚硬幣的效果定義（coinEffects 依「原始硬幣位置」索引，不是可擲序）。 */
  function coinEffect(skill, index) {
    const arr = skill && skill.coinEffects;
    return (arr && arr[index]) || null;
  }
  Effects.coinEffect = coinEffect;

})(window);

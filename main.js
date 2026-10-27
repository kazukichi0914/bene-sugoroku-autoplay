// MAIN world: ゲーム内オブジェクト($.game / createjs)を直接操作する
(() => {
  'use strict';
  const TAG = '[BeneAuto]';

  // ===== 調整パラメータ =====
  const CFG = {
    turnsPerDay: 2,        // 12時間ごと = 1日2ターン想定（週効果アイテムの価値計算に使用）
    minGain: 0.5,          // 素振りより期待値がこれ以上高い時だけアイテム使用
    expireSoonHours: 24,   // 期限が近いアイテムを優先する閾値
    expireSoonBonus: 1.0,
    // マス種別ごとの着地ボーナス（マス数換算）
    massBonus: { 1: 0, 2: 10, 3: 3, 4: -5, 5: 0, 6: 2, 7: 2, 8: 2, 9: 2.5, 10: 1 },
    waitAfterActionMs: 4 * 60 * 1000
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 60000, interval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      await sleep(interval);
    }
    throw new Error('waitFor timeout: ' + fn.toString().slice(0, 100));
  }
  function report(type, data = {}) {
    console.log(TAG, type, data);
    window.postMessage({ __beneAuto: true, type, data }, location.origin);
  }

  // ===== 起動判定（拡張が開いたウィンドウのみ実行） =====
  function getCfg() {
    return new Promise((resolve) => {
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__beneAutoCfg !== true) return;
        done = true; window.removeEventListener('message', onMsg); resolve(ev.data);
      };
      window.addEventListener('message', onMsg);
      (async () => {
        for (let i = 0; i < 15 && !done; i++) {
          window.postMessage({ __beneAuto: true, type: 'ready' }, location.origin);
          await sleep(1000);
        }
        if (!done) { window.removeEventListener('message', onMsg); resolve({ auto: false }); }
      })();
    });
  }

  // ===== フック: alert自動クローズ / API監視 =====
  const state = { endSeen: false, eventResult: null, lastAlert: null, fatal: null };
  function installHooks() {
    const cj = window.createjs;
    cj.alert = function (content, title, cb) {
      if (typeof title === 'function') { cb = title; title = ''; }
      state.lastAlert = String(content);
      report('alert', { content: String(content), title: String(title || '') });
      setTimeout(() => { try { cb && cb(); } catch (_) {} }, 300);
    };
    const origShowError = cj.showError;
    cj.showError = function (msg) {
      state.fatal = String(msg);
      try { return origShowError && origShowError.apply(this, arguments); } catch (_) {}
    };
    const g = window.$.game;
    if (typeof g.callApi === 'function') {
      const orig = g.callApi;
      g.callApi = function (name, params, handlers) {
        const h = Object.assign({}, handlers || {});
        const okOrig = h.success;
        h.success = function (xml) {
          try {
            if (name === 'event') {
              state.eventResult = {
                dice: xml.dice_num && xml.dice_num.text,
                location: xml.current_location && xml.current_location.text,
                points: xml.current_point && xml.current_point.text
              };
            }
            if (name === 'end') state.endSeen = true;
          } catch (_) {}
          return okOrig && okOrig.apply(this, arguments);
        };
        return orig.call(this, name, params, h);
      };
    }
  }

  // ===== 画面上の状態表示（ドライラン用） =====
  function showBanner(text, canPlay) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
      padding: '10px 18px', borderRadius: '8px', font: 'bold 16px system-ui, sans-serif', whiteSpace: 'pre-line',
      textAlign: 'center', boxShadow: '0 2px 8px rgba(0,0,0,.3)', cursor: 'pointer',
      background: canPlay ? '#fff3cd' : '#e3f2e5', color: canPlay ? '#7a5b00' : '#2e7d32'
    });
    el.title = 'クリックで閉じる';
    el.onclick = () => el.remove();
    document.body.appendChild(el);
  }

  // ===== 移動分布 =====
  const D6 = [1, 2, 3, 4, 5, 6];
  const uni = (a) => a.map((v) => [v, 1 / a.length]);
  function sumDice(n) {
    let d = new Map([[0, 1]]);
    for (let k = 0; k < n; k++) {
      const nd = new Map();
      for (const [s, p] of d) for (const f of D6) nd.set(s + f, (nd.get(s + f) || 0) + p / 6);
      d = nd;
    }
    return [...d];
  }
  const ROLL = uni(D6);
  const MOVE = {
    1: uni(D6.map((v) => v + 1)), 2: uni(D6.map((v) => v + 2)), 3: uni(D6.map((v) => v + 3)),
    4: sumDice(2), 5: sumDice(3), 6: sumDice(4), 7: sumDice(5),
    8: uni(D6.map((v) => v * 2)),
    9: [[1, 1]], 10: [[2, 1]], 11: [[3, 1]], 12: [[4, 1]], 13: [[5, 1]], 14: [[6, 1]],
    15: [[10, 1]], 16: [[15, 1]],
    17: uni([4, 5, 6]),
    18: uni(D6.map((v) => (v % 2 ? 1 : 8)))
  };
  const expMove = (dist) => dist.reduce((a, [v, p]) => a + v * p, 0);

  function turnsLeftThisWeek() {
    // JSTの月曜始まりで今週残り日数×1日のターン数（今回含む）
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const dowMon0 = (jst.getUTCDay() + 6) % 7;
    return (7 - dowMon0) * CFG.turnsPerDay;
  }

  // ===== 判定ロジック =====
  function decide() {
    const s = $.game.settings;
    const u = $.game.user;
    const GOAL = s.map.length - 1;
    const pos = u.location | 0;
    const massAt = (i) => { const m = s.map[i]; return m && m.mass ? (m.mass.id | 0) : 0; };
    const durIds = new Set((u.durationItems || []).filter(Boolean).map((x) => x.id));
    const buffs = {
      extra: (durIds.has(23) ? 1 : 0) + (durIds.has(24) ? 2 : 0),
      omamori: durIds.has(25), tonkatsu: durIds.has(26), steak: durIds.has(27)
    };
    const turns = turnsLeftThisWeek();

    const landScore = (move) => {
      const to = Math.min(pos + move + buffs.extra, GOAL);
      const id = massAt(to);
      let b = CFG.massBonus[id] || 0;
      if (id === 4 && buffs.omamori) b = 0;
      if (id === 10 && (buffs.tonkatsu || buffs.steak)) b = 3;
      return (to - pos) + b;
    };
    const evDist = (dist) => dist.reduce((a, [v, p]) => a + landScore(v) * p, 0);

    // 将来価値（ステッキ/鏡の取得対象選定用）
    const futureValue = (id) => {
      if (MOVE[id]) return expMove(MOVE[id]) - 3.5;
      switch (id) {
        case 19: return 2;
        case 20: return 3;
        case 23: return durIds.has(23) ? 0 : 1 * turns;
        case 24: return durIds.has(24) ? 0 : 2 * turns;
        case 25: return durIds.has(25) ? 0 : 0.4 * turns;
        case 26: return durIds.has(26) ? 0 : 1.5;
        case 27: return durIds.has(27) ? 0 : 0.3 * turns;
        default: return 0;
      }
    };

    const now = Date.now();
    const held = new Map(); // id -> earliest period
    for (const it of u.items || []) {
      if (!it.item || !it.item.isUsable) continue;
      const t = +it.period;
      if (t && t < now) continue;
      const prev = held.get(it.item.id);
      if (!prev || t < prev) held.set(it.item.id, t);
    }

    const base = evDist(ROLL);
    const options = [{ type: 'roll', value: base, label: 'サイコロ' }];

    for (const [id, period] of held) {
      const item = s.item[id];
      let value, extra = {};
      if (MOVE[id]) value = evDist(MOVE[id]);
      else if (id === 19) {
        let best = -Infinity, bestD = 6;
        for (const d of D6) { const v = landScore(d); if (v > best) { best = v; bestD = d; } }
        value = best; extra.dice = bestD;
      } else if (id === 21 || id === 22) {
        const pool = [];
        if (id === 21) for (const x of held.keys()) { if (x !== 21) pool.push(x); }
        else s.item.each((i) => { if (i.id !== 22 && i.isUsable) pool.push(i.id); });
        if (!pool.length) continue;
        // 既に所持しているアイテムは週効果が重複するため価値を半減して選定
        const tv = (x) => futureValue(x) * (held.has(x) ? 0.5 : 1);
        const target = pool.reduce((a, b) => (tv(b) > tv(a) ? b : a));
        value = base + tv(target) * 0.9; extra.target = target; // 直接効果アイテムを優先するため0.9掛け
      } else if (id >= 20 && id <= 27) {
        if (id !== 20 && durIds.has(id)) continue; // 効果中の週アイテムは重複使用しない
        value = base + futureValue(id);
      } else continue;
      if (period && period - now < CFG.expireSoonHours * 3600 * 1000) value += CFG.expireSoonBonus;
      options.push({ type: 'item', id, value, label: item ? item.name : String(id), actionType: item && item.actionType, ...extra });
    }

    options.sort((a, b) => b.value - a.value);
    let pick = options[0];
    if (pick.type === 'item' && pick.value - base < CFG.minGain) pick = options.find((o) => o.type === 'roll');
    return { pick, pos, goal: GOAL, buffs, options: options.map((o) => ({ ...o, value: +o.value.toFixed(2) })) };
  }

  // ===== 実行 =====
  async function doItem(pick) {
    const menu = $.game.menu;
    $.game.controller.useItem();
    await waitFor(() => menu.current && !menu.showUseItem.animating, 20000);
    await sleep(800);
    menu.showUseItem(pick.id);
    await waitFor(() => menu.showUseItem.current && !menu.showUseItem.animating, 10000);
    await sleep(400);
    menu.useItem();
    const A = $.game.settings.item;
    if (pick.actionType === A.ACTION_TYPE_SELECT_DICE) {
      await waitFor(() => !menu.showUseItem.animating && $('div.select_dice:visible').length, 10000);
      await sleep(300);
      menu.selectDice($(`div.select_dice li[data-value="${pick.dice}"]`)[0]);
      await sleep(300);
      menu.onDiceSelected();
    } else if (pick.actionType === A.ACTION_TYPE_SELECT_MY_ITEM || pick.actionType === A.ACTION_TYPE_SELECT_ANY_ITEM) {
      await waitFor(() => !menu.showUseItem.animating && $(`div.select_item a[data-value="${pick.target}"]`).length, 10000);
      await sleep(300);
      menu.selectItem($(`div.select_item a[data-value="${pick.target}"]`)[0]);
      await waitFor(() => !menu.selectItem.animating && menu.selectItem.current, 10000);
      await sleep(300);
      menu.onItemSelected();
    }
  }

  async function run(opt) {
    await waitFor(() => window.$ && $.game && $.game.isReady && $.game.isReady() && window.createjs && $.game.controller && $.game.controller.login, 60000);
    installHooks();

    // 赤いスタートボタン（splashのonClickと同じ処理）
    if (!($.game.user && $.game.user.gameUserToken)) {
      await sleep(1500);
      $.game.stopTimer();
      $.game.controller.login();
    }
    await waitFor(() => $.game.user && $.game.user.gameUserToken, 30000);
    if ($.game.user.registrationStatus === 0) return report('error', { message: 'ニックネーム未登録。手動で初回登録してください' });

    // 前回の未完了イベント再生(response_type=4)などでメニューが無効な間は待つ
    await waitFor(() => state.endSeen || (createjs.findObject('map') && $.game.menuEnabled() && !$.game.menu.active), 180000);
    if (state.endSeen) return report('done', { message: '保留中イベントを消化', result: state.eventResult });

    const canPlay = !!$.game.playEnabled();
    // ドライランはサイコロ済みでも判定結果を返し、振れるかどうかを伝える
    if (opt.dry) {
      let d = null; try { d = decide(); } catch (_) {}
      showBanner(canPlay ? `🎲 まだ振っていません（振れます）\n判定: ${d ? d.pick.label : '-'}` : '✅ サイコロ実行済み（今は振れません）', canPlay);
      return report('dry', { canPlay, ...d });
    }
    if (!canPlay) return report('no-play', { message: 'サイコロ済み（今はプレイ不可）' });

    const d = decide();
    report('decision', d);

    // ループ防止: 5分以内の多重実行をブロック（強制実行時は除く）
    // 午前枠の終わり際と昼枠の始まりが近接しうるため短めにしている
    const KEY = 'beneAuto.lastActionAt';
    let last = 0; try { last = +localStorage.getItem(KEY) || 0; } catch (_) {}
    if (!opt.force && Date.now() - last < 5 * 60 * 1000) return report('no-play', { message: '5分以内に実行済み' });
    try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {}

    if (d.pick.type === 'item') await doItem(d.pick);
    else $.game.controller.rollDice();

    await waitFor(() => state.endSeen || state.lastAlert || state.fatal, CFG.waitAfterActionMs, 500).catch(() => {});
    if (state.fatal) return report('error', { message: state.fatal, decision: d.pick });
    if (state.endSeen) return report('done', { decision: d.pick, result: state.eventResult });
    if (state.lastAlert) return report('error', { message: state.lastAlert, decision: d.pick });
    report('error', { message: '完了を確認できず', decision: d.pick });
  }

  (async () => {
    const res = await getCfg();
    if (!res.auto) return;
    try { await run(res.cfg || {}); }
    catch (e) { report('error', { message: String(e && e.message || e) }); }
  })();

  // 手動デバッグ用: コンソールで window.__beneAutoDecide() を実行すると判定結果を表示
  window.__beneAutoDecide = () => decide();
})();

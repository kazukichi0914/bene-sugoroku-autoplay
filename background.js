// ベネワンすごろく オートプレイ - Service Worker
const GAME_URL = 'https://bene-one.gamefactory.jp/game';
const RUN_TIMEOUT_MIN = 6;     // 1回の実行の最大時間
const LOG_MAX = 50;
const WIN_W = 400, WIN_H = 300; // 自動実行ウィンドウのサイズ
// 1日の実行枠（JST, 0時からの分）。各枠で1回ずつ実行する
const SLOTS = [
  { id: 'am', from: 9 * 60, to: 12 * 60 },    // 9:00〜12:00
  { id: 'noon', from: 12 * 60, to: 13 * 60 }  // 12:00〜13:00
];
const CHECK_MIN = 5;           // 枠に入ったかの確認間隔
const MAX_TRIES = 3;           // 1枠あたりの最大試行回数（エラー時の再試行込み）

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

async function getSlotState() {
  const { date } = jstNow();
  const { slotState } = await chrome.storage.local.get('slotState');
  return slotState?.date === date ? slotState : { date };
}

async function checkSchedule() {
  const { min } = jstNow();
  const slot = SLOTS.find((s) => s.from <= min && min < s.to);
  if (!slot) return;
  const st = await getSlotState();
  const cur = st[slot.id] || { tries: 0, done: false };
  if (cur.done || cur.tries >= MAX_TRIES) return;
  const { running } = await chrome.storage.local.get('running');
  if (running && Date.now() - running.startedAt < RUN_TIMEOUT_MIN * 60 * 1000) return;
  st[slot.id] = { ...cur, tries: cur.tries + 1 };
  await chrome.storage.local.set({ slotState: st });
  startRun({ slot: slot.id });
}

async function ensureAlarm() {
  chrome.alarms.clear('bene-run'); // 旧12時間ごとのアラーム
  const a = await chrome.alarms.get('bene-check');
  if (!a) chrome.alarms.create('bene-check', { delayInMinutes: 1, periodInMinutes: CHECK_MIN });
}

// 起動・再読み込み時も、枠内で未実行ならすぐ実行（PCスリープ等の取りこぼし対策）
chrome.runtime.onInstalled.addListener(async () => { await ensureAlarm(); checkSchedule(); });
chrome.runtime.onStartup.addListener(async () => { await ensureAlarm(); checkSchedule(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bene-check') checkSchedule();
  if (alarm.name === 'bene-timeout') finish({ type: 'timeout', data: { message: 'タイムアウト（未ログイン or 画面遷移失敗の可能性）' } });
});

async function cornerBounds() {
  const width = WIN_W, height = WIN_H;
  try {
    const displays = await chrome.system.display.getInfo();
    const { workArea: a } = displays.find((d) => d.isPrimary) || displays[0];
    return { width, height, left: a.left + a.width - width, top: a.top + a.height - height };
  } catch (_) {
    return { width, height, left: 0, top: 0 };
  }
}

async function startRun({ dry = false, force = false, slot = null }) {
  const { running } = await chrome.storage.local.get('running');
  if (running && Date.now() - running.startedAt < RUN_TIMEOUT_MIN * 60 * 1000) return;
  // 背景タブはタイマーが1Hzに間引かれアニメが進まないため、非フォーカスのポップアップウィンドウで開く
  // 最小化も同様に止まるので、見える状態のまま小さく画面右下に置く
  // ドライランは画面を見るためのものなので、通常サイズで前面に開く
  const bounds = dry ? { width: 900, height: 760, left: 0, top: 0 } : await cornerBounds();
  let win;
  try {
    win = await chrome.windows.create({ url: GAME_URL, type: 'popup', focused: dry, ...bounds });
  } catch (e) {
    return finish({ type: 'error', data: { message: `ウィンドウを開けません: ${e.message}`, bounds } });
  }
  await addLog({ type: 'start', data: { message: 'ウィンドウを開きました', bounds } });
  const tabId = win.tabs[0].id;
  await chrome.storage.local.set({
    running: { tabId, windowId: win.id, startedAt: Date.now(), cfg: { dry, force }, handedOut: false, slot },
    lastRunAt: Date.now(),
    runningLastUrl: null
  });
  chrome.alarms.create('bene-timeout', { delayInMinutes: RUN_TIMEOUT_MIN });
  chrome.action.setBadgeText({ text: '…' });
}

async function addLog(entry) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift({ at: Date.now(), ...entry });
  await chrome.storage.local.set({ logs: logs.slice(0, LOG_MAX) });
}

// 実行中ウィンドウの最終URLを記録（途中で閉じた時の原因調査用）
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const { running } = await chrome.storage.local.get('running');
  if (running?.tabId !== tabId) return;
  await chrome.storage.local.set({ runningLastUrl: info.url }); // runningを書き戻すとhandedOutと競合するため別キー
});

// 結果が出る前にウィンドウが閉じた場合はエラーとして記録
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { running, runningLastUrl } = await chrome.storage.local.get(['running', 'runningLastUrl']);
  if (running?.windowId !== windowId) return;
  finish({ type: 'error', data: { message: `結果が出る前にウィンドウが閉じました（最終URL: ${runningLastUrl || '不明'}）` } });
});

async function finish(msg) {
  const { running, logs = [] } = await chrome.storage.local.get(['running', 'logs']);
  logs.unshift({ at: Date.now(), ...msg });
  await chrome.storage.local.set({ logs: logs.slice(0, LOG_MAX), lastResult: msg, running: null });
  chrome.alarms.clear('bene-timeout');
  // プレイ済み or プレイ不可ならその枠は完了。エラー/タイムアウトは次の確認で再試行
  if (running?.slot && ['done', 'no-play'].includes(msg.type)) {
    const st = await getSlotState();
    st[running.slot] = { ...(st[running.slot] || { tries: 1 }), done: true };
    await chrome.storage.local.set({ slotState: st });
  }
  const badge = { done: 'OK', dry: 'DRY', 'no-play': '-', error: 'ERR', timeout: 'TO' }[msg.type] || '?';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: msg.type === 'done' ? '#2e7d32' : '#c62828' });
  // サイコロを振れるかの最新状態（ポップアップ表示用）
  const canPlay = { done: false, 'no-play': false, dry: msg.data?.canPlay }[msg.type];
  if (canPlay !== undefined) await chrome.storage.local.set({ playStatus: { at: Date.now(), canPlay } });
  // ドライランは画面を確認できるよう閉じずに残す
  if (running?.windowId && msg.type !== 'dry') setTimeout(() => chrome.windows.remove(running.windowId).catch(() => {}), 3000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.kind === 'getCfg') {
      // 自動実行で開いたタブにだけ、1回だけ設定を渡す（リダイレクト後の再実行ループ防止）
      const { running } = await chrome.storage.local.get('running');
      if (running && sender.tab?.id === running.tabId && !running.handedOut) {
        running.handedOut = true;
        await chrome.storage.local.set({ running });
        sendResponse({ auto: true, cfg: running.cfg });
      } else {
        sendResponse({ auto: false });
      }
    } else if (msg?.kind === 'report') {
      const { running } = await chrome.storage.local.get('running');
      if (!running || sender.tab?.id !== running.tabId) return sendResponse({});
      if (['done', 'dry', 'no-play', 'error'].includes(msg.type)) await finish({ type: msg.type, data: msg.data });
      else {
        const { logs = [] } = await chrome.storage.local.get('logs');
        logs.unshift({ at: Date.now(), type: msg.type, data: msg.data });
        await chrome.storage.local.set({ logs: logs.slice(0, LOG_MAX) });
      }
      sendResponse({});
    } else if (msg?.kind === 'runNow') {
      await chrome.storage.local.set({ running: null });
      await startRun({ dry: !!msg.dry, force: true });
      sendResponse({ ok: true });
    }
  })();
  return true;
});

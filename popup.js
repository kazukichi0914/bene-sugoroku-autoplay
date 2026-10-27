const fmt = (t) => new Date(t).toLocaleString('ja-JP');

// background.js の SLOTS と対応
const SLOTS = [{ id: 'am', label: '9:00〜12:00' }, { id: 'noon', label: '12:00〜13:00' }];

function slotText(st) {
  if (!st) return '未実行';
  if (st.done) return '済';
  return st.tries >= 3 ? `失敗(${st.tries}回)` : `再試行待ち(${st.tries}回)`;
}

async function render() {
  const { lastRunAt, logs = [], slotState, playStatus } = await chrome.storage.local.get(['lastRunAt', 'logs', 'slotState', 'playStatus']);
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const st = slotState?.date === today ? slotState : {};
  const play = document.getElementById('play');
  if (playStatus) {
    play.textContent = `${playStatus.canPlay ? '🎲 まだ振っていません（振れます）' : '✅ サイコロ済み（今は振れません）'}  ${fmt(playStatus.at)} 時点`;
    play.className = playStatus.canPlay ? 'can' : 'used';
  } else {
    play.textContent = 'サイコロの状態: 未確認（「判定のみ」で確認できます）';
    play.className = '';
  }
  document.getElementById('info').textContent =
    `前回: ${lastRunAt ? fmt(lastRunAt) : '-'}\n本日: ` + SLOTS.map((s) => `${s.label} ${slotText(st[s.id])}`).join(' / ');
  document.getElementById('logs').textContent = logs.slice(0, 15)
    .map((l) => {
      const head = l.type === 'dry' ? (l.data?.canPlay ? '振れる ' : 'サイコロ済み ') : '';
      return `${fmt(l.at)} [${l.type}] ${head}${JSON.stringify(l.data?.pick || l.data?.decision || l.data?.message || l.data?.result || l.data)}`;
    })
    .join('\n');
}

document.getElementById('run').onclick = () => chrome.runtime.sendMessage({ kind: 'runNow', dry: false }).then(render);
document.getElementById('dry').onclick = () => chrome.runtime.sendMessage({ kind: 'runNow', dry: true }).then(render);
chrome.storage.onChanged.addListener(render);
render();

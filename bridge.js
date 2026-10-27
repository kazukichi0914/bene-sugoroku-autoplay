// ISOLATED world: MAIN world <-> service worker の中継
(() => {
  const cfgPromise = chrome.runtime.sendMessage({ kind: 'getCfg' }).catch(() => ({ auto: false }));

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const m = ev.data;
    if (!m || m.__beneAuto !== true) return;
    if (m.type === 'ready') {
      const res = await cfgPromise;
      window.postMessage({ __beneAutoCfg: true, auto: !!res?.auto, cfg: res?.cfg || {} }, location.origin);
      return;
    }
    chrome.runtime.sendMessage({ kind: 'report', type: m.type, data: m.data }).catch(() => {});
  });
})();

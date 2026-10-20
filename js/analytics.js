/* ══════════════════════════════════════════════════════════
   流量統計 —— Firebase Analytics（骨子裡就是 Google Analytics 4）

   設定在 index.html 的 ARENA_CONFIG.firebase；沒填就整段跳過，
   網站的每個功能照常跑，只是不會有數據。

   為什麼要排隊（q）：SDK 是從 CDN 動態載入的，載好之前使用者
   可能已經切過分頁了，先收進陣列，載好再一次補送。
   ══════════════════════════════════════════════════════════ */
(function () {
  const q = [];
  const off = () => {};

  // 還沒載好之前先排隊；呼叫端永遠不用判斷「統計有沒有開」
  window.Track = (name, params) => q.push([name, params || {}]);

  const cfg = (window.ARENA_CONFIG || {}).firebase;
  const usable = cfg && cfg.apiKey && cfg.measurementId;

  // file:// 直接開檔時 SDK 連不上（沒有網域），本機預覽請用 http
  if (!usable || location.protocol === 'file:') { window.Track = off; return; }

  const CDN = 'https://www.gstatic.com/firebasejs/12.18.0/';

  Promise.all([
    import(CDN + 'firebase-app.js'),
    import(CDN + 'firebase-analytics.js')
  ]).then(async ([{ initializeApp }, { initializeAnalytics, logEvent, isSupported }]) => {
    if (!await isSupported()) { window.Track = off; return; }

    // send_page_view: false —— 開頁那筆自動的關掉，改由分頁切換自己送，
    // 統計報表上才會是「個人榜／公會戰／刷題…」而不是全部擠成同一頁
    const an = initializeAnalytics(initializeApp(cfg), { config: { send_page_view: false } });

    window.Track = (name, params) => logEvent(an, name, params || {});
    q.splice(0).forEach(([n, p]) => window.Track(n, p));
  }).catch(() => { window.Track = off; });   // 擋追蹤的瀏覽器會載入失敗，靜靜略過
})();

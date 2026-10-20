/* ============================================================
   quiz.js — 刷題練習：選名字 → 抽 10 題 → 交卷計分
   ------------------------------------------------------------
   分數不進學習成績；「練習次數」由後端寫進「表現紀錄」，
   自動變成互動成績。

   為什麼讀和寫走兩條不同的路：
     讀（題庫、今日次數）→ gviz CSV，跟同步學員名單同一條路，實測穩定。
     寫（交卷）→ Apps Script，每回合只呼叫這一次。
   Apps Script 的網頁應用程式約每四次會有一次回 404（後端跑太久、
   Google 的一次性回傳網址過期），所以能不用它的地方就不用它。

   正確答案不會送到瀏覽器：gviz 只讀題目與選項那幾欄，
   對答案在 Apps Script 後端做。
   ============================================================ */

const Quiz = (() => {

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const USER_KEY = 'LT153P034.quizUser';
  const LAST_KEY = 'LT153P034.quizLast';   // 最後一次成績，重整也還在
  const cfg = () => window.ARENA_CONFIG || {};
  const api = () => (cfg().quizApi || '').trim();

  const PER_ROUND   = 10;   // 每回合幾題
  const DAILY_LIMIT = 3;    // 一天幾次（後端才是真正的閘門，這裡只是畫面用）

  /**
   * 老師的測試帳號。不在學員名單裡，所以不佔排名、不影響任何人的成績；
   * 後端認得這個名字，交卷時對答案照做，但兩張紀錄表都不寫 ——
   * 因此也沒有「今天用了幾次」，可以一直測。
   * 名字要跟後端 CONFIG.TEST_USER 完全一致。
   */
  const TEST_USER = { name: 'LOLO老師', seat: '', avatar: '🧑‍🏫' };
  const isTest = n => String(n || '').trim() === TEST_USER.name;

  /**
   * 測試帳號的密碼閘門。
   * 存的是雜湊不是明碼 —— 學員按 F12 翻原始碼不會直接看到密碼。
   * 但要講清楚：這擋的是「順手點點看」的學員，擋不住真的想破解的人
   * （前端的密碼一定破得了）。真正的保險是測試帳號不寫任何紀錄、不佔排名，
   * 就算被闖進去也偷不到分數。
   */
  const TEST_PASS = 'zvr4k0';
  const PASS_KEY  = 'LT153P034.quizTeacher';
  const hash = s => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  /** 解鎖過就記住，同一台電腦不用每次重打 */
  const unlocked = () => localStorage.getItem(PASS_KEY) === TEST_PASS;

  /* ── 讀：走 gviz，跟同步學員名單同一條路 ───────────── */

  /**
   * 題庫。刻意只取 A~H 欄（科目/題號/主題/題目/四個選項），
   * 不取第 I 欄「正確答案」與第 J 欄「講義出處」——
   * 前端拿不到答案，也就沒得從原始碼偷看。
   */
  /**
   * 「期末保留」欄（題庫的第 K 欄）有填任何字的題目，刷題練習抽不到 —— 留給期末考。
   *
   * 過濾刻意在 Google 那端做，不是抓回來再篩：保留題連下載都不會下載，
   * 學員按 F12 看網路封包也翻不到期末考題。
   * 題庫還沒加這一欄時，gviz 會回一段 JSON 錯誤而不是 CSV，這時退回原本的不過濾行為，
   * 讓刷題照常運作（而不是整個掛掉）。
   */
  const RESERVE_COL = 'K';

  async function fetchBankRows(id) {
    const tab = cfg().quizBankSheet || '題庫';
    const rows = await Sheet
      .fetchRows(id, tab, `select A,B,C,D,E,F,G,H where ${RESERVE_COL} is null`)
      .catch(() => null);

    const failed = !rows || !rows.length || String(rows[0][0] ?? '').trim().startsWith('{');
    return failed ? Sheet.fetchRows(id, tab, 'select A,B,C,D,E,F,G,H') : rows;
  }

  async function fetchBank() {
    const id = Sheet.parseId(cfg().sheetId);
    if (!id) throw new Error('還沒設定班級試算表');
    const rows = await fetchBankRows(id);
    if (rows.length < 2) throw new Error('「題庫」分頁還沒有題目');

    const out = [];
    rows.slice(1).forEach((r, i) => {
      const [subject, num, topic, stem, ...opts] = r.map(v => String(v ?? '').trim());
      const options = opts.slice(0, 4);
      if (!stem || options.length < 4 || options.some(o => !o)) return;   // 空列或沒填滿的略過
      // key 要跟後端算出來的一模一樣，否則交卷時對不到題目。
      // 題號留白時兩邊都退回用列號（i 從 0 起算，對應後端的第 1 筆資料）。
      out.push({ key: `${subject}#${num || (i + 1)}`, subject, topic, stem, options });
    });
    if (out.length < PER_ROUND)
      throw new Error(`題庫可抽的題目只有 ${out.length} 題（已扣掉期末保留），不足 ${PER_ROUND} 題`);
    return out;
  }

  /**
   * 今天已經交了幾次卷。只讀「日期」與「姓名」兩欄。
   * 這裡刻意不吞錯誤 —— 讀不到就要讓人看見，
   * 不然網路一斷就每個人都顯示「還剩 3 次」，看起來像可以無限練。
   * （真正的閘門在後端交卷時，所以最壞情況也只是畫面不準。）
   */
  async function fetchUsedToday(name) {
    if (isTest(name)) return 0;      // 測試帳號不寫紀錄，也就沒有次數上限
    const id = Sheet.parseId(cfg().sheetId);
    if (!id) throw new Error('還沒設定班級試算表');

    // 分頁還沒建立時 gviz 會退回第一個分頁，下面的日期比對自然對不上，結果就是 0 次
    const rows = await Sheet.fetchRows(id, cfg().quizLogSheet || '刷題紀錄', 'select B,D');
    if (rows.length < 2) return 0;

    const today = new Date().toLocaleDateString('sv-SE');   // 產生 YYYY-MM-DD
    const target = name.trim();
    return rows.slice(1).filter(r => {
      const d = String(r[0] ?? '').trim().slice(0, 10);
      return d === today && String(r[1] ?? '').trim() === target;
    }).length;
  }

  /**
   * 交卷失敗後的救援：直接去「刷題紀錄」把這一回合的成績撈回來。
   *
   * 交卷走 Apps Script，實測會忽快忽慢（2～27 秒）還會隨機回 404；
   * 送不出去時後端其實常常已經寫進去了，學員卻只看到紅字錯誤，
   * 第三次遇到就被每日上限鎖住，成績永遠看不到 —— 這個函式就是補這個洞。
   *
   * 走 gviz（抓名單、抓題庫的同一條路，實測沒失敗過），不碰 Apps Script。
   * 撈得到分數，但撈不到逐題檢討 —— 正解不在前端讀得到的欄位裡，
   * 所以 detail 是空的，畫面會註明這次沒有檢討可看。
   */
  async function recoverRound(name, roundId) {
    const id = Sheet.parseId(cfg().sheetId);
    if (!id || !roundId) return null;

    // 日期,姓名,得分,答對,題數,回合編號
    const rows = (await Sheet.fetchRows(id, cfg().quizLogSheet || '刷題紀錄', 'select B,D,F,G,H,K')).slice(1);
    const hit = rows.find(r => String(r[5] ?? '').trim() === roundId);
    if (!hit) return null;                       // 真的沒寫進去，那就讓原本的錯誤浮上來

    // 順便把今天用掉幾次一起算出來，省一趟查詢
    const today = new Date().toLocaleDateString('sv-SE');
    const used = rows.filter(r => String(r[0] ?? '').trim().slice(0, 10) === today
                               && String(r[1] ?? '').trim() === name.trim()).length;

    return {
      ok: true, name,
      score: Number(hit[2]) || 0, correct: Number(hit[3]) || 0, total: Number(hit[4]) || 0,
      used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used),
      pointsEarned: cfg().quizPoints ?? 0.5,
      detail: [], recovered: true,
    };
  }

  const S = {
    stage: 'pick',      // pick | ready | playing | result
    user: null,         // { name, seat, avatar }
    status: null,       // 後端回的剩餘次數
    questions: [],
    picks: [],          // 每題選了哪個「原始選項索引」，-1 = 還沒選
    order: [],          // 每題的顯示順序（打散後的原始索引）
    at: 0,              // 目前第幾題
    startedAt: 0,
    result: null,
    bank: null,         // 題庫讀一次就留著，同一次上課不用重讀
    roundId: '',
    busy: false,
    error: '',
  };

  let students = [];

  /* ── 後端呼叫 ─────────────────────────────────────── */

  /* ── 寫：交卷，每回合只呼叫這一次 ─────────────────── */

  /**
   * 呼叫 Apps Script 交卷。
   * 它偶爾會回 404（後端跑太久、Google 的一次性回傳網址過期），所以會重試；
   * 能安全重試是因為後端認 roundId —— 同一回合寫過就不會再寫第二次。
   */
  async function call(action, params, body) {
    const url = api();
    if (!url) throw new Error('尚未設定刷題後端網址，請老師到「設定」頁填入 quizApi');

    const once = async () => {
      const bust = `_=${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const opts = body
        // 用 text/plain 送 JSON：避開瀏覽器的 preflight，Apps Script 不處理 OPTIONS
        ? { method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, ...body }) }
        : { method: 'GET', cache: 'no-store' };

      const qs = new URLSearchParams({ action, ...(params || {}) }).toString();
      const res = await fetch(body ? `${url}?${bust}` : `${url}?${qs}&${bust}`, opts);
      if (!res.ok) throw new Error(`連線失敗（HTTP ${res.status}）`);

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // 沒部署好時 Apps Script 會回一頁 HTML 登入畫面，直接說清楚怎麼修
        throw new Error('後端沒有回傳資料，請確認部署時「誰可以存取」選的是「任何人」');
      }
      if (!data.ok) throw new Error(data.error || '後端回報失敗');
      return data;
    };

    // Apps Script 實測約每四次會有一次 404（後端跑太久、重導網址過期），
    // 所以連線類的錯誤一律重試。交卷能安全重試是因為後端認 roundId，
    // 同一回合寫過就不會再寫第二次。
    //
    // 「系統忙碌」也要重試：全班同時交卷時後端搶不到鎖就回這句
    // （2026-08-21 實測 17 人同時打後端，慢的排到 60 秒、還有 3 個直接掉 404）。
    // 它代表這份卷「根本還沒寫進去」，所以重試不但安全，而且是唯一的救法 ——
    // 原本這句不在白名單裡，塞車的學員會直接吃到紅字。
    const RETRYABLE = /HTTP|Failed to fetch|NetworkError|load failed|沒有回傳資料|系統忙碌/i;
    let lastErr;

    const TRIES = 4;
    for (let i = 0; i < TRIES; i++) {
      try {
        return await once();
      } catch (e) {
        lastErr = e;
        if (!RETRYABLE.test(e.message)) throw e;       // 後端明講的錯（次數用完等）不重試
        if (i < TRIES - 1) await new Promise(r => setTimeout(r, 900 * (i + 1)));
      }
    }
    throw new Error(lastErr.message + `　（已重試 ${TRIES} 次，請稍等幾秒再按一次交卷，你的答案還留著）`);
  }

  /* ── 流程 ─────────────────────────────────────────── */

  function loadUser() {
    try {
      const saved = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      if (saved && saved.name) return saved;
    } catch { /* 存檔壞了就當作沒選過 */ }
    return null;
  }

  async function chooseUser(name) {
    if (isTest(name) && !askPass()) return;
    const s = isTest(name) ? TEST_USER : students.find(x => x.name === name);
    if (!s) return;
    S.user = { name: s.name, seat: s.seat || '', avatar: s.avatar || '🙂' };
    localStorage.setItem(USER_KEY, JSON.stringify(S.user));

    // 先換頁再查後端 —— Apps Script 要好幾秒才回，卡在名單頁不動會被當成壞掉
    S.status = null;
    S.result = loadLast(S.user.name);          // 今天已經考過就直接把成績攤開給他看
    S.stage = S.result ? 'result' : 'ready';
    render();
    await refreshStatus();
  }

  /** 測試帳號的密碼關卡。已解鎖或通過回 true；按取消、打錯回 false */
  function askPass() {
    if (unlocked()) return true;

    const pw = prompt('這是老師的測試帳號，請輸入密碼：');
    if (pw === null) return false;                   // 按取消就安靜回名單

    if (hash(pw.trim()) !== TEST_PASS) {
      S.error = '密碼不對，這個帳號是老師測試用的。請點選你自己的名字。';
      render();
      return false;
    }
    localStorage.setItem(PASS_KEY, TEST_PASS);
    return true;
  }

  function forgetUser() {
    localStorage.removeItem(USER_KEY);
    Object.assign(S, { stage: 'pick', user: null, status: null, result: null, error: '' });
    render();
  }

  /**
   * 只更新剩餘次數，不動 stage —— 學員切走再切回來時，結果頁要留著給他看檢討，
   * 但上面的「還剩幾次」必須是最新的（他可能在別的裝置上又練了幾次）。
   */
  async function refreshStatus() {
    if (!S.user) return;
    await guard(async () => {
      const used = await fetchUsedToday(S.user.name);
      S.status = {
        name: S.user.name, used, limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - used),
        pointsPerPractice: cfg().quizPoints ?? 0.5,
      };
    }, 'status');
  }

  async function start() {
    await guard(async () => {
      // 先確認次數（讀 gviz，很快），再本機抽題 —— 完全不碰 Apps Script
      const used = await fetchUsedToday(S.user.name);
      if (used >= DAILY_LIMIT) {
        S.status = { used, limit: DAILY_LIMIT, remaining: 0, pointsPerPractice: cfg().quizPoints ?? 0.5 };
        throw new Error(`今天的 ${DAILY_LIMIT} 次機會已經用完了，明天再來！`);
      }

      const bank = S.bank && S.bank.length ? S.bank : (S.bank = await fetchBank());
      const questions = shuffle(bank.slice()).slice(0, PER_ROUND);

      S.questions = questions;
      S.status = {
        name: S.user.name, used, limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - used),
        pointsPerPractice: cfg().quizPoints ?? 0.5,
      };
      S.picks = questions.map(() => -1);
      // 每題的選項順序也打散，避免背「答案在第幾個」
      S.order = questions.map(q => shuffle(q.options.map((_, i) => i)));
      S.at = 0;
      S.startedAt = Date.now();
      S.stage = 'playing';
      S.result = null;
      // 這回合的身分證：交卷若因連線問題送了兩次，後端靠它認出是同一份卷
      S.roundId = `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    }, 'start');
  }

  async function submit() {
    await guard(async () => {
      try {
        S.result = await call('submit', null, {
          name: S.user.name,
          seat: S.user.seat,
          roundId: S.roundId,
          seconds: Math.round((Date.now() - S.startedAt) / 1000),
          answers: S.questions.map((q, i) => ({ key: q.key, pick: S.picks[i] })),
        });
      } catch (e) {
        // 送不出去不代表沒記到 —— 先去試算表找找這一回合，找不到才把原錯誤丟出去
        const saved = await recoverRound(S.user.name, S.roundId).catch(() => null);
        if (!saved) throw e;
        S.result = saved;
      }
      S.status = S.result;
      S.stage = 'result';
      saveLast();
    }, 'submit');
  }

  /* ── 成績存本機：連線再怎麼不順，分數至少不會從畫面上消失 ── */

  function saveLast() {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({
        name: S.user?.name,
        date: new Date().toLocaleDateString('sv-SE'),
        result: S.result,
      }));
    } catch { /* 存不下就算了，不能影響作答 */ }
  }

  /** 取回同一個人、同一天的成績；隔天就不給了（免得早上打開看到昨天的分數） */
  function loadLast(name) {
    try {
      const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (v && v.result && v.name === name &&
          v.date === new Date().toLocaleDateString('sv-SE')) return v.result;
    } catch { /* 存檔壞了就當作沒有 */ }
    return null;
  }

  /**
   * 統一處理載入中與錯誤訊息。
   * kind 會影響按鈕上的字（查次數 vs 出題 vs 計分）。
   * 已經在忙就直接忽略 —— 後端要好幾秒才回，學員一定會連點，
   * 不擋的話會送出好幾份卷、次數被算好幾次。
   */
  async function guard(fn, kind) {
    if (S.busy) return;
    S.busy = kind || 'loading';
    S.error = '';
    render();
    try {
      await fn();
    } catch (e) {
      S.error = e.message || String(e);
    } finally {
      S.busy = '';
      render();
    }
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ── 畫面 ─────────────────────────────────────────── */

  function render() {
    const el = $('#quizBody');
    if (!el) return;

    if (!api())        { el.innerHTML = notConfigured(); return; }
    if (!students.length) { el.innerHTML = needSync(); bind(el); return; }

    el.innerHTML = [
      S.error ? `<p class="quiz-error" role="alert">⚠️ ${esc(S.error)}</p>` : '',
      S.stage === 'pick'    ? viewPick()    :
      S.stage === 'ready'   ? viewReady()   :
      S.stage === 'playing' ? viewPlaying() : viewResult(),
    ].join('');
    bind(el);
  }

  const notConfigured = () => `
    <div class="quiz-empty">
      <p class="quiz-empty-title">刷題練習還沒開啟</p>
      <p>老師需要先部署 Apps Script 後端，並把網址填進 <code>ARENA_CONFIG.quizApi</code>。</p>
      <p class="quiz-hint">設定步驟寫在 <code>apps-script/刷題後端.gs</code> 檔案開頭。</p>
    </div>`;

  const needSync = () => `
    <div class="quiz-empty">
      <p class="quiz-empty-title">還沒有學員名單</p>
      <p>請老師先按右上角的「🔄 同步」把學員資料讀進來。</p>
      <button class="btn btn-primary" data-act="sync">🔄 現在同步</button>
    </div>`;

  function viewPick() {
    const list = [...students].sort((a, b) =>
      String(a.seat || '').localeCompare(String(b.seat || ''), 'zh-Hant', { numeric: true }));

    return `
      <div class="quiz-pick">
        <h3 class="quiz-h">請先選擇你的名字</h3>
        <p class="quiz-sub">選了才能開始練習。每天有 3 次機會，練習次數會計入互動成績。</p>
        <div class="quiz-people">
          ${list.map(s => `
            <button class="quiz-person" data-act="pick" data-name="${esc(s.name)}">
              <span class="quiz-person-ava">${esc(s.avatar || '🙂')}</span>
              <span class="quiz-person-seat">${esc(s.seat || '')}</span>
              <span class="quiz-person-name">${esc(s.name)}</span>
            </button>`).join('')}
          <button class="quiz-person is-test" data-act="pick" data-name="${esc(TEST_USER.name)}">
            <span class="quiz-person-ava">${TEST_USER.avatar}</span>
            <span class="quiz-person-seat">🔒 測試</span>
            <span class="quiz-person-name">${esc(TEST_USER.name)}</span>
          </button>
        </div>
      </div>`;
  }

  function viewReady() {
    const st = S.status;
    // 還沒查到剩餘次數（第一次進來要等後端），先顯示查詢中，不要假裝有 0 次
    if (!st) {
      return `
        <div class="quiz-ready">
          ${who()}
          <p class="quiz-loading">正在查詢今天的練習次數…</p>
        </div>`;
    }

    const left = st.remaining ?? 0;
    const pts = st.pointsPerPractice ?? 0;
    const limit = st.limit ?? 3;

    // 測試帳號：不限次數，也不會留下任何紀錄，所以不畫「還剩幾次」的燈號
    if (isTest(S.user?.name)) {
      return `
        <div class="quiz-ready">
          ${who()}
          <p class="quiz-hint">🧪 測試帳號：不限次數、不寫紀錄、不加分，隨便測。</p>
          <button class="btn btn-primary btn-lg" data-act="start" ${S.busy ? 'disabled' : ''}>
            ${S.busy === 'start' ? '出題中，請稍候…' : S.busy ? '讀取中…' : '🎯 開始練習（10 題）'}
          </button>
        </div>`;
    }

    return `
      <div class="quiz-ready">
        ${who()}
        <div class="quiz-chances" role="status">
          ${Array.from({ length: limit }, (_, i) =>
            `<span class="quiz-pip ${i < left ? 'is-on' : ''}" aria-hidden="true"></span>`).join('')}
          <span class="quiz-chances-text">今天還剩 <strong>${left}</strong> 次</span>
        </div>
        ${left > 0 ? `
          <button class="btn btn-primary btn-lg" data-act="start" ${S.busy ? 'disabled' : ''}>
            ${S.busy === 'start' ? '出題中，請稍候…' : S.busy ? '讀取中…' : '🎯 開始練習（10 題）'}
          </button>
          <p class="quiz-hint">分數不算進學習成績，但每練完一次，互動成績 +${pts} 分。</p>
        ` : `
          <p class="quiz-done">今天的 ${limit} 次機會用完了，明天再來 💪</p>
        `}
      </div>`;
  }

  function who() {
    const u = S.user || {};
    return `
      <div class="quiz-who">
        <span class="quiz-who-ava">${esc(u.avatar || '🙂')}</span>
        <span class="quiz-who-name">${esc(u.seat ? `${u.seat} ${u.name}` : u.name)}</span>
        <button class="btn btn-ghost btn-sm" data-act="forget">不是我</button>
      </div>`;
  }

  function viewPlaying() {
    const i = S.at;
    const q = S.questions[i];
    const order = S.order[i];
    const answered = S.picks.filter(p => p >= 0).length;
    const last = i === S.questions.length - 1;

    return `
      <div class="quiz-play">
        <div class="quiz-progress">
          <div class="quiz-progress-bar"><span style="width:${(i + 1) / S.questions.length * 100}%"></span></div>
          <span class="quiz-progress-text">第 ${i + 1} / ${S.questions.length} 題 · 已作答 ${answered}</span>
        </div>

        <div class="quiz-card">
          <p class="quiz-tag">${esc(q.subject)}${q.topic ? ` · ${esc(q.topic)}` : ''}</p>
          <p class="quiz-stem">${esc(q.stem)}</p>
          <div class="quiz-opts">
            ${order.map((origIdx, n) => `
              <button class="quiz-opt ${S.picks[i] === origIdx ? 'is-picked' : ''}"
                      data-act="answer" data-idx="${origIdx}">
                <span class="quiz-opt-key">${'ABCD'[n]}</span>
                <span class="quiz-opt-text">${esc(q.options[origIdx])}</span>
              </button>`).join('')}
          </div>
        </div>

        <div class="quiz-nav">
          <button class="btn" data-act="prev" ${i === 0 ? 'disabled' : ''}>← 上一題</button>
          ${last
            ? `<button class="btn btn-primary" data-act="submit" ${S.busy ? 'disabled' : ''}>
                 ${S.busy === 'submit' ? '計分中…最久 30 秒，別重整' : `✅ 交卷（已作答 ${answered}/${S.questions.length}）`}
               </button>`
            : `<button class="btn btn-primary" data-act="next">下一題 →</button>`}
        </div>
      </div>`;
  }

  function viewResult() {
    const r = S.result || {};
    const tone = r.score >= 80 ? 'is-good' : r.score >= 60 ? 'is-ok' : 'is-low';
    // 剩餘次數以最新查到的為準，不是交卷當下那個數字
    const test = isTest(S.user?.name);
    const left = test ? 1 : (S.status?.remaining ?? r.remaining ?? 0);

    return `
      <div class="quiz-result">
        ${who()}
        <div class="quiz-score ${tone}">
          <span class="quiz-score-num">${r.score}</span>
          <span class="quiz-score-sub">答對 ${r.correct} / ${r.total} 題</span>
        </div>
        <p class="quiz-earned">${
          test ? '🧪 測試帳號：沒有寫入任何紀錄，也沒有加分' :
          r.alreadyRecorded
            ? `這份已經記錄過了，沒有重複加分 · 今天還剩 ${left} 次`
            : `互動成績 +${r.pointsEarned} 分已記錄 · 今天還剩 ${left} 次`}</p>
        ${r.recovered ? `
          <p class="quiz-recovered">📡 交卷時網路不順，這份成績是從紀錄裡撈回來的
          —— <strong>分數與加分都已經記錄好了</strong>，只是這次沒有逐題檢討可以看。</p>` : ''}

        <ol class="quiz-review">
          ${(r.detail || []).map((d, n) => `
            <li class="quiz-review-item ${d.isRight ? 'is-right' : 'is-wrong'}">
              <p class="quiz-review-stem"><span class="quiz-review-mark">${d.isRight ? '✓' : '✗'}</span>${n + 1}. ${esc(d.stem)}</p>
              ${d.isRight ? '' : `
                <p class="quiz-review-line">你選的：${d.pick >= 0 ? esc(d.options[d.pick]) : '（未作答）'}</p>`}
              <p class="quiz-review-line quiz-review-ans">正解：${esc(d.options[d.answerIndex])}</p>
              ${d.src ? `<p class="quiz-review-src">📖 ${esc(d.src)}</p>` : ''}
            </li>`).join('')}
        </ol>

        <div class="quiz-nav">
          ${left > 0
            ? `<button class="btn btn-primary" data-act="start" ${S.busy ? 'disabled' : ''}>
                 ${S.busy === 'start' ? '出題中，請稍候…' : '🔁 再練一次'}</button>`
            : `<p class="quiz-done">今天的機會用完了，明天再來 💪</p>`}
        </div>
      </div>`;
  }

  /* ── 事件 ─────────────────────────────────────────── */

  function bind(el) {
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'pick')   return chooseUser(btn.dataset.name);
        if (act === 'forget') return forgetUser();
        if (act === 'start')  return start();
        if (act === 'submit') return submit();
        if (act === 'sync')   return document.querySelector('#btnSync')?.click();
        if (act === 'answer') { S.picks[S.at] = Number(btn.dataset.idx); return next(); }
        if (act === 'next')   { S.at = Math.min(S.at + 1, S.questions.length - 1); return render(); }
        if (act === 'prev')   { S.at = Math.max(S.at - 1, 0); return render(); }
      });
    });
  }

  /** 選完自動跳下一題；最後一題留在原地等他按交卷 */
  function next() {
    if (S.at < S.questions.length - 1) S.at++;
    render();
  }

  /* ── 對外 ─────────────────────────────────────────── */

  return {
    /**
     * 借用這支的後端呼叫器（自帶重試，Apps Script 約每四次會回一次 404）。
     * 目前給「存檔回合」用；動作要能安全重試，靠後端認 snapId/roundId 防重複。
     */
    call,

    /** 學員名單變動時呼叫（同步完成後） */
    setStudents(list) {
      students = list || [];
      if (!S.user) {
        const saved = loadUser();
        // 名單換人時，舊的選擇要作廢，才不會用已離班的名字送出紀錄（測試帳號不受名單影響）
        // 測試帳號要解鎖過才續用，免得密碼清掉後還留在測試身分
        if (saved && ((isTest(saved.name) && unlocked()) || students.some(s => s.name === saved.name))) {
          S.user = saved;
          // 重新整理、關掉再開，成績都還在（不然第三次考完一重整就永遠看不到了）
          const last = loadLast(saved.name);
          if (last) { S.result = last; S.stage = 'result'; }
        }
      }
      render();
    },

    /**
     * 作答中接管鍵盤：1–4 選答案、←→ 換題、Enter 下一題或交卷。
     * 回傳 true 代表這個按鍵已經處理掉，app.js 的全域快捷鍵就不要再插手
     * （否則學員按 1 想選第一個選項，結果被切到個人榜）。
     */
    handleKey(e) {
      if (S.stage !== 'playing') return false;
      if (!document.querySelector('#view-quiz.is-active')) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;

      const order = S.order[S.at] || [];
      const last = S.at === S.questions.length - 1;

      if (/^[1-4]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        if (n >= order.length) return false;
        e.preventDefault();
        S.picks[S.at] = order[n];
        next();
        return true;
      }

      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        if (last && e.key === 'Enter') submit();
        else if (!last) { S.at++; render(); }
        return true;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (S.at > 0) { S.at--; render(); }
        return true;
      }

      return false;
    },

    /** 切到刷題頁時呼叫：回來就重新查一次剩餘次數 */
    async onEnter() {
      if (!api() || !students.length) return render();
      // 作答到一半切走再回來，不要打斷他；其他情況一律重查剩餘次數
      if (S.user && S.stage !== 'playing') {
        if (S.stage === 'pick') S.stage = 'ready';
        return refreshStatus();
      }
      render();
    },
  };
})();

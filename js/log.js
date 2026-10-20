/* ============================================================
   log.js — 賽季日誌：一週一段的班級歷程
   ------------------------------------------------------------
   讀兩個新分頁，都走 gviz（跟同步名單同一條路，穩）：
     「課程表」  一堂一列 —— 週次 / 日期 / 主題 / 講師 / 側記
     「學習報告」一週一列 —— 週次 / 期間 / 重點數據 / 摘要 /
                            學員回饋 / 成效評估 / 改善方向

   每一欄都可以留空，留空就不畫那一塊 —— 側記還沒寫、報告還沒出，
   畫面只是少一段，不會壞掉也不會開天窗。

   分頁不存在時 gviz 會安靜地退回第一個分頁（也就是學員總表），
   所以讀回來一定要驗表頭，不然會把成績當課程表畫出來。
   ============================================================ */

const Log = (() => {

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const cfg = () => window.ARENA_CONFIG || {};
  const val = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  /** 一格內的多行拆成陣列（學員回饋、改善方向都是一格多則） */
  const lines = s => s.split(/\r?\n/).map(t => t.trim()).filter(Boolean);

  /** 回饋一則一行；但某一則本身就有換行時（例如整封信），改成用空行分則 */
  const blocks = s => (/\r?\n[ \t]*\r?\n/.test(s)
    ? s.split(/\r?\n[ \t]*\r?\n/)
    : s.split(/\r?\n/)).map(t => t.trim()).filter(Boolean);

  let cache = null;      // 讀成功就留著，切分頁不重讀
  let loading = false;

  /** 一天先只排一列（桌面剛好滿一列），其餘收進「再看 N 張」 */
  const MAX_SHOTS = 12;

  const LESSON_ALIASES = {
    week:    ['週次', '週別', '周次', '週'],
    date:    ['日期', 'date'],
    time:    ['時間', 'time'],
    topic:   ['主題', '課程', '單元', '課程名稱'],
    teacher: ['講師', '老師', 'teacher'],
    note:    ['側記', '筆記', '花絮', '隨手記']
  };

  const ALBUM_ALIASES = {
    date:   ['日期'],
    time:   ['時間', 'time'],
    fileId: ['檔案id', 'id', '檔案'],
    name:   ['檔名', '名稱']
  };

  const REPORT_ALIASES = {
    week:    ['週次', '週別', '周次', '週'],
    range:   ['期間', '日期範圍'],
    stats:   ['重點數據', '數據', '統計'],
    summary: ['摘要', '概述'],
    voices:  ['學員回饋', '回饋', '學員意見'],
    review:  ['成效評估', '評估', '成效'],
    actions: ['改善方向', '改善', '調整'],
    // 以下三欄是選配的「整期總評」，只有最後一週會填
    sumStats:  ['整體數據'],
    sumReview: ['整體評估'],
    sumVoices: ['整體回饋']
  };

  /** 依別名比對表頭，回傳 {欄位: 索引}；找不到的是 -1 */
  function mapCols(header, aliases) {
    const norm = header.map(h => String(h ?? '').trim().toLowerCase().replace(/\s+/g, ''));
    const idx = {};
    for (const [key, words] of Object.entries(aliases)) {
      idx[key] = norm.findIndex(h => h && words.some(w => h.includes(w.toLowerCase())));
    }
    return idx;
  }

  /** 「第1週」「第 10 週」→ 數字，用來排序；抓不到就排到最後 */
  const weekNo = s => {
    const m = String(s).match(/\d+/);
    return m ? parseInt(m[0], 10) : 9999;
  };

  /**
   * 日期收斂成 "8/12" 當比對鍵：課程表寫「8/12（三）」、相簿寫「8/12」，
   * 「2026/8/12」「8月12日」也都收得進來。
   */
  const dayKey = s => {
    const m = String(s ?? '').match(/(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
    return m ? `${+m[1]}/${+m[2]}` : '';
  };

  /** 「8/12（三）」→ 812，同一週裡按日期由舊到新；沒填日期的排到最後 */
  const dayNo = s => {
    const k = dayKey(s);
    if (!k) return 9999;
    const [m, d] = k.split('/').map(Number);
    return m * 100 + d;
  };

  /**
   * 還沒上到的那一天先不顯示 —— 課程表可以一次把整期都填好，
   * 日誌只會長到今天為止。日期沒填的照樣顯示（寧可多顯示，不要漏）。
   * ponytail: 課程表不寫年份，這裡一律當今年；跨年的班要改成從試算表帶年份進來。
   */
  const isFuture = date => {
    const k = dayKey(date);
    if (!k) return false;
    const [m, d] = k.split('/').map(Number);
    const now = new Date();
    return new Date(now.getFullYear(), m - 1, d) >
           new Date(now.getFullYear(), now.getMonth(), now.getDate());
  };

  /** 「14:30」→ 870（當天的第幾分鐘）；讀不出時間回 null */
  const minutes = s => {
    const m = String(s ?? '').match(/(\d{1,2}):(\d{2})/);
    return m ? +m[1] * 60 + +m[2] : null;
  };

  /**
   * 這張照片是哪一堂課拍的：當天所有課裡，**最後一堂已經開始**的那堂。
   * 下課空檔、午休、放學後拍的（11:03、12:07、16:56 這種）因此會歸給
   * 剛上完的那一堂，符合直覺 —— 那本來就是那堂課的延伸。
   * 第一堂開始前拍的（09:06 進教室）算第一堂。
   * 照片沒有拍攝時間、或課程表那天沒填時間 → 回 null，照片改掛在那一天底下。
   */
  function lessonAt(items, time) {
    const at = minutes(time);
    if (at == null) return null;

    const timed = items
      .map(l => ({ l, start: minutes(l.time) }))
      .filter(x => x.start != null)
      .sort((a, b) => a.start - b.start);
    if (!timed.length) return null;

    let hit = timed[0].l;
    timed.forEach(x => { if (x.start <= at) hit = x.l; });
    return hit;
  }

  /* ── 讀分頁 ───────────────────────────────────────── */

  /**
   * 讀一個分頁並驗表頭。分頁不存在時 gviz 會退回第一個分頁，
   * 那時 must 指定的欄位一定找不到 —— 回 null 當作「還沒建這個分頁」。
   */
  async function fetchTab(id, tabName, aliases, must) {
    const rows = await Sheet.fetchRows(id, tabName).catch(() => null);
    if (!rows || rows.length < 2) return null;

    const idx = mapCols(rows[0], aliases);
    if (must.some(k => idx[k] < 0)) return null;
    return { idx, body: rows.slice(1) };
  }

  async function fetchLessons(id) {
    const tab = await fetchTab(id, cfg().logCourseSheet || '課程表', LESSON_ALIASES, ['topic']);
    if (!tab) return [];

    return tab.body.map(r => ({
      week:    val(r, tab.idx.week),
      date:    val(r, tab.idx.date),
      time:    val(r, tab.idx.time),
      topic:   val(r, tab.idx.topic),
      teacher: val(r, tab.idx.teacher),
      note:    val(r, tab.idx.note)
    })).filter(l => l.topic && !isFuture(l.date));
  }

  async function fetchReports(id) {
    const tab = await fetchTab(id, cfg().logReportSheet || '學習報告', REPORT_ALIASES, ['week']);
    if (!tab) return [];

    return tab.body.map(r => ({
      week:    val(r, tab.idx.week),
      range:   val(r, tab.idx.range),
      stats:   val(r, tab.idx.stats),
      summary: val(r, tab.idx.summary),
      voices:  blocks(val(r, tab.idx.voices)),
      review:  val(r, tab.idx.review),
      actions: lines(val(r, tab.idx.actions)),
      sumStats:  val(r, tab.idx.sumStats),
      sumReview: val(r, tab.idx.sumReview),
      sumVoices: blocks(val(r, tab.idx.sumVoices))
    })).filter(rep => rep.week);
  }

  async function fetchAlbum(id) {
    const tab = await fetchTab(id, cfg().logAlbumSheet || '課堂相簿', ALBUM_ALIASES, ['fileId']);
    if (!tab) return [];

    return tab.body.map(r => ({
      day:  dayKey(val(r, tab.idx.date)),
      time: val(r, tab.idx.time),
      id:   val(r, tab.idx.fileId),
      name: val(r, tab.idx.name)
    })).filter(p => p.id && p.day);
  }

  /* ── 分組：週 → 天 → 課 ───────────────────────────── */

  function groupByWeek(lessons, reports, photos) {
    const weeks = new Map();

    const bucket = key => {
      if (!weeks.has(key)) weeks.set(key, { week: key, days: new Map(), report: null });
      return weeks.get(key);
    };

    lessons.forEach(l => {
      const w = bucket(l.week || '未分週');
      if (!w.days.has(l.date)) w.days.set(l.date, { date: l.date, items: [], photos: [] });
      w.days.get(l.date).items.push({ ...l, photos: [] });
      // 側記跟著它那一堂走（見 renderDay），不再收斂成一天一則
    });

    // 照片依拍攝日掛到對應那一天；課程表沒有那一天就不顯示
    if (photos.length) {
      const byDay = new Map();
      weeks.forEach(w => w.days.forEach(d => {
        const k = dayKey(d.date);
        if (k) byDay.set(k, d);
      }));
      photos.forEach(p => {
        const day = byDay.get(p.day);
        if (!day) return;
        const lesson = lessonAt(day.items, p.time);
        (lesson || day).photos.push(p);
      });
    }

    reports.forEach(rep => { bucket(rep.week).report = rep; });

    // 週和日都由舊到新：第1週在最上面，一天一天往下讀，跟課程表同一個方向
    return [...weeks.values()]
      .sort((a, b) => weekNo(a.week) - weekNo(b.week))
      .map(w => ({ ...w, days: [...w.days.values()].sort((a, b) => dayNo(a.date) - dayNo(b.date)) }));
  }

  /* ── 畫面 ─────────────────────────────────────────── */

  /** 「參訓人數=17 / 回收率=100%」→ 數據卡 */
  function renderStats(raw) {
    const cards = raw.split('/').map(s => s.trim()).filter(Boolean).map(s => {
      const [label, value] = s.split('=').map(t => (t || '').trim());
      return value ? { label, value } : { label: '', value: label };
    });
    if (!cards.length) return '';

    return `<div class="rp-stats">${cards.map(c => `
      <div class="rp-stat">
        <div class="rp-stat-value">${esc(c.value)}</div>
        ${c.label ? `<div class="rp-stat-label">${esc(c.label)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function renderReport(rep) {
    if (!rep) return '';

    const block = (title, html) => html
      ? `<div class="rp-block"><h4 class="rp-h">${title}</h4>${html}</div>` : '';

    const para = t => t ? `<p class="rp-text">${esc(t)}</p>` : '';

    const quotes = list => list.length
      ? `<div class="rp-voices">${list.map(v =>
          `<blockquote class="rp-voice">${esc(v)}</blockquote>`).join('')}</div>`
      : '';

    const voices = quotes(rep.voices);

    const actions = rep.actions.length
      ? `<ul class="rp-actions">${rep.actions.map(a =>
          `<li>${esc(a)}</li>`).join('')}</ul>`
      : '';

    // 整期總評：三欄都空就整塊不畫
    const summaryBlock = (rep.sumStats || rep.sumReview || rep.sumVoices.length)
      ? `<div class="rp-block rp-overall">
           <h4 class="rp-h">這一期整體來看</h4>
           ${rep.sumStats ? renderStats(rep.sumStats) : ''}
           ${para(rep.sumReview)}
           ${quotes(rep.sumVoices)}
         </div>`
      : '';

    return `
      <div class="rp">
        <div class="rp-head">
          <span class="rp-badge">學習分析報告</span>
          ${rep.range ? `<span class="rp-range">${esc(rep.range)}</span>` : ''}
        </div>
        ${rep.stats ? renderStats(rep.stats) : ''}
        ${block('這一週的整體樣貌', para(rep.summary))}
        ${block('學員說了什麼', voices)}
        ${block('學習成效', para(rep.review))}
        ${block('我接下來會這樣調整', actions)}
        ${summaryBlock}
      </div>`;
  }

  /**
   * Drive 的兩個圖片端點都會偶發失敗（實測各約六分之一），但不會同時掛，
   * 所以 lh3 掛掉就換 thumbnail。HEIC 由 Google 那端自動轉檔，瀏覽器看得到。
   */
  function renderPhotos(photos, label) {
    if (!photos.length) return '';

    const thumb = id => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1200`;
    const shot = (p, i) => `
      <a class="lg-shot" href="https://drive.google.com/file/d/${esc(p.id)}/view"
         target="_blank" rel="noopener">
        <img loading="lazy" alt="${esc(label)} 照片 ${i + 1}"
             src="https://lh3.googleusercontent.com/d/${esc(p.id)}=w1200"
             onerror="this.onerror=null;this.src='${thumb(p.id)}'">
      </a>`;

    const grid = (list, from) =>
      `<div class="lg-shots">${list.map((p, i) => shot(p, from + i)).join('')}</div>`;

    const rest = photos.slice(MAX_SHOTS);
    // 收在 <details> 裡的圖是 loading="lazy"，沒展開就不會去下載
    return grid(photos.slice(0, MAX_SHOTS), 0) + (rest.length ? `
      <details class="lg-more">
        <summary>
          <span class="lg-more-in">再看 ${rest.length} 張</span>
          <span class="lg-more-out">收合</span>
        </summary>
        ${grid(rest, MAX_SHOTS)}
      </details>` : '');
  }

  function renderDay(day) {
    const items = day.items.map(l => `
      <li class="lg-lesson">
        <div class="lg-lesson-head">
          <span class="lg-topic">${esc(l.topic)}</span>
          ${l.teacher ? `<span class="lg-teacher">${esc(l.teacher)}</span>` : ''}
          ${l.time ? `<span class="lg-time">${esc(l.time)}</span>` : ''}
          ${l.photos.length ? `<span class="lg-count">${l.photos.length} 張</span>` : ''}
        </div>
        ${l.note ? `<p class="lg-note">${esc(l.note)}</p>` : ''}
        ${renderPhotos(l.photos, l.topic)}
      </li>`).join('');

    return `
      <div class="lg-day">
        <div class="lg-date">${esc(day.date || '日期未填')}</div>
        <ul class="lg-lessons">${items}</ul>
        ${renderPhotos(day.photos, day.date)}
      </div>`;
  }

  function renderWeek(w) {
    return `
      <section class="lg-week">
        <header class="lg-week-head">
          <h3>${esc(w.week)}</h3>
          ${w.report && w.report.range ? `<span class="chip">${esc(w.report.range)}</span>` : ''}
        </header>
        <div class="lg-days">${w.days.map(renderDay).join('')}</div>
        ${renderReport(w.report)}
      </section>`;
  }

  function render(weeks) {
    const body = $('#logBody');
    if (!weeks.length) {
      body.innerHTML = `
        <div class="callout">
          還沒讀到「課程表」分頁。到試算表建一個分頁叫 <code>課程表</code>，
          第一列填 <code>週次 · 日期 · 主題 · 講師 · 側記</code>，再按上面的「同步」。
        </div>`;
      return;
    }
    body.innerHTML = weeks.map(renderWeek).join('');
  }

  /* ── 滑過縮圖放大看 ───────────────────────────────── */

  let zoom = null;

  /**
   * 滑鼠指到哪張，游標旁邊就浮一張大的（用的是同一個網址，瀏覽器已經有快取，不會再下載）。
   * 事件掛在 #logBody 上而不是每張圖上 —— 重畫時 innerHTML 換掉，掛在圖上的就全沒了。
   * 觸控裝置沒有 hover，整個不啟用。
   */
  function initZoom() {
    const body = $('#logBody');
    if (!body || zoom || !matchMedia('(hover: hover)').matches) return;

    zoom = document.createElement('div');
    zoom.className = 'lg-zoom';
    zoom.innerHTML = '<img alt="">';
    document.body.appendChild(zoom);
    const big = zoom.querySelector('img');

    // 預設放在游標右邊，靠近視窗邊緣就翻到另一邊，不讓它被切到
    let at = { x: 0, y: 0 };
    const place = (x, y) => {
      at = { x, y };
      const pad = 16;
      const { width: w, height: h } = zoom.getBoundingClientRect();
      const left = x + 20 + w + pad > innerWidth ? x - 20 - w : x + 20;
      const top = Math.min(Math.max(pad, y - h / 2), innerHeight - h - pad);
      zoom.style.transform = `translate(${Math.max(pad, left)}px, ${top}px)`;
    };

    // 換圖的瞬間高度還是上一張的，載好才知道真正多高 —— 重算一次才不會掉出畫面
    big.addEventListener('load', () => place(at.x, at.y));
    // 縮圖本來就載不出來的那幾張（Google 偶發），放大也是空的，不如不要浮出來
    big.addEventListener('error', () => zoom.classList.remove('is-on'));

    body.addEventListener('mouseover', e => {
      const img = e.target.closest('.lg-shot img');
      if (!img) return;
      big.src = img.currentSrc || img.src;
      zoom.classList.add('is-on');
      place(e.clientX, e.clientY);
    });

    body.addEventListener('mouseout', e => {
      if (e.target.closest('.lg-shot img')) zoom.classList.remove('is-on');
    });

    body.addEventListener('mousemove', e => {
      if (zoom.classList.contains('is-on')) place(e.clientX, e.clientY);
    });
  }

  /* ── 對外 ─────────────────────────────────────────── */

  async function load(force = false) {
    if (loading) return;
    if (cache && !force) { render(cache); return; }

    const id = Sheet.parseId(cfg().sheetId);
    if (!id) {
      $('#logBody').innerHTML = `<div class="callout err">還沒設定班級試算表，先到「設定」貼上連結。</div>`;
      return;
    }

    loading = true;
    $('#logBody').innerHTML = `<div class="callout">讀取中…</div>`;

    try {
      const [lessons, reports, photos] =
        await Promise.all([fetchLessons(id), fetchReports(id), fetchAlbum(id)]);
      cache = groupByWeek(lessons, reports, photos);
      render(cache);
    } catch (e) {
      console.error('[log]', e);
      $('#logBody').innerHTML =
        `<div class="callout err">讀取失敗：${esc(e.message)}<br>檢查試算表共用權限是否為「知道連結的任何人 → 檢視者」。</div>`;
    } finally {
      loading = false;
    }
  }

  /** 進到這個分頁才讀，不佔開場的同步 */
  function onEnter() { initZoom(); load(); }

  /** 按「同步」時一起更新；正在看這一頁就當場重畫 */
  function invalidate() {
    cache = null;
    const view = document.getElementById('view-log');
    if (view && view.classList.contains('is-active')) load();
  }

  /** Slido 話牆的連結寫在 ARENA_CONFIG.wallUrl，沒填就不顯示按鈕 */
  function initWall() {
    const url = (cfg().wallUrl || '').trim();
    const btn = $('#btnWall');
    if (!btn) return;
    if (!url) { btn.hidden = true; return; }
    btn.href = url;
    btn.hidden = false;
  }

  return { onEnter, load, invalidate, initWall };
})();

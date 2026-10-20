/* ============================================================
   data.js — 狀態、儲存、Google 試算表讀取、戰力計算
   ============================================================ */

const Store = (() => {
  // v2：改成配分制（累積得分＝學期成績）。舊的 v1 存檔是不同的分數尺度，
  // 沿用會讓「名次走勢」出現斷層，所以直接換 key 重新開始。
  const KEY = 'LT153P034.v2';

  // index.html 裡寫死的班級設定，當作預設值
  const BUILT_IN = window.ARENA_CONFIG || {};

  const DEFAULTS = {
    className: '客網新進人員訓練班第034期',
    sheetId: BUILT_IN.sheetId || '',
    sheetName: BUILT_IN.sheetName || '',
    logSheetName: BUILT_IN.logSheetName || '',   // 加減分流水帳的分頁名；留空就不讀
    perfTarget: BUILT_IN.perfTarget || 70,        // 活躍度的「整期滿分目標」加分數
    autoSync: false,
    // 配分：三項相加＝學期成績滿分。作業那 30 分由三份作業平分。
    weights: { ...{ quality: 30, performance: 20, exam: 50 }, ...(BUILT_IN.weights || {}) },
    options: { anim: true, sound: true, blind: false },
    students: [],
    history: [],          // [{ t, label, ranks:{id:rank}, totals:{id:number}, champion }]
    lastSync: null
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const saved = JSON.parse(raw);
      const merged = {
        ...structuredClone(DEFAULTS),
        ...saved,
        weights: { ...DEFAULTS.weights, ...(saved.weights || {}) },
        options: { ...DEFAULTS.options, ...(saved.options || {}) }
      };
      // 班級設定一律以 index.html 為準：設定分頁鎖了密碼進不去，
      // 舊裝置存的值（舊試算表、舊配分）會蓋掉這裡調整過的新值，所以讓內建設定贏。
      for (const k of ['sheetId', 'sheetName', 'logSheetName', 'perfTarget']) {
        if (BUILT_IN[k]) merged[k] = BUILT_IN[k];
      }
      if (BUILT_IN.weights) merged.weights = { ...merged.weights, ...BUILT_IN.weights };
      return merged;
    } catch (e) {
      console.warn('[Store] 讀取本機資料失敗，改用預設值', e);
      return structuredClone(DEFAULTS);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[Store] 無法寫入 localStorage', e);
    }
  }

  function reset() {
    localStorage.removeItem(KEY);
    state = structuredClone(DEFAULTS);
  }

  return {
    get state() { return state; },
    set(patch) { Object.assign(state, patch); save(); },
    save, reset,
    replaceAll(next) { state = next; save(); }
  };
})();


/* ── 戰力計算 ─────────────────────────────────────────── */

const Scoring = (() => {

  // 段位依名次百分位，不看絕對分數 —— 累積總分整個賽季都在長，
  // 用固定門檻的話期初全班青銅、期末全班王者，段位就沒有意義了。
  const TIERS = [
    { top: 0.06, name: '王者' },
    { top: 0.18, name: '鑽石' },
    { top: 0.36, name: '白金' },
    { top: 0.60, name: '黃金' },
    { top: 0.85, name: '白銀' },
    { top: 1.00, name: '青銅' }
  ];

  /** @param {number} rank 名次（1 起算） @param {number} count 全班人數 */
  function tierOf(rank, count) {
    const p = count > 0 ? rank / count : 1;
    return TIERS.find(t => p <= t.top + 1e-9).name;
  }

  const r1 = n => Math.round(n * 10) / 10;

  /**
   * 排行榜的「累積總分」：所有拿到手的分數直接相加，不換算、不設上限。
   * 每交一份作業、每拿一次加分，數字就往上長，期末會遠超過 100。
   * 還沒評分的作業就是還沒加上去，不是 0 分。
   */
  function rawTotalOf(s) {
    const hw = s.assignments && s.assignments.length
      ? s.assignments.reduce((sum, a) => a.score === null ? sum : sum + a.score, 0)
      : s.quality;                                    // 舊的單欄「作業成績」格式
    return r1(hw + (s.perfRaw || 0) + s.exam);
  }

  /**
   * 學期成績（滿分 100）——期末要輸入學習系統的數字，依配分加權算出來。
   * 跟排行榜的累積總分是兩套數字：這個看比重，那個看累積量。
   */
  function gradeOf(s, w) {
    return r1(s.quality / 100 * w.quality
            + s.performance / 100 * w.performance
            + s.exam / 100 * w.exam);
  }

  /**
   * 產生排序後的榜單，附上名次、段位、與上一回合相比的名次變化。
   * @returns {Array} rows — 每筆含 rank / total(累積總分) / grade(學期成績) / tier / delta / badges
   */
  function buildBoard(students, weights, history) {
    const rows = students.map(s => ({
      ...s,
      total: rawTotalOf(s),
      grade: gradeOf(s, weights)
    }));

    rows.sort((a, b) =>
      b.total - a.total ||
      b.exam - a.exam ||
      b.quality - a.quality ||
      a.name.localeCompare(b.name, 'zh-Hant')
    );

    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.tier = tierOf(r.rank, rows.length);
    });

    const prev = history.length ? history[history.length - 1] : null;
    rows.forEach(r => {
      const before = prev && prev.ranks[r.id];
      r.prevRank = before ?? null;
      r.delta = before ? before - r.rank : null;   // 正數 = 名次上升
    });

    attachBadges(rows, history);
    return rows;
  }

  /** 依全班相對表現與歷史紀錄掛上徽章 */
  function attachBadges(rows, history) {
    if (!rows.length) return;

    const best = k => Math.max(...rows.map(r => r[k]));
    const topQ = best('quality'), topP = best('performance');

    // 第三個維度跟能力三角、排位榜、三項成績一致：有刷題資料就用刷題均分，
    // 讀不到才退回終極考驗。終極考驗要考完試才有分數，整季都是 0，
    // 拿它算「三維均衡」永遠不可能達成（實習 90 幾 − 0）。
    const hasQuiz = rows.some(r => r.quizTimes != null);
    const dim3    = r => hasQuiz ? r.quizAvg : r.exam;
    const top3    = Math.max(...rows.map(dim3));

    // 進步之星：與上一回合相比名次進步最多的人（至少進步 1 名）
    let starGain = 0;
    rows.forEach(r => { if (r.delta && r.delta > starGain) starGain = r.delta; });

    // 連霸：這一回合第 1 名，且上一回合也是第 1 名
    const prev = history.length ? history[history.length - 1] : null;

    rows.forEach(r => {
      const b = [];
      const d3 = dim3(r);
      if (r.rank === 1 && prev && prev.champion === r.id) b.push({ icon: '🔥', name: '連霸', desc: '連續兩回合排名第一' });
      if (r.quality === topQ && topQ > 0)     b.push({ icon: '✨', name: '實習達人', desc: '全班實習成績最高' });
      if (r.performance === topP && topP > 0) b.push({ icon: '🙋', name: '課堂之星', desc: '全班活躍度最高' });
      if (d3 === top3 && top3 > 0)
        b.push(hasQuiz ? { icon: '🎯', name: '刷題王', desc: '全班刷題均分最高' }
                       : { icon: '🎯', name: '考神',   desc: '全班終極考驗最高' });
      if (starGain > 0 && r.delta === starGain) b.push({ icon: '🚀', name: '進步之星', desc: `名次進步 ${starGain} 名，全班最多` });
      if ([r.quality, r.performance, d3].some(v => v >= 100)) b.push({ icon: '💯', name: '滿分王', desc: '單項拿到滿分' });
      if (Math.max(r.quality, r.performance, d3) - Math.min(r.quality, r.performance, d3) <= 5)
        b.push({ icon: '⚖️', name: '三維均衡', desc: '三項成績差距在 5 分以內' });
      if (r.rank === 1) b.push({ icon: '⚡', name: '積分王', desc: '全班累積總分最高' });
      r.badges = b;
    });
  }

  /** 公會積分 = 公會內平均戰力 */
  function buildTeams(rows) {
    const map = new Map();
    rows.forEach(r => {
      const key = (r.team || '').trim();
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });

    const teams = [...map.entries()].map(([name, members]) => ({
      name,
      members: members.sort((a, b) => a.rank - b.rank),
      score: Math.round(members.reduce((s, m) => s + m.total, 0) / members.length * 10) / 10
    }));

    teams.sort((a, b) => b.score - a.score);
    teams.forEach((t, i) => t.rank = i + 1);
    return teams;
  }

  return { buildBoard, buildTeams, tierOf, rawTotalOf, gradeOf, TIERS };
})();


/* ── Google 試算表讀取 ────────────────────────────────── */

const Sheet = (() => {

  /** 從貼上的網址抽出試算表 ID；已經是純 ID 就原樣回傳。 */
  function parseId(input) {
    const s = (input || '').trim();
    if (!s) return '';
    const m = s.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9-_]{20,})/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
    return '';
  }

  /** @param {string} [tq] gviz 查詢語法，例如 'select A,B,C' —— 用來只取需要的欄位 */
  function endpoints(id, sheetName, tq) {
    const tab = sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
    const q   = tq ? `&tq=${encodeURIComponent(tq)}` : '';
    const urls = [
      `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${tab}${q}`
    ];
    // 「發布到網路」產生的 2PACX- 型 ID 走另一個端點
    if (id.startsWith('2PACX-')) {
      urls.unshift(`https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv&single=true`);
    }
    return urls;
  }

  /** 逐字元解析 CSV，正確處理引號內的逗號與換行 */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }

  const ALIASES = {
    seat:        ['座號', '座位', '號次', '學號', '編號', 'seat'],
    name:        ['姓名', '學員', '學員姓名', '名字', 'name', 'student'],
    team:        ['組別', '公會', '隊伍', '小組', '組', 'team', 'group'],
    unit:        ['單位', '營運處', 'unit', 'dept'],
    avatar:      ['頭像', '圖示', 'avatar', 'emoji', 'icon'],
    hw1:         ['作業1', '作業一', '實習1', 'hw1'],
    hw2:         ['作業2', '作業二', '實習2', 'hw2'],
    hw3:         ['作業3', '作業三', '實習3', 'hw3'],
    quality:     ['作業', '品質', 'quality'],   // 沒有作業1~3 時才會用到的單欄舊格式
    performance: ['表現', '上課', '活躍', 'performance', 'class'],
    exam:        ['考試', '測驗', '終極', 'exam', 'test', 'score']
  };

  /** 「回合紀錄」分頁（一列一位學員在某回合的名次）的欄位別名 */
  const SNAP_ALIASES = {
    time:     ['時間'],
    round:    ['回合'],
    label:    ['標籤'],
    seat:     ['座號'],
    name:     ['姓名'],
    rank:     ['名次'],
    total:    ['累積總分'],
    champion: ['冠軍']
  };

  /** 「表現紀錄」分頁（一列一筆加減分）的欄位別名 */
  const LOG_ALIASES = {
    date:    ['日期', 'date'],
    item:    ['堂次', '課程', '課別', '節次', 'lesson'],
    name:    ['學員', '姓名', '名字', 'name', 'student'],
    delta:   ['加減分', '加分', '分數', 'delta', 'point'],
    reason:  ['事由', '原因', '說明', '備註', 'reason', 'note'],
    teacher: ['老師', '講師', 'teacher']
  };

  /** 依別名比對表頭，回傳 {欄位: 索引}；找不到的欄位是 -1 */
  function mapWith(header, aliases) {
    const norm = header.map(h => h.trim().toLowerCase().replace(/\s+/g, ''));
    const idx = {};
    for (const [key, words] of Object.entries(aliases)) {
      idx[key] = norm.findIndex(h => h && words.some(w => h.includes(w.toLowerCase())));
    }
    return idx;
  }

  const mapHeaders = header => mapWith(header, ALIASES);

  function clamp100(v) {
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  const HW_LABELS = ['實習1', '實習2', '實習3'];

  /** 取座號的比對鍵：「01」「1」「1號」都收斂成 "1"；不是數字就回空字串 */
  function seatKey(v) {
    const n = parseInt(String(v ?? '').trim(), 10);
    return isFinite(n) ? String(n) : '';
  }

  /**
   * 拆開「01 黃相奎」這種帶座號的下拉選單標籤。
   * 分隔符號空白／點／頓號／減號／括號都吃，全形半形皆可；
   * 只填座號（"01"）或只填姓名（"黃相奎"）也都拆得動。
   */
  function splitLabel(v) {
    const s = String(v ?? '').replace(/　/g, ' ').trim();
    const m = s.match(/^(\d{1,3})\s*[.、．・_:：)）\-]?\s*(.*)$/);
    return m ? { seat: seatKey(m[1]), name: m[2].trim() } : { seat: '', name: s };
  }

  /** 平均並取到小數一位；空陣列回 0 */
  function avg(nums) {
    if (!nums.length) return 0;
    return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length * 10) / 10;
  }

  const FALLBACK_AVATARS = ['🦊','🐯','🐼','🦁','🐺','🦉','🐧','🦄','🐲','🦅','🐬','🦈','🐝','🦖','🐙','🦋','🐳'];

  /**
   * 頭像欄要真的含 emoji 才採用。
   * 留空、編碼壞掉、或誤填成文字時，都退回自動配的動物頭像，
   * 才不會在榜上出現一串亂碼。
   */
  function pickAvatar(raw, n) {
    const v = (raw || '').trim();
    if (v && /\p{Extended_Pictographic}/u.test(v)) return v;
    return FALLBACK_AVATARS[n % FALLBACK_AVATARS.length];
  }

  function rowsToStudents(rows) {
    if (rows.length < 2) throw new Error('試算表至少要有表頭與一列資料');

    const idx = mapHeaders(rows[0]);
    if (idx.name < 0) throw new Error('找不到「姓名」欄位，請確認第一列有欄位名稱');

    // 有「作業1/2/3」就用三欄平均；只有舊的單欄「作業成績」也照樣讀得動
    const hwIdx = [idx.hw1, idx.hw2, idx.hw3];
    const hasHw = hwIdx.some(i => i >= 0);

    if (!hasHw && idx.quality < 0 && idx.performance < 0 && idx.exam < 0)
      throw new Error('找不到任何成績欄位（作業1~3 / 上課表現 / 考試成績）');

    const pick = (r, i) => (i >= 0 ? (r[i] ?? '').trim() : '');

    // ID 只由姓名決定，不綁列號 —— 在試算表中插入/搬動列時，歷史回合紀錄才不會全部對不上。
    const used = new Set();
    const idFor = name => {
      let id = `s_${slug(name)}`, n = 2;
      while (used.has(id)) id = `s_${slug(name)}_${n++}`;   // 同名時才加編號
      used.add(id);
      return id;
    };

    return rows.slice(1).map((r, n) => {
      const name = pick(r, idx.name);
      if (!name) return null;

      // 三份作業等權平均。留白＝還沒評分，不列入平均；漏交要明確填 0。
      const assignments = hasHw
        ? HW_LABELS.map((label, i) => {
            const raw = pick(r, hwIdx[i]);
            return { label, score: raw === '' ? null : clamp100(raw) };
          })
        : [];
      const graded = assignments.filter(a => a.score !== null);

      return {
        id: idFor(name),
        name,
        // 欄位若是「座號姓名」合併的（值長成「1黄相奎」），只取開頭的數字；
        // 純數字的「01」則原樣保留，前導零不會掉。
        seat: (pick(r, idx.seat).match(/^\s*(\d+)/) || [, pick(r, idx.seat)])[1],
        team: pick(r, idx.team),
        unit: pick(r, idx.unit),
        avatar: pickAvatar(pick(r, idx.avatar), n),
        assignments,
        quality: hasHw ? avg(graded.map(a => a.score)) : clamp100(pick(r, idx.quality)),
        performance: clamp100(pick(r, idx.performance)),
        exam:        clamp100(pick(r, idx.exam))
      };
    }).filter(Boolean);
  }

  function slug(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** 抓某個分頁的 CSV 並切成列；依序嘗試各端點，全部失敗才拋錯。 */
  async function fetchRows(id, sheetName, tq) {
    let lastErr;
    for (const url of endpoints(id, sheetName, tq)) {
      try {
        const res = await fetch(url + `&_=${Date.now()}`, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (/^\s*</.test(text)) throw new Error('回傳的不是 CSV，請確認試算表已設為「知道連結的任何人可檢視」');
        return parseCSV(text);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('讀取失敗');
  }

  /** 抓取並解析學員總表 */
  async function fetchStudents(rawId, sheetName) {
    const id = parseId(rawId);
    if (!id) throw new Error('無法辨識試算表連結，請貼上完整的 Google 試算表網址');
    const students = rowsToStudents(await fetchRows(id, sheetName));
    if (!students.length) throw new Error('試算表沒有讀到任何學員');
    return students;
  }

  /** 抓取「表現紀錄」分頁的加減分流水帳，一列一筆 */
  async function fetchPerfLog(rawId, logSheetName) {
    const id = parseId(rawId);
    if (!id) throw new Error('無法辨識試算表連結');

    const rows = await fetchRows(id, logSheetName);
    if (rows.length < 2) return [];

    const idx = mapWith(rows[0], LOG_ALIASES);
    if (idx.name < 0 || idx.delta < 0)
      throw new Error(`「${logSheetName}」分頁至少要有「學員」與「加減分」兩欄`);

    const pick = (r, i) => (i >= 0 ? (r[i] ?? '').trim() : '');

    return rows.slice(1).map(r => {
      const name = pick(r, idx.name);
      const delta = parseFloat(pick(r, idx.delta).replace(/[^\d.\-]/g, ''));
      if (!name || !isFinite(delta)) return null;   // 空白列與寫不成數字的分數直接略過
      return {
        name, delta,
        date:    pick(r, idx.date),
        item:    pick(r, idx.item),
        reason:  pick(r, idx.reason),
        teacher: pick(r, idx.teacher)
      };
    }).filter(Boolean);
  }

  /**
   * 兩張對照表：姓名一張、座號一張。各種紀錄分頁的「學員」欄通常長成「01 黃相奎」，
   * 兩邊都試，其中一邊對上就算數 —— 座號改了或姓名改了都還有另一條路。
   */
  function indexStudents(students) {
    const byName = new Map();
    const bySeat = new Map();

    students.forEach(s => {
      const p = splitLabel(s.name);          // 總表姓名欄自己就帶座號時也拆得開
      byName.set(s.name.trim(), s);
      if (p.name && !byName.has(p.name)) byName.set(p.name, s);

      const seat = seatKey(s.seat) || p.seat;
      if (seat && !bySeat.has(seat)) bySeat.set(seat, s);
    });

    return { byName, bySeat };
  }

  /** @param {string} [seat] 紀錄分頁自己有座號欄時傳進來，多一條比對路 */
  function matchStudent(byName, bySeat, label, seat) {
    const raw = String(label ?? '').replace(/　/g, ' ').trim();
    const p = splitLabel(raw);
    return byName.get(raw)
        || (p.name && byName.get(p.name))
        || (p.seat && bySeat.get(p.seat))
        || (seatKey(seat) && bySeat.get(seatKey(seat)))
        || null;
  }

  /**
   * 把流水帳併進學員資料：累計加減分，再換算成 0–100 的表現分數。
   * 換算採「目標法」——累計 ÷ 滿分目標 × 100，超過封頂 100，
   * 這樣分數只會往上爬，不會因為別人加分而倒退。
   * @returns {{matched:number, unmatched:string[]}} 對不到姓名的要回報，否則那些分數會默默消失
   */
  function applyPerfLog(students, log, target) {
    const { byName, bySeat } = indexStudents(students);

    const unmatched = new Set();
    let matched = 0;

    students.forEach(s => { s.perfLog = []; s.perfRaw = 0; });

    log.forEach(e => {
      const s = matchStudent(byName, bySeat, e.name);
      if (!s) { unmatched.add(e.name); return; }
      s.perfLog.push(e);
      s.perfRaw += e.delta;
      matched++;
    });

    const goal = target > 0 ? target : 50;
    students.forEach(s => {
      s.perfRaw = Math.round(s.perfRaw * 10) / 10;
      s.performance = Math.max(0, Math.min(100, Math.round(s.perfRaw / goal * 1000) / 10));
    });

    return { matched, unmatched: [...unmatched] };
  }

  /**
   * 抓「刷題紀錄」分頁：一列一次交卷，只取座號／姓名／得分三欄。
   *
   * 分頁不存在時 gviz 會默默退回第一個分頁（也就是學員總表），
   * 那時 C/D/F 會撈到組別、頭像、作業2 這種完全無關的值 ——
   * 所以先認表頭有沒有「得分」，不對就當作沒有這個分頁，回空陣列。
   */
  async function fetchQuizLog(rawId, sheetName) {
    const id = parseId(rawId);
    if (!id) throw new Error('無法辨識試算表連結');

    const rows = await fetchRows(id, sheetName, 'select C,D,F');   // 座號 / 姓名 / 得分
    if (rows.length < 2 || !rows[0].some(h => h.includes('得分'))) return [];

    return rows.slice(1).map(r => {
      const name = (r[1] ?? '').trim();
      const score = parseFloat(String(r[2] ?? '').replace(/[^\d.\-]/g, ''));
      if (!name || !isFinite(score)) return null;
      return { seat: (r[0] ?? '').trim(), name, score: Math.max(0, Math.min(100, score)) };
    }).filter(Boolean);
  }

  /**
   * 把刷題紀錄併進學員資料：練了幾次、平均幾分、最佳幾分。
   * 平均得分就是能力三角第三軸的值 —— 練習次數不用，那個已經
   * 透過「每練一次 +0.5」計進活躍度了，再畫一次等於同一件事畫兩遍。
   * @returns {number} 有練過的人數
   */
  function applyQuizLog(students, log) {
    const { byName, bySeat } = indexStudents(students);
    const scores = new Map(students.map(s => [s, []]));

    log.forEach(e => {
      const s = matchStudent(byName, bySeat, e.name, e.seat);
      if (s) scores.get(s).push(e.score);
    });

    students.forEach(s => {
      const list = scores.get(s);
      s.quizTimes = list.length;             // null/undefined 代表這次沒讀到刷題資料
      s.quizAvg   = avg(list);
      s.quizBest  = list.length ? Math.max(...list) : 0;
    });

    return students.filter(s => s.quizTimes > 0).length;
  }

  /**
   * 抓「回合紀錄」分頁，還原成網頁用的 history 陣列。
   *
   * 這是回合紀錄的唯一真相 —— 以前存在瀏覽器的 localStorage，換一台裝置就看不到、
   * 清快取就整季消失。分頁不存在時 gviz 會退回第一個分頁，所以一樣先認表頭。
   *
   * 學員 id 是網頁依姓名即時算出來的，不寫進試算表；讀回來時用姓名／座號對回目前名單，
   * 這樣試算表插入、搬動列，或之後改了 id 算法，舊回合都還掛得回去。
   *
   * 回 null 與回 [] 是兩件事，呼叫端要分開處理：
   *   null —— 分頁根本不存在（還沒存過任何回合）→ 沿用瀏覽器本機既有的
   *   []   —— 分頁在，但裡面被清空了（老師把回合刪掉重來）→ 本機也要跟著清掉
   *
   * @returns {?Array} [{ t, label, ranks:{id:rank}, totals:{id:number}, champion }]，依回合由舊到新
   */
  async function fetchSnapshots(rawId, sheetName, students) {
    const id = parseId(rawId);
    if (!id) throw new Error('無法辨識試算表連結');

    const rows = await fetchRows(id, sheetName);
    // 分頁不存在時 gviz 會退回第一個分頁，認表頭才分得出來
    if (!rows.length || !rows[0].some(h => h.includes('名次'))) return null;
    if (rows.length < 2) return [];

    const idx = mapWith(rows[0], SNAP_ALIASES);
    const { byName, bySeat } = indexStudents(students);
    const pick = (r, i) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const rounds = new Map();

    rows.slice(1).forEach(r => {
      const no = parseInt(pick(r, idx.round), 10);
      const rank = parseInt(pick(r, idx.rank), 10);
      const s = matchStudent(byName, bySeat, pick(r, idx.name), pick(r, idx.seat));
      if (!isFinite(no) || !isFinite(rank) || !s) return;   // 已離班的人就跳過那一列

      if (!rounds.has(no)) rounds.set(no, {
        t: Date.parse(pick(r, idx.time).replace(' ', 'T')) || Date.now(),
        label: pick(r, idx.label) || `第 ${no} 回合`,
        ranks: {}, totals: {}, champion: null
      });

      const h = rounds.get(no);
      h.ranks[s.id] = rank;
      h.totals[s.id] = parseFloat(pick(r, idx.total)) || 0;
      if (pick(r, idx.champion)) h.champion = s.id;
    });

    return [...rounds.keys()].sort((a, b) => a - b).map(no => rounds.get(no));
  }

  const TEMPLATE_HEADER = '座號\t姓名\t組別\t單位\t頭像\t實習1\t實習2\t實習3\t考試成績';
  const LOG_TEMPLATE_HEADER = '日期\t堂次\t學員\t加減分\t事由\t老師';

  /** 17 人示範資料，讓沒接試算表時也能立刻看到效果 */
  function demoStudents() {
    const names = ['陳彥廷','林佳蓉','黃冠宇','張雅婷','李承翰','吳思妤','王柏叡','劉宜靜','蔡孟儒',
                   '鄭雅文','許家豪','謝欣怡','洪志明','曾郁涵','邱建華','周美玲','潘冠霖'];
    const teams = ['雷霆隊','疾風隊','烈焰隊','曜石隊'];
    const units = ['台北營運處','新北營運處','桃園營運處','基隆營運處'];
    return names.map((name, i) => {
      const assignments = HW_LABELS.map(label => ({ label, score: Math.round(58 + Math.random() * 42) }));
      return {
        id: `s_demo_${i}`,
        name,
        seat: String(i + 1).padStart(2, '0'),
        team: teams[i % 4],
        unit: units[(i + 1) % 4],
        avatar: FALLBACK_AVATARS[i % FALLBACK_AVATARS.length],
        assignments,
        quality:     avg(assignments.map(a => a.score)),
        performance: Math.round(58 + Math.random() * 42),
        exam:        Math.round(52 + Math.random() * 48)
      };
    });
  }

  return { fetchStudents, fetchPerfLog, applyPerfLog, fetchQuizLog, applyQuizLog,
           fetchSnapshots, parseId, parseCSV, rowsToStudents,
           fetchRows, demoStudents, TEMPLATE_HEADER, LOG_TEMPLATE_HEADER };
})();

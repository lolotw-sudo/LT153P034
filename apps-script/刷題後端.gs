/**
 * 客網新進人員訓練班第034期 — 刷題練習後端
 * ============================================================
 * 部署一次即可，之後改題目只要改試算表，不用重新部署。
 *
 * 【設定步驟】
 *   1. 打開你的班級試算表 → 擴充功能 → Apps Script
 *   2. 把本檔全部內容貼進去，覆蓋原本的 myFunction
 *   3. 先執行一次 setup（上方函式選 setup → 執行），會自動建好
 *      「題庫」與「刷題紀錄」兩個分頁，並把設定檢查結果印在執行紀錄
 *   4. 把題庫貼進「題庫」分頁（第一列是欄位名，不要刪）
 *   5. 右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *        執行身分：我
 *        誰可以存取：任何人          ← 一定要選這個，學員才連得上
 *      按「部署」後複製那串 /exec 結尾的網址
 *   6. 把網址填進網站 index.html 的 ARENA_CONFIG.quizApi
 *
 * 【改了本檔之後要怎麼更新】
 *   走「部署 → 管理部署作業 → 鉛筆(編輯) → 版本選『新版本』→ 部署」。
 *   不要按「新增部署作業」—— 那會給一組新網址，index.html 裡的舊網址就失效了。
 *   更新完把 /exec 網址貼到瀏覽器，看到 ok:true 就成功。
 *
 * 【整個專案只能有這一份程式碼】
 *   Apps Script 會把同專案裡所有 .gs 當成一份程式碼看，所以不要把本檔
 *   複製成第二個檔案 —— CONFIG、doGet、doPost 會重複宣告，整支後端會掛掉。
 *   要更新就覆蓋原本那個檔，不要新增。
 *
 * 【這支後端負責什麼】
 *   兩個寫入動作：
 *     submit   —— 交卷：對答案、寫刷題紀錄、加互動成績分
 *     snapshot —— 老師按「存檔回合」：把全班當下的名次寫進「回合紀錄」分頁
 *   讀取（題目、剩餘次數、回合紀錄）都由網頁直接讀試算表（gviz），不經過這裡 ——
 *   Apps Script 網頁應用程式約每四次會有一次回 404，用得越少越穩。
 *
 * 【為什麼答案不會外流】
 *   網頁讀題庫時只取到題目與選項那幾欄，讀不到「正確答案」欄，
 *   對答案是在這支後端做的。學員按 F12 看原始碼也看不到答案。
 */

const CONFIG = {
  BANK_TAB:  '題庫',        // 題庫分頁名
  LOG_TAB:   '刷題紀錄',     // 每次交卷寫一列（本檔自動建立）
  SNAP_TAB:  '回合紀錄',     // 老師按「存檔回合」時寫入（本檔自動建立）
  PERF_TAB:  '表現紀錄',     // 互動成績的加減分流水帳（沿用現有分頁）
  ROSTER_TAB: '',           // 學員總表分頁名；留空＝第一個分頁

  QUESTIONS_PER_ROUND: 10,  // 每回合抽幾題
  DAILY_LIMIT: 3,           // 一天幾次機會
  POINTS_PER_PRACTICE: 0.5, // 每練習一次，互動成績加幾分（一天三次＝最多 1.5 分）

  PERF_ITEM: '刷題練習',
  PERF_TEACHER: '系統',
  TZ: 'Asia/Taipei',

  // 老師的測試帳號：不用在學員名單裡，交卷會照常對答案，
  // 但兩張紀錄表都不寫（所以不佔次數、不加分、不污染成績）。
  // 要跟前端 js/quiz.js 的 TEST_USER.name 完全一致。
  TEST_USER: 'LOLO老師',
};

const LOG_HEADER  = ['時間', '日期', '座號', '姓名', '科目', '得分', '答對', '題數', '用時(秒)', '今日第幾次', '回合編號'];
const BANK_HEADER = ['科目', '題號', '主題', '題目', '選項A', '選項B', '選項C', '選項D', '正確答案', '講義出處'];
const PERF_HEADER = ['日期', '堂次', '學員', '加減分', '事由', '老師'];
const SNAP_HEADER = ['時間', '回合', '標籤', '座號', '姓名', '名次', '累積總分', '冠軍', '存檔編號'];


/* ── 對外入口 ───────────────────────────────────────── */

/**
 * 網頁只有「交卷」會呼叫本後端（走 doPost）。
 * doGet 留著當健康檢查用：部署完把 /exec 網址貼到瀏覽器，
 * 看到 ok:true 就表示部署成功。
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'status') return json(statusOf(param(e, 'name')));
    return json({
      ok: true, service: '刷題後端',
      題庫題數: readBank().length,
      每回合題數: CONFIG.QUESTIONS_PER_ROUND,
      每日次數: CONFIG.DAILY_LIMIT,
      每次加分: CONFIG.POINTS_PER_PRACTICE,
      時間: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'),
    });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'submit')   return json(submitRound(body));
    if (body.action === 'snapshot') return json(saveSnapshot(body));
    return json({ ok: false, error: '不認得的 action' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

const param = (e, k) => String((e && e.parameter && e.parameter[k]) || '').trim();

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}


/* ── 三個動作 ───────────────────────────────────────── */

/** 查某人今天還剩幾次 */
function statusOf(name) {
  if (!name) return { ok: false, error: '請先選擇你的名字' };
  if (!inRoster(name)) return { ok: false, error: `學員名單裡找不到「${name}」，請重新選擇` };

  const used = usedToday(name);
  return {
    ok: true, name,
    used, limit: CONFIG.DAILY_LIMIT,
    remaining: Math.max(0, CONFIG.DAILY_LIMIT - used),
    pointsPerPractice: CONFIG.POINTS_PER_PRACTICE,
  };
}

/**
 * 交卷：後端對答案、寫紀錄、加互動分。
 * body = { name, seat, answers:[{key, pick}], seconds }
 *   pick = 學員選的選項在 options 裡的索引（0–3），沒作答填 -1
 */
function submitRound(body) {
  const name = String(body.name || '').trim();
  const st = statusOf(name);
  if (!st.ok) return st;

  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!answers.length) return { ok: false, error: '沒有收到作答內容' };

  // 併發保護：兩個分頁要嘛都寫成功，要嘛都不寫，也避免同時交卷把次數算錯
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: '系統忙碌中，請 3 秒後再按一次交卷' };
  }

  try {
    // 網路不穩時同一份卷可能送兩次（Apps Script 偶爾回 404，學員會重按）。
    // 認回合編號：已經記過的就只重算分數給他看，不再寫入、不再加分。
    const roundId = String(body.roundId || '').trim();
    const already = roundId ? roundOf(roundId) : 0;

    const used = usedToday(name);
    if (!already && used >= CONFIG.DAILY_LIMIT)
      return { ok: false, error: `今天的 ${CONFIG.DAILY_LIMIT} 次機會已經用完了`, used, limit: CONFIG.DAILY_LIMIT, remaining: 0 };

    const byKey = {};
    readBank().forEach(q => { byKey[q.key] = q; });

    let correct = 0;
    const detail = answers.map(a => {
      const q = byKey[String(a.key)];
      if (!q) return null;                       // 題庫改過、對不上的題目直接略過
      const pick = Number(a.pick);
      const isRight = pick === q.answerIndex;
      if (isRight) correct++;
      return {
        stem: q.stem, options: q.options,
        pick: isFinite(pick) ? pick : -1,
        answerIndex: q.answerIndex,
        isRight, src: q.src, subject: q.subject,
      };
    }).filter(Boolean);

    if (!detail.length) return { ok: false, error: '這些題目在題庫裡都找不到，請重新開始一次' };

    const total = detail.length;
    const score = Math.round(correct / total * 100);
    const times = already || used + 1;

    if (already) {
      return {
        ok: true, name, score, correct, total, detail,
        used, limit: CONFIG.DAILY_LIMIT,
        remaining: Math.max(0, CONFIG.DAILY_LIMIT - used),
        pointsEarned: CONFIG.POINTS_PER_PRACTICE,
        alreadyRecorded: true,
      };
    }

    // 測試帳號到此為止：分數算給老師看，但兩張表都不寫，所以不佔次數也不加分
    if (isTestUser(name)) {
      return {
        ok: true, name, score, correct, total, detail,
        used: 0, limit: CONFIG.DAILY_LIMIT, remaining: CONFIG.DAILY_LIMIT,
        pointsEarned: 0, test: true,
      };
    }

    const seat = String(body.seat || '').trim();
    const subject = detail.length ? uniq(detail.map(d => d.subject)).join('、') : '';
    const seconds = Math.max(0, Math.round(Number(body.seconds) || 0));

    const now = new Date();
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    tabOf(ss, CONFIG.LOG_TAB, LOG_HEADER).appendRow([
      Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss'),
      Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd'),
      seat, name, subject, score, correct, total, seconds, times, roundId,
    ]);

    // 互動成績：直接寫進現有的「表現紀錄」，網站的計分邏輯完全不用改
    tabOf(ss, CONFIG.PERF_TAB, PERF_HEADER).appendRow([
      Utilities.formatDate(now, CONFIG.TZ, 'M/d'),
      CONFIG.PERF_ITEM,
      seat ? `${seat} ${name}` : name,
      CONFIG.POINTS_PER_PRACTICE,
      `刷題練習 今日第${times}次（答對 ${correct}/${total}）`,
      CONFIG.PERF_TEACHER,
    ]);

    return {
      ok: true, name, score, correct, total, detail,
      used: times, limit: CONFIG.DAILY_LIMIT,
      remaining: Math.max(0, CONFIG.DAILY_LIMIT - times),
      pointsEarned: CONFIG.POINTS_PER_PRACTICE,
    };
  } finally {
    lock.releaseLock();
  }
}


/* ── 試算表存取 ─────────────────────────────────────── */

/** 取分頁；不存在就建一個並寫好表頭 */
function tabOf(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 依表頭名稱找欄位索引，找不到回 -1（欄位順序改了也不會壞） */
function indexOf(header, names) {
  const norm = header.map(h => String(h).trim());
  for (const n of names) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 快取包裝：題庫與名單不會一直變，但 SpreadsheetApp 每次讀都要 1～2 秒。
 * 全班同時刷題時，每個請求都重讀整張表會塞車（症狀是很慢、甚至回 404）。
 * 快取放 6 小時（Google 上限）—— 過期後的第一個請求要重讀試算表，
 * 會慢到可能被 Google 判 404，所以放越久越好，一天大概只有第一次會慢。
 * 改完題目要立刻生效就執行一次 clearCache()。
 */
function cached(key, seconds, fn) {
  const c = CacheService.getScriptCache();
  const hit = c.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* 快取壞了就重讀 */ }
  }
  const val = fn();
  try {
    c.put(key, JSON.stringify(val), seconds);   // 單筆超過 100KB 會丟例外，不快取也能跑
  } catch (e) {
    Logger.log('快取寫入失敗（題庫可能太大）：' + e.message);
  }
  return val;
}

/** 改完題庫想立刻生效就執行這個 */
function clearCache() {
  CacheService.getScriptCache().removeAll(['quizBank', 'quizRoster']);
  Logger.log('✅ 快取已清除，下一次請求會重讀試算表');
}

const CACHE_SECONDS = 21600;   // 6 小時，CacheService 的上限

const readBank   = () => cached('quizBank', CACHE_SECONDS, readBankRaw);
const readRoster = () => cached('quizRoster', CACHE_SECONDS, readRosterRaw);

function readBankRaw() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.BANK_TAB);
  if (!sh) throw new Error(`找不到「${CONFIG.BANK_TAB}」分頁，請先執行一次 setup`);

  const values = sh.getDataRange().getValues();
  if (values.length < 2) throw new Error(`「${CONFIG.BANK_TAB}」分頁沒有題目`);

  const h = values[0];
  const c = {
    subject: indexOf(h, ['科目']), num: indexOf(h, ['題號']), topic: indexOf(h, ['主題']),
    stem: indexOf(h, ['題目']), ans: indexOf(h, ['正確答案']), src: indexOf(h, ['講義出處', '出處']),
    opts: ['選項A', '選項B', '選項C', '選項D'].map(k => indexOf(h, [k])),
  };
  if (c.stem < 0 || c.ans < 0 || c.opts.some(i => i < 0))
    throw new Error('「題庫」分頁的欄位名稱不對，需要：' + BANK_HEADER.join('、'));

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const stem = String(row[c.stem] || '').trim();
    const options = c.opts.map(i => String(row[i] || '').trim());
    const letter = String(row[c.ans] || '').trim().toUpperCase();
    const answerIndex = 'ABCD'.indexOf(letter);

    if (!stem || answerIndex < 0 || options.some(o => !o)) continue;   // 空列與填錯的列跳過

    const subject = String(row[c.subject] || '').trim();
    out.push({
      key: `${subject}#${String(row[c.num] || r).trim()}`,
      subject, stem, options, answerIndex,
      topic: c.topic >= 0 ? String(row[c.topic] || '').trim() : '',
      src:   c.src  >= 0 ? String(row[c.src]  || '').trim() : '',
    });
  }
  return out;
}

/** 學員總表的姓名清單 */
function readRosterRaw() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = CONFIG.ROSTER_TAB ? ss.getSheetByName(CONFIG.ROSTER_TAB) : ss.getSheets()[0];
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const col = indexOf(values[0], ['姓名', '學員', '名字']);
  if (col < 0) return [];

  return values.slice(1)
               .map(r => String(r[col] || '').trim())
               .filter(Boolean);
}

const isTestUser = name => String(name || '').trim() === CONFIG.TEST_USER;
const inRoster = name => isTestUser(name) || readRoster().indexOf(name.trim()) >= 0;

/** 這個回合編號記過了嗎？回傳當時是「今日第幾次」，沒記過回 0 */
function roundOf(roundId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LOG_TAB);
  if (!sh) return 0;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rCol = indexOf(header, ['回合編號']), tCol = indexOf(header, ['今日第幾次']);
  if (rCol < 0) return 0;                       // 舊版表頭沒這欄，就沒有防重複能力

  const rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (let r = rows.length - 1; r >= 0; r--) {  // 從最新的往回找，通常第一筆就中
    if (String(rows[r][rCol] || '').trim() === roundId)
      return Number(rows[r][tCol]) || 1;
  }
  return 0;
}

/**
 * 某人今天已經交了幾次卷。
 * 這個不能快取 —— 它就是每日次數的閘門，讀到舊資料會讓人多練幾次。
 * 但只讀「日期」與「姓名」兩欄，不整張表撈。
 */
function usedToday(name) {
  if (isTestUser(name)) return 0;      // 測試帳號不留紀錄，永遠是 0 次
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LOG_TAB);
  if (!sh) return 0;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const dCol = indexOf(header, ['日期']), nCol = indexOf(header, ['姓名']);
  if (dCol < 0 || nCol < 0) return 0;

  // 只抓涵蓋這兩欄的最小範圍
  const from = Math.min(dCol, nCol), width = Math.abs(dCol - nCol) + 1;
  const rows = sh.getRange(2, from + 1, lastRow - 1, width).getValues();
  const di = dCol - from, ni = nCol - from;

  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const target = name.trim();
  let n = 0;

  for (let r = 0; r < rows.length; r++) {
    const raw = rows[r][di];
    // 日期欄可能被試算表自動轉成日期物件，也可能是純文字，兩種都要認得
    const d = raw instanceof Date
      ? Utilities.formatDate(raw, CONFIG.TZ, 'yyyy-MM-dd')
      : String(raw || '').trim().slice(0, 10);
    if (d === today && String(rows[r][ni] || '').trim() === target) n++;
  }
  return n;
}


/* ── 小工具 ─────────────────────────────────────────── */

/** Fisher-Yates 洗牌（sort(random) 的分布是歪的，別用） */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const uniq = arr => arr.filter((v, i) => arr.indexOf(v) === i);


/* ── 存檔回合 ───────────────────────────────────────── */

/**
 * 老師按「存檔回合」時，把全班當下的名次整批寫進「回合紀錄」分頁，一位學員一列。
 *
 * 為什麼要有 snapId：網頁那端連線失敗會自動重試（Apps Script 約每四次會回一次
 * 404），沒有防重複的話同一次存檔會被寫成兩個回合。所以網頁每次按下按鈕產生一個
 * snapId，這裡先查有沒有寫過，寫過就直接回傳原本的回合編號、不再寫第二次。
 *
 * body = { action, label, snapId, rows: [{ seat, name, rank, total }] }
 */
function saveSnapshot(body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: '沒有可存檔的名次' };

  const snapId = String(body.snapId || '').trim();
  const label = String(body.label || '').trim();

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = tabOf(ss, CONFIG.SNAP_TAB, SNAP_HEADER);

    const done = snapId && roundOfSnap(sh, snapId);
    if (done) return { ok: true, round: done, label, rows: rows.length, duplicated: true };

    const round = nextRound(sh);
    const now = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm:ss');

    sh.getRange(sh.getLastRow() + 1, 1, rows.length, SNAP_HEADER.length).setValues(
      rows.map(r => [
        now, round, label,
        String(r.seat || ''), String(r.name || ''),
        Number(r.rank) || 0, Number(r.total) || 0,
        Number(r.rank) === 1 ? '✔' : '',
        snapId,
      ])
    );

    return { ok: true, round, label, rows: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/** 下一個回合編號＝現有最大值 + 1；表還是空的就從 1 開始 */
function nextRound(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const col = sh.getRange(2, 2, last - 1, 1).getValues();
  return Math.max(0, ...col.map(r => Number(r[0]) || 0)) + 1;
}

/** 這個 snapId 寫過了嗎？寫過就回它的回合編號，沒寫過回 0 */
function roundOfSnap(sh, snapId) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(2, 2, last - 1, SNAP_HEADER.length - 1).getValues();  // 回合 ～ 存檔編號
  const hit = vals.find(r => String(r[SNAP_HEADER.length - 2]).trim() === snapId);
  return hit ? Number(hit[0]) || 0 : 0;
}


/* ── 設定與自我檢查 ─────────────────────────────────── */

/** 部署前先執行這個：建好分頁並檢查設定 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = [];

  const bank = ss.getSheetByName(CONFIG.BANK_TAB);
  if (!bank) {
    tabOf(ss, CONFIG.BANK_TAB, BANK_HEADER);
    log.push(`✅ 已建立「${CONFIG.BANK_TAB}」分頁，請把題庫貼進去（第一列欄位名不要刪）`);
  } else {
    try {
      const n = readBank().length;
      log.push(n ? `✅ 題庫讀到 ${n} 題` : `⚠️ 「${CONFIG.BANK_TAB}」分頁還沒有題目`);
    } catch (e) {
      log.push('❌ 題庫讀取失敗：' + e.message);
    }
  }

  const logSh = tabOf(ss, CONFIG.LOG_TAB, LOG_HEADER);
  const cur = logSh.getRange(1, 1, 1, Math.max(1, logSh.getLastColumn())).getValues()[0]
                   .map(String).join('|');
  if (cur !== LOG_HEADER.join('|')) {
    if (logSh.getLastRow() <= 1) {
      logSh.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]);
      log.push(`✅ 「${CONFIG.LOG_TAB}」表頭已更新為最新版`);
    } else {
      log.push(`⚠️ 「${CONFIG.LOG_TAB}」表頭是舊版但已有資料，請手動在最後補一欄「回合編號」`);
    }
  } else {
    log.push(`✅ 「${CONFIG.LOG_TAB}」分頁就緒`);
  }

  const snap = ss.getSheetByName(CONFIG.SNAP_TAB);
  log.push(snap ? `✅ 找到「${CONFIG.SNAP_TAB}」分頁，存檔回合會寫進這裡`
                : `⚠️ 找不到「${CONFIG.SNAP_TAB}」分頁，第一次存檔回合時會自動建立`);

  const perf = ss.getSheetByName(CONFIG.PERF_TAB);
  log.push(perf ? `✅ 找到「${CONFIG.PERF_TAB}」分頁，互動成績會寫進這裡`
                : `⚠️ 找不到「${CONFIG.PERF_TAB}」分頁，交卷時會自動建立`);

  const roster = CONFIG.ROSTER_TAB ? ss.getSheetByName(CONFIG.ROSTER_TAB) : ss.getSheets()[0];
  log.push(roster ? `✅ 學員總表：「${roster.getName()}」分頁`
                  : '❌ 找不到學員總表分頁');

  log.push(`— 設定：每回合 ${CONFIG.QUESTIONS_PER_ROUND} 題、一天 ${CONFIG.DAILY_LIMIT} 次、每次互動成績 +${CONFIG.POINTS_PER_PRACTICE} 分`);
  log.forEach(l => Logger.log(l));
  return log.join('\n');
}

/** 不部署也能驗證邏輯：假裝有人交了一份全對的卷（會真的寫進試算表） */
function selfTest() {
  const bank = readBank();
  if (!bank.length) throw new Error('題庫是空的');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = CONFIG.ROSTER_TAB ? ss.getSheetByName(CONFIG.ROSTER_TAB) : ss.getSheets()[0];
  const values = sh.getDataRange().getValues();
  const nameCol = indexOf(values[0], ['姓名', '學員', '名字']);
  const who = String(values[1][nameCol]).trim();

  Logger.log('用「%s」測試：%s', who, JSON.stringify(statusOf(who)));

  const picked = shuffle(bank.slice()).slice(0, CONFIG.QUESTIONS_PER_ROUND);
  const res = submitRound({
    name: who, seat: '',
    answers: picked.map(q => ({ key: q.key, pick: q.answerIndex })),   // 全部答對
    seconds: 42,
    roundId: 'selftest_' + Date.now(),
  });
  Logger.log('交卷結果：得分 %s，答對 %s/%s，剩餘次數 %s',
             res.score, res.correct, res.total, res.remaining);
  Logger.log('（這筆測試紀錄會留在「%s」與「%s」分頁，記得手動刪掉）',
             CONFIG.LOG_TAB, CONFIG.PERF_TAB);
  return res;
}

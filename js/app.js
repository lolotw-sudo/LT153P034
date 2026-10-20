/* ============================================================
   app.js — 啟動、事件綁定、資料流
   ============================================================ */

(() => {
  const $  = UI.$;
  const $$ = UI.$$;
  const S  = () => Store.state;
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let rows = [];
  let autoTimer = null;

  /* ── 重新計算並重繪 ───────────────────────────────── */

  function refresh() {
    const st = S();
    rows = Scoring.buildBoard(st.students, st.weights, st.history);

    UI.setCardData(rows);
    UI.renderBoard(rows, st.options);
    UI.renderSnapshots();

    $('#className').textContent = st.className || '客網新進人員訓練班第034期';
    $('#seasonLabel').textContent = st.history.length
      ? `第 ${st.history.length} 回合已存檔`
      : '賽季進行中';
    renderWeightMini();
    renderGrades();
    Quiz.setStudents(st.students);
  }

  /** 學期成績清單：期末要輸入學習系統的 0–100 分，只在設定頁出現 */
  function renderGrades() {
    const el = $('#gradeTable');
    if (!el) return;
    const list = [...rows].sort((a, b) =>
      (a.seat || '').localeCompare(b.seat || '', 'zh-Hant', { numeric: true }) ||
      a.name.localeCompare(b.name, 'zh-Hant'));

    el.innerHTML = `
      <thead><tr><th>座號</th><th>姓名</th><th>作業</th><th>活躍度</th><th>終極考驗</th><th>學期成績</th></tr></thead>
      <tbody>${list.map(r => `
        <tr>
          <td>${esc(r.seat || '')}</td>
          <td>${esc(r.name)}</td>
          <td>${r.quality}</td>
          <td>${r.performance}</td>
          <td>${r.exam}</td>
          <td class="grade-cell">${r.grade.toFixed(1)}</td>
        </tr>`).join('')}</tbody>`;
  }

  /** 複製成 TSV，可直接貼進試算表或學習系統 */
  function gradesTSV() {
    const list = [...rows].sort((a, b) =>
      (a.seat || '').localeCompare(b.seat || '', 'zh-Hant', { numeric: true }) ||
      a.name.localeCompare(b.name, 'zh-Hant'));
    return ['座號\t姓名\t學期成績',
      ...list.map(r => `${r.seat || ''}\t${r.name}\t${r.grade.toFixed(1)}`)].join('\n');
  }

  /** 排位榜三條進度條的圖例；第三條跟能力三角同一個維度 */
  function renderWeightMini() {
    const hasQuiz = S().students.some(s => s.quizTimes != null);
    $('#weightMini').innerHTML = `
      <span><i class="dot dot-q"></i>作業</span>
      <span><i class="dot dot-p"></i>活躍度</span>
      ${hasQuiz ? `<span><i class="dot dot-z"></i>刷題均分</span>`
                : `<span><i class="dot dot-e"></i>終極考驗</span>`}`;
  }

  /* ── 同步試算表 ───────────────────────────────────── */

  async function sync(silent = false) {
    const st = S();
    if (!st.sheetId) {
      if (!silent) {
        FX.toast('請先到「設定」貼上 Google 試算表連結', 'err');
        switchView('settings');
      }
      return;
    }

    setSyncStatus('同步中…', 'sync-busy');
    $('#btnSync').disabled = true;

    try {
      const students = await Sheet.fetchStudents(st.sheetId, st.sheetName);

      // 表現紀錄是選配的第二個分頁：讀不到只降級成「表現 0 分」，不讓整次同步失敗
      let note = '';
      if (st.logSheetName) {
        try {
          const log = await Sheet.fetchPerfLog(st.sheetId, st.logSheetName);
          const { matched, unmatched } = Sheet.applyPerfLog(students, log, st.perfTarget);
          note = `<br>📋 表現紀錄 ${matched} 筆已計入（滿分目標 ${st.perfTarget} 分）。`;
          if (unmatched.length)
            note += `<br>⚠️ 有 ${unmatched.length} 個名字對不到學員，這些分數<b>沒有被計算</b>：${unmatched.map(esc).join('、')}`;
        } catch (e) {
          console.warn('[sync] 表現紀錄', e);
          note = `<br>⚠️ 讀不到「${esc(st.logSheetName)}」分頁（${esc(e.message)}）；`
               + `活躍度這次改用總表的欄位，加減分沒有計入。`;
        }
      }

      // 刷題紀錄同樣是選配分頁：讀得到才把能力三角的第三軸換成刷題練習，
      // 讀不到就整段跳過，雷達圖自動退回顯示終極考驗。
      try {
        const quizTab = (window.ARENA_CONFIG || {}).quizLogSheet || '刷題紀錄';
        const quizLog = await Sheet.fetchQuizLog(st.sheetId, quizTab);
        if (quizLog.length) {
          const practiced = Sheet.applyQuizLog(students, quizLog);
          note += `<br>🎯 刷題紀錄 ${quizLog.length} 筆已計入能力三角（${practiced} 人練過）。`;
        }
      } catch (e) {
        console.warn('[sync] 刷題紀錄', e);
      }

      // 回合紀錄：試算表是唯一真相，讀得到就完全以它為準 —— 包含「被清空」也算數，
      // 老師把回合刪掉重來時，本機要跟著清掉，不然這台會一直顯示已經刪掉的回合。
      // 只有分頁不存在（回 null）或連線失敗時，才沿用這台瀏覽器既有的。
      let history = st.history;
      try {
        const snapTab = (window.ARENA_CONFIG || {}).snapshotSheet || '回合紀錄';
        const remote = await Sheet.fetchSnapshots(st.sheetId, snapTab, students);
        if (remote) {
          history = remote;
          note += remote.length
            ? `<br>📌 回合紀錄 ${remote.length} 個回合已從試算表讀入。`
            : `<br>📌 「${esc(snapTab)}」分頁目前沒有任何回合，名次變化會顯示 NEW。`;
        }
      } catch (e) {
        console.warn('[sync] 回合紀錄', e);
      }

      Store.set({ students, history, lastSync: Date.now() });
      refresh();
      Log.invalidate();
      setSyncStatus(`已同步 ${timeStr(Date.now())}`, 'sync-ok');
      setSheetStatus(`✅ 讀到 ${students.length} 位學員。${note}`, note.includes('⚠️') ? '' : 'ok');
      if (!silent) FX.toast(`已從試算表讀入 ${students.length} 位學員`, 'ok');
    } catch (err) {
      console.error('[sync]', err);
      setSyncStatus('同步失敗', 'sync-err');
      setSheetStatus(`❌ ${err.message}<br>檢查：試算表共用權限是否為「知道連結的任何人 → 檢視者」、分頁名稱是否正確。`, 'err');
      if (!silent) FX.toast(`同步失敗：${err.message}`, 'err');
    } finally {
      $('#btnSync').disabled = false;
    }
  }

  function setSyncStatus(text, cls) {
    const el = $('#syncStatus');
    el.textContent = text;
    el.className = cls || '';
  }

  function setSheetStatus(html, cls) {
    const el = $('#sheetStatus');
    el.innerHTML = html;
    el.className = 'callout ' + (cls || '');
  }

  const timeStr = t => new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

  function setAutoSync(on) {
    clearInterval(autoTimer);
    autoTimer = null;
    if (on) autoTimer = setInterval(() => sync(true), 60000);
  }

  /* ── 回合存檔 ─────────────────────────────────────── */

  let snapping = false;

  /**
   * 存檔回合：把全班當下的名次寫進試算表的「回合紀錄」分頁。
   *
   * 以前只存在 localStorage，換一台裝置就看不到、清快取就整季消失；
   * 學員手機上永遠是空的，所以他們看到的名次變化一直是 NEW。
   * 沒設定後端網址時才退回只存本機，並在提示裡講明白。
   */
  async function snapshot() {
    if (!rows.length) { FX.toast('沒有資料可以存檔', 'err'); return; }
    if (snapping) return;

    // 回合是全班共用的，學員手癢按一下會把所有人的「本回合變化」洗掉
    if (lockEnabled() && !unlocked) {
      FX.toast('存檔回合是老師的動作，請先到「設定」解鎖', 'err');
      switchView('settings');
      return;
    }

    const st = S();
    const label = `第 ${st.history.length + 1} 回合 · ${new Date().toLocaleDateString('zh-TW')}`;
    const snap = {
      t: Date.now(), label,
      ranks:  Object.fromEntries(rows.map(r => [r.id, r.rank])),
      totals: Object.fromEntries(rows.map(r => [r.id, r.total])),
      champion: rows[0].id
    };

    const keepLocally = msg => {
      st.history.push(snap);
      Store.save();
      refresh();
      FX.toast(msg, 'ok');
    };

    if (!(window.ARENA_CONFIG || {}).quizApi) {
      keepLocally(`📌 ${label} 已存檔（沒設定後端網址，只存在這台裝置）`);
      return;
    }

    snapping = true;
    $('#btnSnapshot').disabled = true;
    try {
      // snapId 讓後端擋掉重試造成的重複寫入（Apps Script 約每四次會回一次 404）
      await Quiz.call('snapshot', null, {
        label,
        snapId: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        rows: rows.map(r => ({ seat: r.seat, name: r.name, rank: r.rank, total: r.total }))
      });
      keepLocally(`📌 ${label} 已存進試算表，全班都看得到`);
    } catch (e) {
      console.error('[snapshot]', e);
      FX.toast(`存檔失敗，沒有寫進試算表：${e.message}`, 'err');
    } finally {
      snapping = false;
      $('#btnSnapshot').disabled = false;
    }
  }

  /* ── 分頁切換 ─────────────────────────────────────── */

  const VIEW_NAMES = { solo: '個人榜', schedule: '課程表', log: '賽季日誌', quiz: '刷題', settings: '設定' };

  // 流量統計：每切一次分頁送一筆 page_view。沒設定 Firebase 時 Track 是空殼，什麼都不做。
  const trackView = name => Track('page_view', {
    page_title: VIEW_NAMES[name] || name,
    page_location: location.href.split('#')[0] + '#' + name
  });

  function switchView(name) {
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === `view-${name}`));
    if (name === 'settings') applyLockState();
    if (name === 'quiz') Quiz.onEnter();
    if (name === 'log') Log.onEnter();
    if (name === 'schedule') Log.loadSchedule();
    trackView(name);
  }

  /* ── 設定鎖 ───────────────────────────────────────────
     純前端的「防手癢」鎖：沒有伺服器可以驗證密碼，懂開發者工具的人
     可以繞過。目的是避免共用電腦或投影機上有人隨手改到設定。
     解鎖狀態存在 sessionStorage，關掉瀏覽器就自動恢復鎖定。
     ─────────────────────────────────────────────────── */

  const UNLOCK_KEY = 'LT153P034.unlocked';
  let unlocked = false;

  const lockHash = () => (window.ARENA_CONFIG && window.ARENA_CONFIG.settingsPasswordHash) || '';
  const lockEnabled = () => lockHash().length > 0;

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function applyLockState() {
    const locked = lockEnabled() && !unlocked;
    $('#settingsLock').hidden = !locked;
    $('#settingsWrap').hidden = locked;
    $('#relockRow').hidden = !lockEnabled() || locked;
    if (locked) $('#lockInput').value = '';
  }

  function setUnlocked(on) {
    unlocked = on;
    try {
      if (on) sessionStorage.setItem(UNLOCK_KEY, '1');
      else sessionStorage.removeItem(UNLOCK_KEY);
    } catch (e) { /* 無痕模式可能不給寫，忽略 */ }
    applyLockState();
  }

  async function tryUnlock(e) {
    e.preventDefault();
    const msg = $('#lockMsg');
    const input = $('#lockInput').value;

    if (!input) { msg.textContent = '請輸入密碼。'; msg.className = 'lock-msg err'; return; }

    if (!window.crypto || !crypto.subtle) {
      msg.textContent = '這個瀏覽器不支援密碼驗證，請改用 https 網址開啟。';
      msg.className = 'lock-msg err';
      return;
    }

    if (await sha256(input) === lockHash()) {
      msg.textContent = '';
      setUnlocked(true);
      FX.toast('🔓 設定已解鎖', 'ok');
    } else {
      msg.textContent = '密碼不對，再試一次。';
      msg.className = 'lock-msg err';
      $('#lockInput').value = '';
      $('#lockInput').focus();
    }
  }

  /* ── 權重滑桿 ─────────────────────────────────────── */

  function bindWeights() {
    $$('.weight-row').forEach(row => {
      const key = row.dataset.key;
      const input = row.querySelector('input');
      const out = row.querySelector('output');

      input.value = S().weights[key];
      const sync = () => {
        S().weights[key] = Number(input.value);
        Store.save();
        updateWeightOutputs();
        refresh();
      };
      input.addEventListener('input', sync);
    });
    updateWeightOutputs();
  }

  function updateWeightOutputs() {
    const w = S().weights;
    $$('.weight-row').forEach(row => {
      const key = row.dataset.key;
      row.querySelector('input').value = w[key];
      row.querySelector('output').textContent = w[key] + ' 分';
    });
    const sum = w.quality + w.performance + w.exam;
    const el = $('#weightSum');
    if (el) {
      el.textContent = `滿分合計 ${sum} 分`;
      el.className = sum === 100 ? 'hint ok' : 'hint warn';
    }
  }

  function applyPreset(str) {
    const [q, p, e] = str.split(',').map(Number);
    S().weights = { quality: q, performance: p, exam: e };
    Store.save();
    updateWeightOutputs();
    refresh();
  }

  /* ── 匯出 / 匯入 ──────────────────────────────────── */

  function exportBackup() {
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `training-arena-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    FX.toast('備份已下載', 'ok');
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.students)) throw new Error('檔案格式不正確');
        Store.replaceAll(data);
        hydrateSettings();
        refresh();
        FX.toast('備份已還原', 'ok');
      } catch (e) {
        FX.toast(`匯入失敗：${e.message}`, 'err');
      }
    };
    reader.readAsText(file);
  }

  /* ── 把 state 填回設定畫面 ────────────────────────── */

  function hydrateSettings() {
    const st = S();
    $('#sheetUrl').value = st.sheetId;
    $('#sheetName').value = st.sheetName;
    $('#logSheetName').value = st.logSheetName;
    $('#perfTarget').value = st.perfTarget;
    $('#classNameInput').value = st.className;
    $('#autoSync').checked = st.autoSync;
    $('#optAnim').checked = st.options.anim;
    $('#optSound').checked = st.options.sound;
    $('#optBlind').checked = st.options.blind;

    FX.setAnim(st.options.anim);
    FX.setSound(st.options.sound);
    updateWeightOutputs();
    setAutoSync(st.autoSync);
  }

  /* ── 事件綁定 ─────────────────────────────────────── */

  function bindEvents() {
    $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

    $('#btnSync').addEventListener('click', () => sync());
    $('#btnSnapshot').addEventListener('click', snapshot);
    $('#btnCeremony').addEventListener('click', () => Ceremony.open(rows));

    $('#btnSaveSheet').addEventListener('click', () => {
      const id = Sheet.parseId($('#sheetUrl').value);
      if (!id) { setSheetStatus('❌ 這不像是 Google 試算表連結，請貼上瀏覽器網址列的完整連結。', 'err'); return; }
      const target = parseFloat($('#perfTarget').value);
      Store.set({
        sheetId: id,
        sheetName: $('#sheetName').value.trim(),
        logSheetName: $('#logSheetName').value.trim(),
        perfTarget: isFinite(target) && target > 0 ? target : 70
      });
      $('#sheetUrl').value = id;
      $('#perfTarget').value = S().perfTarget;
      sync();
    });

    $('#autoSync').addEventListener('change', e => {
      Store.set({ autoSync: e.target.checked });
      setAutoSync(e.target.checked);
      FX.toast(e.target.checked ? '已開啟自動同步（每 60 秒）' : '已關閉自動同步');
    });

    $('#btnCopyTemplate').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(Sheet.TEMPLATE_HEADER);
        FX.toast('表頭已複製，貼到試算表第一列即可', 'ok');
      } catch {
        setSheetStatus(`手動複製這一列到試算表第一列：<br><code>${Sheet.TEMPLATE_HEADER.replace(/\t/g, ' | ')}</code>`);
      }
    });

    $('#btnCopyLogTemplate').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(Sheet.LOG_TEMPLATE_HEADER);
        FX.toast('表頭已複製，貼到「表現紀錄」分頁第一列', 'ok');
      } catch {
        setSheetStatus(`手動複製這一列到「表現紀錄」分頁第一列：<br><code>${Sheet.LOG_TEMPLATE_HEADER.replace(/\t/g, ' | ')}</code>`);
      }
    });

    $('#btnCopyGrades').addEventListener('click', async () => {
      if (!rows.length) { FX.toast('還沒有學員資料', 'err'); return; }
      try {
        await navigator.clipboard.writeText(gradesTSV());
        FX.toast(`已複製 ${rows.length} 位學員的成績，可直接貼上`, 'ok');
      } catch {
        FX.toast('瀏覽器不允許複製，請直接從表格選取', 'err');
      }
    });

    $('#btnLoadDemo').addEventListener('click', () => {
      Store.set({ students: Sheet.demoStudents() });
      refresh();
      switchView('solo');
      FX.toast('已載入 17 人示範資料', 'ok');
    });

    $('#classNameInput').addEventListener('input', e => {
      Store.set({ className: e.target.value });
      $('#className').textContent = e.target.value || '客網新進人員訓練班第034期';
    });

    $('#optAnim').addEventListener('change', e => {
      S().options.anim = e.target.checked; Store.save(); FX.setAnim(e.target.checked);
    });
    $('#optSound').addEventListener('change', e => {
      S().options.sound = e.target.checked; Store.save(); FX.setSound(e.target.checked);
    });
    $('#optBlind').addEventListener('change', e => {
      S().options.blind = e.target.checked; Store.save(); refresh();
    });

    $$('[data-preset]').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

    $('#btnExport').addEventListener('click', exportBackup);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); });
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('確定要清除所有本機資料嗎？包含試算表設定與所有回合紀錄，這個動作無法復原。')) return;
      Store.reset();
      hydrateSettings();
      refresh();
      setSheetStatus('');
      setSyncStatus('尚未同步', '');
      FX.toast('已清除本機資料');
    });

    $('#lockForm').addEventListener('submit', tryUnlock);
    $('#btnRelock').addEventListener('click', () => {
      setUnlocked(false);
      FX.toast('🔒 設定已重新鎖定');
    });

    $('#drawerClose').addEventListener('click', UI.closeCard);
    $('#drawerScrim').addEventListener('click', UI.closeCard);

    $('#cNext').addEventListener('click', () => Ceremony.next());
    $('#cPrev').addEventListener('click', () => Ceremony.prev());
    $('#cAuto').addEventListener('click', () => Ceremony.toggleAuto());
    $('#cExit').addEventListener('click', () => Ceremony.close());

    document.addEventListener('keydown', e => {
      if (Ceremony.handleKey(e)) return;
      if (Quiz.handleKey(e)) return;
      if (e.target.matches('input, textarea')) return;

      switch (e.key.toLowerCase()) {
        case 'escape': UI.closeCard(); break;
        case 'r': sync(); break;
        case 's': snapshot(); break;
        case 'c': Ceremony.open(rows); break;
        case '1': switchView('solo'); break;
        case '2': switchView('schedule'); break;
        case '3': switchView('log'); break;
        case '4': switchView('quiz'); break;
        case '5': switchView('settings'); break;
      }
    });
  }

  /* ── 啟動 ─────────────────────────────────────────── */

  function init() {
    FX.startBackground(document.getElementById('bgCanvas'));
    FX.initConfetti(document.getElementById('fxCanvas'));

    try { unlocked = sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { unlocked = false; }

    hydrateSettings();
    bindWeights();
    bindEvents();
    Log.initWall();
    applyLockState();
    refresh();
    // 開訓前先讓學員看課程表；開訓當天起自動換回個人榜在前
    const start = (window.ARENA_CONFIG || {}).courseStart;
    if (start && Date.now() < new Date(`${start}T00:00:00+08:00`)) {
      const tab = $('.tab[data-view="schedule"]');
      tab.parentNode.prepend(tab);
      switchView('schedule');
    } else {
      trackView('solo');   // 開頁時畫面本來就停在個人榜，這筆要自己記
    }

    const st = S();
    if (st.lastSync) setSyncStatus(`上次同步 ${timeStr(st.lastSync)}`, '');

    if (st.sheetId) {
      sync(true);
    } else if (!st.students.length) {
      // 第一次打開就有東西可看，不會是一片空白
      Store.set({ students: Sheet.demoStudents() });
      refresh();
      setSheetStatus('目前顯示的是示範資料。貼上你的 Google 試算表連結後按「儲存並同步」就會換成真實班級。');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

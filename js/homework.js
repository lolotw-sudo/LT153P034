/* ============================================================
   homework.js — 交作業（學員個人頁）與作業批改（設定頁）
   繳交紀錄讀試算表「作業繳交」分頁（gviz）；上傳與評分走刷題後端（Quiz.call）。
   檔案存在老師的 Drive，不公開 —— 只有老師點得開，學員只看得到檔名與狀態。
   ============================================================ */

const Homework = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cfg = () => window.ARENA_CONFIG || {};

  const ITEMS = ['作業1', '作業2'];      // 要跟後端 CONFIG.HW_ITEMS 一致
  const MAX_MB = 20;                     // 要跟後端 CONFIG.HW_MAX_MB 一致
  const KEY_STORE = 'LT153P034.hwKey';   // 老師密碼只記在這個分頁（關掉瀏覽器就忘）

  let rows = [];         // [{ name, item, time, file, fileId, score, comment }]
  let sortBy = 'name';   // 批改表的排序：name＝依姓名、item＝依作業
  let loaded = false;

  async function load() {
    const id = Sheet.parseId(cfg().sheetId);
    if (!id) return;
    // 讀失敗就丟出去，不要把「讀不到」當成「沒人交」—— 學員會以為沒交成功
    const data = await Sheet.fetchRows(id, cfg().hwSheet || '作業繳交');
    // 分頁還不存在時 gviz 會退回第一個分頁 —— 表頭沒有「檔案ID」就當作還沒人交
    const head = data && data[0] ? data[0].map(h => String(h).trim()) : [];
    const col = n => head.indexOf(n);
    rows = col('檔案ID') < 0 ? [] : data.slice(1).map(r => ({
      name: r[col('姓名')] || '', item: r[col('作業')] || '', time: r[col('繳交時間')] || '',
      file: r[col('檔名')] || '', fileId: r[col('檔案ID')] || '',
      score: r[col('分數')] || '', comment: r[col('評語')] || ''
    })).filter(r => r.name && r.item);
    loaded = true;
  }

  const find = (name, item) => rows.find(r => r.name === name && r.item === item);

  /** 後端回來的結果直接蓋進本機資料（gviz 會晚幾秒才看得到新的一列） */
  function upsert(rec) {
    const old = find(rec.name, rec.item);
    old ? Object.assign(old, rec) : rows.push(rec);
  }

  /* ── 學員：個人頁裡的交作業 ─────────────────────── */

  async function mount(name) {
    const box = $('#hwBox');
    if (!box) return;
    if (!cfg().quizApi) { box.innerHTML = '<p class="hint">交作業還沒開放。</p>'; return; }
    box.dataset.name = name;
    if (!loaded) {
      box.innerHTML = '<p class="hint">讀取繳交紀錄中…</p>';
      try { await load(); } catch (e) {
        box.innerHTML = '<p class="hint">讀不到繳交紀錄，請稍後關掉再打開一次。</p>';
        return;
      }
    }
    if (box.isConnected && box.dataset.name === name) render(box, name);
  }

  function render(box, name) {
    box.innerHTML = ITEMS.map(item => {
      const r = find(name, item);
      const graded = r && r.score !== '';
      const status = !r ? '<span class="hw-st">未繳交</span>'
        : graded ? `<span class="hw-st ok">已評分 ${esc(r.score)} 分</span>`
        : '<span class="hw-st wait">已繳交，等待評分</span>';
      return `
        <div class="hw-item">
          <div class="hw-head"><b>${item}</b>${status}</div>
          ${r ? `<p class="hint">📎 ${esc(r.file)}　${esc(r.time)}</p>` : ''}
          ${graded && r.comment ? `<p class="hw-comment">💬 ${esc(r.comment)}</p>` : ''}
          ${graded ? '' : `
            <label class="hw-upload">
              <input type="file" data-item="${item}">
              <span class="btn btn-sm btn-primary">${r ? '重新上傳' : '選擇檔案上傳'}</span>
            </label>`}
        </div>`;
    }).join('') + `<p class="hint">檔案上限 ${MAX_MB} MB。老師評分前都可以重交，以最後一次為準。</p>`;

    box.querySelectorAll('input[type=file]').forEach(inp =>
      inp.addEventListener('change', () => upload(box, name, inp)));
  }

  const toBase64 = file => new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1] || '');
    fr.onerror = () => fail(new Error('讀不到這個檔案'));
    fr.readAsDataURL(file);
  });

  async function upload(box, name, inp) {
    const file = inp.files[0];
    if (!file) return;
    const item = inp.dataset.item;
    if (file.size > MAX_MB * 1024 * 1024) { FX.toast(`檔案超過 ${MAX_MB} MB，請壓縮後再上傳`, 'err'); inp.value = ''; return; }
    if (find(name, item) && !confirm(`${item} 已經交過了，要用「${file.name}」取代嗎？`)) { inp.value = ''; return; }

    box.querySelectorAll('input[type=file]').forEach(i => i.disabled = true);
    inp.nextElementSibling.textContent = '上傳中…';
    try {
      const res = await Quiz.call('hwSubmit', null, {
        name, item, fileName: file.name, mimeType: file.type, data: await toBase64(file)
      });
      upsert({ name, item, time: res.time, file: res.fileName, fileId: '', score: '', comment: '' });
      FX.toast(`✅ ${item} 已交出：${file.name}`, 'ok');
    } catch (e) {
      FX.toast(`上傳失敗：${e.message}`, 'err');
    }
    if (box.isConnected) render(box, name);
  }

  /* ── 老師：設定頁的作業批改 ─────────────────────── */

  async function mountAdmin() {
    const box = $('#hwAdmin');
    if (!box) return;
    box.innerHTML = '<p class="hint">讀取繳交紀錄中…</p>';
    try { await load(); } catch (e) {
      box.innerHTML = `<p class="hint">讀不到繳交紀錄：${esc(e.message)}。按右上角「同步」再試一次。</p>`;
      return;
    }
    renderAdmin(box);
  }

  function renderAdmin(box) {
    const names = (Store.state.students || []).map(s => s.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    // 依姓名：同一人的作業1、作業2 排在一起；依作業：先列全班作業1，再列作業2
    const pairs = sortBy === 'item'
      ? ITEMS.flatMap(item => names.map(name => [name, item]))
      : names.flatMap(name => ITEMS.map(item => [name, item]));
    const done = item => rows.filter(r => r.item === item).length;
    let key = '';
    try { key = sessionStorage.getItem(KEY_STORE) || ''; } catch (e) {}

    box.innerHTML = `
      <div class="row-actions">
        <label class="field hw-key">
          <span class="field-label">老師密碼（評分時後端會核對）</span>
          <input type="password" id="hwKey" value="${esc(key)}" autocomplete="off">
        </label>
        <label class="field hw-sort">
          <span class="field-label">排序</span>
          <select id="hwSort">
            <option value="name"${sortBy === 'name' ? ' selected' : ''}>依姓名</option>
            <option value="item"${sortBy === 'item' ? ' selected' : ''}>依作業</option>
          </select>
        </label>
        <button class="btn btn-sm" id="hwReload">🔄 重新整理</button>
      </div>
      <p class="hint">${ITEMS.map(i => `${i}：${done(i)} / ${names.length} 人已交`).join('　')}。分數存好後按右上角「同步」，排行榜就會更新。</p>
      <div class="hw-table-wrap"><table class="grade-table hw-table">
        <thead><tr><th>姓名</th><th>作業</th><th>檔案</th><th>分數</th><th>評語</th><th></th></tr></thead>
        <tbody>${pairs.map(([name, item]) => {
          const r = find(name, item);
          if (!r) return `<tr class="hw-none"><td>${esc(name)}</td><td>${item}</td><td colspan="4">未繳交</td></tr>`;
          const link = r.fileId
            ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(r.fileId)}/view" target="_blank" rel="noopener">${esc(r.file)}</a>`
            : esc(r.file);
          return `
            <tr data-name="${esc(name)}" data-item="${item}">
              <td>${esc(name)}</td><td>${item}</td>
              <td>${link}<br><small>${esc(r.time)}</small></td>
              <td><input type="number" class="hw-score" min="0" max="100" step="1" value="${esc(r.score)}"></td>
              <td><input type="text" class="hw-cmt" value="${esc(r.comment)}" placeholder="給學員的評語（選填）"></td>
              <td><button class="btn btn-sm btn-primary hw-save">${r.score !== '' ? '更新' : '儲存'}</button></td>
            </tr>`;
        }).join('')}</tbody>
      </table></div>`;

    $('#hwKey').addEventListener('change', e => {
      try { sessionStorage.setItem(KEY_STORE, e.target.value); } catch (err) {}
    });
    $('#hwReload').addEventListener('click', mountAdmin);
    $('#hwSort').addEventListener('change', e => { sortBy = e.target.value; renderAdmin(box); });
    box.querySelectorAll('.hw-save').forEach(btn => btn.addEventListener('click', () => grade(btn)));
  }

  async function grade(btn) {
    const tr = btn.closest('tr');
    const { name, item } = tr.dataset;
    const score = tr.querySelector('.hw-score').value.trim();
    const comment = tr.querySelector('.hw-cmt').value.trim();
    const key = $('#hwKey').value;
    if (!key) { FX.toast('請先填老師密碼', 'err'); return; }
    if (score === '' || +score < 0 || +score > 100) { FX.toast('分數要填 0～100', 'err'); return; }

    btn.disabled = true;
    btn.textContent = '儲存中…';
    try {
      await Quiz.call('hwGrade', null, { key, name, item, score, comment });
      try { sessionStorage.setItem(KEY_STORE, key); } catch (e) {}
      upsert({ name, item, score: String(score), comment });
      btn.textContent = '更新';
      FX.toast(`✅ ${name} ${item}：${score} 分`, 'ok');
    } catch (e) {
      btn.textContent = '儲存';
      FX.toast(`評分失敗：${e.message}`, 'err');
    }
    btn.disabled = false;
  }

  /** 按「同步」時下次重讀 */
  function invalidate() { loaded = false; }

  return { mount, mountAdmin, invalidate };
})();

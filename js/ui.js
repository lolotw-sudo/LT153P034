/* ============================================================
   ui.js — 排行榜、頒獎台、公會戰、個人戰績卡的畫面渲染
   ============================================================ */

const UI = (() => {

  const $  = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let lastChampionId = null;

  /* ── 主排行榜 ─────────────────────────────────────── */

  function renderBoard(rows, options) {
    const board = $('#board');
    const empty = $('#boardEmpty');

    $('#rosterCount').textContent = `${rows.length} 位學員`;
    empty.hidden = rows.length > 0;

    // FLIP: 先量測現有卡片位置
    const existing = [...board.children];
    const before = FX.flipRead(existing);

    const byId = new Map(existing.map(n => [n.dataset.id, n]));
    const frag = document.createDocumentFragment();

    rows.forEach(r => {
      const node = byId.get(r.id) || createRow(r);
      byId.delete(r.id);
      updateRow(node, r, options);
      frag.appendChild(node);           // appendChild 會自動搬移既有節點，維持 DOM 身分
    });

    byId.forEach(n => n.remove());      // 名單上已移除的學員
    board.appendChild(frag);

    FX.flipPlay([...board.children], before);
    renderPodium(rows, options);

    // 冠軍易主 → 全場彩帶
    const champ = rows[0]?.id ?? null;
    if (champ && lastChampionId && champ !== lastChampionId) {
      FX.celebrate();
      FX.toast(`👑 ${rows[0].name} 登頂了！`, 'ok');
    }
    lastChampionId = champ;
  }

  function createRow(r) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = r.id;
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="rank-cell"><span class="rank-num"></span></div>
      <div class="row-avatar"></div>
      <div class="row-id">
        <div class="row-name"></div>
        <div class="row-meta"></div>
      </div>
      <div class="bars">
        <div class="bar-track bar-q"><i class="bar-fill"></i></div>
        <div class="bar-track bar-p"><i class="bar-fill"></i></div>
        <div class="bar-track bar-e"><i class="bar-fill"></i></div>
      </div>
      <div class="total-cell">
        <div class="total-num">0</div>
        <div class="total-label">積分</div>
      </div>
      <div class="delta-cell"></div>`;

    const open = () => openCard(li.dataset.id);
    li.addEventListener('click', open);
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return li;
  }

  function updateRow(li, r, options) {
    li.dataset.rank = r.rank;
    li.classList.toggle('blind', !!options.blind);

    li.querySelector('.rank-num').textContent = r.rank;
    li.querySelector('.row-avatar').textContent = r.avatar;

    const streak = r.badges.some(b => b.name === '連霸');
    li.querySelector('.row-name').innerHTML =
      esc(r.name) + (streak ? ' <span class="streak">🔥</span>' : '');

    li.querySelector('.row-meta').innerHTML = [
      `<span class="tier tier-${r.tier}">${r.tier}</span>`,
      r.team ? `<span class="team-tag">${esc(r.team)}</span>` : '',
      r.badges.length
        ? `<span class="badges">${r.badges.slice(0, 4)
            .map(b => `<span class="badge" title="${esc(b.name)}：${esc(b.desc)}">${b.icon}</span>`).join('')}</span>`
        : ''
    ].join('');

    // 第三條跟能力三角同一個維度：有刷題資料就畫刷題均分，
    // 讀不到才退回終極考驗（那個要期末考完才有分數，整季都是 0）
    const hasQuiz = r.quizTimes != null;
    const tracks = li.querySelectorAll('.bar-track');
    tracks[2].className = 'bar-track ' + (hasQuiz ? 'bar-z' : 'bar-e');

    tracks[0].title = `實習 ${r.quality}`;
    tracks[1].title = `活躍度 ${r.performance}`;
    tracks[2].title = hasQuiz ? `刷題均分 ${r.quizAvg}（練習 ${r.quizTimes} 次）`
                              : `終極考驗 ${r.exam}`;

    const fills = li.querySelectorAll('.bar-fill');
    fills[0].style.width = r.quality + '%';
    fills[1].style.width = r.performance + '%';
    fills[2].style.width = (hasQuiz ? r.quizAvg : r.exam) + '%';

    FX.countTo(li.querySelector('.total-num'), r.total, 1);
    li.querySelector('.delta-cell').innerHTML = deltaChip(r);
  }

  function deltaChip(r) {
    if (r.prevRank == null) return `<span class="delta delta-new">NEW</span>`;
    if (r.delta > 0)  return `<span class="delta delta-up pulse">▲${r.delta}</span>`;
    if (r.delta < 0)  return `<span class="delta delta-down pulse">▼${-r.delta}</span>`;
    return `<span class="delta delta-same">–</span>`;
  }

  /* ── 頒獎台 ───────────────────────────────────────── */

  const PLACE_TAG = { 1: 'CHAMPION', 2: 'RUNNER-UP', 3: 'THIRD' };
  const CROWN     = { 1: '👑', 2: '🥈', 3: '🥉' };

  function renderPodium(rows, options) {
    const pod = $('#podium');
    const top = rows.slice(0, 3);

    if (top.length < 3) { pod.innerHTML = ''; return; }

    // 名次組成沒變就不重建，避免每次同步都重播進場動畫
    const sig = top.map(r => r.id).join('|');
    if (pod.dataset.sig === sig) {
      top.forEach((r, i) => {
        const el = pod.querySelector(`.pod[data-place="${i + 1}"]`);
        if (!el) return;
        el.classList.toggle('blind', !!options.blind);
        FX.countTo(el.querySelector('.pod-score'), r.total, 1);
      });
      return;
    }
    pod.dataset.sig = sig;

    pod.innerHTML = top.map((r, i) => `
      <div class="pod ${options.blind ? 'blind' : ''}" data-place="${i + 1}" data-id="${esc(r.id)}" tabindex="0">
        <span class="pod-crown">${CROWN[i + 1]}</span>
        <div class="pod-avatar">${esc(r.avatar)}</div>
        <div class="pod-name">${esc(r.name)}</div>
        <div class="pod-score" data-value="0">0</div>
        <div class="pod-place-tag">${PLACE_TAG[i + 1]}</div>
      </div>`).join('');

    pod.querySelectorAll('.pod').forEach((el, i) => {
      FX.countTo(el.querySelector('.pod-score'), top[i].total, 1);
      el.addEventListener('click', () => openCard(el.dataset.id));
    });
  }

  /* ── 公會戰 ───────────────────────────────────────── */

  function renderTeams(teams) {
    const grid = $('#teamGrid');
    const empty = $('#teamEmpty');

    $('#teamCount').textContent = `${teams.length} 個公會`;
    empty.hidden = teams.length > 0;

    if (!teams.length) { grid.innerHTML = ''; return; }

    const max = teams[0].score || 100;

    grid.innerHTML = teams.map((t, i) => `
      <div class="team-card" data-rank="${t.rank}" style="animation-delay:${i * 70}ms">
        <div class="team-head">
          <span class="team-rank">${t.rank}</span>
          <span class="team-name">${esc(t.name)}</span>
          <span class="team-score">${t.score.toFixed(1)}</span>
        </div>
        <div class="team-bar"><i data-w="${(t.score / max) * 100}"></i></div>
        <div class="team-members">
          ${t.members.map(m => `<span class="team-member">${esc(m.avatar)} ${esc(m.name)} <b>#${m.rank}</b></span>`).join('')}
        </div>
      </div>`).join('');

    // 下一幀才設寬度，讓長條有拉伸動畫
    requestAnimationFrame(() => {
      grid.querySelectorAll('.team-bar > i').forEach(i => i.style.width = i.dataset.w + '%');
    });
  }

  /* ── 個人戰績卡 ───────────────────────────────────── */

  let cardRows = [];
  const setCardData = rows => { cardRows = rows; };

  function openCard(id) {
    const r = cardRows.find(x => x.id === id);
    if (!r) return;

    $('#drawerBody').innerHTML = playerCardHTML(r);
    $('#drawer').hidden = false;
    $('#drawerScrim').hidden = false;

    drawRadar($('#pcRadar'), r);
    drawSparkline($('#pcSpark'), r);

    requestAnimationFrame(() => {
      $$('#drawerBody .bar-fill').forEach(f => f.style.width = f.dataset.w + '%');
    });
  }

  function closeCard() {
    $('#drawer').hidden = true;
    $('#drawerScrim').hidden = true;
  }

  function playerCardHTML(r) {
    const hist = Store.state.history;
    const bestRank = hist.reduce((best, h) => {
      const v = h.ranks[r.id];
      return v && v < best ? v : best;
    }, r.rank);

    return `
      <div class="pc-head">
        <div class="pc-avatar">${esc(r.avatar)}</div>
        <div>
          <div class="pc-name">${esc(r.name)}</div>
          <div class="pc-sub">
            <span class="tier tier-${r.tier}">${r.tier}</span>
            ${r.team ? `<span class="team-tag">${esc(r.team)}</span>` : ''}
            ${r.unit ? `<span class="team-tag unit-tag">${esc(r.unit)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="pc-hero">
        <div class="pc-stat"><b>#${r.rank}</b><span>目前名次</span></div>
        <div class="pc-stat"><b>${r.total.toFixed(1)}</b><span>累積總分</span></div>
        <div class="pc-stat"><b>#${bestRank}</b><span>生涯最佳</span></div>
        <div class="pc-stat"><b>${r.prevRank == null ? '—' : (r.delta > 0 ? '▲' + r.delta : r.delta < 0 ? '▼' + -r.delta : '持平')}</b><span>本回合變化</span></div>
      </div>

      <div class="pc-section">
        <h4>能力三角</h4>
        <div class="radar-wrap"><svg id="pcRadar" width="240" height="215" viewBox="0 0 240 215"></svg></div>
        ${quizNoteHTML(r)}
      </div>

      <div class="pc-section">
        <h4>三項成績</h4>
        <div class="pc-dims">
          ${dimRow('實習', 'q', r.quality)}
          ${hwDetailHTML(r)}
          ${dimRow('活躍度', 'p', r.performance)}
          ${perfNoteHTML(r)}
          ${r.quizTimes == null            /* 同能力三角第三軸：見 drawRadar */
              ? dimRow('終極考驗', 'e', r.exam)
              : dimRow('刷題均分', 'z', r.quizAvg)}
        </div>
      </div>

      <div class="pc-section">
        <h4>名次走勢</h4>
        ${hist.length >= 1
          ? `<svg id="pcSpark" class="spark" viewBox="0 0 300 84" preserveAspectRatio="none"></svg>`
          : `<p class="spark-empty">存檔一個回合以後才會出現走勢圖。</p><svg id="pcSpark" hidden></svg>`}
      </div>

      <div class="pc-section">
        <h4>徽章牆</h4>
        <div class="pc-badges">
          ${r.badges.map(b => `<span class="pc-badge">${b.icon} ${esc(b.name)}</span>`).join('')}
        </div>
      </div>

      ${perfLogHTML(r)}`;
  }

  /** 三場實習各自幾分；留白的顯示「未評」，代表它還沒被加進累積總分 */
  function hwDetailHTML(r) {
    if (!r.assignments || !r.assignments.length) return '';
    const items = r.assignments.map(a =>
      `<span class="pc-chip${a.score === null ? ' is-empty' : ''}">${esc(a.label)} <b>${a.score === null ? '未評' : a.score}</b></span>`
    ).join('');
    return `<div class="pc-subrow">${items}</div>`;
  }

  /** 活躍度的來源：累計了幾分、離滿分目標還有多遠 */
  function perfNoteHTML(r) {
    if (!r.perfLog) return '';
    const goal = Store.state.perfTarget || 70;
    const raw  = r.perfRaw || 0;
    return `<div class="pc-subrow">
      <span class="pc-chip">累計 <b>${raw > 0 ? '+' + raw : raw}</b> 分</span>
      <span class="pc-chip is-empty">滿分目標 ${goal} 分</span>
    </div>`;
  }

  /** 能力三角第三軸的來源：刷題練了幾次、平均與最佳幾分 */
  function quizNoteHTML(r) {
    if (r.quizTimes == null) return '';       // 這次同步沒讀到刷題紀錄，雷達圖畫的是終極考驗
    if (!r.quizTimes)
      return `<div class="pc-subrow"><span class="pc-chip is-empty">刷題練習 還沒練過</span></div>`;
    return `<div class="pc-subrow">
      <span class="pc-chip">練習 <b>${r.quizTimes}</b> 次</span>
      <span class="pc-chip">平均 <b>${r.quizAvg}</b> 分</span>
      <span class="pc-chip is-empty">最佳 ${r.quizBest} 分</span>
    </div>`;
  }

  /** 加分明細時間軸——排行榜的說服力來源：分數是怎麼來的 */
  function perfLogHTML(r) {
    if (!r.perfLog || !r.perfLog.length) return '';
    const items = [...r.perfLog].reverse().map(e => `
      <li>
        <span class="log-when">${esc(e.date || '')}${e.item ? ' · ' + esc(e.item) : ''}</span>
        <span class="log-what">${esc(e.reason || '加分')}${e.teacher ? `<i>${esc(e.teacher)}</i>` : ''}</span>
        <b class="log-delta${e.delta < 0 ? ' is-minus' : ''}">${e.delta > 0 ? '+' + e.delta : e.delta}</b>
      </li>`).join('');
    return `
      <div class="pc-section">
        <h4>加分明細 <span class="pc-count">${r.perfLog.length} 筆</span></h4>
        <ul class="pc-log">${items}</ul>
      </div>`;
  }

  function dimRow(label, key, value) {
    return `
      <div class="pc-dim">
        <span>${label}</span>
        <span class="bar-track bar-${key}"><i class="bar-fill" data-w="${value}"></i></span>
        <b>${value}</b>
      </div>`;
  }

  /* ── 雷達圖（三軸） ───────────────────────────────── */

  function drawRadar(svg, r) {
    if (!svg) return;
    const cx = 120, cy = 112, R = 82;
    // 第三軸優先畫刷題練習：終極考驗要考完試才有分數，整個學期都是 0，
    // 三角形會塌成一條線。讀不到刷題紀錄時才退回原本的終極考驗。
    const axes = [
      { label: '實習', value: r.quality,     color: 'var(--q)' },
      { label: '活躍度', value: r.performance, color: 'var(--p)' },
      r.quizTimes == null
        ? { label: '終極考驗',  value: r.exam,    color: 'var(--e)' }
        : { label: '刷題練習',  value: r.quizAvg, color: 'var(--z)' }
    ];

    const pt = (i, ratio) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
      return [cx + Math.cos(a) * R * ratio, cy + Math.sin(a) * R * ratio];
    };

    let out = '';

    // 網格
    [.25, .5, .75, 1].forEach(ring => {
      const pts = axes.map((_, i) => pt(i, ring).map(n => n.toFixed(1)).join(',')).join(' ');
      out += `<polygon points="${pts}" fill="none" stroke="rgba(140,165,255,.16)" stroke-width="1"/>`;
    });
    axes.forEach((_, i) => {
      const [x, y] = pt(i, 1);
      out += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(140,165,255,.16)"/>`;
    });

    // 數值多邊形（從中心展開）
    const target = axes.map((a, i) => pt(i, Math.max(a.value, 1) / 100).map(n => n.toFixed(1)).join(',')).join(' ');
    const start  = axes.map((_, i) => `${cx},${cy}`).join(' ');

    out += `<polygon points="${FX.animOn ? start : target}" fill="rgba(34,211,238,.24)"
              stroke="#22d3ee" stroke-width="2" stroke-linejoin="round" id="radarPoly"
              style="filter:drop-shadow(0 0 10px rgba(34,211,238,.6))"/>`;

    axes.forEach((a, i) => {
      const [x, y] = pt(i, Math.max(a.value, 1) / 100);
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${a.color}"/>`;
      const [lx, ly] = pt(i, 1.22);
      out += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle"
                font-size="11" fill="#9aa4d0">${a.label} ${a.value}</text>`;
    });

    svg.innerHTML = out;

    if (FX.animOn) {
      requestAnimationFrame(() => {
        const poly = svg.querySelector('#radarPoly');
        poly?.animate([{ points: start }, { points: target }],
          { duration: 750, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
        // points 屬性在部分瀏覽器不可動畫，保底直接設值
        setTimeout(() => poly?.setAttribute('points', target), 40);
      });
    }
  }

  /* ── 名次走勢 ─────────────────────────────────────── */

  function drawSparkline(svg, r) {
    if (!svg || svg.hidden) return;
    const hist = Store.state.history;
    // 存檔的回合只到上一次按快照為止，尾端接上此刻的名次，
    // 走勢才看得出「存檔兩回合 + 現在」這三個點，而不是停在舊資料。
    const series = [...hist.map(h => h.ranks[r.id]).filter(v => v != null), r.rank];
    if (series.length < 2) return;

    const W = 300, H = 84, pad = 10;
    const total = Store.state.students.length || Math.max(...series);
    const x = i => pad + (i / (series.length - 1)) * (W - pad * 2);
    const y = v => pad + ((v - 1) / Math.max(1, total - 1)) * (H - pad * 2);  // 名次 1 在最上面

    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

    svg.innerHTML = `
      <polyline points="${pts}" fill="none" stroke="#22d3ee" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round"
        style="filter:drop-shadow(0 0 8px rgba(34,211,238,.7))"/>
      ${series.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"
        fill="${i === series.length - 1 ? '#ffd54a' : '#22d3ee'}"/>`).join('')}
      ${series.map((v, i) => {
        const last = i === series.length - 1;
        // 回合一多，逐點標會擠成一團，那時只留頭尾兩個
        if (series.length > 5 && i > 0 && !last) return '';
        const anchor = i === 0 ? 'start' : last ? 'end' : 'middle';
        // 第一名的點貼著上緣，名次標籤要改放點的下方才不會被裁掉
        const ly = y(v) < 22 ? y(v) + 14 : y(v) - 8;
        return `<text x="${x(i).toFixed(1)}" y="${ly.toFixed(1)}" font-size="9"
                  fill="${last ? '#ffd54a' : '#8b93bd'}" text-anchor="${anchor}">#${v}</text>
                <text x="${x(i).toFixed(1)}" y="${H - 1}" font-size="9"
                  fill="#626b96" text-anchor="${anchor}">${last ? '目前' : '第 ' + (i + 1) + ' 回合'}</text>`;
      }).join('')}`;

    if (FX.animOn) {
      const line = svg.querySelector('polyline');
      const len = line.getTotalLength?.() || 400;
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: 800, easing: 'ease-out', fill: 'forwards' });
    }
  }

  /* ── 賽季紀錄清單 ─────────────────────────────────── */

  function renderSnapshots() {
    const list = document.getElementById('snapshotList');
    const hist = Store.state.history;
    list.innerHTML = hist.slice().reverse().map(h => {
      const champName = Store.state.students.find(s => s.id === h.champion)?.name || '—';
      return `<li>
        <span>${esc(h.label)}</span>
        <span class="snap-champ">👑 ${esc(champName)}</span>
      </li>`;
    }).join('');
  }

  return {
    renderBoard, renderTeams, renderSnapshots,
    openCard, closeCard, setCardData, esc, $, $$
  };
})();

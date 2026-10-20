/* ============================================================
   ceremony.js — 頒獎典禮揭曉模式
   從最後一名倒數揭曉到第一名，前三名放慢節奏並加上彩帶
   ============================================================ */

const Ceremony = (() => {

  const el = {
    root:  () => document.getElementById('ceremony'),
    rank:  () => document.getElementById('cRank'),
    card:  () => document.getElementById('cCard'),
    hint:  () => document.getElementById('cHint'),
    auto:  () => document.getElementById('cAuto')
  };

  let order = [];        // 由最後一名到第一名
  let cursor = -1;
  let autoTimer = null;
  let active = false;

  /** 依名次決定停留時間 — 越接近冠軍越慢，張力越高 */
  const dwell = rank => rank === 1 ? 6000 : rank <= 3 ? 4200 : 2400;

  // 只揭曉前 6 名：17 人班的第 6 名剛好是白金段位的最後一位。
  // 從最後一名開始念完全班會拖太久，後段班的人也不會想被公開唱名。
  const REVEAL_FROM = 6;

  function open(rows) {
    if (!rows.length) { FX.toast('還沒有學員資料', 'err'); return; }

    // 人數不足 6 位時就是全部揭曉
    order = rows.filter(r => r.rank <= REVEAL_FROM).sort((a, b) => b.rank - a.rank);   // 6 → 1
    cursor = -1;
    active = true;

    el.root().hidden = false;
    el.rank().innerHTML = `<span class="rk-in">準備好了嗎</span>`;
    el.rank().classList.remove('is-champion');
    el.card().innerHTML = `<div class="cc-name">前 ${order.length} 名即將揭曉</div>
                           <div class="cc-meta"><span class="cc-score">全班共 ${rows.length} 位選手</span></div>`;
    el.card().classList.remove('is-champion');
    el.hint().innerHTML = '按 <kbd>空白鍵</kbd> 揭曉下一位 · <kbd>Esc</kbd> 離開';

    document.body.style.overflow = 'hidden';
    FX.play('drum');
  }

  function close() {
    stopAuto();
    active = false;
    el.root().hidden = true;
    document.body.style.overflow = '';
  }

  function next() {
    if (!active) return;
    if (cursor >= order.length - 1) { finish(); return; }

    cursor++;
    reveal(order[cursor]);

    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(next, dwell(order[cursor].rank));
    }
  }

  function prev() {
    if (!active || cursor <= 0) return;
    cursor--;
    reveal(order[cursor]);
  }

  function reveal(r) {
    const isChampion = r.rank === 1;
    const isPodium = r.rank <= 3;

    const rank = el.rank();
    rank.classList.toggle('is-champion', isChampion);
    rank.innerHTML = `<span class="rk-in">第 ${r.rank} 名</span>`;

    const card = el.card();
    card.classList.toggle('is-champion', isChampion);
    card.innerHTML = `
      <div class="cc-avatar">${UI.esc(r.avatar)}</div>
      <div class="cc-name">${UI.esc(r.name)}</div>
      <div class="cc-meta">
        <span class="tier tier-${r.tier}">${r.tier}</span>
        ${r.team ? `<span class="team-tag">${UI.esc(r.team)}</span>` : ''}
        <span class="cc-score">${r.total.toFixed(1)}</span>
      </div>
      ${r.badges.length
        ? `<div class="cc-badges">${r.badges.map(b => `<span title="${UI.esc(b.name)}">${b.icon}</span>`).join('')}</div>`
        : ''}`;

    // 重播進場動畫
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

    if (isChampion) {
      FX.play('fanfare');
      FX.celebrate();
      el.hint().innerHTML = '🎉 恭喜本回合冠軍！按 <kbd>Esc</kbd> 離開';
    } else if (isPodium) {
      FX.play('reveal');
      // 從兩側噴，避免蓋住中間的名字
      FX.confetti({ count: 45, originX: .14, originY: .62, power: 13 });
      FX.confetti({ count: 45, originX: .86, originY: .62, power: 13 });
      el.hint().innerHTML = '按 <kbd>空白鍵</kbd> 揭曉下一位 · <kbd>Esc</kbd> 離開';
    } else {
      FX.play('reveal');
    }
  }

  function finish() {
    stopAuto();
    el.hint().innerHTML = '全部揭曉完畢 · 按 <kbd>Esc</kbd> 離開';
  }

  function toggleAuto() {
    if (autoTimer) { stopAuto(); return; }
    el.auto().textContent = '⏸ 暫停';
    autoTimer = setTimeout(next, 400);
    if (cursor < 0) next();
  }

  function stopAuto() {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (el.auto()) el.auto().textContent = '▶ 自動播放';
  }

  function handleKey(e) {
    if (!active) return false;
    if (e.key === 'Escape')    { close(); return true; }
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); stopAuto(); next(); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stopAuto(); prev(); return true; }
    return false;
  }

  return { open, close, next, prev, toggleAuto, handleKey, get active() { return active; } };
})();

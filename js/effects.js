/* ============================================================
   effects.js — 背景粒子、彩帶、數字滾動、FLIP 換位、音效、Toast
   ============================================================ */

const FX = (() => {

  const NEON = ['#22d3ee', '#8b5cf6', '#e879f9', '#a3e635', '#ffd54a', '#fb923c', '#38bdf8'];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let animOn = true;
  const setAnim = on => { animOn = on && !reduced; };

  /* ── 背景漂浮粒子 ─────────────────────────────────── */

  function startBackground(canvas) {
    const ctx = canvas.getContext('2d');
    let dots = [], w = 0, h = 0, raf = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width  = innerWidth  * dpr;
      h = canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.round(Math.min(innerWidth, 1600) / 16);
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        r: Math.random() * 1.7 + .5,
        vx: (Math.random() - .5) * .16,
        vy: -Math.random() * .3 - .05,
        a: Math.random() * .5 + .15,
        c: NEON[(Math.random() * NEON.length) | 0]
      }));
    }

    function frame() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.y < -10) { d.y = innerHeight + 10; d.x = Math.random() * innerWidth; }
        if (d.x < -10) d.x = innerWidth + 10;
        if (d.x > innerWidth + 10) d.x = -10;

        ctx.globalAlpha = d.a;
        ctx.fillStyle = d.c;
        ctx.shadowBlur = 8;
        ctx.shadowColor = d.c;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      raf = requestAnimationFrame(frame);
    }

    resize();
    addEventListener('resize', resize);
    if (!reduced) frame(); else { /* 靜態繪一次 */ ctx.clearRect(0, 0, innerWidth, innerHeight); }

    return () => cancelAnimationFrame(raf);
  }

  /* ── 彩帶 ─────────────────────────────────────────── */

  let fxCtx = null, fxCanvas = null, pieces = [], fxRaf = 0;

  function initConfetti(canvas) {
    fxCanvas = canvas;
    fxCtx = canvas.getContext('2d');
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    addEventListener('resize', fit);
  }

  /**
   * @param {object} opts count / originY / spread / power
   */
  function confetti(opts = {}) {
    if (!fxCtx || !animOn) return;
    const {
      count = 140,
      originX = .5,
      originY = .48,
      power = 13
    } = opts;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * power + 3;
      pieces.push({
        x: innerWidth * originX,
        y: innerHeight * originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 5,
        w: Math.random() * 9 + 4,
        h: Math.random() * 5 + 3,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - .5) * .32,
        c: NEON[(Math.random() * NEON.length) | 0],
        life: 1
      });
    }
    if (!fxRaf) fxRaf = requestAnimationFrame(confettiFrame);
  }

  function confettiFrame() {
    fxCtx.clearRect(0, 0, innerWidth, innerHeight);

    pieces = pieces.filter(p => p.life > 0 && p.y < innerHeight + 60);
    for (const p of pieces) {
      p.vy += .28;            // 重力
      p.vx *= .992;           // 空氣阻力
      p.x += p.vx; p.y += p.vy;
      p.rot += p.vr;
      p.life -= .0055;

      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      fxCtx.globalAlpha = Math.max(0, p.life);
      fxCtx.fillStyle = p.c;
      fxCtx.shadowBlur = 10;
      fxCtx.shadowColor = p.c;
      fxCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fxCtx.restore();
    }

    if (pieces.length) {
      fxRaf = requestAnimationFrame(confettiFrame);
    } else {
      fxCtx.clearRect(0, 0, innerWidth, innerHeight);
      fxRaf = 0;
    }
  }

  /** 兩側噴發，用在冠軍揭曉 */
  function celebrate() {
    confetti({ count: 120, originX: .08, originY: .62, power: 17 });
    confetti({ count: 120, originX: .92, originY: .62, power: 17 });
    // 後面兩波從上方灑落，才不會蓋住畫面中央的冠軍
    setTimeout(() => confetti({ count: 160, originX: .5, originY: .1, power: 15 }), 260);
    setTimeout(() => confetti({ count: 100, originX: .5, originY: .04, power: 12 }), 680);
  }

  /* ── 數字滾動 ─────────────────────────────────────── */

  const countTimers = new WeakMap();

  function countTo(el, to, decimals = 1, duration = 900) {
    const from = parseFloat(el.dataset.value ?? '0') || 0;
    el.dataset.value = to;

    if (!animOn || from === to) { el.textContent = to.toFixed(decimals); return; }

    cancelAnimationFrame(countTimers.get(el));
    const t0 = performance.now();

    const step = now => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (from + (to - from) * eased).toFixed(decimals);
      if (t < 1) countTimers.set(el, requestAnimationFrame(step));
    };
    countTimers.set(el, requestAnimationFrame(step));
  }

  /* ── FLIP 換位 ────────────────────────────────────── */

  /** 呼叫前先記錄位置 */
  function flipRead(nodes) {
    const map = new Map();
    nodes.forEach(n => map.set(n.dataset.id, n.getBoundingClientRect().top));
    return map;
  }

  /** DOM 重排後呼叫，讓每個卡片從舊位置滑到新位置 */
  function flipPlay(nodes, before) {
    if (!animOn) return;

    nodes.forEach(n => {
      const prevTop = before.get(n.dataset.id);
      if (prevTop == null) {
        n.animate(
          [{ opacity: 0, transform: 'translateY(18px) scale(.96)' }, { opacity: 1, transform: 'none' }],
          { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' }
        );
        return;
      }
      const dy = prevTop - n.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;

      // 移動距離越遠、動畫越久，超車感更明顯
      const duration = Math.min(1100, 420 + Math.abs(dy) * 1.4);
      n.animate(
        [
          { transform: `translateY(${dy}px)` },
          { transform: `translateY(${dy * .12}px) scale(1.035)`, offset: .72 },
          { transform: 'none' }
        ],
        { duration, easing: 'cubic-bezier(.22,1.2,.36,1)' }
      );

      n.classList.remove('is-moving-up', 'is-moving-down');
      void n.offsetWidth;                       // 強制 reflow 以重播動畫
      n.classList.add(dy > 0 ? 'is-moving-up' : 'is-moving-down');
      setTimeout(() => n.classList.remove('is-moving-up', 'is-moving-down'), 900);
    });
  }

  /* ── 音效（WebAudio 合成，不需外部檔案） ────────────── */

  let audioCtx = null, soundOn = true;
  const setSound = on => { soundOn = on; };

  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone(freq, start, dur, type = 'triangle', gain = .16) {
    const c = ac();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + start);
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + start + .02);
    g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + start + dur);
    osc.connect(g).connect(c.destination);
    osc.start(c.currentTime + start);
    osc.stop(c.currentTime + start + dur + .05);
  }

  const SOUNDS = {
    reveal:  () => { tone(523, 0, .16); tone(784, .07, .22); },
    drum:    () => { for (let i = 0; i < 6; i++) tone(120 + i * 8, i * .07, .09, 'square', .1); },
    fanfare: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .11, .5, 'triangle', .2));
      tone(1568, .5, .9, 'sine', .14);
    },
    tick:    () => tone(880, 0, .05, 'sine', .07)
  };

  function play(name) {
    if (!soundOn) return;
    try { SOUNDS[name]?.(); } catch (e) { /* 使用者尚未互動時瀏覽器會擋，忽略 */ }
  }

  /* ── Toast ────────────────────────────────────────── */

  function toast(msg, kind = '') {
    const stack = document.getElementById('toasts');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  return {
    startBackground, initConfetti, confetti, celebrate,
    countTo, flipRead, flipPlay,
    play, setSound, setAnim, toast,
    get animOn() { return animOn; }
  };
})();

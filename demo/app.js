/* ══════════════════════════════════════════════════════════════════════
   app.js — entry. Wires the 9 motion patterns to the DOM, plus the two
   bespoke interactive bits (hero blueprint field, layout re-roll).
   ══════════════════════════════════════════════════════════════════════ */

import {
  reduced, addTask,
  initSplash, initNav, initReveal, initVizReveal, initChapters,
  initCountUp, initAccordion, initMagnetic, initFooterDots, initMarquee,
} from './motion.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ══ HERO BLUEPRINT FIELD ══════════════════════════════════════════════
   A dot field on a blueprint grid with a slow travelling scan line.
   Idles cheaply: capped at ~24fps, pauses entirely when off-screen or
   when the tab is hidden, and is a single static paint under
   prefers-reduced-motion.                                              */
function initBlueprintField(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const GAP = 34;
  let dpr = 1, w = 0, h = 0, t = 0, last = 0;
  let stop = null, visible = true;
  const isDark = () => document.documentElement.classList.contains('dark');

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(true);
  }

  function paint(force) {
    ctx.clearRect(0, 0, w, h);

    const line = isDark() ? 'rgba(255,255,255,.055)' : 'rgba(11,11,12,.07)';
    const dot = isDark() ? 'rgba(255,255,255,.16)' : 'rgba(11,11,12,.18)';

    // blueprint grid
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += GAP) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
    for (let y = 0; y <= h; y += GAP) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
    ctx.stroke();

    // heavier every 5th line — reads as a measured sheet
    ctx.strokeStyle = isDark() ? 'rgba(255,255,255,.085)' : 'rgba(11,11,12,.1)';
    ctx.beginPath();
    for (let x = 0, i = 0; x <= w; x += GAP, i += 1) {
      if (i % 5) continue;
      ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h);
    }
    for (let y = 0, i = 0; y <= h; y += GAP, i += 1) {
      if (i % 5) continue;
      ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5);
    }
    ctx.stroke();

    // dot field at intersections, gently breathing with the scan band
    const bandY = force ? -1e9 : (t % (h + 460)) - 230;
    for (let x = 0; x <= w; x += GAP) {
      for (let y = 0; y <= h; y += GAP) {
        const d = Math.abs(y - bandY);
        const near = d < 170 ? 1 - d / 170 : 0;
        if (near > 0.02) {
          ctx.globalAlpha = 0.25 + near * 0.75;
          ctx.fillStyle = '#3B6EF6';
          ctx.beginPath();
          ctx.arc(x, y, 1 + near * 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = dot;
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  const frame = () => {
    const now = performance.now();
    if (now - last < 42) return;   // ≈24fps ceiling — cheap idle
    t += (now - last) * 0.052;
    last = now;
    paint(false);
  };

  const start = () => {
    if (stop || reduced()) return;
    last = performance.now();
    stop = addTask(frame);
  };
  const halt = () => { if (stop) { stop(); stop = null; } };

  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  if (reduced()) { paint(true); return; }

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    visible && !document.hidden ? start() : halt();
  }, { threshold: 0 }).observe(canvas);

  document.addEventListener('visibilitychange', () => {
    document.hidden || !visible ? halt() : start();
  });
}

/* ══ CHAPTER 02 · QR fill ══════════════════════════════════════════════ */
function initQr(el) {
  if (!el) return;
  // Deterministic pseudo-random so the "code" is stable between loads.
  let s = 20260828;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 81; i += 1) {
    const c = i % 9, r = (i / 9) | 0;
    const finder =
      (c < 3 && r < 3) || (c > 5 && r < 3) || (c < 3 && r > 5);
    const on = finder ? !((c === 1 || c === 7) && r === 1) && !(c === 1 && r === 7)
                      : rnd() > 0.48;
    const i2 = document.createElement('i');
    if (!on) i2.style.background = 'transparent';
    i2.style.animationDelay = `${(i % 9) * 18 + r * 22}ms`;
    frag.appendChild(i2);
  }
  el.appendChild(frag);
}

/* ══ CHAPTER 03 · LAYOUT RE-ROLL ═══════════════════════════════════════
   Four hand-authored candidates in % of the room box, cycled on click and
   (while on screen) on a slow timer. Scores are static per candidate so the
   demo never claims a number it did not "compute".                      */
const CANDIDATES = [
  { score: '0.86', pcs: [[6, 12, 44, 20], [22, 46, 20, 30], [72, 10, 12, 56], [56, 62, 16, 22]] },
  { score: '0.91', pcs: [[8, 62, 46, 22], [28, 22, 22, 28], [70, 54, 14, 34], [62, 12, 18, 20]] },
  { score: '0.78', pcs: [[52, 14, 40, 22], [30, 52, 24, 30], [8, 20, 12, 54], [10, 78, 20, 14]] },
  { score: '0.83', pcs: [[10, 16, 38, 24], [54, 50, 26, 30], [78, 12, 12, 30], [16, 58, 18, 22]] },
];

function initReroll(root) {
  if (!root) return;
  const btn = root.querySelector('[data-reroll-btn]');
  const label = root.querySelector('[data-reroll-label]');
  const scoreEl = root.querySelector('[data-reroll-score]');
  const pcs = $$('.pc', root);
  if (pcs.length !== 4) return;

  let idx = 0;
  const apply = (i) => {
    const c = CANDIDATES[i];
    c.pcs.forEach(([x, y, w, h], n) => {
      const el = pcs[n];
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.width = `${w}%`;
      el.style.height = `${h}%`;
    });
    if (label) label.textContent = `CANDIDATE 0${i + 1} / 04`;
    if (scoreEl) scoreEl.textContent = c.score;
  };
  apply(0);

  const next = () => { idx = (idx + 1) % CANDIDATES.length; apply(idx); };
  btn?.addEventListener('click', next);

  if (reduced()) return;

  let timer = null;
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !timer) timer = setInterval(next, 3400);
    else if (!e.isIntersecting && timer) { clearInterval(timer); timer = null; }
  }, { threshold: 0.4 }).observe(root);
}

/* ══ BOOT ══════════════════════════════════════════════════════════════ */
function boot() {
  // 1 · splash
  initSplash($('[data-splash]'));
  // 2 · liquid-glass nav
  initNav($('[data-nav]'), $('[data-nav-toggle]'), $('[data-nav-links]'));
  // 3 · blur reveal on scroll
  initReveal($$('[data-reveal]'));
  initVizReveal($$('[data-viz]'));
  // 4 · numbered scroll chapters
  initChapters($$('.chapter'));
  // 5 · live data tiles
  initCountUp($$('[data-countup]'));
  // 6 · accordion propositions (each group is independent, one-open-at-a-time)
  $$('[data-accordion]').forEach(initAccordion);
  // 7 · magnetic buttons
  initMagnetic($$('[data-magnetic]'));
  // 8 · footer dot grid + wordmark blur-reveal
  initFooterDots($('[data-footer]'), $('[data-dot-canvas]'));
  // 9 · marquee
  initMarquee($$('[data-marquee]'));

  // bespoke
  initBlueprintField($('[data-blueprint-canvas]'));
  initQr($('[data-qr]'));
  initReroll($('[data-viz="reroll"]'));

  document.documentElement.dataset.ainteriorReady = '1';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// ── theme toggle ───────────────────────────────────────────────────────────
// Dark is the ainterior default (see the inline bootstrap in index.html). This
// only handles an explicit user override and persists it.
(function initThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const root = document.documentElement;
  const sync = () => {
    const light = !root.classList.contains('dark');
    btn.setAttribute('aria-pressed', String(light));
    btn.title = light ? 'Switch to dark' : 'Switch to light';
  };
  btn.addEventListener('click', () => {
    const nowLight = root.classList.contains('dark');
    root.classList.toggle('dark', !nowLight);
    try {
      localStorage.setItem('ainterior-theme', nowLight ? 'light' : 'dark');
    } catch (e) { /* private mode — the choice just won't persist */ }
    sync();
  });
  sync();
}());

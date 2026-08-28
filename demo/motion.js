/* ══════════════════════════════════════════════════════════════════════
   motion.js — the 9 motion patterns from SPEC §2.
   Every export must no-op (or settle to final state) under
   prefers-reduced-motion. All scroll work goes through IntersectionObserver
   or a single rAF loop — no layout reads inside scroll handlers.
   ══════════════════════════════════════════════════════════════════════ */

const RM_QUERY = '(prefers-reduced-motion: reduce)';
export const reduced = () =>
  window.matchMedia && window.matchMedia(RM_QUERY).matches;

/* ── shared rAF ticker so we never stack scroll/pointer loops ─────────── */
const tasks = new Set();
let ticking = false;
function loop() {
  ticking = false;
  for (const t of tasks) t();
  if (tasks.size) {
    ticking = true;
    requestAnimationFrame(loop);
  }
}
export function addTask(fn) {
  tasks.add(fn);
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(loop);
  }
  return () => tasks.delete(fn);
}

/* ══ 1 · SPLASH LOGO BLUR-REVEAL ═══════════════════════════════════════
   scale 1.06→1, blur 14px→0, opacity 0→1, then the mask wipes up.
   ~1100ms, cubic-bezier(.16,1,.3,1). Once per session via sessionStorage.
   Skipped entirely under prefers-reduced-motion.                        */
const SPLASH_KEY = 'ainterior.splash.v1';

export function initSplash(el) {
  if (!el) return;
  const kill = () => {
    el.classList.add('is-gone');
    el.setAttribute('hidden', '');
    document.documentElement.style.removeProperty('overflow');
  };

  let seen = false;
  try { seen = sessionStorage.getItem(SPLASH_KEY) === '1'; } catch { seen = false; }

  if (seen || reduced()) { kill(); return; }

  try { sessionStorage.setItem(SPLASH_KEY, '1'); } catch { /* private mode */ }

  document.documentElement.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('is-on'));
  });

  // 1100ms reveal, then wipe + fade, then remove from the flow.
  setTimeout(() => el.classList.add('is-wipe', 'is-fade'), 1100);
  setTimeout(kill, 1100 + 1050);
}

/* ══ 2 · LIQUID-GLASS NAV ══════════════════════════════════════════════
   Shrinks + gains border past 40px. Uses IO on a sentinel rather than a
   scroll handler so there is no per-frame layout read.                  */
export function initNav(wrap, toggle, links) {
  if (!wrap) return;

  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  Object.assign(sentinel.style, {
    position: 'absolute', top: '0', left: '0',
    width: '1px', height: '40px', pointerEvents: 'none',
  });
  document.body.prepend(sentinel);

  new IntersectionObserver(
    ([e]) => wrap.classList.toggle('is-stuck', !e.isIntersecting),
    { threshold: 0 }
  ).observe(sentinel);

  if (toggle && links) {
    const close = () => {
      links.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', (e) => {
      if (e.target.closest('a')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }
}

/* ══ 3 · BLUR REVEAL ON SCROLL ═════════════════════════════════════════
   opacity 0→1, translateY 24px→0, blur 10px→0, staggered 60ms by index
   within the same viewport batch.                                       */
export function initReveal(nodes) {
  const els = Array.from(nodes);
  if (!els.length) return;

  if (reduced()) {
    els.forEach((el) => el.classList.add('is-in'));
    document.querySelectorAll('[data-viz]').forEach((v) => v.classList.add('is-in'));
    return;
  }

  const show = (el, delay) => {
    el.style.setProperty('--rd', `${delay}ms`);
    el.classList.add('is-in');
    io.unobserve(el);
  };

  const io = new IntersectionObserver(
    (entries) => {
      let i = 0;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          show(entry.target, i * 60);
          i += 1;
        } else if (entry.boundingClientRect.bottom < 0) {
          // Already scrolled past — a fast scroll or a deep link jumped over
          // it. Reveal with no stagger so nothing is ever left invisible.
          show(entry.target, 0);
        }
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
  );
  els.forEach((el) => io.observe(el));

  // Last-resort sweep: anything at or above the fold after a scroll settles.
  let idle;
  const sweep = () => {
    const vh = window.innerHeight;
    for (const el of els) {
      if (el.classList.contains('is-in')) continue;
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.92) show(el, 0);
    }
  };
  window.addEventListener('scroll', () => {
    clearTimeout(idle);
    idle = setTimeout(sweep, 90);
  }, { passive: true });
}

/* Chapter visuals get their own observer so SVG line-draws fire on entry. */
export function initVizReveal(nodes) {
  const els = Array.from(nodes);
  if (!els.length) return;
  if (reduced()) { els.forEach((el) => el.classList.add('is-in')); return; }

  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting && e.boundingClientRect.bottom > 0) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }),
    { threshold: 0.25 }
  );
  els.forEach((el) => io.observe(el));
}

/* ══ 4 · NUMBERED SCROLL CHAPTERS ══════════════════════════════════════
   Sticky mono numeral highlights while its chapter owns the viewport.   */
export function initChapters(nodes) {
  const els = Array.from(nodes);
  if (!els.length) return;

  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      e.target.classList.toggle('is-active', e.isIntersecting);
    }),
    { rootMargin: '-38% 0px -38% 0px', threshold: 0 }
  );
  els.forEach((el) => io.observe(el));
}

/* ══ 5 · LIVE DATA TILES — count-up on reveal ══════════════════════════ */
const fmt = (n, sep) =>
  sep ? Math.round(n).toLocaleString('en-US') : String(Math.round(n));

export function initCountUp(nodes) {
  const els = Array.from(nodes);
  if (!els.length) return;

  const settle = (el) => {
    const to = Number(el.dataset.to || 0);
    el.textContent = fmt(to, el.dataset.sep);
  };

  if (reduced()) { els.forEach(settle); return; }

  const run = (el) => {
    const to = Number(el.dataset.to || 0);
    if (to === 0) { settle(el); return; }
    const dur = 1500;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      // easeOutExpo — matches the cubic-bezier(.16,1,.3,1) feel
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = fmt(to * e, el.dataset.sep);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      run(e.target);
      io.unobserve(e.target);
    }),
    { threshold: 0.5 }
  );
  els.forEach((el) => io.observe(el));
}

/* ══ 6 · ACCORDION — one open at a time, grid-template-rows 0fr→1fr ════ */
export function initAccordion(root) {
  if (!root) return;
  const btns = Array.from(root.querySelectorAll('.acc__btn'));

  const setOpen = (btn, open) => {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(open));
    if (panel) panel.classList.toggle('is-open', open);
  };

  // Sync initial DOM state to the aria markup.
  btns.forEach((b) => setOpen(b, b.getAttribute('aria-expanded') === 'true'));

  btns.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const willOpen = btn.getAttribute('aria-expanded') !== 'true';
      btns.forEach((b) => setOpen(b, false));
      setOpen(btn, willOpen);
    });

    // Roving arrow-key navigation between headers.
    btn.addEventListener('keydown', (e) => {
      const map = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (e.key in map) {
        e.preventDefault();
        btns[(i + map[e.key] + btns.length) % btns.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault(); btns[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault(); btns[btns.length - 1].focus();
      }
    });
  });
}

/* ══ 7 · MAGNETIC BUTTONS — ≤4px toward the cursor ═════════════════════ */
export function initMagnetic(nodes) {
  const els = Array.from(nodes);
  if (!els.length || reduced()) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const MAX = 4;
  els.forEach((el) => {
    let rect = null;
    const enter = () => { rect = el.getBoundingClientRect(); };
    const move = (e) => {
      if (!rect) rect = el.getBoundingClientRect();
      const dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      el.style.setProperty('--bl', `${Math.max(-1, Math.min(1, dx)) * MAX}px`);
      el.style.setProperty('--bt', `${Math.max(-1, Math.min(1, dy)) * MAX}px`);
    };
    const leave = () => {
      rect = null;
      el.style.setProperty('--bl', '0px');
      el.style.setProperty('--bt', '0px');
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('blur', leave);
  });
}

/* ══ 8 · FOOTER DOT GRID — lights up near the cursor ═══════════════════ */
export function initFooterDots(footer, canvas) {
  if (!footer) return;

  new IntersectionObserver(
    ([e]) => footer.classList.toggle('is-in', e.isIntersecting),
    { threshold: 0.18 }
  ).observe(footer);

  if (!canvas || reduced()) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const GAP = 26, R = 1.1, RADIUS = 132;
  let dpr = 1, w = 0, h = 0, cols = 0, rows = 0;
  let mx = -9999, my = -9999, target = { x: -9999, y: -9999 };
  let visible = false, stop = null, dirty = true;

  const styles = getComputedStyle(document.documentElement);
  const readAccent = () => (styles.getPropertyValue('--blueprint').trim() || '#3B6EF6');
  const readBase = () => (document.documentElement.classList.contains('dark')
    ? 'rgba(255,255,255,.16)' : 'rgba(11,11,12,.16)');
  let accent = readAccent(), base = readBase();

  function resize() {
    const r = footer.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / GAP) + 1;
    rows = Math.ceil(h / GAP) + 1;
    accent = readAccent(); base = readBase();
    dirty = true;
  }

  function draw() {
    // Ease the pointer so the field feels liquid without extra listeners.
    mx += (target.x - mx) * 0.14;
    my += (target.y - my) * 0.14;

    const moved = Math.abs(target.x - mx) > 0.4 || Math.abs(target.y - my) > 0.4;
    if (!moved && !dirty) return;
    dirty = false;

    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < cols; i += 1) {
      const x = i * GAP;
      const ddx = x - mx;
      if (ddx * ddx > RADIUS * RADIUS) {
        // Fast path: whole column is out of range — flat dots only.
        ctx.fillStyle = base;
        for (let j = 0; j < rows; j += 1) {
          ctx.beginPath();
          ctx.arc(x, j * GAP, R, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      for (let j = 0; j < rows; j += 1) {
        const y = j * GAP;
        const d = Math.hypot(ddx, y - my);
        if (d > RADIUS) {
          ctx.fillStyle = base;
          ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
        } else {
          const t = 1 - d / RADIUS;
          ctx.globalAlpha = 0.2 + t * 0.8;
          ctx.fillStyle = accent;
          ctx.beginPath(); ctx.arc(x, y, R + t * 1.8, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // Only burn frames while the footer is on screen.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !stop) { dirty = true; stop = addTask(draw); }
    else if (!visible && stop) { stop(); stop = null; }
  }, { threshold: 0 }).observe(footer);

  footer.addEventListener('pointermove', (e) => {
    const r = footer.getBoundingClientRect();
    target = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  footer.addEventListener('pointerleave', () => {
    target = { x: -9999, y: -9999 };
    dirty = true;
  });

  const ro = new ResizeObserver(resize);
  ro.observe(footer);
  resize();
}

/* ══ 9 · MARQUEE — seamless, pauses on hover ═══════════════════════════
   Duplicate the row once so translateX(-50%) loops with no seam. Duration
   scales with content width to keep a constant px/s speed.             */
export function initMarquee(nodes) {
  Array.from(nodes).forEach((marq) => {
    const track = marq.querySelector('[data-marquee-track]');
    const row = marq.querySelector('[data-marquee-row]');
    if (!track || !row) return;

    const clone = row.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('data-marquee-row');
    track.appendChild(clone);

    if (reduced()) return;

    const setDur = () => {
      const px = row.getBoundingClientRect().width;
      if (!px) return;
      track.style.setProperty('--marq-dur', `${Math.max(18, px / 44)}s`);
    };
    setDur();
    // Fonts land late; re-time once they do.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(setDur);
    new ResizeObserver(setDur).observe(row);
  });
}

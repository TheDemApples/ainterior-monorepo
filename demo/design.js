/* demo/design.js — ainterior floorplan designer (SPEC2 §H, fixes #1).
 * Plain ES modules, no build step, works from file:// (SPEC §8).
 * Units: integer mm everywhere; display unit is a view concern only (SPEC §1).
 */

import {
  createFloorplan, addRoom, removeRoom, moveRoom, resizeRoom, setRoomEdge, translateRoom,
  renameRoom, setFloorMaterial, addDoor, addWindow, updateOpening, removeOpening,
  connectRooms, disconnectRooms, rebuildInteriorWalls, roomMetrics, planMetrics,
  validateFloorplan, errorsOnly, floorplanToShell, PRESETS, presetById, createHistory,
  snapRect, snapScalar, setBriefItem, briefCount, saveHandoff, readHandoff,
  HANDOFF_KEY, DRAFT_KEY, GRID_MM, FLOOR_MATERIALS, areaUnits, findSharedEdges,
  bbox, polygonWall, polygonWalls, openingSegment, roomRect, uid, snap,
} from '../packages/floorplan/index.js';
import { CATALOG_DATA } from './catalog-data.js';

/* thumbnails are being added by a parallel agent — import defensively (SPEC2 §H) */
let THUMBS = {};
try {
  const mod = await import('../packages/catalog/thumbs.js');
  THUMBS = mod.THUMBS || {};
} catch { THUMBS = {}; }

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TWEEN_MS = 180;
const EASE = t => 1 - Math.pow(1 - t, 3); // ease-out cubic

/* ─────────────────────────── display units ─────────────────────────── */
const UNIT = {
  mm: { f: 1, label: 'mm', step: 100 },
  cm: { f: 0.1, label: 'cm', step: 10 },
  ft: { f: 0.003280839895, label: 'ft', step: 0.25 },
};
let unit = 'cm';
const toDisp = mm => mm * UNIT[unit].f;
const fromDisp = v => Math.round(v / UNIT[unit].f);
function fmtLen(mm) {
  if (unit === 'ft') {
    const inches = mm / 25.4, ft = Math.floor(inches / 12), inch = inches - ft * 12;
    return `${ft}′${inch.toFixed(1)}″`;
  }
  return `${(mm * UNIT[unit].f).toFixed(unit === 'mm' ? 0 : 1)}`;
}

/* ─────────────────────────── state ─────────────────────────── */
let fp = createFloorplan({ name: 'My floorplan' });
let history = createHistory(fp);
let step = 'entry';                    // entry | build | brief
let tool = 'select';                   // select | room | door | window
let selRoomId = null;
let selOpening = null;                 // {roomId, id}
let view = { scale: 0.08, ox: 0, oy: 0 };   // px per mm + canvas offset
let drag = null;
let hover = null;
let catalog = CATALOG_DATA.items;
let briefRoomId = null;
let catQuery = '', catCat = 'all';

const canvas = $('#plan');
const ctx = canvas.getContext('2d');
const dpr = () => Math.min(2, window.devicePixelRatio || 1);

/* ═══════════════════════ animated numeric feedback ═══════════════════════
 * The centrepiece of #1: typing a width/depth glides the room to the new size.
 * One rAF tween per room, ~180ms ease-out; witness lines + readout count along.
 */
const tweens = new Map();   // roomId -> {from, to, t0, raf}
const counts = new Map();   // element -> {from, to, t0, raf, fmt}

function tweenRoom(roomId, toRect, onDone) {
  const room = fp.rooms.find(r => r.id === roomId);
  if (!room) return;
  const to = Array.isArray(toRect) ? bbox(toRect)
    : (toRect || bbox(room.polygon_mm));
  if (REDUCED) { applyRect(roomId, to); onDone && onDone(); return; }
  const from = bbox(room.polygon_mm);
  const prev = tweens.get(roomId);
  if (prev) cancelAnimationFrame(prev.raf);
  const t0 = performance.now();
  const tick = now => {
    const k = Math.min(1, (now - t0) / TWEEN_MS);
    const e = EASE(k);
    const cur = {
      x0: from.x0 + (to.x0 - from.x0) * e, y0: from.y0 + (to.y0 - from.y0) * e,
      x1: from.x1 + (to.x1 - from.x1) * e, y1: from.y1 + (to.y1 - from.y1) * e,
    };
    applyRect(roomId, cur, /*live*/ true);
    draw();
    if (k < 1) tweens.set(roomId, { from: cur, to, t0, raf: requestAnimationFrame(tick) });
    else { tweens.delete(roomId); applyRect(roomId, to); onDone && onDone(); }
  };
  tweens.set(roomId, { from, to, t0, raf: requestAnimationFrame(tick) });
}

function applyRect(roomId, r, live = false) {
  const room = fp.rooms.find(x => x.id === roomId);
  if (!room) return;
  const x0 = Math.round(r.x0), y0 = Math.round(r.y0);
  const w = Math.max(GRID_MM, Math.round(r.x1 - r.x0));
  const d = Math.max(GRID_MM, Math.round(r.y1 - r.y0));
  room.polygon_mm = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]];
  if (!live) { rebuildInteriorWalls(fp); renderInspector(); renderRooms(); renderIssues(); persist(); }
}

/** Count a numeric element up/down instead of snapping it. */
function countTo(el, value, fmt = v => v) {
  if (!el) return;
  const prev = counts.get(el);
  if (prev) cancelAnimationFrame(prev.raf);
  if (REDUCED) { el.textContent = fmt(value); return; }
  const from = prev ? prev.cur : (parseFloat(el.dataset.v || '0') || 0);
  const t0 = performance.now();
  const tick = now => {
    const k = Math.min(1, (now - t0) / TWEEN_MS);
    const cur = from + (value - from) * EASE(k);
    el.dataset.v = String(cur);
    el.textContent = fmt(cur);
    if (k < 1) counts.set(el, { from, to: value, t0, cur, raf: requestAnimationFrame(tick) });
    else { counts.delete(el); el.dataset.v = String(value); el.textContent = fmt(value); }
  };
  counts.set(el, { from, to: value, t0, cur: from, raf: requestAnimationFrame(tick) });
}

/* ═══════════════════════ persistence ═══════════════════════ */
function persist() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(fp)); } catch { /* quota */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.rooms)) return null;
    return d;
  } catch { return null; }
}

/* ═══════════════════════ step navigation ═══════════════════════ */
const views = { entry: $('#entryView'), build: $('#buildView'), brief: $('#briefView') };
function setStep(s) {
  step = s;
  for (const [k, el] of Object.entries(views)) el.hidden = k !== s;
  $('#stepNav').hidden = s === 'entry';
  $('#unitNav').hidden = s === 'entry';
  $('#histNav').hidden = s !== 'build';
  $('#resetBtn').hidden = s === 'entry';
  $('#nextBtn').hidden = s !== 'build';
  $('#openBtn').hidden = s !== 'brief';
  $$('#stepSeg button').forEach(b => {
    const on = b.dataset.step === s;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  if (s === 'build') { fit(); draw(); renderAll(); }
  if (s === 'brief') { if (!briefRoomId) briefRoomId = fp.rooms[0]?.id || null; renderBrief(); }
}

/* ═══════════════════════ entry screen ═══════════════════════ */
function presetThumb(p, w = 320, h = 180) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#0B0B0C'; g.fillRect(0, 0, w, h);
  const rects = p.rooms.map(roomRect);
  const bb = { x0: Math.min(...rects.map(r => r.x0)), y0: Math.min(...rects.map(r => r.y0)),
    x1: Math.max(...rects.map(r => r.x1)), y1: Math.max(...rects.map(r => r.y1)) };
  const sc = Math.min((w - 40) / (bb.x1 - bb.x0), (h - 40) / (bb.y1 - bb.y0));
  const ox = (w - (bb.x1 - bb.x0) * sc) / 2, oy = (h - (bb.y1 - bb.y0) * sc) / 2;
  const px = x => ox + (x - bb.x0) * sc, py = y => h - (oy + (y - bb.y0) * sc);
  for (const r of p.rooms) {
    const b = bbox(r.polygon_mm);
    g.fillStyle = 'rgba(59,110,246,.10)';
    g.strokeStyle = '#3B6EF6'; g.lineWidth = 1.4;
    g.fillRect(px(b.x0), py(b.y1), b.w * sc, b.d * sc);
    g.strokeRect(px(b.x0), py(b.y1), b.w * sc, b.d * sc);
    g.fillStyle = '#8A8A93'; g.font = '10px "JetBrains Mono", monospace';
    g.fillText(r.name, px(b.x0) + 6, py(b.y1) + 14);
  }
  for (const iw of p.interior_walls || []) {
    g.strokeStyle = '#DC6B47'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px(iw.a[0]), py(iw.a[1])); g.lineTo(px(iw.b[0]), py(iw.b[1])); g.stroke();
  }
  return c.toDataURL('image/png');
}

function renderEntry() {
  const grid = $('#presetGrid');
  grid.innerHTML = '';
  PRESETS.forEach((p, i) => {
    const full = presetById(p.id);
    rebuildInteriorWalls(full);
    const m = planMetrics(full);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset';
    b.innerHTML = `
      <img class="thumb" alt="${p.name} plan" src="${presetThumb(full)}" />
      <span class="pname">${p.name}</span>
      <span class="pmeta mono dim">
        <span>${m.count} room${m.count === 1 ? '' : 's'}</span>
        <span>${m.area_m2.toFixed(1)} m²</span>
        <span>${m.area_ft2.toFixed(0)} ft²</span>
        <span>${full.interior_walls.length} int. wall${full.interior_walls.length === 1 ? '' : 's'}</span>
      </span>
      <span class="pblurb">${p.blurb}</span>`;
    b.addEventListener('click', () => {
      fp = full; history = createHistory(fp);
      persist();
      openInStudio();          // presets hand off straight to the studio (§H-a)
    });
    grid.appendChild(b);
  });

  const draft = loadDraft();
  const note = $('#draftNote');
  if (draft && draft.rooms.length) {
    note.hidden = false;
    $('#draftText').textContent =
      `You have a saved draft — “${draft.name}”, ${draft.rooms.length} room${draft.rooms.length === 1 ? '' : 's'}.`;
  } else note.hidden = true;

  // blur-reveal on entry
  $$('.reveal').forEach((el, i) => {
    el.style.transitionDelay = REDUCED ? '0s' : `${i * 60}ms`;
    requestAnimationFrame(() => el.classList.add('in'));
  });
}

$('#startBlank').addEventListener('click', () => {
  fp = createFloorplan({ name: 'My floorplan' });
  history = createHistory(fp);
  selRoomId = null; selOpening = null;
  persist(); setStep('build');
  toast('Drag on the canvas to place your first room.');
});
$('#resumeDraft').addEventListener('click', () => {
  const d = loadDraft(); if (!d) return;
  fp = d; history = createHistory(fp);
  selRoomId = fp.rooms[0]?.id || null;
  setStep('build');
});
$('#discardDraft').addEventListener('click', () => {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  renderEntry();
});

/* ═══════════════════════ canvas: view + draw ═══════════════════════ */
function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr()));
  canvas.height = Math.max(1, Math.round(r.height * dpr()));
  canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  draw();
}
const px = x => view.ox + x * view.scale;
const py = y => view.oy - y * view.scale;      // plan y is up; canvas y is down
const mmX = x => (x - view.ox) / view.scale;
const mmY = y => (view.oy - y) / view.scale;

function fit() {
  const wrap = canvas.parentElement.getBoundingClientRect();
  const rects = fp.rooms.map(roomRect);
  if (!rects.length) {
    view = { scale: 0.07, ox: wrap.width / 2, oy: wrap.height / 2 };
    draw(); return;
  }
  const bb = { x0: Math.min(...rects.map(r => r.x0)) - 600, y0: Math.min(...rects.map(r => r.y0)) - 600,
    x1: Math.max(...rects.map(r => r.x1)) + 600, y1: Math.max(...rects.map(r => r.y1)) + 600 };
  view.scale = Math.min(wrap.width / (bb.x1 - bb.x0), wrap.height / (bb.y1 - bb.y0));
  view.ox = (wrap.width - (bb.x1 - bb.x0) * view.scale) / 2 - bb.x0 * view.scale;
  view.oy = wrap.height - ((wrap.height - (bb.y1 - bb.y0) * view.scale) / 2 - bb.y0 * view.scale);
  draw();
}

const ROOM_FILL = 'rgba(59,110,246,.10)';
const ROOM_FILL_SEL = 'rgba(220,107,71,.13)';

function draw() {
  if (step !== 'build') return;
  const w = canvas.width / dpr(), h = canvas.height / dpr();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0B0B0C'; ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);
  drawEnvelope();
  for (const r of fp.rooms) drawRoom(r);
  drawGuides(w, h);
}

function drawGrid(w, h) {
  const stepPx = GRID_MM * view.scale;
  if (stepPx < 5) return;
  ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = view.ox % stepPx; x < w; x += stepPx) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = view.oy % stepPx; y < h; y += stepPx) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  // metre lines
  const mPx = 1000 * view.scale;
  if (mPx > 30) {
    ctx.strokeStyle = 'rgba(255,255,255,.075)';
    ctx.beginPath();
    for (let x = view.ox % mPx; x < w; x += mPx) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = view.oy % mPx; y < h; y += mPx) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }
}

function drawEnvelope() {
  if (!fp.rooms.length) return;
  const shell = floorplanToShell(fp);
  ctx.strokeStyle = 'rgba(245,242,237,.35)'; ctx.lineWidth = 2;
  ctx.beginPath();
  shell.polygon_mm.forEach(([x, y], i) => i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y)));
  ctx.closePath(); ctx.stroke();
  // interior walls — one per shared edge
  ctx.strokeStyle = '#DC6B47'; ctx.lineWidth = 3;
  for (const iw of shell.interior_walls) {
    ctx.beginPath(); ctx.moveTo(px(iw.a[0]), py(iw.a[1])); ctx.lineTo(px(iw.b[0]), py(iw.b[1])); ctx.stroke();
    for (const o of iw.openings) {
      const dir = [(iw.b[0] - iw.a[0]), (iw.b[1] - iw.a[1])];
      const len = Math.hypot(...dir) || 1; dir[0] /= len; dir[1] /= len;
      const p0 = [iw.a[0] + dir[0] * o.offset_mm, iw.a[1] + dir[1] * o.offset_mm];
      const p1 = [p0[0] + dir[0] * o.width_mm, p0[1] + dir[1] * o.width_mm];
      ctx.strokeStyle = '#0B0B0C'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(px(p0[0]), py(p0[1])); ctx.lineTo(px(p1[0]), py(p1[1])); ctx.stroke();
      ctx.strokeStyle = '#DC6B47'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(px(p0[0]), py(p0[1])); ctx.lineTo(px(p1[0]), py(p1[1])); ctx.stroke();
      ctx.strokeStyle = '#DC6B47'; ctx.lineWidth = 3;
    }
  }
}

function drawRoom(r) {
  const b = bbox(r.polygon_mm);
  const sel = r.id === selRoomId;
  const x = px(b.x0), y = py(b.y1), w = b.w * view.scale, h = b.d * view.scale;
  ctx.fillStyle = sel ? ROOM_FILL_SEL : ROOM_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = sel ? '#DC6B47' : '#3B6EF6';
  ctx.lineWidth = sel ? 2 : 1.4;
  ctx.strokeRect(x, y, w, h);

  // openings
  for (const o of r.openings || []) {
    const [p0, p1] = openingSegment(r.polygon_mm, o);
    const isSel = selOpening && selOpening.id === o.id;
    ctx.strokeStyle = '#0B0B0C'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(px(p0[0]), py(p0[1])); ctx.lineTo(px(p1[0]), py(p1[1])); ctx.stroke();
    ctx.strokeStyle = o.type === 'door' ? (isSel ? '#F5F2ED' : '#DC6B47') : (isSel ? '#F5F2ED' : '#3B6EF6');
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(px(p0[0]), py(p0[1])); ctx.lineTo(px(p1[0]), py(p1[1])); ctx.stroke();
    if (o.type === 'door') {  // swing arc
      const wall = polygonWall(r.polygon_mm, o.wall_index);
      const nrm = [-wall.dir[1], wall.dir[0]];
      ctx.strokeStyle = 'rgba(220,107,71,.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px(p0[0]), py(p0[1]), o.width_mm * view.scale, 0, Math.PI * 2);
      ctx.stroke();
      void nrm;
    }
  }

  // name + live area
  if (w > 46 && h > 30) {
    const m = roomMetrics(r);
    ctx.fillStyle = sel ? '#F5F2ED' : '#C9C4BB';
    ctx.font = '600 11px "Inter Tight", sans-serif';
    ctx.fillText(r.name, x + 7, y + 15);
    ctx.fillStyle = '#8A8A93'; ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(`${m.area_m2.toFixed(2)} m² · ${m.area_ft2.toFixed(0)} ft²`, x + 7, y + 28);
  }

  // dimension witness lines — they ride the tween because they read live geometry
  drawWitness(b, sel);

  // handles when selected
  if (sel) {
    ctx.fillStyle = '#F5F2ED';
    for (const [hx, hy] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
      ctx.beginPath(); ctx.arc(px(hx), py(hy), 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(245,242,237,.8)'; ctx.lineWidth = 1;
    for (const [ex, ey] of [[(b.x0 + b.x1) / 2, b.y0], [(b.x0 + b.x1) / 2, b.y1], [b.x0, (b.y0 + b.y1) / 2], [b.x1, (b.y0 + b.y1) / 2]]) {
      ctx.strokeRect(px(ex) - 3.5, py(ey) - 3.5, 7, 7);
    }
  }
}

function drawWitness(b, sel) {
  const off = 16;
  ctx.strokeStyle = sel ? 'rgba(220,107,71,.85)' : 'rgba(59,110,246,.6)';
  ctx.fillStyle = sel ? '#DC6B47' : '#3B6EF6';
  ctx.lineWidth = 1;
  ctx.font = '10px "JetBrains Mono", monospace';
  // width witness (below)
  const yw = py(b.y0) + off;
  ctx.beginPath();
  ctx.moveTo(px(b.x0), yw); ctx.lineTo(px(b.x1), yw);
  ctx.moveTo(px(b.x0), yw - 4); ctx.lineTo(px(b.x0), yw + 4);
  ctx.moveTo(px(b.x1), yw - 4); ctx.lineTo(px(b.x1), yw + 4);
  ctx.stroke();
  ctx.fillText(fmtLen(b.w) + (unit === 'ft' ? '' : UNIT[unit].label), (px(b.x0) + px(b.x1)) / 2 - 18, yw + 12);
  // depth witness (left)
  const xd = px(b.x0) - off;
  ctx.beginPath();
  ctx.moveTo(xd, py(b.y0)); ctx.lineTo(xd, py(b.y1));
  ctx.moveTo(xd - 4, py(b.y0)); ctx.lineTo(xd + 4, py(b.y0));
  ctx.moveTo(xd - 4, py(b.y1)); ctx.lineTo(xd + 4, py(b.y1));
  ctx.stroke();
  ctx.save();
  ctx.translate(xd - 6, (py(b.y0) + py(b.y1)) / 2 + 18);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(fmtLen(b.d) + (unit === 'ft' ? '' : UNIT[unit].label), 0, 0);
  ctx.restore();
}

let guides = [];
function drawGuides(w, h) {
  if (!guides.length) return;
  ctx.strokeStyle = 'rgba(224,163,60,.8)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === 'v') { ctx.moveTo(px(g.at), 0); ctx.lineTo(px(g.at), h); }
    else { ctx.moveTo(0, py(g.at)); ctx.lineTo(w, py(g.at)); }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/* ═══════════════════════ canvas: hit-testing + pointer ═══════════════════════ */
function hitTest(mx, my) {
  const x = mmX(mx), y = mmY(my);
  // openings first (they're on top)
  for (const r of fp.rooms) {
    for (const o of r.openings || []) {
      const [p0, p1] = openingSegment(r.polygon_mm, o);
      const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
      if (Math.hypot(px(cx) - mx, py(cy) - my) < 14) return { kind: 'opening', room: r, opening: o };
    }
  }
  for (let i = fp.rooms.length - 1; i >= 0; i--) {
    const r = fp.rooms[i];
    const b = bbox(r.polygon_mm);
    const tol = 9 / view.scale;
    const inX = x >= b.x0 - tol && x <= b.x1 + tol;
    const inY = y >= b.y0 - tol && y <= b.y1 + tol;
    if (!inX || !inY) continue;
    const nearW = Math.abs(x - b.x0) <= tol, nearE = Math.abs(x - b.x1) <= tol;
    const nearS = Math.abs(y - b.y0) <= tol, nearN = Math.abs(y - b.y1) <= tol;
    if ((nearW || nearE) && (nearS || nearN))
      return { kind: 'corner', room: r, corner: `${nearW ? 'w' : 'e'}${nearS ? 's' : 'n'}` };
    if (nearW || nearE) return { kind: 'edge', room: r, side: nearW ? 'w' : 'e' };
    if (nearS || nearN) return { kind: 'edge', room: r, side: nearS ? 's' : 'n' };
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return { kind: 'body', room: r };
  }
  return null;
}

function nearestWall(x, y) {
  let best = null;
  for (const r of fp.rooms) {
    for (const w of polygonWalls(r.polygon_mm)) {
      const t = (x - w.a[0]) * w.dir[0] + (y - w.a[1]) * w.dir[1];
      const qx = w.a[0] + w.dir[0] * t, qy = w.a[1] + w.dir[1] * t;
      const d = Math.hypot(x - qx, y - qy);
      if (t >= -1 && t <= w.length_mm + 1 && (!best || d < best.d))
        best = { room: r, wall: w, t, d };
    }
  }
  return best && best.d < 16 / view.scale ? best : null;
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const x = mmX(mx), y = mmY(my);

  if (tool === 'door' || tool === 'window') {
    const hit = nearestWall(x, y);
    if (hit) {
      history.commit(d => {
        const spec = { wall_index: hit.wall.index, offset_mm: Math.max(0, Math.round(hit.t - (tool === 'door' ? 450 : 600))) };
        const o = tool === 'door' ? addDoor(d, hit.room.id, spec) : addWindow(d, hit.room.id, spec);
        if (o) selOpening = { roomId: hit.room.id, id: o.id };
        selRoomId = hit.room.id;
      });
      syncFromHistory();
      toast(`${tool === 'door' ? 'Door' : 'Window'} placed — drag it along the wall.`);
    }
    return;
  }

  const hit = hitTest(mx, my);
  if (tool === 'room' || !hit) {
    // begin a new room drag
    const gx = snap(x), gy = snap(y);
    drag = { kind: 'new', x0: gx, y0: gy, x1: gx, y1: gy, moved: false };
    return;
  }
  selRoomId = hit.room.id;
  if (hit.kind === 'opening') selOpening = { roomId: hit.room.id, id: hit.opening.id };
  else if (hit.kind !== 'opening') selOpening = null;
  renderAll();
  drag = { kind: hit.kind, room: hit.room, side: hit.side, corner: hit.corner,
    opening: hit.opening, startX: x, startY: y, orig: bbox(hit.room.polygon_mm), moved: false };
});

canvas.addEventListener('pointermove', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const x = mmX(mx), y = mmY(my);
  $('#hudCursor').innerHTML = `<b>${fmtLen(Math.round(x))}</b> , <b>${fmtLen(Math.round(y))}</b>`;
  hover = hitTest(mx, my);
  canvas.style.cursor = cursorFor(hover);

  if (!drag) return;
  drag.moved = true;
  const others = fp.rooms.filter(r => r !== drag.room).map(roomRect);

  if (drag.kind === 'new') {
    drag.x1 = x; drag.y1 = y;
    const rx0 = Math.min(drag.x0, x), ry0 = Math.min(drag.y0, y);
    const rx1 = Math.max(drag.x0, x), ry1 = Math.max(drag.y0, y);
    const s = snapRect({ x0: rx0, y0: ry0, x1: Math.max(rx1, rx0 + GRID_MM), y1: Math.max(ry1, ry0 + GRID_MM) }, others);
    drag.rect = s; guides = s.guides;
    drawGhost(s);
    return;
  }
  if (drag.kind === 'body') {
    const s = snapRect({
      x0: drag.orig.x0 + (x - drag.startX), y0: drag.orig.y0 + (y - drag.startY),
      x1: drag.orig.x1 + (x - drag.startX), y1: drag.orig.y1 + (y - drag.startY),
    }, others);
    guides = s.guides;
    applyRect(drag.room.id, s, true);
    draw();
    return;
  }
  if (drag.kind === 'edge' || drag.kind === 'corner') {
    const sides = drag.kind === 'corner'
      ? [drag.corner[0], drag.corner[1]] : [drag.side];
    const candX = others.flatMap(o => [o.x0, o.x1]);
    const candY = others.flatMap(o => [o.y0, o.y1]);
    let r = { ...drag.orig };
    guides = [];
    for (const s of sides) {
      if (s === 'w' || s === 'e') {
        const v = snapScalar(x, candX);
        if (s === 'w') r.x0 = Math.min(v.value, r.x1 - GRID_MM); else r.x1 = Math.max(v.value, r.x0 + GRID_MM);
        if (v.snapped) guides.push({ axis: 'v', at: v.value });
      } else {
        const v = snapScalar(y, candY);
        if (s === 's') r.y0 = Math.min(v.value, r.y1 - GRID_MM); else r.y1 = Math.max(v.value, r.y0 + GRID_MM);
        if (v.snapped) guides.push({ axis: 'h', at: v.value });
      }
    }
    applyRect(drag.room.id, r, true);
    draw();
    return;
  }
  if (drag.kind === 'opening' && drag.opening) {
    const hit = nearestWall(x, y);
    if (hit && hit.room.id === drag.room.id) {
      const o = drag.opening;
      const off = Math.max(0, Math.min(Math.round(hit.t - o.width_mm / 2), hit.wall.length_mm - o.width_mm));
      o.wall_index = hit.wall.index; o.offset_mm = off;
      draw(); renderInspector();
    }
  }
});

function drawGhost(s) {
  draw();
  ctx.strokeStyle = '#E0A33C'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.6;
  ctx.strokeRect(px(s.x0), py(s.y1), (s.x1 - s.x0) * view.scale, (s.y1 - s.y0) * view.scale);
  ctx.setLineDash([]);
  ctx.fillStyle = '#E0A33C'; ctx.font = '11px "JetBrains Mono", monospace';
  ctx.fillText(`${fmtLen(s.x1 - s.x0)} × ${fmtLen(s.y1 - s.y0)}`, px(s.x0) + 6, py(s.y1) - 8);
}

canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  guides = [];
  if (drag.kind === 'new') {
    const s = drag.rect;
    if (s && (s.x1 - s.x0) >= GRID_MM && (s.y1 - s.y0) >= GRID_MM) {
      history.commit(d => {
        const r = addRoom(d, { name: `Room ${d.rooms.length + 1}`,
          w_mm: s.x1 - s.x0, d_mm: s.y1 - s.y0, at: [s.x0, s.y0] });
        selRoomId = r.id;
      });
      syncFromHistory();
      setTool('select');
    }
  } else if (drag.moved && drag.kind !== 'opening') {
    const id = drag.room.id;
    const finalRect = bbox(drag.room.polygon_mm);
    history.commit(d => {
      const r = d.rooms.find(x => x.id === id);
      if (r) { r.polygon_mm = [[finalRect.x0, finalRect.y0], [finalRect.x1, finalRect.y0],
        [finalRect.x1, finalRect.y1], [finalRect.x0, finalRect.y1]]; rebuildInteriorWalls(d); }
    });
    syncFromHistory();
  } else if (drag.kind === 'opening') {
    history.commit(d => {
      const r = d.rooms.find(x => x.id === drag.room.id);
      const o = r && r.openings.find(x => x.id === drag.opening.id);
      if (o) { o.wall_index = drag.opening.wall_index; o.offset_mm = drag.opening.offset_mm; }
    });
    syncFromHistory();
  }
  drag = null;
  draw();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const ns = Math.min(0.5, Math.max(0.012, view.scale * k));
  view.ox = mx - (mx - view.ox) * (ns / view.scale);
  view.oy = my - (my - view.oy) * (ns / view.scale);
  view.scale = ns;
  draw();
}, { passive: false });

function cursorFor(h) {
  if (!h) return tool === 'select' ? 'crosshair' : 'copy';
  if (h.kind === 'body') return 'move';
  if (h.kind === 'opening') return 'grab';
  if (h.kind === 'corner') return h.corner === 'ws' || h.corner === 'en' ? 'nesw-resize' : 'nwse-resize';
  if (h.kind === 'edge') return h.side === 'w' || h.side === 'e' ? 'ew-resize' : 'ns-resize';
  return 'default';
}

/* ═══════════════════════ inspector ═══════════════════════ */
function renderAll() { renderRooms(); renderInspector(); renderIssues(); renderTotals(); draw(); }

function renderRooms() {
  const list = $('#roomList');
  list.innerHTML = '';
  $('#roomCount').textContent = `${fp.rooms.length}`;
  for (const r of fp.rooms) {
    const m = roomMetrics(r);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'room-item' + (r.id === selRoomId ? ' on' : '');
    b.innerHTML = `<span class="sw" style="background:${matColor(r.floor_material)}"></span>
      <span class="rn">${r.name}</span><span class="ra">${m.area_m2.toFixed(1)} m²</span>`;
    b.addEventListener('click', () => { selRoomId = r.id; selOpening = null; renderAll(); });
    list.appendChild(b);
  }
}

function matColor(m) {
  return { oak: '#B08A5A', ash: '#C9BBA6', concrete: '#8A8A93', tile: '#7FA3B8', carpet: '#A97F6B' }[m] || '#B08A5A';
}

function renderTotals() {
  const m = planMetrics(fp);
  $('#totArea').innerHTML = `${m.area_m2.toFixed(2)}<small>m²</small>`;
  $('#totAreaFt').innerHTML = `${m.area_ft2.toFixed(1)}<small>ft²</small>`;
  $('#totEnv').innerHTML = m.count
    ? `${fmtLen(m.footprint_mm.w)}×${fmtLen(m.footprint_mm.d)}<small>${unit === 'ft' ? '' : UNIT[unit].label}</small>` : '—';
  $('#totWalls').textContent = String(fp.interior_walls.length);
}

function renderInspector() {
  const host = $('#inspector');
  const room = fp.rooms.find(r => r.id === selRoomId);
  $('#selName').textContent = room ? room.name : '—';
  if (!room) {
    host.innerHTML = `<p class="dim" style="font-size:12px;line-height:1.6">
      Nothing selected.<br><br>Drag on the canvas to place a room, then drag its edges,
      corners or body. Click a wall with the door/window tool to place an opening.</p>`;
    return;
  }
  const b = bbox(room.polygon_mm);
  const m = roomMetrics(room);
  host.innerHTML = `
    <div class="field"><label for="fName">name</label>
      <input id="fName" class="input" value="${esc(room.name)}" maxlength="60" /></div>
    <div class="row">
      <div class="field numwrap" id="wWrap"><label for="fW">width (${UNIT[unit].label})</label>
        <input id="fW" class="input mono" type="number" min="${toDisp(GRID_MM)}" step="${UNIT[unit].step}"
          value="${toDisp(b.w).toFixed(unit === 'mm' ? 0 : 1)}" />
        <span class="glide" id="wGlide"></span></div>
      <div class="field numwrap" id="dWrap"><label for="fD">depth (${UNIT[unit].label})</label>
        <input id="fD" class="input mono" type="number" min="${toDisp(GRID_MM)}" step="${UNIT[unit].step}"
          value="${toDisp(b.d).toFixed(unit === 'mm' ? 0 : 1)}" />
        <span class="glide" id="dGlide"></span></div>
    </div>
    <div class="row">
      <div class="field"><label for="fX">x (${UNIT[unit].label})</label>
        <input id="fX" class="input mono" type="number" step="${UNIT[unit].step}" value="${toDisp(b.x0).toFixed(unit === 'mm' ? 0 : 1)}" /></div>
      <div class="field"><label for="fY">y (${UNIT[unit].label})</label>
        <input id="fY" class="input mono" type="number" step="${UNIT[unit].step}" value="${toDisp(b.y0).toFixed(unit === 'mm' ? 0 : 1)}" /></div>
    </div>
    <div class="row">
      <div class="field"><label for="fH">ceiling (mm)</label>
        <input id="fH" class="input mono" type="number" min="2000" step="50" value="${room.height_mm}" /></div>
      <div class="field"><label for="fMat">floor material</label>
        <select id="fMat" class="input">${FLOOR_MATERIALS.map(f =>
          `<option value="${f}" ${f === room.floor_material ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
    </div>
    <div class="metrics">
      <div class="metric"><span class="k">area</span><span class="v" id="mArea">${m.area_m2.toFixed(2)}<small>m²</small></span></div>
      <div class="metric"><span class="k">area</span><span class="v" id="mAreaFt">${m.area_ft2.toFixed(1)}<small>ft²</small></span></div>
      <div class="metric"><span class="k">perimeter</span><span class="v">${(m.perimeter_m).toFixed(2)}<small>m</small></span></div>
      <div class="metric"><span class="k">openings</span><span class="v">${room.openings.length}</span></div>
    </div>
    <div class="grp">
      <div class="grp-head"><span class="eyebrow">doors &amp; windows</span>
        <span class="bar-group">
          <button class="btn tiny" id="addDoorBtn" type="button">+ door</button>
          <button class="btn tiny" id="addWinBtn" type="button">+ window</button>
        </span></div>
      <div class="grp-body"><div class="op-list" id="opList"></div></div>
    </div>
    <div class="grp">
      <div class="grp-head"><span class="eyebrow">interior doors</span></div>
      <div class="grp-body" id="connBody"></div>
    </div>
    <button class="btn ghost" id="delRoomBtn" type="button" style="color:var(--err)">delete room</button>`;

  /* ── wiring ── */
  $('#fName').addEventListener('input', e => {
    history.commit(d => renameRoom(d, room.id, e.target.value));
    fp = history.current; renderRooms(); persist();
  });
  $('#fMat').addEventListener('change', e => {
    history.commit(d => setFloorMaterial(d, room.id, e.target.value));
    syncFromHistory();
  });
  $('#fH').addEventListener('change', e => {
    history.commit(d => { const r = d.rooms.find(x => x.id === room.id); if (r) r.height_mm = Math.max(2000, Math.round(+e.target.value || 2600)); });
    syncFromHistory();
  });
  $('#fX').addEventListener('change', e => {
    const b2 = bbox(room.polygon_mm);
    history.commit(d => moveRoom(d, room.id, [fromDisp(+e.target.value || 0), b2.y0]));
    syncFromHistory();
  });
  $('#fY').addEventListener('change', e => {
    const b2 = bbox(room.polygon_mm);
    history.commit(d => moveRoom(d, room.id, [b2.x0, fromDisp(+e.target.value || 0)]));
    syncFromHistory();
  });

  /* ── THE animated numeric feedback: type a width, the wall glides out ── */
  const wireDim = (inputSel, wrapSel, glideSel, axis) => {
    const input = $(inputSel), wrap = $(wrapSel), glide = $(glideSel);
    let deb = null;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v <= 0) return;
      const mm = fromDisp(v);
      const cur = bbox(room.polygon_mm);
      const target = axis === 'w'
        ? { x0: cur.x0, y0: cur.y0, x1: cur.x0 + mm, y1: cur.y1 }
        : { x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y0 + mm };
      wrap.classList.add('gliding');
      countTo(glide, mm, val => `${fmtLen(Math.round(val))}${unit === 'ft' ? '' : 'mm'}`);
      clearTimeout(deb);
      tweenRoom(room.id, target, () => {
        wrap.classList.remove('gliding');
        history.commit(d => {
          const r = d.rooms.find(x => x.id === room.id);
          if (r) { const x0 = Math.round(target.x0), y0 = Math.round(target.y0);
            const x1 = Math.round(target.x1), y1 = Math.round(target.y1);
            r.polygon_mm = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            rebuildInteriorWalls(d); }
        });
        fp = history.current; renderAll();
      });
      deb = setTimeout(() => {}, 0);
    });
  };
  wireDim('#fW', '#wWrap', '#wGlide', 'w');
  wireDim('#fD', '#dWrap', '#dGlide', 'd');

  $('#addDoorBtn').addEventListener('click', () => setTool('door'));
  $('#addWinBtn').addEventListener('click', () => setTool('window'));
  $('#delRoomBtn').addEventListener('click', () => {
    history.commit(d => removeRoom(d, room.id));
    selRoomId = null; selOpening = null;
    syncFromHistory();
  });

  renderOpenings(room);
  renderConnections(room);
}

function renderOpenings(room) {
  const list = $('#opList');
  list.innerHTML = '';
  if (!room.openings.length) {
    list.innerHTML = `<p class="dim" style="font-size:11.5px;margin:0">None yet — pick the door or window tool and click a wall.</p>`;
    return;
  }
  const walls = polygonWalls(room.polygon_mm);
  for (const o of room.openings) {
    const el = document.createElement('div');
    el.className = 'op' + (selOpening && selOpening.id === o.id ? ' on' : '');
    el.innerHTML = `
      <div class="op-top">
        <span class="tag ${o.type}">${o.type}</span>
        <span class="mono dim">wall ${o.wall_index}</span>
        <span class="sp"></span>
        <button class="btn tiny" data-act="del" type="button">✕</button>
      </div>
      <div class="row3">
        <div class="field"><label>offset mm</label>
          <input class="input mono" type="number" data-k="offset_mm" value="${o.offset_mm}" min="0" step="50" /></div>
        <div class="field"><label>width mm</label>
          <input class="input mono" type="number" data-k="width_mm" value="${o.width_mm}" min="300" step="50" /></div>
        <div class="field"><label>${o.type === 'door' ? 'swing' : 'sill mm'}</label>
          ${o.type === 'door'
            ? `<select class="input" data-k="swing">${['in-left', 'in-right', 'out-left', 'out-right'].map(s =>
                `<option ${s === o.swing ? 'selected' : ''}>${s}</option>`).join('')}</select>`
            : `<input class="input mono" type="number" data-k="sill_mm" value="${o.sill_mm}" min="0" step="50" />`}
        </div>
      </div>`;
    el.querySelector('[data-act="del"]').addEventListener('click', () => {
      history.commit(d => removeOpening(d, room.id, o.id));
      if (selOpening && selOpening.id === o.id) selOpening = null;
      syncFromHistory();
    });
    el.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        const v = k === 'swing' ? inp.value : Math.round(+inp.value || 0);
        history.commit(d => updateOpening(d, room.id, o.id, { [k]: v }));
        syncFromHistory();
      });
    });
    el.addEventListener('click', ev => {
      if (ev.target.closest('button,input,select')) return;
      selOpening = { roomId: room.id, id: o.id }; renderAll();
    });
    list.appendChild(el);
  }
  void walls;
}

function renderConnections(room) {
  const host = $('#connBody');
  host.innerHTML = '';
  const shared = findSharedEdges(fp.rooms).filter(s => s.a_room === room.id || s.b_room === room.id);
  if (!shared.length) {
    host.innerHTML = `<p class="dim" style="font-size:11.5px;margin:0">No shared walls — drag this room against a neighbour to connect them.</p>`;
    return;
  }
  for (const s of shared) {
    const otherId = s.a_room === room.id ? s.b_room : s.a_room;
    const other = fp.rooms.find(r => r.id === otherId);
    const conn = (fp.connections || []).find(c =>
      (c.a_room === s.a_room && c.b_room === s.b_room) || (c.a_room === s.b_room && c.b_room === s.a_room));
    const row = document.createElement('div');
    row.className = 'op';
    row.innerHTML = `
      <div class="op-top">
        <span class="tag door">${conn ? (conn.type === 'opening' ? 'opening' : 'door') : 'wall'}</span>
        <span style="font-size:11.5px">${esc(other ? other.name : otherId)}</span>
        <span class="sp"></span>
        <span class="mono dim">${s.length_mm}mm shared</span>
      </div>
      ${conn ? `
      <div class="row3">
        <div class="field"><label>offset mm</label>
          <input class="input mono" type="number" data-k="offset_mm" value="${conn.offset_mm}" min="0" step="50" /></div>
        <div class="field"><label>width mm</label>
          <input class="input mono" type="number" data-k="width_mm" value="${conn.width_mm}" min="600" step="50" /></div>
        <div class="field"><label>&nbsp;</label>
          <button class="btn tiny" data-act="rm" type="button">remove door</button></div>
      </div>` : `
      <div class="bar-group">
        <button class="btn sm" data-act="door" type="button">add interior door</button>
        <button class="btn sm ghost" data-act="open" type="button">open archway</button>
      </div>`}`;
    if (conn) {
      row.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
        history.commit(d => connectRooms(d, s.a_room, s.b_room,
          { ...conn, [inp.dataset.k]: Math.round(+inp.value || 0) }));
        syncFromHistory();
      }));
      row.querySelector('[data-act="rm"]').addEventListener('click', () => {
        history.commit(d => disconnectRooms(d, s.a_room, s.b_room));
        syncFromHistory();
      });
    } else {
      row.querySelector('[data-act="door"]').addEventListener('click', () => {
        history.commit(d => connectRooms(d, s.a_room, s.b_room, {}));
        syncFromHistory();
      });
      row.querySelector('[data-act="open"]').addEventListener('click', () => {
        history.commit(d => connectRooms(d, s.a_room, s.b_room, { type: 'opening', width_mm: Math.min(1200, s.length_mm) }));
        syncFromHistory();
      });
    }
    host.appendChild(row);
  }
}

/* ═══════════════════════ validation (inline, non-blocking) ═══════════════════════ */
function renderIssues() {
  const issues = validateFloorplan(fp);
  const errs = issues.filter(i => i.severity === 'error').length;
  const warns = issues.filter(i => i.severity === 'warn').length;
  $('#issueCount').textContent = issues.length ? `${errs} err · ${warns} warn` : 'clean';
  const host = $('#issues');
  host.innerHTML = '';
  if (!issues.length) {
    host.innerHTML = `<span class="issue-none">✓ plan is valid</span>`;
    return;
  }
  for (const i of issues.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `issue ${i.severity}`;
    b.innerHTML = `<span class="code">${i.code}</span><span>${esc(i.message)}</span>`;
    if (i.room_id) b.addEventListener('click', () => { selRoomId = i.room_id; renderAll(); });
    host.appendChild(b);
  }
  if (issues.length > 8)
    host.insertAdjacentHTML('beforeend', `<span class="dim mono" style="font-size:10px">+${issues.length - 8} more</span>`);
}

/* ═══════════════════════ furniture brief ═══════════════════════ */
function renderBrief() {
  const rooms = fp.rooms;
  const rl = $('#briefRoomList');
  rl.innerHTML = '';
  $('#briefTotal').textContent = String(briefCount(fp));
  for (const r of rooms) {
    const n = (fp.brief?.[r.id] || []).reduce((s, e) => s + e.qty, 0);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'room-item' + (r.id === briefRoomId ? ' on' : '');
    b.innerHTML = `<span class="sw" style="background:${matColor(r.floor_material)}"></span>
      <span class="rn">${esc(r.name)}</span><span class="ra">${n} pc</span>`;
    b.addEventListener('click', () => { briefRoomId = r.id; renderBrief(); });
    rl.appendChild(b);
  }
  $('#briefRoomName').textContent = rooms.find(r => r.id === briefRoomId)?.name || '—';
  renderCatChips();
  renderCatList();
  renderPicked();
}

function renderCatChips() {
  const cats = ['all', ...new Set(catalog.map(i => i.category))];
  const host = $('#catChips');
  host.innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn' + (c === catCat ? ' on' : '');
    b.textContent = c;
    b.addEventListener('click', () => { catCat = c; renderBrief(); });
    host.appendChild(b);
  }
}

function renderCatList() {
  const q = catQuery.trim().toLowerCase();
  const items = catalog.filter(i =>
    (catCat === 'all' || i.category === catCat) &&
    (!q || [i.name, i.product_type, i.brand, ...(i.tags || [])].join(' ').toLowerCase().includes(q)));
  $('#catCount').textContent = `${items.length} / ${catalog.length}`;
  const host = $('#catList');
  host.innerHTML = '';
  const picked = fp.brief?.[briefRoomId] || [];
  for (const it of items.slice(0, 120)) {
    const entry = picked.find(e => e.item_id === it.id);
    const qty = entry ? entry.qty : 0;
    const row = document.createElement('div');
    row.className = 'cat-row' + (qty ? ' has' : '');
    const thumb = THUMBS[it.id];
    row.innerHTML = `
      <span class="th">${thumb
        ? `<img src="${thumb}" alt="" loading="lazy" />`
        : `<span class="ph">${esc((i => i[0])(it.name))}</span>`}</span>
      <span class="meta">
        <span class="nm">${esc(it.brand)} ${esc(it.name)}</span>
        <span class="sub">${esc(it.product_type)} · ${it.dims_mm.w}×${it.dims_mm.d}×${it.dims_mm.h}mm${it.price_usd != null ? ` · $${it.price_usd}` : ''}</span>
      </span>
      <span class="qty">
        <button class="btn tiny" data-d="-1" type="button" aria-label="fewer">−</button>
        <span class="n">${qty}</span>
        <button class="btn tiny" data-d="1" type="button" aria-label="more">+</button>
      </span>`;
    row.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => {
      history.commit(d => setBriefItem(d, briefRoomId, it.id, qty + (+b.dataset.d)));
      fp = history.current; persist(); renderBrief();
    }));
    host.appendChild(row);
  }
  if (!items.length) host.innerHTML = `<p class="dim" style="font-size:12px">No catalog items match.</p>`;
}

function renderPicked() {
  const host = $('#briefPicked');
  const picked = fp.brief?.[briefRoomId] || [];
  if (!picked.length) { host.innerHTML = `<span class="dim" style="font-size:11px">Nothing picked for this room yet.</span>`; return; }
  host.innerHTML = `<span class="eyebrow">picked for this room</span>` + picked.map(e => {
    const it = catalog.find(x => x.id === e.item_id);
    return `<div class="picked-row"><span class="mono">${e.qty}×</span>
      <span class="sp">${it ? esc(it.brand + ' ' + it.name) : esc(e.item_id)}</span></div>`;
  }).join('');
}

$('#catSearch').addEventListener('input', e => { catQuery = e.target.value; renderCatList(); });

/* ═══════════════════════ handoff ═══════════════════════ */
function openInStudio() {
  rebuildInteriorWalls(fp);
  const { url } = saveHandoff(fp, localStorage, 'editor.html');
  const errs = errorsOnly(validateFloorplan(fp)).length;
  toast(errs ? `Opening the studio with ${errs} validation error${errs === 1 ? '' : 's'} flagged…` : 'Handing off to the studio…');
  setTimeout(() => { window.location.href = url; }, REDUCED ? 0 : 450);
}
$('#openBtn').addEventListener('click', openInStudio);

/* ═══════════════════════ toolbar / misc ═══════════════════════ */
function setTool(t) {
  tool = t;
  $$('#toolSeg button').forEach(b => {
    const on = b.dataset.tool === t;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  canvas.classList.toggle('mode-select', t === 'select');
}
$$('#toolSeg button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$$('#stepSeg button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.step === 'entry') setStep('entry');
  else if (!fp.rooms.length && b.dataset.step === 'brief') toast('Draw at least one room first.');
  else setStep(b.dataset.step);
}));
$$('#unitSeg button').forEach(b => b.addEventListener('click', () => {
  unit = b.dataset.unit;
  $$('#unitSeg button').forEach(x => {
    const on = x.dataset.unit === unit;
    x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on));
  });
  renderAll();
}));
$('#fitBtn').addEventListener('click', fit);
$('#delBtn').addEventListener('click', () => {
  if (selOpening) {
    history.commit(d => removeOpening(d, selOpening.roomId, selOpening.id));
    selOpening = null;
  } else if (selRoomId) {
    history.commit(d => removeRoom(d, selRoomId));
    selRoomId = null;
  }
  syncFromHistory();
});
$('#addRoomBtn').addEventListener('click', () => setTool('room'));
$('#nextBtn').addEventListener('click', () => {
  if (!fp.rooms.length) { toast('Draw at least one room first.'); return; }
  setStep('brief');
});
$('#resetBtn').addEventListener('click', () => {
  fp = createFloorplan({ name: 'My floorplan' });
  history = createHistory(fp);
  selRoomId = null; selOpening = null; briefRoomId = null;
  persist(); setStep('build');
});
$('#undoBtn').addEventListener('click', () => { history.undo(); fp = history.current; renderAll(); persist(); });
$('#redoBtn').addEventListener('click', () => { history.redo(); fp = history.current; renderAll(); persist(); });

function syncFromHistory() { fp = history.current; renderAll(); persist(); }

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); fp = history.current; renderAll(); persist(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); fp = history.current; renderAll(); persist(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && step === 'build' && !e.target.closest('input,select,textarea')) {
    $('#delBtn').click();
  } else if (e.key === 'Escape') { selOpening = null; setTool('select'); renderAll(); }
});

let toastT = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ═══════════════════════ boot ═══════════════════════ */
new ResizeObserver(() => { if (step === 'build') resizeCanvas(); }).observe(canvas.parentElement);
window.addEventListener('resize', () => { if (step === 'build') resizeCanvas(); });

renderEntry();
setStep('entry');
resizeCanvas();

/* test hooks (harmless in production) */
window.__design = {
  get fp() { return fp; },
  setStep, fit, draw, openInStudio,
  addRoomAt: (w, d, x, y) => { history.commit(dd => { const r = addRoom(dd, { w_mm: w, d_mm: d, at: [x, y] }); selRoomId = r.id; }); syncFromHistory(); },
  tweenRoom, bboxOf: id => bbox(fp.rooms.find(r => r.id === id).polygon_mm),
  saveHandoff: () => saveHandoff(fp, localStorage, 'editor.html'),
  readHandoff: () => readHandoff(localStorage),
  HANDOFF_KEY, DRAFT_KEY,
};

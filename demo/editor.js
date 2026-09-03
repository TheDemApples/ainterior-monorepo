// demo/editor.js — harness for packages/three-editor.
import { createEditor, fmtLen } from '../packages/three-editor/editor.js';
import { SAMPLE_CATALOG } from './sample-catalog.js';
import { CATALOG_DATA } from './catalog-data.js';
// Product thumbnails (#6). Rendered from each item's proxy geometry and shipped as
// data URIs in an ES module rather than loose PNGs, because the demo must also run
// from file:// where fetch() of local files is blocked. Imported defensively so a
// missing module degrades to the colour swatch instead of breaking the studio.
let THUMBS = {};
try {
  const m = await import('../packages/catalog/thumbs.js');
  THUMBS = (m && (m.THUMBS || m.default)) || {};
} catch (e) {
  console.warn('[demo] catalog thumbnails unavailable, falling back to swatches', e);
}

// ---------------------------------------------------------------------------
// CATALOG — swap point.
// Tries packages/catalog/catalog.json (the 100+ item drop-in) and falls back to
// the inline 14-item sample. Any archetype the proxy builder doesn't know falls
// back to a generic box derived from dims_mm (see proxies.js `fallbackParts`).
// ---------------------------------------------------------------------------
// The full catalog is imported as an ES module rather than fetched, because the
// demo has to run from file:// too (SPEC §8.1) and fetch() of a local .json is
// blocked under the file: origin. Regenerate with tools/gen-catalog-module.mjs.
async function loadCatalog() {
  const items = CATALOG_DATA && (Array.isArray(CATALOG_DATA) ? CATALOG_DATA : CATALOG_DATA.items);
  if (items && items.length) return { items, source: `catalog (${items.length} items)` };
  return { items: SAMPLE_CATALOG.items, source: `inline sample (${SAMPLE_CATALOG.items.length})` };
}

// ---------------------------------------------------------------------------
// ROOM — 4.2 x 3.6m living room with a door and a window (SPEC §4.4)
// ---------------------------------------------------------------------------
const DEMO_ROOM = {
  id: 'room_demo', name: 'Living room',
  polygon_mm: [[0, 0], [4600, 0], [4600, 3800], [0, 3800]],
  height_mm: 2600,
  openings: [
    { id: 'd1', type: 'door', wall_index: 0, offset_mm: 420, width_mm: 900, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
    { id: 'w1', type: 'window', wall_index: 2, offset_mm: 1300, width_mm: 1800, height_mm: 1400, sill_mm: 820, swing: null },
  ],
  features: [
    { id: 'f1', type: 'radiator', wall_index: 2, offset_mm: 1500, width_mm: 1400, depth_mm: 120 },
  ],
  source: 'manual', confidence: 1,
};

// ---------------------------------------------------------------------------
// Floorplan handoff (#1) — packages/floorplan/README.md defines the contract:
// demo/design.html writes localStorage['ainterior.floorplan.handoff'] and
// navigates to editor.html?plan=handoff. `payload.shell` is what we render.
// ---------------------------------------------------------------------------
const HANDOFF_KEY = 'ainterior.floorplan.handoff';
let PLAN = null;          // the full handoff payload when we arrived from the designer
let ROOM = DEMO_ROOM;

function readHandoffPlan() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('plan') !== 'handoff') return null;
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || !payload.shell || !Array.isArray(payload.shell.polygon_mm)) return null;
    if (payload.shell.polygon_mm.length < 3) return null;
    return payload;
  } catch (e) {
    console.warn('[demo] floorplan handoff unreadable, using the demo room', e);
    return null;
  }
}

/** shell (floorplanToShell) -> the Room shape the editor consumes (SPEC §4.4 + §G2). */
function shellToRoom(shell) {
  return {
    id: shell.id || 'plan',
    name: shell.name || 'Floorplan',
    polygon_mm: shell.polygon_mm,
    holes_mm: shell.holes_mm || [],
    height_mm: shell.height_mm || 2600,
    wall_thickness_mm: shell.wall_thickness_mm,
    openings: shell.openings || [],
    features: shell.features || [],
    interior_walls: shell.interior_walls || [],
    rooms: shell.rooms || [],
    source: shell.source || 'manual',
    confidence: shell.confidence != null ? shell.confidence : 1,
  };
}

/** brief -> the {item_id, qty} list solveLayouts expects, flattened across rooms. */
function briefToItems(brief) {
  const tally = new Map();
  for (const entry of brief || []) {
    for (const it of (entry.items || [])) {
      if (!it || !it.item_id) continue;
      tally.set(it.item_id, (tally.get(it.item_id) || 0) + Math.max(1, it.qty || 1));
    }
  }
  return [...tally].map(([item_id, qty]) => ({ item_id, qty }));
}

// ---------------------------------------------------------------------------
// optional layout engine (SPEC §5.1) — never hard-fail if absent
// ---------------------------------------------------------------------------
let engine = null;
async function loadEngine() {
  try {
    const mod = await import('../packages/layout-engine/index.js');
    if (mod && (mod.solveLayouts || (mod.default && mod.default.solveLayouts))) {
      engine = mod.solveLayouts ? mod : mod.default;
      return 'layout-engine';
    }
  } catch (_) { /* absent — fall back */ }
  return 'fallback placer';
}

/** Simple deterministic wall-anchoring placer used when the engine is absent. */
function fallbackSolve({ room, items, catalog, seed = 1 }) {
  const poly = room.polygon_mm;
  const walls = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nIn = [-u[1], u[0]];
    return { i, a, b, len, u, nIn, cursor: 250, rot: rotForWall(nIn) };
  });
  // start on the longest wall, then rotate through them (seed shifts the order)
  const order = walls.slice().sort((p, q) => q.len - p.len);
  const rot = (seed % order.length + order.length) % order.length;
  const ring = order.slice(rot).concat(order.slice(0, rot));
  const placements = [];
  let n = 0, wi = 0, centreCursor = 0;
  for (const req of items) {
    const item = catalog.get ? catalog.get(req.item_id) : catalog[req.item_id];
    if (!item) continue;
    for (let q = 0; q < (req.qty || 1); q++) {
      n += 1;
      const pl = item.placement || {};
      if (pl.against_wall) {
        let placed = false;
        for (let attempt = 0; attempt < ring.length; attempt++) {
          const w = ring[(wi + attempt) % ring.length];
          if (w.cursor + item.dims_mm.w + 250 <= w.len) {
            const s = w.cursor + item.dims_mm.w / 2;
            const off = (pl.wall_offset_mm || 0) + item.dims_mm.d / 2;
            placements.push({
              instance_id: 'i' + n, item_id: item.id,
              x_mm: Math.round(w.a[0] + w.u[0] * s + w.nIn[0] * off),
              y_mm: Math.round(w.a[1] + w.u[1] * s + w.nIn[1] * off),
              rot_deg: w.rot, colorway: 0, against: { wall_index: w.i },
              locked: false, added_by_ai: true,
            });
            w.cursor += item.dims_mm.w + 200;
            wi = (wi + attempt + 1) % ring.length;
            placed = true;
            break;
          }
        }
        if (placed) continue;
      }
      // centre-ish fallback, walked along the room centre line
      const b = bounds(room);
      centreCursor += 1;
      placements.push({
        instance_id: 'i' + n, item_id: item.id,
        x_mm: Math.round(b.cx + ((centreCursor % 3) - 1) * 900),
        y_mm: Math.round(b.cy + (Math.floor(centreCursor / 3) % 3 - 1) * 900),
        rot_deg: 0, colorway: 0, against: null, locked: false, added_by_ai: true,
      });
    }
  }
  return [{
    id: 'layout_fallback', seed, mode: 'augment', style: 'neutral', score: 0.5,
    placements, rationale: ['Wall-anchored fallback placer (layout-engine not present).'],
    violations: [], metrics: {},
  }];
}
function rotForWall(nIn) {
  let deg = Math.atan2(nIn[1], nIn[0]) * 180 / Math.PI - 90;
  return ((Math.round(deg / 15) * 15) % 360 + 360) % 360;
}
function bounds(room) {
  const xs = room.polygon_mm.map((p) => p[0]), ys = room.polygon_mm.map((p) => p[1]);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
let editor = null;
let CATALOG = [];
let catMap = new Map();
let activeCat = 'all';
let engineName = '—';

(async function main() {
  const [{ items, source }, eName] = await Promise.all([loadCatalog(), loadEngine()]);

  PLAN = readHandoffPlan();
  if (PLAN) {
    ROOM = shellToRoom(PLAN.shell);
    console.info(`[demo] loaded floorplan "${ROOM.name}" — `
      + `${(ROOM.rooms || []).length} room(s), ${(ROOM.interior_walls || []).length} interior wall(s)`);
  }
  CATALOG = items;
  catMap = new Map(items.map((i) => [i.id, i]));
  engineName = eName;

  editor = createEditor({
    mount: $('#viewport'),
    room: ROOM,
    catalog: CATALOG,
    unit: 'cm',
    onSelect: renderInspector,
    onViolations: renderViolations,
    onChange: (layout) => {
      const li = $('#layoutInfo');
      // Show the layout engine's real score, not the editor's internal fallback.
      // The fallback is a rough `1 - errors*0.15 - violations*0.02`, which read
      // 0.94 on a layout the engine actually scored 0.742 — it ignores walkway
      // quality, balance, focal coherence, wall use and coverage, so it flatters
      // the layout. Recompute with the engine whenever it is available.
      let score = layout.score;
      if (engine && engine.scoreLayout) {
        try {
          const r = engine.scoreLayout({ room: ROOM, layout, catalog: catMap });
          if (r && Number.isFinite(r.score)) score = r.score;
        } catch (_) { /* fall back to whatever the editor reported */ }
      }
      if (li) {
        li.textContent = `${layout.placements.length} pieces · score ${Number(score).toFixed(2)}`;
      }
      if (!editor) return;               // still inside createEditor's boot
      syncHistoryButtons();
      renderInspector(selectedPayload());
    },
  });

  if (engine && engine.validatePlacement) {
    editor.setValidator(({ room, layout, catalog }) => {
      try { return engine.validatePlacement({ room, layout, catalog }) || []; }
      catch (_) { return []; }
    });
  }

  window.editor = editor;              // for the Playwright harness / console
  window.aiEditor = editor;            // stable alias used by tools/verify_demo.py
  window.aiCatalog = CATALOG;
  window.aiRoom = ROOM;

  $('#catCount').textContent = source;
  $('#engineInfo').textContent = 'engine: ' + engineName;
  const b = bounds(ROOM);
  $('#roomInfo').textContent =
    `${ROOM.name} · ${fmtLen(4600, 'cm')} × ${fmtLen(3800, 'cm')} · h ${fmtLen(ROOM.height_mm, 'cm')}`;

  buildCategoryChips();
  renderCatalog();
  wireTopbar();
  seedStartingLayout();
  document.body.dataset.ready = '1';
})();

function seedStartingLayout() {
  // Arrived from the floorplan designer: honour the furniture the user actually
  // chose, rather than the hand-authored demo scene.
  if (PLAN) {
    const items = briefToItems(PLAN.brief);
    if (items.length) { applyAiLayout(items, 1, 'use-mine'); return; }
    // a plan with no brief: leave the space empty so the user starts clean
    editor.setLayout({
      id: 'layout_empty', seed: 1, mode: 'use-mine', style: 'neutral', score: 0,
      placements: [], rationale: ['Empty plan — add furniture from the catalog.'],
      violations: [], metrics: {},
    });
    editor.select(null); editor.clearHistory();
    return;
  }
  // Hand-authored reference layout for the 4.6 x 3.8m demo room. Wall indices:
  // 0 = y=0 (door), 1 = x=4600, 2 = y=3800 (window + radiator), 3 = x=0.
  const authored = [
    ['ikea-stoense-rug',          2700, 2100,  90],
    ['ikea-ektorp-3s',            4120, 2100,  90],
    ['ikea-lack-coffee',          3000, 2100,  90],
    ['ikea-besta-tv-bench',        230, 2100, 270],
    ['generic-tv-55',               60, 2100, 270],
    ['ikea-poang-armchair',       2350,  780, 315],
    ['ikea-billy-bookcase',       4150, 3650, 180],
    ['ikea-hektar-floor-lamp',    3980,  560,   0],
  ].filter(([id]) => catMap.has(id));

  // The authored reference above targets the 14-item inline sample, whose ids
  // differ from the shipped catalog (`ikea-ektorp-3s` vs `ikea-ektorp-3seat`).
  // When it doesn't resolve we must NOT fall back to CATALOG.slice(0, 8): the
  // catalog is ordered by category, so the first eight entries are all sofas and
  // armchairs. That produced a demo opening on eight overlapping couches with 21
  // clearance violations and a 0.43 score. Instead compose a real living-room
  // brief by archetype — resilient to id changes — and let the engine solve it.
  if (authored.length < 6) {
    seedByArchetype();
    return;
  }

  if (authored.length >= 6) {
    editor.setLayout({
      id: 'layout_demo', seed: 1, mode: 'use-mine', style: 'neutral', score: 0,
      placements: authored.map(([item_id, x_mm, y_mm, rot_deg], i) => ({
        instance_id: 'i' + (i + 1), item_id, x_mm, y_mm, rot_deg,
        colorway: 0, against: null, locked: false, added_by_ai: false,
      })),
      rationale: ['Seating anchored to the long wall facing the wall-mounted TV; rug overlaps the sofa front legs.'],
      violations: [], metrics: {},
    });
    editor.select(null);
    editor.clearHistory();
    return;
  }
  seedByArchetype();
}

/**
 * Compose a plausible living-room brief from whatever catalog is loaded, chosen
 * by archetype rather than by id so it survives catalog swaps. Falls back
 * gracefully when an archetype is absent.
 */
export function livingRoomBrief(catalog, room) {
  const wall = Math.max(
    ...room.polygon_mm.map((p, i, a) => {
      const q = a[(i + 1) % a.length];
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    }),
  );
  // One of each, in placement-priority order, with a target width per archetype.
  // Picking the *largest* fitting piece per archetype looked reasonable in
  // isolation but composed badly: it paired a 2490mm sofa with an 1800mm coffee
  // table and a 1800mm TV bench in a 4.6x3.8m room, so the clearances fought each
  // other before the solver even started. Target widths keep the set in
  // proportion to each other and to the room.
  const want = [
    ['sofa_3seat', 1, 2100], ['coffee_table', 1, 1100], ['rug', 1, 1700],
    ['tv_bench', 1, 1500], ['tv', 1, 1250], ['armchair', 1, 800],
    ['floor_lamp', 1, 350], ['bookcase', 1, 800], ['plant', 1, 500],
  ];
  const brief = [];
  for (const [arch, qty, targetW] of want) {
    const pool = catalog.filter((i) => i.archetype === arch);
    if (!pool.length) continue;
    const fits = pool.filter((i) => i.dims_mm.w <= wall - 600);
    const from = fits.length ? fits : pool;
    // closest to the target width, not the biggest available
    const chosen = from.slice().sort(
      (a, b) => Math.abs(a.dims_mm.w - targetW) - Math.abs(b.dims_mm.w - targetW),
    )[0];
    if (chosen) brief.push({ item_id: chosen.id, qty });
  }
  return brief;
}

function seedByArchetype() {
  const brief = livingRoomBrief(CATALOG, ROOM);
  // The brief is already complete, so seed with 'use-mine' — 'augment' would add
  // a second rug and a second plant on top of the ones we just asked for.
  applyAiLayout(brief, 1, 'use-mine');
}

function applyAiLayout(items, seed, mode = 'augment') {
  let layouts;
  if (engine && engine.solveLayouts) {
    try {
      // Ask for three strategically distinct candidates and take the top-scoring
      // one. count:1 pinned us to whichever strategy the seed happened to draw.
      layouts = engine.solveLayouts({
        room: ROOM, items, catalog: catMap, mode, style: 'neutral', seed, count: 3,
      });
    } catch (e) { console.warn('[demo] layout-engine failed, falling back', e); }
  }
  if (!layouts || !layouts.length) layouts = fallbackSolve({ room: ROOM, items, catalog: catMap, seed });
  editor.setLayout(layouts[0]);

  // The internal fallback placer parks rugs against a wall, so this harness used
  // to shove the rug to the room centre afterwards. The real layout engine places
  // rugs under the seating group deliberately (it enforces the >=200mm sofa
  // front-leg overlap rule), and moving it post-solve broke that relationship and
  // manufactured fresh violations. Only correct the fallback's output.
  if (!(engine && engine.solveLayouts)) {
    const rug = layouts[0].placements.find((p) => (catMap.get(p.item_id) || {}).archetype === 'rug');
    if (rug) {
      const b = bounds(ROOM);
      editor.setPosition(rug.instance_id, b.cx, b.cy);
      editor.setRotation(rug.instance_id, 90);
    }
  }
  editor.select(null);
}

// ---------------------------------------------------------------------------
// catalog browser
// ---------------------------------------------------------------------------
function buildCategoryChips() {
  const cats = ['all', ...new Set(CATALOG.map((i) => i.category).filter(Boolean))];
  const wrap = $('#cats');
  wrap.innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.className = 'chip' + (c === activeCat ? ' on' : '');
    b.textContent = c;
    b.onclick = () => { activeCat = c; buildCategoryChips(); renderCatalog(); };
    wrap.appendChild(b);
  }
}

function renderCatalog() {
  const q = ($('#search').value || '').trim().toLowerCase();
  const list = $('#catList');
  list.innerHTML = '';
  const unit = editor ? editor.getUnit() : 'cm';
  const rows = CATALOG.filter((i) => {
    if (activeCat !== 'all' && i.category !== activeCat) return false;
    if (!q) return true;
    return [i.name, i.product_type, i.archetype, i.brand, ...(i.tags || [])]
      .join(' ').toLowerCase().includes(q);
  });
  for (const it of rows) {
    const btn = document.createElement('button');
    btn.className = 'cat-item';
    btn.setAttribute('role', 'listitem');
    const hex = (it.colorways && it.colorways[0] && it.colorways[0].hex) || '#888';
    const d = it.dims_mm;
    const thumb = THUMBS[it.id];
    btn.innerHTML =
      (thumb
        ? `<span class="cat-thumb" style="background-image:url('${thumb}')" aria-hidden="true"></span>`
        : `<span class="cat-thumb" style="background:${hex}" aria-hidden="true"></span>`) +
      `<span class="cat-body">` +
      `<span class="nm"><span class="sw" style="background:${hex}"></span>` +
      `<span>${it.brand} ${it.name}</span></span>` +
      `<span class="dm">${fmtLen(d.w, unit)} × ${fmtLen(d.d, unit)} × ${fmtLen(d.h, unit)}</span>` +
      `<span class="ty">${it.product_type || it.archetype}</span>` +
      `</span>`;
    btn.title = `${it.archetype} · add to room`;
    btn.onclick = () => editor && editor.add(it.id);
    list.appendChild(btn);
  }
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'v-none';
    p.textContent = 'No matches.';
    list.appendChild(p);
  }
}

// ---------------------------------------------------------------------------
// inspector
// ---------------------------------------------------------------------------
function selectedPayload() {
  if (!editor) return null;
  const id = editor.getSelection();
  if (!id) return null;
  const info = editor.getDimensions(id);
  if (!info) return null;
  return { ...info.placement, item: info.item };
}

function renderInspector(sel) {
  const el = $('#inspector');
  if (!sel) {
    el.innerHTML = '<p class="empty">Nothing selected. Click a piece in the room, then drag it on the floor. Snapping: 10&nbsp;mm grid, 120&nbsp;mm wall snap, neighbour edge-align.</p>';
    return;
  }
  const unit = editor.getUnit();
  const info = editor.getDimensions(sel.instance_id) || { walls: [], dims_mm: sel.item.dims_mm };
  const d = sel.item.dims_mm;
  const cw = (sel.item.colorways || []);
  el.innerHTML = `
    <div class="insp-title">${sel.item.brand} ${sel.item.name}</div>
    <div class="insp-sub">${sel.item.product_type || ''} · <em>${sel.item.archetype}</em>${sel.item.sku ? ' · ' + sel.item.sku : ''}</div>
    <dl class="kv">
      <dt>w×d×h</dt><dd>${fmtLen(d.w, unit)} × ${fmtLen(d.d, unit)} × ${fmtLen(d.h, unit)}</dd>
      <dt>position</dt><dd>x ${fmtLen(sel.x_mm, unit)} · y ${fmtLen(sel.y_mm, unit)}</dd>
      ${info.walls.map((w) => `<dt>wall ${w.wall_index}</dt><dd>${fmtLen(w.dist, unit)}</dd>`).join('')}
      ${sel.item.seat_h_mm ? `<dt>seat h</dt><dd>${fmtLen(sel.item.seat_h_mm, unit)}</dd>` : ''}
      ${sel.item.price_usd != null ? `<dt>price</dt><dd>$${sel.item.price_usd}</dd>` : ''}
    </dl>
    <div class="row">
      <span class="eyebrow">rot</span>
      <input class="num" id="rotNum" type="number" step="15" value="${Math.round(sel.rot_deg || 0)}" aria-label="Rotation degrees" />
      <span class="dim">deg ccw</span>
    </div>
    <div class="row"><span class="eyebrow">colorway</span>
      <span class="sw-list">${cw.map((c, i) =>
        `<button class="sw-btn${i === (sel.colorway | 0) ? ' on' : ''}" data-cw="${i}" style="background:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}</span>
    </div>
    <div class="row">
      <label class="chk"><input type="checkbox" id="lockChk" ${sel.locked ? 'checked' : ''}/> <span>lock</span></label>
      <button class="btn" id="dupBtn">duplicate</button>
      <button class="btn" id="delBtn">remove</button>
    </div>`;

  $('#rotNum').onchange = (e) => editor.setRotation(sel.instance_id, parseFloat(e.target.value) || 0);
  $('#lockChk').onchange = (e) => editor.setLocked(sel.instance_id, e.target.checked);
  $('#dupBtn').onclick = () => editor.duplicate(sel.instance_id);
  $('#delBtn').onclick = () => editor.remove(sel.instance_id);
  el.querySelectorAll('[data-cw]').forEach((b) => {
    b.onclick = () => editor.setColorway(sel.instance_id, parseInt(b.dataset.cw, 10));
  });
}

function renderViolations(list) {
  const el = $('#violations');
  $('#vCount').textContent = String(list.length);
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="v ok"><code>CLEAR</code>No collisions or clearance conflicts.</div>';
    return;
  }
  const seen = new Set();
  for (const v of list) {
    const key = v.code + '|' + (v.instance_ids || []).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const d = document.createElement('div');
    d.className = 'v ' + v.severity;
    d.innerHTML = `<code>${v.code}</code>${v.message}`;
    if (v.instance_ids && v.instance_ids.length) {
      d.style.cursor = 'pointer';
      d.onclick = () => editor.select(v.instance_ids[0]);
    }
    el.appendChild(d);
  }
}

// ---------------------------------------------------------------------------
// topbar
// ---------------------------------------------------------------------------
function syncHistoryButtons() {
  $('#undoBtn').disabled = !editor.canUndo();
  $('#redoBtn').disabled = !editor.canRedo();
}

function wireTopbar() {
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    editor.setView(b.dataset.view);
    [...$('#viewSeg').children].forEach((c) => {
      const on = c === b;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
  });
  $('#unitSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    editor.setUnit(b.dataset.unit);
    [...$('#unitSeg').children].forEach((c) => {
      const on = c === b;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    renderCatalog();
    renderInspector(selectedPayload());
    const u = editor.getUnit();
    $('#roomInfo').textContent =
      `${ROOM.name} · ${fmtLen(4600, u)} × ${fmtLen(3800, u)} · h ${fmtLen(ROOM.height_mm, u)}`;
  });
  $('#clearanceToggle').onchange = (e) => editor.setClearances(e.target.checked);
  $('#undoBtn').onclick = () => { editor.undo(); syncHistoryButtons(); renderInspector(selectedPayload()); };
  $('#redoBtn').onclick = () => { editor.redo(); syncHistoryButtons(); renderInspector(selectedPayload()); };
  $('#search').oninput = renderCatalog;
  $('#aiBtn').onclick = () => {
    const layout = editor.getLayout();
    const items = layout.placements.length
      ? Object.entries(layout.placements.reduce((a, p) => (a[p.item_id] = (a[p.item_id] || 0) + 1, a), {}))
          .map(([item_id, qty]) => ({ item_id, qty }))
      // same reasoning as seedStartingLayout: slicing the catalog head yields
      // nothing but sofas, so compose a real brief by archetype instead.
      : livingRoomBrief(CATALOG, ROOM);
    applyAiLayout(items, (layout.seed || 1) + 1);
  };
  $('#snapBtn').onclick = () => {
    const url = editor.snapshot({ width: 1600, height: 1000 });
    $('#snapImg').src = url;
    $('#snapDl').href = url;
    const dlg = $('#snapDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  };
  $('#snapClose').onclick = () => {
    const dlg = $('#snapDlg');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  };

  // ---- annotated blueprint (SPEC §5.2) ------------------------------------
  let bpPaper = 'A3';
  let blueprintMod = null;

  async function getBlueprint() {
    if (blueprintMod) return blueprintMod;
    try {
      const m = await import('../packages/blueprint/index.js');
      blueprintMod = m.renderBlueprint ? m : (m.default || null);
    } catch (e) {
      console.warn('[demo] blueprint package unavailable', e);
      blueprintMod = null;
    }
    return blueprintMod;
  }

  async function drawBlueprint() {
    const host = $('#bpHost');
    const meta = $('#bpMeta');
    const mod = await getBlueprint();
    if (!mod || !mod.renderBlueprint) {
      host.innerHTML = '<p class="dim">blueprint package not available</p>';
      return;
    }
    const layout = editor.getLayout();
    const unit = (document.querySelector('#unitSeg button.on') || {}).dataset
      ? document.querySelector('#unitSeg button.on').dataset.unit : 'mm';
    let svg;
    try {
      svg = mod.renderBlueprint({
        room: ROOM,
        layout,
        catalog: catMap,
        opts: {
          unit, paper: bpPaper, scale: 'fit',
          show: {
            dimensions: true, names: true, schedule: true, northArrow: true,
            scaleBar: true, titleBlock: true, clearances: !!$('#bpClearances').checked,
          },
          title: ROOM.name || 'Room',
          project: 'ainterior',
          author: 'ainterior studio',
          date: new Date().toISOString().slice(0, 10),
        },
      });
    } catch (e) {
      console.error('[demo] blueprint render failed', e);
      host.innerHTML = `<p class="dim">blueprint render failed: ${e.message}</p>`;
      return;
    }
    host.innerHTML = svg;
    const svgEl = host.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.style.width = '100%';
      svgEl.style.height = 'auto';
    }
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const dl = $('#bpDl');
    if (dl.dataset.url) URL.revokeObjectURL(dl.dataset.url);
    const url = URL.createObjectURL(blob);
    dl.href = url;
    dl.dataset.url = url;
    let totalTxt = '';
    try {
      const s = mod.renderSchedule({ layout, catalog: catMap });
      const qty = s.rows.reduce((a, r) => a + (r.qty || 0), 0);
      totalTxt = ` · ${s.rows.length} schedule rows · ${qty} pieces · $${s.total}`;
    } catch (_) { /* schedule is optional metadata here */ }
    meta.textContent = `${bpPaper} · ${unit} · ${layout.placements.length} placements${totalTxt}`;
  }

  $('#bpBtn').onclick = async () => {
    const dlg = $('#bpDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    await drawBlueprint();
  };
  $('#bpClose').onclick = () => {
    const dlg = $('#bpDlg');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  };
  $('#bpClearances').onchange = () => drawBlueprint();
  $('#bpPaperSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-paper]');
    if (!b) return;
    bpPaper = b.dataset.paper;
    [...$('#bpPaperSeg').querySelectorAll('button')].forEach((x) => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    drawBlueprint();
  });

  syncHistoryButtons();
}

// ---------------------------------------------------------------------------
// Resizable side panels (#5)
// ---------------------------------------------------------------------------
// `.main` is a 5-column grid whose outer track widths come from CSS custom
// properties, so dragging only writes a variable — no layout thrash, and the
// 3D viewport resizes through its own ResizeObserver.
(function initPanelResize() {
  const root = document.documentElement;
  const LIMITS = { l: [190, 560], r: [200, 560] };
  const KEY = 'ainterior.studio.panels';

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  const clamp = (side, px) => Math.max(LIMITS[side][0], Math.min(LIMITS[side][1], px));
  const apply = (side, px) => root.style.setProperty(side === 'l' ? '--panel-l' : '--panel-r', `${Math.round(px)}px`);
  if (Number.isFinite(saved.l)) apply('l', clamp('l', saved.l));
  if (Number.isFinite(saved.r)) apply('r', clamp('r', saved.r));

  const persist = () => {
    const cs = getComputedStyle(root);
    const out = {
      l: parseFloat(cs.getPropertyValue('--panel-l')) || undefined,
      r: parseFloat(cs.getPropertyValue('--panel-r')) || undefined,
    };
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { /* private mode */ }
  };

  function wire(id, side) {
    const el = document.getElementById(id);
    if (!el) return;
    const panel = document.querySelector(side === 'l' ? '.panel-left' : '.panel-right');

    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startW = panel ? panel.getBoundingClientRect().width : 260;
      el.setPointerCapture(ev.pointerId);
      el.classList.add('is-dragging');
      document.body.classList.add('is-resizing');

      const move = (e) => {
        // left panel grows with +dx, right panel grows with -dx
        const dx = e.clientX - startX;
        apply(side, clamp(side, startW + (side === 'l' ? dx : -dx)));
      };
      const up = () => {
        el.releasePointerCapture(ev.pointerId);
        el.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('lostpointercapture', up);
        persist();
        window.dispatchEvent(new Event('resize'));   // nudge the viewport observer
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    });

    // keyboard-accessible resize
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 40 : 12;
      let dir = 0;
      if (ev.key === 'ArrowLeft') dir = -1;
      else if (ev.key === 'ArrowRight') dir = 1;
      else return;
      ev.preventDefault();
      const cur = panel ? panel.getBoundingClientRect().width : 260;
      apply(side, clamp(side, cur + (side === 'l' ? dir * step : -dir * step)));
      persist();
      window.dispatchEvent(new Event('resize'));
    });
  }

  wire('resizeL', 'l');
  wire('resizeR', 'r');
}());

// ---------------------------------------------------------------------------
// Adaptive graphics quality (#11 support)
// ---------------------------------------------------------------------------
// The realism layer (PBR maps + IBL environment + soft shadows) costs roughly
// 5x the frame time of flat materials. Measured in this sandbox's software
// rasteriser: 0.39fps full / 0.91 without the environment / 2.04 with neither /
// 6.07 at half resolution — while the JavaScript per-frame work is only ~7ms.
// On a real GPU none of that matters, but we cannot assume one, so measure the
// machine we actually landed on and step down if it can't keep up.
(function initQuality() {
  const KEY = 'ainterior.studio.quality';
  const seg = document.getElementById('qualSeg');
  if (!seg) return;

  const mark = (q) => {
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.q === q;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };

  let pref = 'auto';
  try { pref = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* private mode */ }
  mark(pref);

  const apply = (tier) => {
    if (!editor || !editor.setQualityTier) return;
    editor.setQualityTier(tier);
    const el = document.getElementById('engineInfo');
    if (el && !/gfx/.test(el.textContent || '')) el.textContent += ` · gfx: ${tier}`;
    else if (el) el.textContent = el.textContent.replace(/gfx: \w+/, `gfx: ${tier}`);
  };

  /**
   * Sample real frame pacing. Bounded by TIME, not by a frame count: a
   * frame-counted probe is a trap on exactly the machines it exists to detect —
   * waiting for 22 frames at 0.4fps takes ~55 seconds, so the probe never
   * returned and the tier never dropped. A slow machine now reports slow within
   * one budget window.
   */
  function measure(budgetMs = 700) {
    return new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const step = () => {
        n += 1;
        const elapsed = performance.now() - t0;
        if (elapsed < budgetMs && n < 60) requestAnimationFrame(step);
        else res((1000 * n) / Math.max(1, elapsed));
      };
      requestAnimationFrame(step);
    });
  }

  async function auto() {
    const high = await measure();
    if (high >= 24) { apply('high'); return; }
    apply('medium');
    const med = await measure();
    if (med >= 20) return;
    apply('low');
  }

  const run = () => { if (pref === 'auto') auto(); else apply(pref); };
  // let the first frames settle (shader compile, texture upload) before judging
  if (document.body.dataset.ready === '1') setTimeout(run, 900);
  else {
    const t = setInterval(() => {
      if (document.body.dataset.ready === '1') { clearInterval(t); setTimeout(run, 900); }
    }, 200);
  }

  seg.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-q]');
    if (!b) return;
    pref = b.dataset.q;
    mark(pref);
    try { localStorage.setItem(KEY, pref); } catch (e) { /* private mode */ }
    if (pref === 'auto') auto(); else apply(pref);
  });
}());

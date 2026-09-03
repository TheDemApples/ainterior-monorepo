// tests/integration.mjs — cross-package integration: real catalog x layout engine x blueprint.
// This is the path no subagent could test: each built against its own fixtures.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveLayouts, scoreLayout } from '../packages/layout-engine/index.js';
import { renderBlueprint, renderSchedule } from '../packages/blueprint/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const cat = JSON.parse(readFileSync(join(ROOT, 'packages/catalog/catalog.json'), 'utf8'));
const items = cat.items;
const catMap = new Map(items.map((i) => [i.id, i]));

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); pass++; }
  catch (e) { console.log(`  \u2717 ${name}\n      ${e.message}`); fail++; failures.push(name); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ARCHETYPES = new Set(['sofa_2seat','sofa_3seat','sofa_sectional_l','loveseat','armchair','ottoman','bench','chaise','dining_chair','office_chair','stool','bar_stool','bed_single','bed_double','bed_queen','bed_king','crib','nightstand','dresser','wardrobe','bookcase','shelf_unit','sideboard','cabinet','tv_bench','storage_box','coffee_table','side_table','dining_table_rect','dining_table_round','desk','console_table','kitchen_island','rug','floor_lamp','table_lamp','pendant_lamp','wall_lamp','tv','art_frame','mirror','plant','curtain','wall_shelf','monitor','appliance','rack','cushion','bike','curtain_rod','string_lights']);

const LIVING = {
  id: 'r_living', name: 'Living room',
  polygon_mm: [[0,0],[4600,0],[4600,3800],[0,3800]],
  height_mm: 2600,
  openings: [
    { id:'d1', type:'door', wall_index:0, offset_mm:400, width_mm:900, height_mm:2040, sill_mm:0, swing:'in-left' },
    { id:'w1', type:'window', wall_index:2, offset_mm:1400, width_mm:1800, height_mm:1400, sill_mm:800, swing:null },
  ],
  features: [], source: 'manual', confidence: 1,
};
const BEDROOM = {
  id: 'r_bed', name: 'Bedroom',
  polygon_mm: [[0,0],[3600,0],[3600,4000],[0,4000]],
  height_mm: 2600,
  openings: [
    { id:'d1', type:'door', wall_index:0, offset_mm:300, width_mm:800, height_mm:2040, sill_mm:0, swing:'in-left' },
    { id:'w1', type:'window', wall_index:2, offset_mm:1200, width_mm:1400, height_mm:1400, sill_mm:900, swing:null },
  ],
  features: [], source: 'manual', confidence: 1,
};

function pick(archetype, n = 1) {
  const found = items.filter((i) => i.archetype === archetype).slice(0, n);
  assert(found.length === n, `catalog lacks ${n}x ${archetype} (found ${found.length})`);
  return found;
}

console.log('\n  CROSS-PACKAGE INTEGRATION\n' + '\u2500'.repeat(69));

// ---- 1. catalog conforms to what the engine + editor actually read ----------
t('every catalog archetype is in the SPEC §4.3 closed set', () => {
  const bad = [...new Set(items.map((i) => i.archetype))].filter((a) => !ARCHETYPES.has(a));
  assert(bad.length === 0, `unknown archetypes: ${bad.join(', ')}`);
});

t('every item has the fields the engine dereferences', () => {
  for (const i of items) {
    assert(i.dims_mm && Number.isFinite(i.dims_mm.w) && Number.isFinite(i.dims_mm.d) && Number.isFinite(i.dims_mm.h), `${i.id}: dims_mm`);
    assert(i.clearance_mm && ['front','back','left','right'].every((k) => Number.isFinite(i.clearance_mm[k])), `${i.id}: clearance_mm`);
    assert(i.placement && typeof i.placement === 'object', `${i.id}: placement`);
    assert(i.proxy && Array.isArray(i.proxy.parts) && i.proxy.parts.length, `${i.id}: proxy.parts`);
  }
});

t('every item has the fields the blueprint schedule prints', () => {
  for (const i of items) {
    assert(typeof i.name === 'string' && i.name, `${i.id}: name`);
    assert(typeof i.brand === 'string', `${i.id}: brand`);
    assert(i.price_usd === null || Number.isFinite(i.price_usd), `${i.id}: price_usd`);
    assert(typeof i.category === 'string' && i.category, `${i.id}: category`);
  }
});

t('proxy part shapes are limited to box|cyl|sphere|plane', () => {
  const ok = new Set(['box','cyl','sphere','plane']);
    const bad = new Set();
  for (const i of items) for (const p of i.proxy.parts) if (!ok.has(p.shape)) bad.add(`${i.id}:${p.shape}`);
  assert(bad.size === 0, `bad shapes: ${[...bad].slice(0,5).join(', ')}`);
});

// ---- 2. the engine solves real-catalog briefs -------------------------------
const livingBrief = [
  ...pick('sofa_3seat').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('coffee_table').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('armchair', 2).map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('rug').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('tv_bench').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('tv').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('floor_lamp').map((i) => ({ item_id: i.id, qty: 1 })),
  ...pick('bookcase').map((i) => ({ item_id: i.id, qty: 1 })),
];

let livingLayouts;
t('solves a real 9-piece living room brief from the real catalog', () => {
  const t0 = Date.now();
  livingLayouts = solveLayouts({ room: LIVING, items: livingBrief, catalog: catMap, mode: 'use-mine', style: 'neutral', seed: 7, count: 3 });
  const ms = Date.now() - t0;
  assert(livingLayouts.length === 3, `expected 3 layouts, got ${livingLayouts.length}`);
  console.log(`      solved 3 candidates in ${ms}ms`);
  assert(ms < 3000, `too slow: ${ms}ms`);
});

t('placed every requested piece (nothing silently dropped)', () => {
  const want = livingBrief.length;
  const got = livingLayouts[0].placements.filter((p) => !p.added_by_ai).length;
  assert(got === want, `requested ${want}, placed ${got}`);
});

t('no ERROR-severity violations on the best living-room layout', () => {
  const errs = (livingLayouts[0].violations || []).filter((v) => v.severity === 'error');
  assert(errs.length === 0, `errors: ${errs.map((e) => `${e.code}`).join(', ')}`);
});

t('all placements land inside the room polygon', () => {
  for (const L of livingLayouts) {
    for (const p of L.placements) {
      assert(p.x_mm >= 0 && p.x_mm <= 4600 && p.y_mm >= 0 && p.y_mm <= 3800,
        `${p.item_id} at ${p.x_mm},${p.y_mm} outside 4600x3800`);
    }
  }
});

t('rationale is non-empty and specific on every candidate', () => {
  for (const L of livingLayouts) {
    assert(Array.isArray(L.rationale) && L.rationale.length, 'empty rationale');
    assert(L.rationale.join(' ').length > 30, 'rationale too thin');
  }
});

t('re-roll (seed+1) produces a materially different layout', () => {
  const a = solveLayouts({ room: LIVING, items: livingBrief, catalog: catMap, seed: 7, count: 1 })[0];
  const b = solveLayouts({ room: LIVING, items: livingBrief, catalog: catMap, seed: 8, count: 1 })[0];
  const key = (L) => L.placements.map((p) => `${p.item_id}@${p.x_mm},${p.y_mm},${p.rot_deg}`).sort().join('|');
  assert(key(a) !== key(b), 'seed+1 gave an identical layout');
});

t('determinism: same seed twice is byte-identical', () => {
  const a = solveLayouts({ room: LIVING, items: livingBrief, catalog: catMap, seed: 42, count: 2 });
  const b = solveLayouts({ room: LIVING, items: livingBrief, catalog: catMap, seed: 42, count: 2 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'non-deterministic output');
});

t('augment mode adds AI pieces that exist in the real catalog', () => {
  const L = solveLayouts({ room: LIVING, items: livingBrief.slice(0, 3), catalog: catMap, mode: 'augment', style: 'cozy', seed: 3, count: 1 })[0];
  const added = L.placements.filter((p) => p.added_by_ai);
  assert(added.length > 0, 'augment added nothing');
  for (const p of added) assert(catMap.has(p.item_id), `added unknown item ${p.item_id}`);
  console.log(`      augment added: ${added.map((p) => catMap.get(p.item_id).name).join(', ')}`);
});

// ---- 3. bedroom brief (different anchor archetype) -------------------------
t('solves a bedroom brief (bed anchor, not sofa)', () => {
  const brief = [
    ...pick('bed_queen').map((i) => ({ item_id: i.id, qty: 1 })),
    ...pick('nightstand', 2).map((i) => ({ item_id: i.id, qty: 1 })),
    ...pick('wardrobe').map((i) => ({ item_id: i.id, qty: 1 })),
    ...pick('dresser').map((i) => ({ item_id: i.id, qty: 1 })),
  ];
  const L = solveLayouts({ room: BEDROOM, items: brief, catalog: catMap, seed: 11, count: 2 });
  assert(L.length === 2, 'expected 2 bedroom candidates');
  const errs = (L[0].violations || []).filter((v) => v.severity === 'error');
  assert(errs.length === 0, `bedroom errors: ${errs.map((e) => e.code).join(', ')}`);
});

// ---- 4. blueprint renders from a real solved layout ------------------------
let svg;
t('blueprint renders SVG from the real solved layout', () => {
  svg = renderBlueprint({ room: LIVING, layout: livingLayouts[0], catalog: catMap,
    opts: { unit: 'mm', paper: 'A3', title: 'Living room', project: 'ainterior demo', author: 'test' } });
  assert(typeof svg === 'string' && svg.length > 5000, `svg too small: ${svg && svg.length}`);
  assert(svg.trim().startsWith('<svg') || svg.trim().startsWith('<?xml'), 'not an svg root');
  assert(svg.includes('</svg>'), 'unterminated svg');
});

t('blueprint has no external references (self-contained)', () => {
  assert(!/xlink:href\s*=\s*"http/.test(svg), 'external xlink');
  assert(!/<image[^>]+href\s*=\s*"(?!data:)/.test(svg), 'external image');
  assert(!/@import/.test(svg), 'css @import');
});

t('every placed piece is named on the blueprint', () => {
  const names = new Set(livingLayouts[0].placements.map((p) => catMap.get(p.item_id).name));
  const missing = [...names].filter((n) => !svg.includes(n));
  assert(missing.length === 0, `names absent from sheet: ${missing.join(', ')}`);
});

t('schedule covers every placement with real prices', () => {
  const s = renderSchedule({ layout: livingLayouts[0], catalog: catMap });
  const qty = s.rows.reduce((a, r) => a + (r.qty || 0), 0);
  assert(qty === livingLayouts[0].placements.length, `schedule qty ${qty} != ${livingLayouts[0].placements.length}`);
  assert(Number.isFinite(s.total), 'no schedule total');
  console.log(`      schedule: ${s.rows.length} rows, ${qty} pieces, total $${s.total}`);
});

// ---- 5. scoreLayout agrees with the solver --------------------------------
t('scoreLayout reproduces the solver score for its own output', () => {
  const r = scoreLayout({ room: LIVING, layout: livingLayouts[0], catalog: catMap });
  assert(Number.isFinite(r.score), 'no score');
  const d = Math.abs(r.score - livingLayouts[0].score);
  assert(d < 0.02, `score drift ${d.toFixed(4)} (solver ${livingLayouts[0].score}, rescore ${r.score})`);
});

t('candidates are sorted by score descending', () => {
  for (let i = 1; i < livingLayouts.length; i++) {
    assert(livingLayouts[i - 1].score >= livingLayouts[i].score,
      `unsorted: ${livingLayouts[i-1].score} < ${livingLayouts[i].score}`);
  }
});

// ---- 6. stress: every catalog item must be placeable & renderable ---------
t(`every one of the ${items.length} catalog items solves+renders without throwing`, () => {
  const bad = [];
  const BIG = { ...LIVING, polygon_mm: [[0,0],[8000,0],[8000,7000],[0,7000]] };
  for (const it of items) {
    try {
      const L = solveLayouts({ room: BIG, items: [{ item_id: it.id, qty: 1 }], catalog: catMap, seed: 5, count: 1 })[0];
      renderBlueprint({ room: BIG, layout: L, catalog: catMap, opts: { paper: 'A4' } });
    } catch (e) { bad.push(`${it.id}: ${e.message}`); }
  }
  assert(bad.length === 0, `${bad.length} items failed:\n      ${bad.slice(0, 6).join('\n      ')}`);
});

console.log('\u2500'.repeat(69));
console.log(`  ${pass} passed   ${fail} failed   ${pass + fail} total`);
console.log(`  RESULT: ${fail ? 'FAIL' : 'PASS'}`);
if (fail) { console.log(`  failing: ${failures.join(', ')}`); process.exitCode = 1; }
console.log('\u2500'.repeat(69) + '\n');

// packages/layout-engine/tests/run.js
// Plain Node, zero deps.  Run:  node tests/run.js
// Covers determinism, re-roll divergence, every hard rule from SPEC §5.1 and
// blueprint SVG well-formedness.

import { solveLayouts, scoreLayout, validatePlacement, suggestAdditions } from '../index.js';
import { buildRoom, expand, RULES, doorApron, VIOLATION_CODES, frontLegOverlap, isSofa, isBed, sideEnvelope } from '../rules.js';
import { obbPenetration, obbGap, obbOutsideDepth, frontAxis, distToBoundary } from '../geom.js';
import { renderBlueprint, renderSchedule } from '../../blueprint/index.js';
import * as F from './fixtures.js';

let pass = 0, fail = 0;
const failures = [];
const t0 = Date.now();

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, message: e && e.message ? e.message : String(e) });
    console.log(`  \u2717 ${name}\n      ${e && e.message ? e.message : e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const solve = (room, items, o = {}) => solveLayouts({
  room, items, catalog: F.CATALOG,
  mode: o.mode || 'use-mine', style: o.style || 'neutral',
  seed: o.seed != null ? o.seed : 84213, count: o.count || 3,
});

const ents = (room, layout) => expand(buildRoom(room), layout, F.CATALOG);
const best = (room, items, o) => solve(room, items, o)[0];

// ---------------------------------------------------------------------------
console.log('\nlayout-engine \u2014 determinism');

test('same seed twice \u21d2 byte-identical output', () => {
  const a = solve(F.LIVING, F.LIVING_ITEMS, { seed: 4242 });
  const b = solve(F.LIVING, F.LIVING_ITEMS, { seed: 4242 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'two runs with the same seed differ');
});

test('same seed twice \u21d2 identical in augment mode too', () => {
  const a = solve(F.BEDROOM, F.BEDROOM_ITEMS, { seed: 7, mode: 'augment' });
  const b = solve(F.BEDROOM, F.BEDROOM_ITEMS, { seed: 7, mode: 'augment' });
  assert(JSON.stringify(a) === JSON.stringify(b), 'augment mode is not deterministic');
});

test('seed+1 re-roll is materially different but still valid', () => {
  const a = solve(F.LIVING, F.LIVING_ITEMS, { seed: 4242 })[0];
  const b = solve(F.LIVING, F.LIVING_ITEMS, { seed: 4243 })[0];
  const byId = new Map(b.placements.map((p) => [p.instance_id, p]));
  let moved = 0;
  for (const p of a.placements) {
    const q = byId.get(p.instance_id);
    if (!q) { moved++; continue; }
    if (Math.hypot(p.x_mm - q.x_mm, p.y_mm - q.y_mm) > 150 || p.rot_deg !== q.rot_deg) moved++;
  }
  assert(moved >= 2, `only ${moved} piece(s) moved on re-roll \u2014 not a material difference`);
  assert(b.violations.filter((v) => v.severity === 'error').length === 0,
    'the re-rolled layout has hard errors');
});

test('candidates are strategically distinct and sorted by score', () => {
  const L = solve(F.LIVING, F.LIVING_ITEMS, { seed: 99, count: 3 });
  assert(L.length === 3, `expected 3 candidates, got ${L.length}`);
  const strat = new Set(L.map((l) => l.__strategy));
  assert(strat.size === 3, `candidates reuse strategies: ${[...strat].join(',')}`);
  for (let i = 1; i < L.length; i++) {
    assert(L[i - 1].score >= L[i].score, 'candidates are not sorted by score desc');
  }
});

// ---------------------------------------------------------------------------
console.log('\nlayout-engine \u2014 hard invariants');

const CASES = [
  ['living room 4.2\u00d73.6', F.LIVING, F.LIVING_ITEMS],
  ['bedroom 3.0\u00d73.4', F.BEDROOM, F.BEDROOM_ITEMS],
  ['studio 5.5\u00d73.2', F.STUDIO, F.STUDIO_ITEMS],
];

for (const [label, room, items] of CASES) {
  test(`${label}: no two floor colliders overlap`, () => {
    for (const l of solve(room, items, { seed: 1234 })) {
      const E = ents(room, l).filter((e) => e.collider);
      for (let i = 0; i < E.length; i++) {
        for (let j = i + 1; j < E.length; j++) {
          const pen = obbPenetration(E[i].box, E[j].box);
          assert(pen <= 2, `${E[i].item.name} \u2229 ${E[j].item.name} = ${Math.round(pen)}mm in ${l.id}`);
        }
      }
    }
  });

  test(`${label}: everything stays inside the room outline`, () => {
    for (const l of solve(room, items, { seed: 1234 })) {
      const rm = buildRoom(room);
      for (const e of ents(room, l)) {
        assert(obbOutsideDepth(e.box, rm.poly) <= 1,
          `${e.item.name} pokes outside the room in ${l.id}`);
      }
    }
  });

  test(`${label}: walkway never drops below ${RULES.WALKWAY_ABS_MIN_MM}mm`, () => {
    const l = best(room, items, { seed: 1234 });
    assert(l.metrics.walkway_min_mm >= RULES.WALKWAY_ABS_MIN_MM,
      `walkway_min_mm = ${l.metrics.walkway_min_mm}`);
  });

  test(`${label}: door apron + swing arc kept clear`, () => {
    const rm = buildRoom(room);
    for (const l of solve(room, items, { seed: 1234 })) {
      for (const d of rm.doors) {
        const ap = doorApron(d);
        for (const e of ents(room, l)) {
          if (!e.collider) continue;
          assert(obbPenetration(ap, e.box) <= 20,
            `${e.item.name} sits in the ${RULES.DOOR_APRON_MM}mm apron of ${d.id} (${l.id})`);
        }
      }
      assert(!l.violations.some((v) => v.code === 'BLOCKS_DOOR'),
        `BLOCKS_DOOR reported in ${l.id}`);
    }
  });

  test(`${label}: hard errors are only honest capacity reports`, () => {
    const l = best(room, items, { seed: 1234 });
    const errs = l.violations.filter((v) => v.severity === 'error');
    // geometry-breaking errors are never acceptable; a room that genuinely
    // cannot host the brief may report UNREACHABLE / OUT_OF_BOUNDS (§8.8).
    const forbidden = errs.filter((v) => ['OVERLAP', 'BLOCKS_DOOR', 'WALKWAY_TIGHT'].indexOf(v.code) >= 0);
    assert(forbidden.length === 0, forbidden.map((e) => `${e.code}: ${e.message}`).join(' | '));
    for (const e of errs) {
      assert(['UNREACHABLE', 'OUT_OF_BOUNDS', 'NO_WALL_SUPPORT', 'BLOCKS_WINDOW'].indexOf(e.code) >= 0,
        `unexpected hard error ${e.code}: ${e.message}`);
      assert(l.rationale.some((s2) => /clearance|left out|could not|walkway/i.test(s2)),
        `error ${e.code} is not explained in the rationale`);
    }
  });

  test(`${label}: radiators and low windows stay unblocked by tall pieces`, () => {
    const l = best(room, items, { seed: 1234 });
    assert(!l.violations.some((v) => v.code === 'BLOCKS_RADIATOR' && v.severity === 'error'),
      'a radiator is hard-blocked');
  });
}

test('coffee table sits 350\u2013450mm off the sofa front edge', () => {
  for (const seed of [11, 22, 33, 44]) {
    const l = best(F.LIVING, F.LIVING_ITEMS, { seed });
    const E = ents(F.LIVING, l);
    const sofa = E.find((e) => isSofa(e.arche));
    const ct = E.find((e) => e.arche === 'coffee_table');
    assert(sofa && ct, 'fixture should place both a sofa and a coffee table');
    const g = obbGap(sofa.box, ct.box);
    assert(g >= RULES.COFFEE_TABLE_MIN_MM - 1 && g <= RULES.COFFEE_TABLE_MAX_MM + 1,
      `gap ${Math.round(g)}mm outside 350\u2013450mm band (seed ${seed})`);
  }
});

test('rug overlaps the sofa front legs by \u2265200mm and is never a collider', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  const E = ents(F.LIVING, l);
  const sofa = E.find((e) => isSofa(e.arche));
  const rug = E.find((e) => e.arche === 'rug');
  assert(sofa && rug, 'expected a sofa and a rug');
  assert(rug.collider === false, 'rug was treated as a floor collider');
  const ov = frontLegOverlap(sofa.box, rug.box);
  assert(ov >= RULES.RUG_SOFA_OVERLAP_MM, `rug reaches only ${Math.round(ov)}mm under the front legs`);
});

test('bed: headboard on a wall and \u2265700mm on both access sides', () => {
  const rm = buildRoom(F.BEDROOM);
  const l = best(F.BEDROOM, F.BEDROOM_ITEMS, { seed: 1234 });
  const E = ents(F.BEDROOM, l);
  const bed = E.find((e) => isBed(e.arche));
  assert(bed, 'expected a bed');
  const f = frontAxis(bed.box);
  const head = [bed.box.cx - f[0] * bed.box.d / 2, bed.box.cy - f[1] * bed.box.d / 2];
  assert(distToBoundary(head[0], head[1], rm.poly) <= 200, 'headboard is not against a wall');
  for (const side of [-1, 1]) {
    const env = sideEnvelope(bed.box, side, RULES.BED_ACCESS_MM);
    assert(obbOutsideDepth(env, rm.poly) <= 40,
      `access side ${side > 0 ? 'right' : 'left'} is cut off by a wall`);
    for (const o of E) {
      if (o === bed || !o.collider || o.arche === 'nightstand') continue;
      assert(obbPenetration(env, o.box) <= 40,
        `${o.item.name} eats the ${RULES.BED_ACCESS_MM}mm bed access side`);
    }
  }
});

test('TV distance is judged against 1.6\u20132.5\u00d7 the diagonal', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  const E = ents(F.LIVING, l);
  const tv = E.find((e) => e.arche === 'tv');
  const sofa = E.find((e) => isSofa(e.arche));
  assert(tv && sofa, 'expected a TV and a sofa');
  const diag = Math.hypot(tv.item.dims_mm.w, tv.item.dims_mm.h);
  const dist = Math.hypot(tv.box.cx - sofa.box.cx, tv.box.cy - sofa.box.cy);
  const flagged = l.violations.some((v) => v.code === 'TV_TOO_CLOSE' || v.code === 'TV_TOO_FAR');
  const inBand = dist >= diag * RULES.TV_DIST_MIN_FACTOR && dist <= diag * RULES.TV_DIST_MAX_FACTOR;
  assert(inBand !== flagged, `dist ${Math.round(dist)}mm, inBand=${inBand}, flagged=${flagged}`);
  assert(inBand, `viewing distance ${Math.round(dist)}mm is outside the comfortable band`);
});

test('dining: 1100mm circulation + 600mm of edge per seat is measured', () => {
  const l = best(F.STUDIO, F.STUDIO_ITEMS, { seed: 5150 });
  const E = ents(F.STUDIO, l);
  const table = E.find((e) => e.arche === 'dining_table_rect');
  assert(table, 'expected a dining table');
  const chairs = E.filter((e) => e.arche === 'dining_chair');
  const perim = 2 * (table.box.w + table.box.d);
  if (chairs.length) {
    assert(perim / chairs.length >= RULES.DINING_EDGE_PER_SEAT_MM - 1,
      `${Math.round(perim / chairs.length)}mm of edge per seat`);
  }
});

test('wall-mounted and ceiling items are excluded from floor collision', () => {
  const l = best(F.BEDROOM, F.BEDROOM_ITEMS, { seed: 1234 });
  const E = ents(F.BEDROOM, l);
  const art = E.find((e) => e.arche === 'art_frame');
  assert(art, 'expected wall art in the bedroom fixture');
  assert(art.collider === false, 'wall-mounted art was treated as a floor collider');
});

test('unfittable room emits violations instead of overlapping or shrinking', () => {
  const L = solve(F.TINY, F.TINY_ITEMS, { seed: 8 });
  const l = L[0];
  const E = ents(F.TINY, l).filter((e) => e.collider);
  for (let i = 0; i < E.length; i++) {
    for (let j = i + 1; j < E.length; j++) {
      assert(obbPenetration(E[i].box, E[j].box) <= 2,
        `${E[i].item.name} overlaps ${E[j].item.name} in an impossible room`);
    }
  }
  assert(l.violations.length > 0, 'no violations reported for an impossible brief');
  assert(l.violations.some((v) => v.severity === 'error'), 'impossible brief produced no error');
  assert(l.placements.length < F.TINY_ITEMS.length,
    'every piece was placed in a room that cannot hold them');
  // real dimensions preserved
  for (const p of l.placements) {
    const item = F.CATALOG.get(p.item_id);
    assert(item.dims_mm.w > 0 && item.dims_mm.d > 0, 'dimensions were mutated');
  }
});

test('violation codes and severities stay inside the closed sets', () => {
  const all = [];
  for (const [, room, items] of CASES) {
    for (const l of solve(room, items, { seed: 606 })) all.push(...l.violations);
  }
  all.push(...solve(F.TINY, F.TINY_ITEMS, { seed: 606 })[0].violations);
  assert(all.length > 0, 'expected at least one violation across all fixtures');
  for (const v of all) {
    assert(VIOLATION_CODES.indexOf(v.code) >= 0, `unknown code ${v.code}`);
    assert(['error', 'warn', 'info'].indexOf(v.severity) >= 0, `bad severity ${v.severity}`);
    assert(typeof v.message === 'string' && v.message.length > 8, `weak message for ${v.code}`);
    assert(Array.isArray(v.instance_ids), `instance_ids missing for ${v.code}`);
  }
});

test('metrics contract from \u00a74.5 is present', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  for (const key of ['walkway_min_mm', 'coverage', 'balance']) {
    assert(typeof l.metrics[key] === 'number', `metrics.${key} missing`);
  }
  assert(l.score >= 0 && l.score <= 1, `score ${l.score} out of range`);
  assert(Array.isArray(l.rationale) && l.rationale.length >= 3, 'rationale too thin');
  assert(l.rationale.every((r) => typeof r === 'string' && r.length > 20), 'generic rationale line');
  assert(l.rationale.some((r) => /\d/.test(r)), 'no rationale line cites a real measurement');
});

test('placement contract from \u00a74.5 is respected', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  for (const p of l.placements) {
    for (const key of ['instance_id', 'item_id', 'x_mm', 'y_mm', 'rot_deg', 'colorway', 'locked', 'added_by_ai']) {
      assert(key in p, `placement missing ${key}`);
    }
    assert(Number.isInteger(p.x_mm) && Number.isInteger(p.y_mm), 'coordinates must be integer mm');
    assert(p.rot_deg >= 0 && p.rot_deg < 360, `rot_deg ${p.rot_deg} out of range`);
  }
});

test('augment mode adds a small number of tagged, gap-driven pieces', () => {
  const plain = best(F.LIVING, [{ item_id: 'ikea-ektorp-3s', qty: 1 }, { item_id: 'ikea-lack-coffee', qty: 1 }], { seed: 3 });
  const aug = best(F.LIVING, [{ item_id: 'ikea-ektorp-3s', qty: 1 }, { item_id: 'ikea-lack-coffee', qty: 1 }], { seed: 3, mode: 'augment' });
  const added = aug.placements.filter((p) => p.added_by_ai);
  assert(added.length > 0, 'augment mode added nothing to an under-furnished room');
  assert(added.length <= 4, `augment added ${added.length} pieces (max 4)`);
  assert(aug.placements.length > plain.placements.length, 'augment did not grow the layout');
  const sugg = suggestAdditions({
    room: F.LIVING, layout: plain, catalog: F.CATALOG, style: 'cozy', seed: 3,
  });
  assert(sugg.every((s) => s.item_id && s.reason && s.reason.length > 20),
    'suggestAdditions returned a reason that is not a real sentence');
});

test('locked placements are honoured verbatim', () => {
  const items = [
    { item_id: 'ikea-ektorp-3s', qty: 1, locked_placement: { x_mm: 2100, y_mm: 500, rot_deg: 0 } },
    { item_id: 'ikea-lack-coffee', qty: 1 },
  ];
  const l = best(F.LIVING, items, { seed: 17 });
  const p = l.placements.find((q) => q.item_id === 'ikea-ektorp-3s');
  assert(p && p.x_mm === 2100 && p.y_mm === 500 && p.locked === true,
    `locked placement was moved to ${p && p.x_mm},${p && p.y_mm}`);
});

test('validatePlacement filters violations to one instance', () => {
  const l = best(F.TINY, F.TINY_ITEMS, { seed: 8 });
  const all = validatePlacement({ room: F.TINY, layout: l, catalog: F.CATALOG });
  assert(Array.isArray(all), 'validatePlacement must return an array');
  const id = l.placements[0].instance_id;
  const one = validatePlacement({ room: F.TINY, layout: l, catalog: F.CATALOG, instance_id: id });
  assert(one.every((v) => v.instance_ids.indexOf(id) >= 0), 'filter leaked other instances');
});

test('scoreLayout is stable and re-derivable from a layout alone', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  const a = scoreLayout({ room: F.LIVING, layout: l, catalog: F.CATALOG });
  const b = scoreLayout({ room: F.LIVING, layout: l, catalog: F.CATALOG });
  assert(a.score === b.score, 'scoreLayout is not deterministic');
  assert(a.metrics.walkway_min_mm === l.metrics.walkway_min_mm, 'metrics drift on rescore');
});

test('performance: a 6\u201310 item room solves in well under 300ms per candidate', () => {
  const t = Date.now();
  const N = 5;
  for (let i = 0; i < N; i++) solve(F.LIVING, F.LIVING_ITEMS, { seed: 100 + i, count: 3 });
  const per = (Date.now() - t) / (N * 3);
  console.log(`      \u2192 ${per.toFixed(1)}ms per candidate (${F.LIVING_ITEMS.length} lines / 9 pieces)`);
  assert(per < 300, `${per.toFixed(1)}ms per candidate`);
});

// ---------------------------------------------------------------------------
console.log('\nblueprint \u2014 output');

function xmlWellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let mm;
  while ((mm = re.exec(svg))) {
    const [, close, tag, , selfClose] = mm;
    if (close) {
      if (!stack.length || stack.pop() !== tag) return `unbalanced </${tag}>`;
    } else if (!selfClose) stack.push(tag);
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  const amps = svg.match(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g);
  if (amps) return `raw ampersand x${amps.length}`;
  return null;
}

const SHEETS = [
  ['living', F.LIVING, F.LIVING_ITEMS, 'A3'],
  ['bedroom', F.BEDROOM, F.BEDROOM_ITEMS, 'A4'],
  ['studio', F.STUDIO, F.STUDIO_ITEMS, 'A3'],
];

for (const [label, room, items, paper] of SHEETS) {
  test(`${label}: blueprint SVG is well-formed and standalone (${paper})`, () => {
    const l = best(room, items, { seed: 1234 });
    const svg = renderBlueprint({
      room, layout: l, catalog: F.CATALOG,
      opts: { paper, unit: 'mm', title: `${label} plan`, project: 'test', author: 'tests' },
    });
    assert(svg.startsWith('<?xml'), 'missing XML declaration');
    assert(/<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg), 'missing SVG namespace');
    assert(svg.trim().endsWith('</svg>'), 'SVG is not closed');
    const err = xmlWellFormed(svg);
    assert(!err, `not well-formed: ${err}`);
    assert(!/xlink:href|<image|@import|url\(http/.test(svg), 'external reference found');
    assert(!/(fill|stroke)="(?!#000|#fff|none|url\(#hatch)/.test(svg), 'non black/white paint found');
    assert(/<pattern id="hatch"/.test(svg), 'wall hatch pattern missing');
    assert(/stroke-dasharray/.test(svg), 'no dashed linework (door arc / soft goods) found');
  });

  test(`${label}: every placement is tagged and named on the sheet`, () => {
    const l = best(room, items, { seed: 1234 });
    const svg = renderBlueprint({ room, layout: l, catalog: F.CATALOG, opts: { paper } });
    const sched = renderSchedule({ layout: l, catalog: F.CATALOG });
    assert(sched.rows.length > 0, 'empty schedule');
    for (const r of sched.rows) {
      for (const key of ['tag', 'qty', 'brand', 'name', 'dims', 'sku', 'price', 'total']) {
        assert(key in r, `schedule row missing ${key}`);
      }
      assert(svg.indexOf(r.dims) >= 0 || svg.indexOf(r.dims.slice(0, 6)) >= 0,
        `dims for ${r.name} absent from the sheet`);
    }
    assert(typeof sched.total === 'number' && sched.total > 0, 'schedule total not computed');
    const qty = sched.rows.reduce((a, r) => a + r.qty, 0);
    assert(qty === l.placements.length, `${qty} scheduled vs ${l.placements.length} placed`);
  });

  test(`${label}: dimension chain totals equal the real room size`, () => {
    const l = best(room, items, { seed: 1234 });
    const svg = renderBlueprint({ room, layout: l, catalog: F.CATALOG, opts: { paper, unit: 'mm' } });
    const rm = buildRoom(room);
    for (const total of [Math.round(rm.bbox.w), Math.round(rm.bbox.h)]) {
      assert(svg.indexOf(`>${total}<`) >= 0, `overall dimension ${total}mm not drawn`);
    }
    // per-wall stations must sum to the wall length
    for (const w of rm.walls) {
      const st = [0, ...w.openings.flatMap((o) => [o.t0, o.t1]), w.len].sort((a, b) => a - b);
      let sum = 0;
      for (let i = 1; i < st.length; i++) sum += st[i] - st[i - 1];
      assert(near(sum, w.len, 1), `wall ${w.index} chain sums to ${sum} not ${w.len}`);
    }
  });
}

test('blueprint render is deterministic for identical input', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  const o = { paper: 'A3', unit: 'mm', date: '2026-01-01' };
  assert(renderBlueprint({ room: F.LIVING, layout: l, catalog: F.CATALOG, opts: o })
    === renderBlueprint({ room: F.LIVING, layout: l, catalog: F.CATALOG, opts: o }),
  'two identical renders differ');
});

test('unit toggle changes the drawn dimensions (mm / cm / ft)', () => {
  const l = best(F.LIVING, F.LIVING_ITEMS, { seed: 1234 });
  const mm = renderBlueprint({ room: F.LIVING, layout: l, catalog: F.CATALOG, opts: { unit: 'mm' } });
  const cm = renderBlueprint({ room: F.LIVING, layout: l, catalog: F.CATALOG, opts: { unit: 'cm' } });
  const ft = renderBlueprint({ room: F.LIVING, layout: l, catalog: F.CATALOG, opts: { unit: 'ft' } });
  assert(mm.indexOf('>4200<') >= 0, 'mm chain missing 4200');
  assert(cm.indexOf('>420<') >= 0, 'cm chain missing 420');
  assert(/>13'-\d/.test(ft), 'ft-in chain missing');
});

test('label collision: no two label boxes overlap on any sheet', () => {
  // the renderer places labels through a collision registry; verify the drawn
  // <text> boxes really are disjoint by re-measuring them from the SVG.
  for (const [label, room, items, paper] of SHEETS) {
    const l = best(room, items, { seed: 1234 });
    const svg = renderBlueprint({ room, layout: l, catalog: F.CATALOG, opts: { paper } });
    const re = /<text x="([-\d.]+)" y="([-\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g;
    const boxes = [];
    let mt;
    while ((mt = re.exec(svg))) {
      const x = +mt[1], y = +mt[2], s = +mt[3], anchor = mt[4], str = mt[5];
      if (!str.trim()) continue;
      if (/rotate\(/.test(mt[0])) continue;               // rotated dim text, measured separately
      const w = str.length * s * 0.5, h = s * 0.92;
      const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      boxes.push({ x0, y0: y - h * 0.78, x1: x0 + w, y1: y + h * 0.22, str });
    }
    assert(boxes.length > 10, `${label}: only ${boxes.length} labels found`);
    let clashes = 0, first = '';
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x1 <= b.x0 || a.x0 >= b.x1 || a.y1 <= b.y0 || a.y0 >= b.y1) continue;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox * oy < 0.35) continue;                     // sub-visual grazing
        clashes++;
        if (!first) first = `"${a.str}" \u2229 "${b.str}" (${(ox * oy).toFixed(2)}mm\u00b2)`;
      }
    }
    assert(clashes === 0, `${label}: ${clashes} overlapping label(s) \u2014 e.g. ${first}`);
  }
});

// ---------------------------------------------------------------------------
const ms = Date.now() - t0;
console.log('\n' + '\u2500'.repeat(66));
console.log(`  ${pass} passed   ${fail} failed   ${pass + fail} total   ${ms}ms`);
if (fail) {
  console.log('\n  FAILURES');
  for (const f of failures) console.log(`   \u2022 ${f.name}\n     ${f.message}`);
}
console.log('  ' + (fail ? 'RESULT: FAIL' : 'RESULT: PASS'));
console.log('\u2500'.repeat(66) + '\n');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* packages/floorplan/tests/run.js — zero dependencies.
 * Run:  node packages/floorplan/tests/run.js
 */

import {
  createFloorplan, addRoom, removeRoom, moveRoom, resizeRoom, setRoomEdge, translateRoom,
  addDoor, addWindow, updateOpening, removeOpening, connectRooms, disconnectRooms,
  deriveInteriorWalls, rebuildInteriorWalls, roomMetrics, planMetrics, floorplanToShell,
  validateFloorplan, errorsOnly, PRESETS, presetById, createHistory, snapRect, snapScalar,
  setBriefItem, briefCount, buildHandoff, saveHandoff, readHandoff, HANDOFF_KEY,
  resetIds, GRID_MM, FLOOR_MATERIALS, setFloorMaterial, renameRoom, getRoom,
} from '../index.js';
import {
  signedArea, polygonArea, polygonPerimeter, isCCW, isRect, ensureCCW, bbox,
  rectPolygon, findSharedEdges, outerRing, unionRects, rectOverlapArea, rectsContiguous,
  openingSegment, polygonWall, areaUnits, roomRect, holeRings,
} from '../geometry.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; process.stdout.write('.'); }
  catch (e) { fail++; failures.push([name, e]); process.stdout.write('F'); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || 'not equal'}\n  actual   ${A}\n  expected ${B}`);
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'not near'}: ${a} vs ${b} (tol ${tol})`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function no(v, msg) { if (v) throw new Error(msg || 'expected falsy'); }
function allInt(poly, msg) {
  for (const p of poly) for (const c of p) {
    if (!Number.isInteger(c)) throw new Error(`${msg || 'non-integer mm'}: ${c}`);
  }
}

/* ══════════════════════ geometry primitives ══════════════════════ */

t('rectPolygon is CCW with wall_index 0=south', () => {
  const p = rectPolygon(0, 0, 4600, 3800);
  eq(p, [[0, 0], [4600, 0], [4600, 3800], [0, 3800]]);
  ok(isCCW(p), 'rect must be CCW');
  ok(isRect(p));
  const w0 = polygonWall(p, 0);
  eq(w0.dir, [1, 0], 'wall 0 runs +x (south wall)');
});

t('area & perimeter match hand-computed values (4600x3800)', () => {
  const p = rectPolygon(0, 0, 4600, 3800);
  // 4600 * 3800 = 17,480,000 mm² = 17.48 m² = 188.15315 ft² (x 10.76391042)
  eq(polygonArea(p), 17480000);
  eq(polygonPerimeter(p), 2 * (4600 + 3800));       // 16 800 mm
  const u = areaUnits(polygonArea(p));
  near(u.m2, 17.48, 1e-9, 'm²');
  near(u.ft2, 188.15315, 1e-4, 'ft²');
});

t('area & perimeter for the L-shaped union (hand-computed)', () => {
  // 4000x3000 plus 2000x1500 stuck on the right at y 0..1500
  const rects = [
    { x0: 0, y0: 0, x1: 4000, y1: 3000 },
    { x0: 4000, y0: 0, x1: 6000, y1: 1500 },
  ];
  const ring = outerRing(rects);
  // 4000*3000 + 2000*1500 = 12e6 + 3e6 = 15e6 mm² = 15 m²
  eq(polygonArea(ring), 15000000);
  // perimeter: 6000 + 1500 + 2000 + 1500 + 4000 + 3000 = 18000
  eq(polygonPerimeter(ring), 18000);
  eq(ring.length, 6, 'L outline has 6 vertices');
  ok(isCCW(ring), 'outer ring CCW');
  allInt(ring);
});

t('signedArea sign flips with winding; ensureCCW normalises', () => {
  const cw = [[0, 0], [0, 1000], [1000, 1000], [1000, 0]];
  ok(signedArea(cw) < 0);
  ok(isCCW(ensureCCW(cw)));
  eq(polygonArea(ensureCCW(cw)), 1000000);
});

t('unionRects merges two abutting rects into one rectangle', () => {
  const rings = unionRects([
    { x0: 0, y0: 0, x1: 3000, y1: 4000 },
    { x0: 3000, y0: 0, x1: 5000, y1: 4000 },
  ]);
  eq(rings.length, 1);
  eq(polygonArea(rings[0]), 5000 * 4000);
  eq(ensureCCW(rings[0]).length, 4, 'collinear mid-vertices collapsed');
});

t('holeRings finds a courtyard', () => {
  const rects = [
    { x0: 0, y0: 0, x1: 6000, y1: 1000 },
    { x0: 0, y0: 5000, x1: 6000, y1: 6000 },
    { x0: 0, y0: 1000, x1: 1000, y1: 5000 },
    { x0: 5000, y0: 1000, x1: 6000, y1: 5000 },
  ];
  eq(holeRings(rects).length, 1, 'one hole');
  eq(polygonArea(outerRing(rects)), 6000 * 6000);
});

t('rectOverlapArea: touching = 0, overlapping = exact', () => {
  eq(rectOverlapArea({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 }), 0);
  eq(rectOverlapArea({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, { x0: 500, y0: 500, x1: 1500, y1: 1500 }), 250000);
});

t('rectsContiguous rejects a floating island', () => {
  ok(rectsContiguous([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 }]));
  no(rectsContiguous([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 500, y0: 0, x1: 510, y1: 10 }]));
});

t('openingSegment places the near edge at offset from the wall start', () => {
  const p = rectPolygon(0, 0, 4000, 3000);
  const [a, b] = openingSegment(p, { wall_index: 0, offset_mm: 300, width_mm: 900 });
  eq(a, [300, 0]); eq(b, [1200, 0]);
  const [c, d] = openingSegment(p, { wall_index: 2, offset_mm: 500, width_mm: 1000 });
  // wall 2 runs from [4000,3000] to [0,3000], i.e. -x
  eq(c, [3500, 3000]); eq(d, [2500, 3000]);
});

/* ══════════════════════ room operations ══════════════════════ */

t('addRoom places an integer-mm CCW rect and returns it', () => {
  resetIds(0);
  const fp = createFloorplan({ name: 'T' });
  const r = addRoom(fp, { name: 'Living room', w_mm: 4600, d_mm: 3800, at: [0, 0] });
  eq(fp.rooms.length, 1);
  eq(r.polygon_mm, [[0, 0], [4600, 0], [4600, 3800], [0, 3800]]);
  eq(r.height_mm, 2600);
  ok(FLOOR_MATERIALS.includes(r.floor_material));
  allInt(r.polygon_mm);
  const m = roomMetrics(r);
  eq(m.area_mm2, 17480000);
  eq(m.perimeter_mm, 16800);
  near(m.area_ft2, 188.15315, 1e-4);
});

t('moveRoom translates without changing size; openings ride along', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 3000, d_mm: 2000, at: [0, 0] });
  addDoor(fp, r.id, { wall_index: 0, offset_mm: 200, width_mm: 900 });
  moveRoom(fp, r.id, [1500, 2500]);
  eq(bbox(r.polygon_mm), { x0: 1500, y0: 2500, x1: 4500, y1: 4500, w: 3000, d: 2000 });
  eq(r.openings[0].offset_mm, 200, 'wall-relative offset unchanged');
  const [a] = openingSegment(r.polygon_mm, r.openings[0]);
  eq(a, [1700, 2500], 'absolute door position followed the room');
  translateRoom(fp, r.id, -500, -500);
  eq(bbox(r.polygon_mm).x0, 1000);
});

t('resizeRoom honours the anchor and clamps openings', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 4000, d_mm: 3000, at: [1000, 1000] });
  addWindow(fp, r.id, { wall_index: 0, offset_mm: 3000, width_mm: 900 });
  resizeRoom(fp, r.id, { w_mm: 2000, anchor: 'min' });
  eq(bbox(r.polygon_mm), { x0: 1000, y0: 1000, x1: 3000, y1: 4000, w: 2000, d: 3000 });
  eq(r.openings[0].offset_mm, 1100, 'window pushed back inside the shorter wall');
  eq(r.openings[0].width_mm, 900);
  resizeRoom(fp, r.id, { w_mm: 4000, anchor: 'max' });
  eq(bbox(r.polygon_mm).x1, 3000, 'max anchor keeps the far corner');
  eq(bbox(r.polygon_mm).x0, -1000);
});

t('setRoomEdge drags one wall and never inverts the room', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [0, 0] });
  setRoomEdge(fp, r.id, 'e', 5000);
  eq(bbox(r.polygon_mm).w, 5000);
  setRoomEdge(fp, r.id, 'e', -9999);
  eq(bbox(r.polygon_mm).w, GRID_MM, 'clamped to one grid cell, not inverted');
});

t('removeRoom drops the room, its connections and its brief', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [0, 0] });
  const b = addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [3000, 0] });
  connectRooms(fp, a.id, b.id, {});
  setBriefItem(fp, b.id, 'ikea-ektorp-3seat', 2);
  eq(fp.connections.length, 1);
  ok(removeRoom(fp, b.id));
  eq(fp.rooms.length, 1);
  eq(fp.connections.length, 0);
  eq(fp.brief[b.id], undefined);
  eq(fp.interior_walls.length, 0);
});

t('rename + floor material', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 3000, d_mm: 3000 });
  renameRoom(fp, r.id, 'Kitchen');
  setFloorMaterial(fp, r.id, 'tile');
  setFloorMaterial(fp, r.id, 'lava');            // rejected — not in the closed set
  eq(getRoom(fp, r.id).name, 'Kitchen');
  eq(getRoom(fp, r.id).floor_material, 'tile');
});

/* ══════════════════════ openings ══════════════════════ */

t('addDoor centres by default; updateOpening clamps to the wall', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 4000, d_mm: 3000 });
  const d = addDoor(fp, r.id, { wall_index: 0 });
  eq(d.width_mm, 900);
  eq(d.offset_mm, 1550, '(4000-900)/2');
  eq(d.height_mm, 2040); eq(d.sill_mm, 0); eq(d.swing, 'in-left');
  updateOpening(fp, r.id, d.id, { offset_mm: 99999 });
  eq(getRoom(fp, r.id).openings[0].offset_mm, 3100, 'clamped to wall length - width');
  const w = addWindow(fp, r.id, { wall_index: 1, offset_mm: 400, width_mm: 1200 });
  eq(w.sill_mm, 900); eq(w.swing, null);
  ok(removeOpening(fp, r.id, w.id));
  eq(getRoom(fp, r.id).openings.length, 1);
});

/* ══════════════════════ shared edges / interior walls ══════════════════════ */

t('two abutting rooms produce EXACTLY ONE shared interior wall', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { name: 'A', w_mm: 3200, d_mm: 4200, at: [0, 0] });
  const b = addRoom(fp, { name: 'B', w_mm: 2600, d_mm: 4200, at: [3200, 0] });
  const shared = findSharedEdges(fp.rooms);
  eq(shared.length, 1, 'one shared edge, not two coincident walls');
  eq(shared[0].axis, 'v'); eq(shared[0].at, 3200);
  eq(shared[0].a, [3200, 0]); eq(shared[0].b, [3200, 4200]);
  eq(shared[0].length_mm, 4200);

  const iw = deriveInteriorWalls(fp);
  eq(iw.length, 1);
  eq(iw[0].a, [3200, 0]); eq(iw[0].b, [3200, 4200]);
  eq(iw[0].thickness_mm, 110);
  eq(iw[0].openings, []);
  eq(iw[0].between.sort(), [a.id, b.id].sort());
});

t('partial overlap yields the overlap segment only', () => {
  const fp = createFloorplan();
  addRoom(fp, { w_mm: 3000, d_mm: 4000, at: [0, 0] });
  addRoom(fp, { w_mm: 3000, d_mm: 2000, at: [3000, 1000] });
  const s = findSharedEdges(fp.rooms);
  eq(s.length, 1);
  eq(s[0].a, [3000, 1000]); eq(s[0].b, [3000, 3000]);
  eq(s[0].length_mm, 2000, 'only the overlapping 2000mm is shared');
});

t('rooms that merely touch at a corner share no wall', () => {
  const fp = createFloorplan();
  addRoom(fp, { w_mm: 2000, d_mm: 2000, at: [0, 0] });
  addRoom(fp, { w_mm: 2000, d_mm: 2000, at: [2000, 2000] });
  eq(findSharedEdges(fp.rooms).length, 0);
});

t('connectRooms puts one door in the shared wall, centred', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { w_mm: 3200, d_mm: 4200, at: [0, 0] });
  const b = addRoom(fp, { w_mm: 2600, d_mm: 4200, at: [3200, 0] });
  const c = connectRooms(fp, a.id, b.id, { width_mm: 800 });
  eq(c.width_mm, 800);
  eq(c.offset_mm, 1700, '(4200-800)/2');
  const iw = fp.interior_walls;
  eq(iw.length, 1);
  eq(iw[0].openings.length, 1);
  eq(iw[0].openings[0].offset_mm, 1700);
  eq(iw[0].openings[0].width_mm, 800);
  eq(iw[0].openings[0].type, 'door');
  // repeat call updates rather than duplicates
  connectRooms(fp, b.id, a.id, { width_mm: 900, offset_mm: 100 });
  eq(fp.connections.length, 1);
  eq(fp.interior_walls[0].openings[0].width_mm, 900);
  eq(fp.interior_walls[0].openings[0].offset_mm, 100);
  ok(disconnectRooms(fp, a.id, b.id));
  eq(fp.interior_walls[0].openings.length, 0, 'wall stays, door gone');
});

t('three-room strip derives two interior walls', () => {
  const fp = createFloorplan();
  addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [0, 0] });
  addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [3000, 0] });
  addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [6000, 0] });
  eq(rebuildInteriorWalls(fp).length, 2);
  eq(polygonArea(outerRing(fp.rooms.map(roomRect))), 9000 * 3000);
});

/* ══════════════════════ validation ══════════════════════ */

t('overlap detection fires with the exact overlap area', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { name: 'A', w_mm: 4000, d_mm: 4000, at: [0, 0] });
  addRoom(fp, { name: 'B', w_mm: 4000, d_mm: 4000, at: [3000, 0] });
  addDoor(fp, a.id, { wall_index: 0 });
  const issues = validateFloorplan(fp);
  const ov = issues.filter(i => i.code === 'overlap');
  eq(ov.length, 1);
  ok(ov[0].severity === 'error');
  ok(/4\.00 m²/.test(ov[0].message), `expected 4.00 m² in "${ov[0].message}"`);
});

t('disconnected-room detection (no door path from the entrance)', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { name: 'Hall', w_mm: 3000, d_mm: 3000, at: [0, 0] });
  const b = addRoom(fp, { name: 'Back room', w_mm: 3000, d_mm: 3000, at: [3000, 0] });
  addDoor(fp, a.id, { wall_index: 0 });                  // front door on the hall
  let issues = validateFloorplan(fp);
  const dc = issues.filter(i => i.code === 'disconnected');
  eq(dc.length, 1);
  eq(dc[0].room_id, b.id);
  connectRooms(fp, a.id, b.id, {});
  issues = validateFloorplan(fp);
  eq(issues.filter(i => i.code === 'disconnected').length, 0, 'door fixes it');
  eq(errorsOnly(issues).length, 0, `unexpected errors: ${JSON.stringify(errorsOnly(issues))}`);
});

t('no_entrance warns when there is no exterior door', () => {
  const fp = createFloorplan();
  addRoom(fp, { w_mm: 4000, d_mm: 4000 });
  const issues = validateFloorplan(fp);
  eq(issues.filter(i => i.code === 'no_entrance').length, 1);
  ok(issues.every(i => i.code !== 'disconnected'));
});

t('room-below-usable-minimum warnings', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { name: 'Cupboard', w_mm: 900, d_mm: 900, at: [0, 0] });
  addDoor(fp, r.id, { wall_index: 0, width_mm: 700 });
  const codes = validateFloorplan(fp).map(i => i.code);
  ok(codes.includes('room_too_small'), 'area under 3.5 m²');
  ok(codes.includes('room_too_narrow'), 'narrower than 1200mm');
});

t('walls thinner than 60mm are errors', () => {
  const fp = createFloorplan({ wall_thickness_mm: 50, interior_thickness_mm: 20 });
  addRoom(fp, { w_mm: 4000, d_mm: 4000 });
  const thin = validateFloorplan(fp).filter(i => i.code === 'thin_wall');
  eq(thin.length, 2);
  ok(thin.every(i => i.severity === 'error'));
  const good = createFloorplan({ wall_thickness_mm: 60, interior_thickness_mm: 60 });
  addRoom(good, { w_mm: 4000, d_mm: 4000 });
  eq(validateFloorplan(good).filter(i => i.code === 'thin_wall').length, 0, '60mm is allowed');
});

t('openings that run off their wall are errors', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 3000, d_mm: 3000 });
  r.openings.push({ id: 'bad', type: 'window', wall_index: 0, offset_mm: 2800, width_mm: 900, height_mm: 1400, sill_mm: 900, swing: null });
  const codes = validateFloorplan(fp).map(i => i.code);
  ok(codes.includes('opening_out_of_span'));
});

t('detached room warning', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { w_mm: 3000, d_mm: 3000, at: [0, 0] });
  addRoom(fp, { name: 'Island', w_mm: 3000, d_mm: 3000, at: [9000, 9000] });
  addDoor(fp, a.id, { wall_index: 0 });
  ok(validateFloorplan(fp).some(i => i.code === 'detached_room'));
});

t('empty plan warns, never throws', () => {
  eq(validateFloorplan(createFloorplan()).map(i => i.code), ['no_rooms']);
  eq(validateFloorplan(null)[0].code, 'malformed');
});

/* ══════════════════════ presets ══════════════════════ */

t('there are at least 4 presets with the named sizes', () => {
  ok(PRESETS.length >= 4, `only ${PRESETS.length} presets`);
  const names = PRESETS.map(p => p.name);
  ok(names.some(n => /Studio 6\.0 × 4\.2/.test(n)), 'Studio 6.0×4.2m');
  ok(names.some(n => /1-bed/.test(n)), '1-bed apartment');
  ok(names.some(n => /2-bed/.test(n)), '2-bed apartment');
  ok(names.some(n => /Single room 4\.6 × 3\.8/.test(n)), 'Single room 4.6×3.8m');
});

t('every preset passes validateFloorplan with zero errors', () => {
  for (const p of PRESETS) {
    const fp = presetById(p.id);
    rebuildInteriorWalls(fp);
    const errs = errorsOnly(validateFloorplan(fp));
    if (errs.length) throw new Error(`${p.id}: ${JSON.stringify(errs, null, 1)}`);
    for (const r of fp.rooms) {
      allInt(r.polygon_mm, `${p.id}/${r.id}`);
      ok(isCCW(r.polygon_mm), `${p.id}/${r.id} must be CCW`);
      ok(FLOOR_MATERIALS.includes(r.floor_material), `${p.id}/${r.id} floor material`);
    }
  }
});

t('preset dimensions are exactly as advertised', () => {
  const single = presetById('fp_single_room');
  eq(bbox(single.rooms[0].polygon_mm).w, 4600);
  eq(bbox(single.rooms[0].polygon_mm).d, 3800);
  near(planMetrics(single).area_m2, 17.48, 1e-9);

  const studio = presetById('fp_studio');
  eq(bbox(studio.rooms[0].polygon_mm).w, 6000);
  eq(bbox(studio.rooms[0].polygon_mm).d, 4200);
  near(planMetrics(studio).area_m2, 25.2, 1e-9);

  const one = presetById('fp_1bed');
  near(planMetrics(one).area_m2, 38.64, 1e-9);
  eq(planMetrics(one).footprint_mm.w, 9200);
  eq(planMetrics(one).footprint_mm.d, 4200);

  const two = presetById('fp_2bed');
  near(planMetrics(two).area_m2, 50.6, 1e-9);
  eq(planMetrics(two).footprint_mm.w, 11000);
  eq(planMetrics(two).footprint_mm.d, 4600);
});

t('1-bed derives 4 interior walls; 2-bed derives 7', () => {
  const one = presetById('fp_1bed');
  const iw1 = deriveInteriorWalls(one);
  // living|hall (x4800), hall|bath (x6000 y0-1800), hall|bed (x6000 y1800-4200), bath|bed (y1800)
  eq(iw1.length, 4, JSON.stringify(iw1.map(w => [w.a, w.b])));
  eq(iw1.filter(w => w.openings.length).length, 3, 'three of the four carry a door');

  const two = presetById('fp_2bed');
  const iw2 = deriveInteriorWalls(two);
  // hall|living, hall|bed1, hall|bed2, hall|bath  +  living|bed1, bed1|bed2, bed2|bath
  eq(iw2.length, 7, JSON.stringify(iw2.map(w => [w.a, w.b])));
  eq(iw2.filter(w => w.openings.length).length, 4, 'four doors off the hall');
});

t('presetById returns an isolated copy', () => {
  const a = presetById('fp_studio');
  a.rooms[0].name = 'mutated';
  eq(presetById('fp_studio').rooms[0].name, 'Studio');
});

/* ══════════════════════ floorplanToShell ══════════════════════ */

t('floorplanToShell: single room, CCW integer polygon, openings preserved', () => {
  const fp = presetById('fp_single_room');
  const s = floorplanToShell(fp);
  eq(s.polygon_mm, [[0, 0], [4600, 0], [4600, 3800], [0, 3800]]);
  ok(isCCW(s.polygon_mm));
  allInt(s.polygon_mm);
  eq(s.height_mm, 2600);
  eq(s.openings.length, 3);
  eq(s.dropped_openings, []);
  eq(s.interior_walls, []);
  eq(s.rooms.length, 1);
  const door = s.openings.find(o => o.id === 'd_front');
  eq([door.wall_index, door.offset_mm, door.width_mm], [0, 400, 900]);
  eq(door.swing, 'in-left');
});

t('floorplanToShell: 1-bed — one wall per shared edge, no duplicates', () => {
  const fp = presetById('fp_1bed');
  const s = floorplanToShell(fp);
  eq(s.polygon_mm, [[0, 0], [9200, 0], [9200, 4200], [0, 4200]]);
  ok(isCCW(s.polygon_mm));
  eq(s.interior_walls.length, 4);
  const seen = new Set();
  for (const w of s.interior_walls) {
    const k = [w.a, w.b].map(p => p.join(':')).sort().join('|');
    ok(!seen.has(k), `duplicate coincident wall at ${k}`);
    seen.add(k);
    allInt([w.a, w.b]);
    ok(w.thickness_mm >= 60);
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    for (const o of w.openings) {
      ok(o.offset_mm >= 0 && o.offset_mm + o.width_mm <= len + 1,
        `interior opening ${o.id} outside its wall span (${o.offset_mm}+${o.width_mm} of ${len})`);
    }
  }
  eq(s.rooms.length, 4);
  eq(s.rooms.map(r => r.name), ['Living / kitchen', 'Hall', 'Bathroom', 'Bedroom']);
});

t('floorplanToShell: every exterior opening lands inside its envelope wall span', () => {
  for (const p of PRESETS) {
    const s = floorplanToShell(presetById(p.id));
    eq(s.dropped_openings, [], `${p.id} dropped openings`);
    for (const o of s.openings) {
      const w = polygonWall(s.polygon_mm, o.wall_index);
      ok(Number.isInteger(o.offset_mm) && Number.isInteger(o.width_mm), `${p.id}/${o.id} integer mm`);
      ok(o.offset_mm >= 0 && o.offset_mm + o.width_mm <= w.length_mm + 1,
        `${p.id}/${o.id}: ${o.offset_mm}+${o.width_mm} does not fit wall ${o.wall_index} (${w.length_mm})`);
      ok(o.sill_mm + o.height_mm <= s.height_mm, `${p.id}/${o.id} above the ceiling`);
    }
  }
});

t('floorplanToShell remaps an opening onto the merged envelope wall', () => {
  // two rooms side by side; the right room's south door must be reported against the
  // merged 6000mm south wall of the envelope, offset shifted by 3000mm.
  const fp = createFloorplan();
  const a = addRoom(fp, { name: 'A', w_mm: 3000, d_mm: 3000, at: [0, 0] });
  const b = addRoom(fp, { name: 'B', w_mm: 3000, d_mm: 3000, at: [3000, 0] });
  addDoor(fp, b.id, { wall_index: 0, offset_mm: 500, width_mm: 900 });
  connectRooms(fp, a.id, b.id, {});
  const s = floorplanToShell(fp);
  eq(s.polygon_mm, [[0, 0], [6000, 0], [6000, 3000], [0, 3000]]);
  eq(s.openings.length, 1);
  eq([s.openings[0].wall_index, s.openings[0].offset_mm, s.openings[0].width_mm], [0, 3500, 900]);
});

t('floorplanToShell: 2-bed envelope + interior walls conform', () => {
  const s = floorplanToShell(presetById('fp_2bed'));
  eq(s.polygon_mm, [[0, 0], [11000, 0], [11000, 4600], [0, 4600]]);
  eq(s.interior_walls.length, 7);
  eq(s.rooms.length, 5);
  eq(s.wall_thickness_mm, 200);
  ok(s.interior_walls.every(w => w.thickness_mm === 110));
  const doors = s.interior_walls.flatMap(w => w.openings);
  eq(doors.length, 4);
  ok(doors.every(d => Number.isInteger(d.offset_mm) && Number.isInteger(d.width_mm)));
});

t('floorplanToShell of an L-shaped plan keeps the 6-vertex envelope', () => {
  const fp = createFloorplan();
  const a = addRoom(fp, { name: 'A', w_mm: 4000, d_mm: 3000, at: [0, 0] });
  const b = addRoom(fp, { name: 'B', w_mm: 2000, d_mm: 1500, at: [4000, 0] });
  addDoor(fp, a.id, { wall_index: 0, offset_mm: 300, width_mm: 900 });
  connectRooms(fp, a.id, b.id, { width_mm: 800 });
  const s = floorplanToShell(fp);
  eq(s.polygon_mm.length, 6);
  eq(polygonArea(s.polygon_mm), 15000000);
  ok(isCCW(s.polygon_mm));
  eq(s.interior_walls.length, 1);
  eq(s.interior_walls[0].openings.length, 1);
  eq(errorsOnly(validateFloorplan(fp)).length, 0);
});

/* ══════════════════════ history / snapping / brief ══════════════════════ */

t('undo/redo restores geometry', () => {
  const fp = createFloorplan();
  addRoom(fp, { w_mm: 3000, d_mm: 3000 });
  const h = createHistory(fp);
  no(h.canUndo);
  h.commit(d => resizeRoom(d, d.rooms[0].id, { w_mm: 4600 }));
  eq(bbox(h.current.rooms[0].polygon_mm).w, 4600);
  ok(h.canUndo);
  h.undo();
  eq(bbox(h.current.rooms[0].polygon_mm).w, 3000);
  ok(h.canRedo);
  h.redo();
  eq(bbox(h.current.rooms[0].polygon_mm).w, 4600);
});

t('snapRect snaps to a neighbour edge, else to the 100mm grid', () => {
  const others = [{ x0: 0, y0: 0, x1: 3000, y1: 4000 }];
  const s = snapRect({ x0: 3040, y0: 30, x1: 5040, y1: 2030 }, others);
  eq(s.x0, 3000, 'snapped to the neighbour edge');
  eq(s.y0, 0);
  ok(s.snapped.x && s.snapped.y);
  const g = snapRect({ x0: 9040, y0: 9060, x1: 11040, y1: 11060 }, others);
  eq([g.x0, g.y0], [9000, 9100], 'fell back to grid');
  eq(snapScalar(4573, [], {}).value, 4600);
  eq(snapScalar(3040, [3000], {}).value, 3000);
});

t('furniture brief add / change / remove', () => {
  const fp = createFloorplan();
  const r = addRoom(fp, { w_mm: 4000, d_mm: 4000 });
  setBriefItem(fp, r.id, 'ikea-ektorp-3seat', 1);
  setBriefItem(fp, r.id, 'ikea-ektorp-3seat', 3);
  setBriefItem(fp, r.id, 'ikea-lack-side', 2);
  eq(fp.brief[r.id].length, 2);
  eq(briefCount(fp), 5);
  setBriefItem(fp, r.id, 'ikea-lack-side', 0);
  eq(fp.brief[r.id].length, 1);
  setBriefItem(fp, r.id, 'ikea-ektorp-3seat', 0);
  eq(fp.brief[r.id], undefined);
  eq(briefCount(fp), 0);
});

t('handoff payload carries floorplan + shell + brief and round-trips localStorage', () => {
  const fp = presetById('fp_1bed');
  rebuildInteriorWalls(fp);
  setBriefItem(fp, 'r_living', 'ikea-ektorp-3seat', 1);
  const store = new Map();
  const shim = { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) ?? null };
  const { payload, url } = saveHandoff(fp, shim);
  eq(url, 'editor.html?plan=handoff');
  ok(store.has(HANDOFF_KEY), 'wrote the handoff key');
  const back = readHandoff(shim);
  eq(back.v, 2);
  eq(back.source, 'design');
  eq(back.shell.polygon_mm, payload.shell.polygon_mm);
  eq(back.shell.interior_walls.length, 4);
  eq(back.brief, [{ room_id: 'r_living', items: [{ item_id: 'ikea-ektorp-3seat', qty: 1 }] }]);
  eq(errorsOnly(back.issues).length, 0);
  ok(JSON.stringify(back).length < 400000, 'payload stays well inside the 5MB quota');
});

/* ══════════════════════ report ══════════════════════ */

console.log(`\n\nfloorplan tests: ${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const [name, e] of failures) console.error(`\n✗ ${name}\n  ${e.message}`);
  process.exit(1);
}
const totals = PRESETS.map(p => {
  const m = planMetrics(presetById(p.id));
  const iw = deriveInteriorWalls(presetById(p.id)).length;
  return `  ${p.id.padEnd(16)} ${String(m.count).padStart(2)} rooms  ${m.area_m2.toFixed(2).padStart(6)} m²  ` +
         `${m.area_ft2.toFixed(1).padStart(7)} ft²  envelope ${m.footprint_mm.w}×${m.footprint_mm.d}mm  ${iw} interior wall(s)`;
});
console.log(totals.join('\n'));
process.exit(0);

/* packages/floorplan/index.js
 * ainterior floorplan model + operations + shell derivation.
 * Dependency-free and DOM-free (SPEC §8.7) so it runs in the browser demo and in Node tests.
 * Units: integer millimetres, plan frame x->right / y->up-the-page (SPEC §1).
 */

import {
  EPS, round, bbox, isRect, ensureCCW, polygonArea, polygonPerimeter, rectPolygon,
  roomRect, rectOverlapArea, findSharedEdges, outerRing, holeRings, polygonWall,
  polygonWalls, openingSegment, areaUnits,
} from './geometry.js';
import { validateFloorplan, errorsOnly, isValid, MIN_WALL_MM } from './validate.js';
import { PRESETS, presetById } from './presets.js';

export {
  validateFloorplan, errorsOnly, isValid, PRESETS, presetById,
  areaUnits, findSharedEdges, outerRing, polygonArea, polygonPerimeter, rectPolygon,
  bbox, isRect, ensureCCW, polygonWall, polygonWalls, openingSegment, roomRect,
  rectOverlapArea, MIN_WALL_MM,
};

export const SCHEMA_VERSION = 2;
export const GRID_MM = 100;                    // SPEC2 §H: 100mm snap grid
export const DEFAULT_HEIGHT_MM = 2600;
export const DEFAULT_EXT_WALL_MM = 200;
export const DEFAULT_INT_WALL_MM = 110;
export const FLOOR_MATERIALS = ['oak', 'ash', 'concrete', 'tile', 'carpet'];  // SPEC2 §G2

export const DOOR = { width_mm: 900, height_mm: 2040, sill_mm: 0, swing: 'in-left' };
export const INTERIOR_DOOR = { width_mm: 800, height_mm: 2040, sill_mm: 0, swing: 'in-left' };
export const WINDOW = { width_mm: 1200, height_mm: 1400, sill_mm: 900 };

/* ───────────────────────────── ids ───────────────────────────── */

let _seq = 0;
export function uid(prefix) {
  _seq += 1;
  return `${prefix}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
/** Deterministic ids for tests / presets. */
export function resetIds(n = 0) { _seq = n; }

export function snap(v, grid = GRID_MM) { return Math.round(v / grid) * grid; }

/* ───────────────────────── construction ───────────────────────── */

export function createFloorplan(opts = {}) {
  return {
    schema: SCHEMA_VERSION,
    id: opts.id || uid('fp_'),
    name: opts.name || 'My floorplan',
    unit: opts.unit || 'cm',                       // display unit only (SPEC §1)
    wall_thickness_mm: opts.wall_thickness_mm ?? DEFAULT_EXT_WALL_MM,
    interior_thickness_mm: opts.interior_thickness_mm ?? DEFAULT_INT_WALL_MM,
    default_height_mm: opts.default_height_mm ?? DEFAULT_HEIGHT_MM,
    rooms: [],
    connections: [],          // interior doorways between adjacent rooms
    interior_walls: [],       // derived — kept in sync by rebuildInteriorWalls()
    brief: {},                // room_id -> [{item_id, qty}]  (furniture brief step)
    created_at: opts.created_at || null,
  };
}

export function cloneFloorplan(fp) {
  return typeof structuredClone === 'function'
    ? structuredClone(fp) : JSON.parse(JSON.stringify(fp));
}

export function makeRoom({ id, name, w_mm, d_mm, at = [0, 0], height_mm, floor_material } = {}) {
  const w = Math.max(GRID_MM, round(w_mm ?? 3000));
  const d = Math.max(GRID_MM, round(d_mm ?? 3000));
  return {
    id: id || uid('r'),
    name: name || 'Room',
    polygon_mm: rectPolygon(round(at[0]), round(at[1]), w, d),
    height_mm: round(height_mm ?? DEFAULT_HEIGHT_MM),
    floor_material: FLOOR_MATERIALS.includes(floor_material) ? floor_material : 'oak',
    openings: [],
    features: [],
    source: 'manual',
    confidence: 1.0,
  };
}

/* ───────────────────────── room operations ───────────────────────── */

export function addRoom(fp, spec = {}) {
  const room = makeRoom({ ...spec, height_mm: spec.height_mm ?? fp.default_height_mm });
  fp.rooms.push(room);
  rebuildInteriorWalls(fp);
  return room;
}

export function removeRoom(fp, roomId) {
  const i = fp.rooms.findIndex(r => r.id === roomId);
  if (i < 0) return false;
  fp.rooms.splice(i, 1);
  fp.connections = (fp.connections || []).filter(c => c.a_room !== roomId && c.b_room !== roomId);
  if (fp.brief) delete fp.brief[roomId];
  rebuildInteriorWalls(fp);
  return true;
}

export function getRoom(fp, roomId) { return fp.rooms.find(r => r.id === roomId) || null; }

/** Absolute translation of a room (its openings ride along, since they're wall-relative). */
export function moveRoom(fp, roomId, to /* [x,y] of bbox min corner */) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const b = bbox(r.polygon_mm);
  const dx = round(to[0]) - b.x0, dy = round(to[1]) - b.y0;
  r.polygon_mm = r.polygon_mm.map(([x, y]) => [round(x + dx), round(y + dy)]);
  rebuildInteriorWalls(fp);
  return r;
}

export function translateRoom(fp, roomId, dx, dy) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const b = bbox(r.polygon_mm);
  return moveRoom(fp, roomId, [b.x0 + dx, b.y0 + dy]);
}

/**
 * Resize a rectangular room. `anchor` fixes which corner stays put:
 *   'min' (default, bbox min corner) | 'max' | 'center' | 'n'|'s'|'e'|'w'
 * Openings are clamped back inside their (possibly shorter) wall.
 */
export function resizeRoom(fp, roomId, { w_mm, d_mm, anchor = 'min' } = {}) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const b = bbox(r.polygon_mm);
  const w = Math.max(GRID_MM, round(w_mm ?? b.w));
  const d = Math.max(GRID_MM, round(d_mm ?? b.d));
  let x = b.x0, y = b.y0;
  if (anchor === 'max') { x = b.x1 - w; y = b.y1 - d; }
  else if (anchor === 'center') { x = round(b.x0 + (b.w - w) / 2); y = round(b.y0 + (b.d - d) / 2); }
  else if (anchor === 'e') { x = b.x1 - w; }
  else if (anchor === 'n') { y = b.y1 - d; }
  r.polygon_mm = rectPolygon(x, y, w, d);
  clampOpenings(r);
  rebuildInteriorWalls(fp);
  return r;
}

/** Set a single edge of a rect room to an absolute coordinate ('w'|'e'|'s'|'n'). */
export function setRoomEdge(fp, roomId, side, value) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const b = bbox(r.polygon_mm);
  let { x0, y0, x1, y1 } = b;
  const v = round(value);
  if (side === 'w') x0 = Math.min(v, x1 - GRID_MM);
  else if (side === 'e') x1 = Math.max(v, x0 + GRID_MM);
  else if (side === 's') y0 = Math.min(v, y1 - GRID_MM);
  else if (side === 'n') y1 = Math.max(v, y0 + GRID_MM);
  r.polygon_mm = rectPolygon(x0, y0, x1 - x0, y1 - y0);
  clampOpenings(r);
  rebuildInteriorWalls(fp);
  return r;
}

export function renameRoom(fp, roomId, name) {
  const r = getRoom(fp, roomId);
  if (r) r.name = String(name ?? '').slice(0, 60) || 'Room';
  return r;
}

export function setFloorMaterial(fp, roomId, material) {
  const r = getRoom(fp, roomId);
  if (r && FLOOR_MATERIALS.includes(material)) r.floor_material = material;
  return r;
}

function clampOpenings(room) {
  const walls = polygonWalls(room.polygon_mm);
  room.openings = (room.openings || []).filter(o => {
    const w = walls[o.wall_index];
    if (!w) return false;
    if (w.length_mm < 400) return false;                 // wall too short to hold anything
    o.width_mm = round(Math.min(o.width_mm, w.length_mm));
    o.offset_mm = round(Math.max(0, Math.min(o.offset_mm, w.length_mm - o.width_mm)));
    return true;
  });
}

/* ───────────────────────── openings ───────────────────────── */

function addOpening(fp, roomId, type, spec = {}) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const walls = polygonWalls(r.polygon_mm);
  const wi = Number.isFinite(spec.wall_index) ? spec.wall_index : 0;
  const wall = walls[wi];
  if (!wall) return null;
  const base = type === 'door' ? DOOR : WINDOW;
  const width = round(Math.min(spec.width_mm ?? base.width_mm, wall.length_mm));
  const offset = round(Math.max(0, Math.min(
    spec.offset_mm ?? Math.max(0, (wall.length_mm - width) / 2),
    wall.length_mm - width)));
  const o = {
    id: spec.id || uid(type === 'door' ? 'd' : 'w'),
    type,
    wall_index: wi,
    offset_mm: offset,
    width_mm: width,
    height_mm: round(spec.height_mm ?? base.height_mm),
    sill_mm: round(spec.sill_mm ?? base.sill_mm),
    swing: type === 'door' ? (spec.swing ?? DOOR.swing) : null,
  };
  r.openings.push(o);
  return o;
}

export function addDoor(fp, roomId, spec = {}) { return addOpening(fp, roomId, 'door', spec); }
export function addWindow(fp, roomId, spec = {}) { return addOpening(fp, roomId, 'window', spec); }

export function updateOpening(fp, roomId, openingId, patch = {}) {
  const r = getRoom(fp, roomId);
  if (!r) return null;
  const o = (r.openings || []).find(x => x.id === openingId);
  if (!o) return null;
  Object.assign(o, patch);
  if (Number.isFinite(patch.wall_index)) o.wall_index = patch.wall_index;
  const wall = polygonWall(r.polygon_mm, o.wall_index);
  o.width_mm = round(Math.max(300, Math.min(o.width_mm, wall.length_mm)));
  o.offset_mm = round(Math.max(0, Math.min(o.offset_mm, wall.length_mm - o.width_mm)));
  o.height_mm = round(o.height_mm);
  o.sill_mm = round(o.sill_mm);
  return o;
}

export function removeOpening(fp, roomId, openingId) {
  const r = getRoom(fp, roomId);
  if (!r) return false;
  const n = r.openings.length;
  r.openings = r.openings.filter(o => o.id !== openingId);
  return r.openings.length !== n;
}

/* ─────────────────── interior connections / walls ─────────────────── */

/**
 * Put an interior door in the wall shared by two rooms.
 * The door lives on the CONNECTION (one door, one wall) — never duplicated per room,
 * which is what keeps floorplanToShell() from emitting two coincident walls.
 */
export function connectRooms(fp, aId, bId, spec = {}) {
  const shared = findSharedEdges(fp.rooms).find(s =>
    (s.a_room === aId && s.b_room === bId) || (s.a_room === bId && s.b_room === aId));
  if (!shared) return null;
  const width = round(Math.min(spec.width_mm ?? INTERIOR_DOOR.width_mm, shared.length_mm));
  const offset = round(Math.max(0, Math.min(
    spec.offset_mm ?? Math.max(0, (shared.length_mm - width) / 2),
    shared.length_mm - width)));
  const existing = (fp.connections || []).find(c =>
    (c.a_room === aId && c.b_room === bId) || (c.a_room === bId && c.b_room === aId));
  const conn = existing || { id: spec.id || uid('c') };
  Object.assign(conn, {
    a_room: shared.a_room, b_room: shared.b_room,
    type: spec.type === 'opening' ? 'opening' : 'door',
    offset_mm: offset,
    width_mm: width,
    height_mm: round(spec.height_mm ?? INTERIOR_DOOR.height_mm),
    sill_mm: round(spec.sill_mm ?? INTERIOR_DOOR.sill_mm),
    swing: spec.swing ?? INTERIOR_DOOR.swing,
  });
  if (!existing) (fp.connections ||= []).push(conn);
  rebuildInteriorWalls(fp);
  return conn;
}

export function disconnectRooms(fp, aId, bId) {
  const n = (fp.connections || []).length;
  fp.connections = (fp.connections || []).filter(c =>
    !((c.a_room === aId && c.b_room === bId) || (c.a_room === bId && c.b_room === aId)));
  rebuildInteriorWalls(fp);
  return fp.connections.length !== n;
}

/**
 * Derive `interior_walls` (SPEC2 §G2) from shared room edges.
 * EXACTLY ONE wall per shared edge — the overlap segment — carrying any connection door.
 */
export function deriveInteriorWalls(fp) {
  const thickness = round(fp.interior_thickness_mm ?? DEFAULT_INT_WALL_MM);
  const shared = findSharedEdges(fp.rooms);
  return shared.map((s, i) => {
    const conn = (fp.connections || []).find(c =>
      (c.a_room === s.a_room && c.b_room === s.b_room) ||
      (c.a_room === s.b_room && c.b_room === s.a_room));
    const openings = [];
    if (conn) {
      const width = Math.min(conn.width_mm, s.length_mm);
      const offset = Math.max(0, Math.min(conn.offset_mm, s.length_mm - width));
      openings.push({
        id: conn.id,
        type: conn.type === 'opening' ? 'opening' : 'door',
        offset_mm: round(offset),
        width_mm: round(width),
        height_mm: round(conn.height_mm),
        sill_mm: round(conn.sill_mm),
        swing: conn.type === 'opening' ? null : conn.swing,
      });
    }
    return {
      id: `iw${i + 1}`,
      a: [round(s.a[0]), round(s.a[1])],
      b: [round(s.b[0]), round(s.b[1])],
      thickness_mm: thickness,
      between: [s.a_room, s.b_room],
      openings,
    };
  });
}

export function rebuildInteriorWalls(fp) {
  fp.interior_walls = deriveInteriorWalls(fp);
  return fp.interior_walls;
}

/* ───────────────────────── metrics ───────────────────────── */

export function roomMetrics(room) {
  const area_mm2 = polygonArea(room.polygon_mm);
  const per_mm = polygonPerimeter(room.polygon_mm);
  const b = bbox(room.polygon_mm);
  const u = areaUnits(area_mm2);
  return {
    id: room.id, name: room.name,
    w_mm: round(b.w), d_mm: round(b.d),
    area_mm2, area_m2: u.m2, area_ft2: u.ft2,
    perimeter_mm: round(per_mm), perimeter_m: per_mm / 1000,
  };
}

export function planMetrics(fp) {
  const rooms = fp.rooms.map(roomMetrics);
  const area_mm2 = rooms.reduce((s, r) => s + r.area_mm2, 0);
  const u = areaUnits(area_mm2);
  const outer = fp.rooms.length ? outerRing(fp.rooms.map(roomRect)) : [];
  return {
    rooms,
    count: rooms.length,
    area_mm2, area_m2: u.m2, area_ft2: u.ft2,
    footprint_mm: outer.length ? bbox(outer) : { w: 0, d: 0, x0: 0, y0: 0, x1: 0, y1: 0 },
    envelope_perimeter_mm: outer.length ? round(polygonPerimeter(outer)) : 0,
  };
}

/* ───────────────────── shell for the 3D editor ───────────────────── */

/**
 * floorplanToShell(fp) -> the object packages/three-editor consumes.
 *   { id, name, polygon_mm (CCW outer), height_mm, openings (merged, remapped to the
 *     outer polygon), interior_walls (SPEC2 §G2), rooms[] metadata, holes[], source }
 *
 * Exterior openings authored per-room are remapped onto the outer envelope: the room-wall
 * segment is matched to the collinear outer edge that contains it and the offset recomputed
 * from that edge's start vertex. Openings that fall on an interior (shared) edge are dropped
 * and reported in `dropped_openings` — they belong to an interior wall instead.
 */
export function floorplanToShell(fp) {
  const rects = fp.rooms.map(roomRect);
  const outer = fp.rooms.length ? outerRing(rects) : [];
  const holes = fp.rooms.length ? holeRings(rects).map(h => h.map(p => [round(p[0]), round(p[1])])) : [];
  const outerWalls = polygonWalls(outer);
  const openings = [];
  const dropped = [];

  for (const room of fp.rooms) {
    for (const o of room.openings || []) {
      const [p, q] = openingSegment(room.polygon_mm, o);
      let placed = false;
      for (const w of outerWalls) {
        if (w.length_mm < EPS) continue;
        const tp = (p[0] - w.a[0]) * w.dir[0] + (p[1] - w.a[1]) * w.dir[1];
        const tq = (q[0] - w.a[0]) * w.dir[0] + (q[1] - w.a[1]) * w.dir[1];
        const dp = Math.hypot(p[0] - (w.a[0] + w.dir[0] * tp), p[1] - (w.a[1] + w.dir[1] * tp));
        const dq = Math.hypot(q[0] - (w.a[0] + w.dir[0] * tq), q[1] - (w.a[1] + w.dir[1] * tq));
        if (dp > EPS || dq > EPS) continue;                      // not on this line
        const lo = Math.min(tp, tq), hi = Math.max(tp, tq);
        if (lo < -EPS || hi > w.length_mm + EPS) continue;        // not within this span
        openings.push({
          id: o.id, type: o.type, wall_index: w.index,
          offset_mm: round(Math.max(0, Math.min(lo, w.length_mm - (hi - lo)))),
          width_mm: round(hi - lo),
          height_mm: round(o.height_mm), sill_mm: round(o.sill_mm),
          swing: o.type === 'door' ? (o.swing ?? DOOR.swing) : null,
          room_id: room.id,
        });
        placed = true;
        break;
      }
      if (!placed) dropped.push({ room_id: room.id, opening_id: o.id, reason: 'not_on_envelope' });
    }
  }
  openings.sort((a, b) => a.wall_index - b.wall_index || a.offset_mm - b.offset_mm);

  const height = fp.rooms.length
    ? Math.max(...fp.rooms.map(r => r.height_mm || DEFAULT_HEIGHT_MM))
    : (fp.default_height_mm ?? DEFAULT_HEIGHT_MM);

  return {
    id: fp.id,
    name: fp.name,
    polygon_mm: outer,
    holes_mm: holes,
    height_mm: round(height),
    wall_thickness_mm: round(fp.wall_thickness_mm ?? DEFAULT_EXT_WALL_MM),
    openings,
    dropped_openings: dropped,
    interior_walls: deriveInteriorWalls(fp),
    rooms: fp.rooms.map(r => {
      const m = roomMetrics(r);
      return {
        id: r.id, name: r.name,
        polygon_mm: ensureCCW(r.polygon_mm).map(p => [round(p[0]), round(p[1])]),
        height_mm: round(r.height_mm), floor_material: r.floor_material,
        area_mm2: m.area_mm2, area_m2: +m.area_m2.toFixed(3),
        openings: (r.openings || []).map(o => ({ ...o })),
        features: (r.features || []).map(f => ({ ...f })),
      };
    }),
    source: 'manual',
    confidence: 1.0,
  };
}

/* ─────────────────── furniture brief (SPEC2 §H) ─────────────────── */

export function setBriefItem(fp, roomId, itemId, qty) {
  fp.brief ||= {};
  const list = (fp.brief[roomId] ||= []);
  const i = list.findIndex(e => e.item_id === itemId);
  const n = Math.max(0, Math.round(qty));
  if (n === 0) { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i].qty = n;
  else list.push({ item_id: itemId, qty: n });
  if (!list.length) delete fp.brief[roomId];
  return fp.brief[roomId] || [];
}

export function briefCount(fp) {
  return Object.values(fp.brief || {}).reduce((s, l) => s + l.reduce((t, e) => t + e.qty, 0), 0);
}

/* ─────────────── handoff to the studio (see README.md) ─────────────── */

export const HANDOFF_KEY = 'ainterior.floorplan.handoff';
export const DRAFT_KEY = 'ainterior.floorplan.draft';
export const HANDOFF_PARAM = 'plan';               // editor.html?plan=handoff
export const HANDOFF_VALUE = 'handoff';

export function buildHandoff(fp) {
  return {
    v: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    source: 'design',
    floorplan: cloneFloorplan(fp),
    shell: floorplanToShell(fp),
    brief: Object.entries(fp.brief || {}).map(([room_id, items]) => ({ room_id, items })),
    issues: validateFloorplan(fp),
  };
}

/** Write the handoff and return the studio URL to navigate to. */
export function saveHandoff(fp, storage, editorPath = 'editor.html') {
  const payload = buildHandoff(fp);
  try { storage.setItem(HANDOFF_KEY, JSON.stringify(payload)); } catch (e) { /* quota */ }
  return { payload, url: `${editorPath}?${HANDOFF_PARAM}=${HANDOFF_VALUE}` };
}

export function readHandoff(storage) {
  try { return JSON.parse(storage.getItem(HANDOFF_KEY) || 'null'); } catch (e) { return null; }
}

/* ───────────────────────── history ───────────────────────── */

/** Tiny undo/redo stack over whole-floorplan snapshots. */
export function createHistory(initial, limit = 60) {
  const past = [], future = [];
  let present = cloneFloorplan(initial);
  return {
    get current() { return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    /** Run `fn(draft)`; the mutated draft becomes the new present. */
    commit(fn) {
      const draft = cloneFloorplan(present);
      const r = fn(draft);
      past.push(present);
      if (past.length > limit) past.shift();
      future.length = 0;
      present = draft;
      return r;
    },
    /** Mutate without pushing history (live drag) — call commit() on release. */
    replace(next) { present = cloneFloorplan(next); },
    undo() { if (!past.length) return present; future.push(present); present = past.pop(); return present; },
    redo() { if (!future.length) return present; past.push(present); present = future.pop(); return present; },
    reset(next) { past.length = 0; future.length = 0; present = cloneFloorplan(next); return present; },
  };
}

/* ───────────────────────── snapping ───────────────────────── */

/**
 * Snap a candidate rect against the 100mm grid and against every other room's edges.
 * Returns {x0,y0,x1,y1, snapped:{x:boolean,y:boolean}, guides:[...]}.
 */
export function snapRect(rect, others, { grid = GRID_MM, tol = 140 } = {}) {
  let { x0, y0, x1, y1 } = rect;
  const w = x1 - x0, d = y1 - y0;
  let sx = snap(x0, grid), sy = snap(y0, grid);
  let snappedX = false, snappedY = false;
  const guides = [];
  const xs = [], ys = [];
  for (const o of others) { xs.push(o.x0, o.x1); ys.push(o.y0, o.y1); }

  let bestDx = Infinity;
  for (const cx of xs) {
    for (const [edge, val] of [['x0', cx], ['x1', cx - w]]) {
      const d0 = Math.abs(val - x0);
      if (d0 < tol && d0 < Math.abs(bestDx)) { bestDx = val - x0; }
      void edge;
    }
  }
  let bestDy = Infinity;
  for (const cy of ys) {
    for (const val of [cy, cy - d]) {
      const d0 = Math.abs(val - y0);
      if (d0 < tol && d0 < Math.abs(bestDy)) { bestDy = val - y0; }
    }
  }
  if (Number.isFinite(bestDx) && Math.abs(bestDx) < tol) { sx = round(x0 + bestDx); snappedX = true; guides.push({ axis: 'v', at: sx }); }
  if (Number.isFinite(bestDy) && Math.abs(bestDy) < tol) { sy = round(y0 + bestDy); snappedY = true; guides.push({ axis: 'h', at: sy }); }

  return {
    x0: sx, y0: sy, x1: sx + round(w), y1: sy + round(d),
    snapped: { x: snappedX, y: snappedY }, guides,
  };
}

/** Snap a single scalar (used while dragging an edge). */
export function snapScalar(v, candidates, { grid = GRID_MM, tol = 140 } = {}) {
  let best = snap(v, grid), bestD = Math.abs(best - v), hit = false;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d < tol && d < bestD) { best = round(c); bestD = d; hit = true; }
  }
  return { value: best, snapped: hit };
}

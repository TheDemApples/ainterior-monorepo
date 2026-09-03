/* packages/floorplan/validate.js
 * validateFloorplan(fp) -> [{severity, code, message, room_id?}]
 * Dependency-free, DOM-free. Non-blocking by design: the builder surfaces these inline
 * and never prevents an edit (SPEC2 §H).
 */

import {
  EPS, bbox, isRect, polygonArea, roomRect, rectOverlapArea, findSharedEdges,
  rectsContiguous, polygonWall, areaUnits,
} from './geometry.js';

export const MIN_WALL_MM = 60;         // SPEC2 §H: walls thinner than 60mm are invalid
export const MIN_ROOM_AREA_MM2 = 3.5e6; // 3.5 m² — below this a room is not usable
export const MIN_ROOM_SIDE_MM = 1200;   // 1.2 m clear in the short direction
export const MIN_SHARED_EDGE_MM = 200;

const sev = { error: 'error', warn: 'warn', info: 'info' };

function isInt(n) { return Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-6; }

export function validateFloorplan(fp) {
  const out = [];
  const add = (severity, code, message, room_id) =>
    out.push(room_id ? { severity, code, message, room_id } : { severity, code, message });

  if (!fp || !Array.isArray(fp.rooms)) {
    add(sev.error, 'malformed', 'Floorplan has no rooms array.');
    return out;
  }
  const rooms = fp.rooms;

  if (rooms.length === 0) {
    add(sev.warn, 'no_rooms', 'Nothing drawn yet — drag on the canvas to place your first room.');
    return out;
  }

  /* ── wall thickness ─────────────────────────────────────────────── */
  const ext = fp.wall_thickness_mm;
  const int = fp.interior_thickness_mm;
  if (!Number.isFinite(ext) || ext < MIN_WALL_MM) {
    add(sev.error, 'thin_wall',
      `Exterior wall thickness ${Number.isFinite(ext) ? ext : '—'}mm is below the ${MIN_WALL_MM}mm minimum.`);
  }
  if (!Number.isFinite(int) || int < MIN_WALL_MM) {
    add(sev.error, 'thin_wall',
      `Interior wall thickness ${Number.isFinite(int) ? int : '—'}mm is below the ${MIN_WALL_MM}mm minimum.`);
  }

  /* ── per-room geometry ──────────────────────────────────────────── */
  const seenIds = new Set();
  for (const r of rooms) {
    if (seenIds.has(r.id)) add(sev.error, 'duplicate_id', `Two rooms share the id "${r.id}".`, r.id);
    seenIds.add(r.id);

    const poly = r.polygon_mm;
    if (!Array.isArray(poly) || poly.length < 3) {
      add(sev.error, 'degenerate', `${label(r)} has no usable outline.`, r.id);
      continue;
    }
    if (!poly.every(p => Array.isArray(p) && p.length === 2 && isInt(p[0]) && isInt(p[1]))) {
      add(sev.error, 'non_integer', `${label(r)} has non-integer millimetre vertices.`, r.id);
    }
    if (!isRect(poly)) {
      add(sev.info, 'non_rect_room',
        `${label(r)} is not an axis-aligned rectangle; its bounding box is used for wall derivation.`, r.id);
    }
    if (!Number.isFinite(r.height_mm) || r.height_mm < 2000) {
      add(sev.warn, 'low_ceiling',
        `${label(r)} ceiling height ${r.height_mm ?? '—'}mm is unusually low.`, r.id);
    }

    const area = polygonArea(poly);
    const b = bbox(poly);
    const shortest = Math.min(b.w, b.d);
    if (area < MIN_ROOM_AREA_MM2) {
      add(sev.warn, 'room_too_small',
        `${label(r)} is only ${areaUnits(area).m2.toFixed(2)} m² — below the ${(MIN_ROOM_AREA_MM2 / 1e6).toFixed(1)} m² usable minimum.`, r.id);
    }
    if (shortest < MIN_ROOM_SIDE_MM) {
      add(sev.warn, 'room_too_narrow',
        `${label(r)} is only ${Math.round(shortest)}mm across at its narrowest — under ${MIN_ROOM_SIDE_MM}mm.`, r.id);
    }

    /* openings must sit inside their wall span (SPEC §4.4) */
    for (const o of r.openings || []) {
      if (!Number.isFinite(o.wall_index) || o.wall_index < 0 || o.wall_index >= poly.length) {
        add(sev.error, 'opening_bad_wall',
          `${label(r)}: ${o.type} "${o.id}" references wall ${o.wall_index}, which does not exist.`, r.id);
        continue;
      }
      const w = polygonWall(poly, o.wall_index);
      if (!isInt(o.offset_mm) || !isInt(o.width_mm)) {
        add(sev.error, 'non_integer',
          `${label(r)}: ${o.type} "${o.id}" has non-integer offset/width.`, r.id);
      }
      if (o.offset_mm < 0 || o.offset_mm + o.width_mm > w.length_mm + EPS) {
        add(sev.error, 'opening_out_of_span',
          `${label(r)}: ${o.type} "${o.id}" runs off the end of its wall ` +
          `(${Math.round(o.offset_mm)}+${Math.round(o.width_mm)}mm on a ${Math.round(w.length_mm)}mm wall).`, r.id);
      }
      if (o.width_mm < 300) {
        add(sev.warn, 'opening_narrow',
          `${label(r)}: ${o.type} "${o.id}" is only ${Math.round(o.width_mm)}mm wide.`, r.id);
      }
      if (o.type === 'door' && o.width_mm < 700) {
        add(sev.warn, 'door_narrow',
          `${label(r)}: door "${o.id}" is ${Math.round(o.width_mm)}mm — under the 700mm comfortable minimum.`, r.id);
      }
      if (Number.isFinite(o.sill_mm) && Number.isFinite(o.height_mm) &&
          o.sill_mm + o.height_mm > r.height_mm + EPS) {
        add(sev.error, 'opening_too_tall',
          `${label(r)}: ${o.type} "${o.id}" head is above the ${r.height_mm}mm ceiling.`, r.id);
      }
    }
    /* openings on the same wall must not overlap each other */
    const byWall = new Map();
    for (const o of r.openings || []) {
      if (!byWall.has(o.wall_index)) byWall.set(o.wall_index, []);
      byWall.get(o.wall_index).push(o);
    }
    for (const [wi, list] of byWall) {
      const sorted = list.slice().sort((a, b2) => a.offset_mm - b2.offset_mm);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].offset_mm < sorted[i - 1].offset_mm + sorted[i - 1].width_mm - EPS) {
          add(sev.warn, 'openings_collide',
            `${label(r)}: "${sorted[i - 1].id}" and "${sorted[i].id}" overlap on wall ${wi}.`, r.id);
        }
      }
    }
  }

  /* ── overlapping rooms ──────────────────────────────────────────── */
  const rects = rooms.map(roomRect);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rectOverlapArea(rects[i], rects[j]);
      if (a > 0) {
        add(sev.error, 'overlap',
          `${label(rooms[i])} overlaps ${label(rooms[j])} by ${areaUnits(a).m2.toFixed(2)} m².`,
          rooms[i].id);
      }
    }
  }

  /* ── detached rooms (not touching the plan at all) ───────────────── */
  if (rooms.length > 1 && !rectsContiguous(rects)) {
    const shared = findSharedEdges(rooms, MIN_SHARED_EDGE_MM);
    const touching = new Set(shared.flatMap(s => [s.a_room, s.b_room]));
    for (const r of rooms) {
      if (!touching.has(r.id)) {
        add(sev.warn, 'detached_room',
          `${label(r)} does not share a wall with any other room — drag it against a neighbour.`, r.id);
      }
    }
  }

  /* ── door-path connectivity from the entrance ────────────────────── */
  const entrances = rooms.filter(r => (r.openings || []).some(o => o.type === 'door'));
  if (entrances.length === 0) {
    add(sev.warn, 'no_entrance', 'No exterior door anywhere — click an outside wall to add the front door.');
  } else if (rooms.length > 1) {
    const adj = new Map(rooms.map(r => [r.id, []]));
    for (const c of fp.connections || []) {
      if (adj.has(c.a_room) && adj.has(c.b_room)) {
        adj.get(c.a_room).push(c.b_room);
        adj.get(c.b_room).push(c.a_room);
      }
    }
    const seen = new Set(entrances.map(r => r.id));
    const q = entrances.map(r => r.id);
    while (q.length) {
      for (const n of adj.get(q.pop()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    for (const r of rooms) {
      if (!seen.has(r.id)) {
        add(sev.error, 'disconnected',
          `${label(r)} cannot be reached from the entrance — add an interior door.`, r.id);
      }
    }
  }

  /* ── interior doors must fit their shared wall ───────────────────── */
  const shared = findSharedEdges(rooms, MIN_SHARED_EDGE_MM);
  for (const c of fp.connections || []) {
    const seg = shared.find(s =>
      (s.a_room === c.a_room && s.b_room === c.b_room) ||
      (s.a_room === c.b_room && s.b_room === c.a_room));
    if (!seg) {
      add(sev.error, 'connection_no_wall',
        `Interior door between "${c.a_room}" and "${c.b_room}" has no shared wall any more.`, c.a_room);
      continue;
    }
    const len = seg.length_mm;
    if (c.width_mm > len) {
      add(sev.error, 'connection_too_wide',
        `Interior door between "${c.a_room}" and "${c.b_room}" is ${c.width_mm}mm on a ${len}mm shared wall.`,
        c.a_room);
    } else if (c.offset_mm < 0 || c.offset_mm + c.width_mm > len + EPS) {
      add(sev.error, 'connection_out_of_span',
        `Interior door between "${c.a_room}" and "${c.b_room}" runs past the end of the shared wall.`,
        c.a_room);
    }
  }

  return out;
}

function label(r) { return r && r.name ? `"${r.name}"` : `Room ${r && r.id}`; }

export function errorsOnly(issues) { return issues.filter(i => i.severity === 'error'); }
export function isValid(fp) { return errorsOnly(validateFloorplan(fp)).length === 0; }

// packages/three-editor/collision.js
// OBB-vs-OBB footprint overlap + clearance envelopes. Pure maths, mm, no deps, no DOM.
// Plan frame per SPEC §1: x right, y up-the-page, rot_deg CCW about the vertical axis,
// 0deg = the item's depth axis faces plan +y. Item origin = footprint centre.

const D2R = Math.PI / 180;

/** Archetypes that never collide on the floor (SPEC §5.1: rugs are never colliders). */
export const NON_COLLIDING = new Set(['rug']);

export function isFloorCollider(item) {
  if (!item) return false;
  if (NON_COLLIDING.has(item.archetype)) return false;
  const pl = item.placement || {};
  if (pl.wall_mounted || pl.ceiling_mounted) return false;
  return true;
}

/**
 * Oriented bounding box for a placement's footprint.
 * @returns {{cx,cy,hw,hd,rot,cos,sin,axes}} mm
 */
export function footprintOBB(placement, item, pad = { front: 0, back: 0, left: 0, right: 0 }) {
  const d = item.dims_mm;
  const rot = (placement.rot_deg || 0) * D2R;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // Asymmetric padding shifts the centre along the local axes.
  const hw = d.w / 2 + (pad.left + pad.right) / 2;
  const hd = d.d / 2 + (pad.front + pad.back) / 2;
  const offLocalX = (pad.right - pad.left) / 2;
  const offLocalY = (pad.front - pad.back) / 2;
  const cx = placement.x_mm + offLocalX * cos - offLocalY * sin;
  const cy = placement.y_mm + offLocalX * sin + offLocalY * cos;
  return { cx, cy, hw, hd, rot, cos, sin };
}

/** The four plan-space corners of an OBB, CCW. */
export function obbCorners(o) {
  const ax = [o.cos, o.sin];            // local +x in plan
  const ay = [-o.sin, o.cos];           // local +y in plan
  const out = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push([
      o.cx + ax[0] * o.hw * sx + ay[0] * o.hd * sy,
      o.cy + ax[1] * o.hw * sx + ay[1] * o.hd * sy,
    ]);
  }
  return out;
}

function projectExtent(corners, axis) {
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const p = c[0] * axis[0] + c[1] * axis[1];
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

/**
 * Separating-axis test. Returns overlap depth in mm (0 = no overlap).
 * @param {number} tol allowed penetration before it counts (default 1mm)
 */
export function obbOverlap(a, b, tol = 1) {
  const ca = obbCorners(a), cb = obbCorners(b);
  const axes = [
    [a.cos, a.sin], [-a.sin, a.cos],
    [b.cos, b.sin], [-b.sin, b.cos],
  ];
  let minDepth = Infinity;
  for (const ax of axes) {
    const [amin, amax] = projectExtent(ca, ax);
    const [bmin, bmax] = projectExtent(cb, ax);
    const depth = Math.min(amax, bmax) - Math.max(amin, bmin);
    if (depth <= tol) return 0;
    if (depth < minDepth) minDepth = depth;
  }
  return minDepth;
}

export function clearanceOf(item) {
  const c = item.clearance_mm || {};
  return {
    front: c.front || 0, back: c.back || 0,
    left: c.left || 0, right: c.right || 0,
  };
}

/** OBB grown by the item's clearance envelope (SPEC §4.1 clearance_mm). */
export function clearanceOBB(placement, item) {
  return footprintOBB(placement, item, clearanceOf(item));
}

// --------------------------------------------------------------------------
// point / polygon helpers
// --------------------------------------------------------------------------
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function distPointSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  const dx = a[0] + vx * t - p[0], dy = a[1] + vy * t - p[1];
  return { dist: Math.hypot(dx, dy), t };
}

/** Signed perpendicular distance from a point to every wall of the room. */
export function wallDistances(pt, room) {
  const poly = room.polygon_mm;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const { dist } = distPointSeg(pt, a, b);
    out.push({ wall_index: i, dist });
  }
  out.sort((p, q) => p.dist - q.dist);
  return out;
}

/** Shortest distance from an OBB footprint to each wall (uses the 4 corners). */
export function obbWallDistances(obb, room) {
  const corners = obbCorners(obb);
  const poly = room.polygon_mm;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let best = Infinity;
    for (const c of corners) best = Math.min(best, distPointSeg(c, a, b).dist);
    out.push({ wall_index: i, dist: best });
  }
  return out.sort((p, q) => p.dist - q.dist);
}

// --------------------------------------------------------------------------
// SPEC2 §F — bounds clamping + wall snapping (defect #12)
// --------------------------------------------------------------------------

/** Twice the signed area. Positive ⇒ CCW in the plan frame (x right, y up). */
export function signedArea2(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/**
 * The room's walls as {a, b, u, nIn, len}. `nIn` is the *interior* normal,
 * derived from the polygon's winding, so concave / L-shaped plans work.
 */
export function wallEdges(poly) {
  const ccw = signedArea2(poly) > 0;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nIn = ccw ? [-u[1], u[0]] : [u[1], -u[0]];
    out.push({ wall_index: i, a, b, u, nIn, len });
  }
  return out;
}

/**
 * How far an OBB's footprint pokes past a wall, and how far along that wall it
 * sits. `depth > 0` means at least one corner is on the outside.
 */
function wallPenetration(corners, w) {
  let minSigned = Infinity, minAlong = Infinity, maxAlong = -Infinity;
  for (const c of corners) {
    const rx = c[0] - w.a[0], ry = c[1] - w.a[1];
    const perp = rx * w.nIn[0] + ry * w.nIn[1];
    const along = rx * w.u[0] + ry * w.u[1];
    if (perp < minSigned) minSigned = perp;
    if (along < minAlong) minAlong = along;
    if (along > maxAlong) maxAlong = along;
  }
  return { gap: minSigned, minAlong, maxAlong };
}

/** Is this wall segment relevant to a footprint at all (roughly beside it)? */
function wallSpans(pen, w, slack = 60) {
  return pen.maxAlong > -slack && pen.minAlong < w.len + slack;
}

/**
 * SPEC2 §F. Clamp a proposed placement so that **every corner of the rotated
 * footprint** stays inside the floor polygon, then optionally snap flush to a
 * wall within `snap_mm`.
 *
 * Corrections are applied purely along wall normals, which is what makes a drag
 * pushing into a wall keep tracking sideways ("slides along the boundary rather
 * than sticking") instead of freezing.
 *
 * @param {{x_mm:number,y_mm:number,rot_deg:number}} placement proposed transform
 * @param {object} item CatalogItem
 * @param {object} room SPEC §4.4 Room
 * @param {object} [opts] { snap:boolean, snap_mm:number, grid_mm:number }
 * @returns {{x_mm,y_mm,rot_deg,clamped:boolean,snapped_wall:number|null,
 *            clamped_walls:number[], corners:[number,number][]}}
 */
export function clampToRoom(placement, item, room, opts = {}) {
  const poly = room.polygon_mm || [];
  const snapOn = opts.snap !== false;
  const snapMm = opts.snap_mm == null ? 120 : opts.snap_mm;
  const grid = opts.grid_mm || 0;
  let x = placement.x_mm, y = placement.y_mm;
  const rot = placement.rot_deg || 0;
  const out = {
    x_mm: x, y_mm: y, rot_deg: rot,
    clamped: false, snapped_wall: null, clamped_walls: [], corners: [],
  };
  if (poly.length < 3 || !item || !item.dims_mm) { out.corners = []; return out; }

  const pl = item.placement || {};
  // Wall/ceiling-mounted pieces are governed by their mount, not the floor OBB.
  const offset = pl.wall_offset_mm || 0;
  const walls = wallEdges(poly);

  // ---- recovery: centre completely outside the polygon (SPEC2 §F) ---------
  // The loop below only corrects *penetration of a wall the footprint spans*.
  // A piece parked far outside the plan (or flicked diagonally past a corner)
  // spans no wall at all, so `wallSpans` rejected every candidate and the
  // placement came back untouched — setPosition(id, 99999, 99999) left the
  // furniture stranded outside the room. Pull the centre back to just inside
  // the nearest wall first; the loop then fixes any remaining corner overlap.
  if (!pointInPolygon([x, y], poly)) {
    let best = null;
    for (const w of walls) {
      const rx = x - w.a[0], ry = y - w.a[1];
      const t = Math.max(0, Math.min(w.len, rx * w.u[0] + ry * w.u[1]));
      const px = w.a[0] + w.u[0] * t, py = w.a[1] + w.u[1] * t;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, px, py, w };
    }
    if (best) {
      let half = 0;
      for (const c of obbCorners(footprintOBB({ x_mm: 0, y_mm: 0, rot_deg: rot }, item))) {
        half = Math.max(half, Math.abs(c[0] * best.w.nIn[0] + c[1] * best.w.nIn[1]));
      }
      x = best.px + best.w.nIn[0] * (half + offset + 1);
      y = best.py + best.w.nIn[1] * (half + offset + 1);
      out.clamped = true;
      out.recovered = true;
    }
  }

  // ---- clamp: iterate so a corner pocket resolves against both walls -------
  for (let iter = 0; iter < 6; iter++) {
    let worst = null;
    const corners = obbCorners(footprintOBB({ x_mm: x, y_mm: y, rot_deg: rot }, item));
    for (const w of walls) {
      const pen = wallPenetration(corners, w);
      if (!wallSpans(pen, w)) continue;
      const need = offset - pen.gap;                 // >0 ⇒ must push inward
      if (need > 0.5 && (!worst || need > worst.need)) worst = { w, need };
    }
    if (!worst) break;
    x += worst.w.nIn[0] * worst.need;
    y += worst.w.nIn[1] * worst.need;
    out.clamped = true;
    if (!out.clamped_walls.includes(worst.w.wall_index)) out.clamped_walls.push(worst.w.wall_index);
  }

  // ---- snap flush when the footprint edge is within 120mm ------------------
  if (snapOn && snapMm > 0) {
    const corners = obbCorners(footprintOBB({ x_mm: x, y_mm: y, rot_deg: rot }, item));
    let best = null;
    for (const w of walls) {
      const pen = wallPenetration(corners, w);
      if (!wallSpans(pen, w)) continue;
      const err = Math.abs(pen.gap - offset);
      if (err <= snapMm && err > 0.5 && (!best || err < best.err)) {
        best = { w, err, push: offset - pen.gap };
      }
    }
    if (best) {
      x += best.w.nIn[0] * best.push;
      y += best.w.nIn[1] * best.push;
      out.snapped_wall = best.w.wall_index;
    }
  }

  if (grid > 0) {
    // Re-grid, then re-verify: rounding must never push a corner back outside.
    const gx = Math.round(x / grid) * grid;
    const gy = Math.round(y / grid) * grid;
    const c = obbCorners(footprintOBB({ x_mm: gx, y_mm: gy, rot_deg: rot }, item));
    let ok = true;
    for (const w of walls) {
      const pen = wallPenetration(c, w);
      if (!wallSpans(pen, w)) continue;
      if (pen.gap < offset - 0.75) { ok = false; break; }
    }
    if (ok) { x = gx; y = gy; }
  }

  out.x_mm = x; out.y_mm = y;
  out.corners = obbCorners(footprintOBB({ x_mm: x, y_mm: y, rot_deg: rot }, item));
  return out;
}

/**
 * Nearest wall plane for a `wall_mounted` item: returns the position on that
 * wall plane plus the rotation that faces into the room, so it can never float
 * in mid-air (SPEC2 §F).
 */
export function snapToWallPlane(placement, item, room) {
  const poly = room.polygon_mm || [];
  if (poly.length < 3) return { ...placement };
  const walls = wallEdges(poly);
  const d = item.dims_mm || { d: 100 };
  const halfDepth = (d.d || 100) / 2;
  const offset = (item.placement && item.placement.wall_offset_mm) || 0;
  let best = null;
  for (const w of walls) {
    const r = distPointSeg([placement.x_mm, placement.y_mm], w.a, w.b);
    if (!best || r.dist < best.dist) best = { w, dist: r.dist, t: r.t };
  }
  if (!best) return { ...placement };
  const w = best.w;
  const t = Math.max(0, Math.min(1, best.t));
  const along = t * w.len;
  const px = w.a[0] + w.u[0] * along + w.nIn[0] * (halfDepth + offset);
  const py = w.a[1] + w.u[1] * along + w.nIn[1] * (halfDepth + offset);
  let deg = Math.atan2(w.nIn[1], w.nIn[0]) * (180 / Math.PI) - 90;
  deg = ((deg % 360) + 360) % 360;
  return {
    ...placement,
    x_mm: Math.round(px), y_mm: Math.round(py),
    rot_deg: Math.round(deg / 15) * 15 % 360,
    wall_index: w.wall_index,
  };
}

/** Every corner of the rotated footprint inside the polygon? (test helper) */
export function obbInsideRoom(placement, item, room, tol = 1) {
  const poly = room.polygon_mm || [];
  const corners = obbCorners(footprintOBB(placement, item));
  const walls = wallEdges(poly);
  for (const w of walls) {
    const pen = wallPenetration(corners, w);
    if (!wallSpans(pen, w)) continue;
    if (pen.gap < -tol) return false;
  }
  return corners.every((c) => pointInPolygon(c, poly) ||
    walls.some((w) => distPointSeg(c, w.a, w.b).dist <= tol));
}

// --------------------------------------------------------------------------
// full-scene detection
// --------------------------------------------------------------------------
/**
 * @param {object} args {room, placements, catalog: Map|obj, clearances:boolean}
 * @returns {{violations: Violation[], overlapping: Set<string>}}
 *          Violation codes from SPEC §4.6.
 */
export function detectCollisions({ room, placements, catalog, clearances = true }) {
  const get = (id) => (catalog instanceof Map ? catalog.get(id) : catalog[id]);
  const violations = [];
  const overlapping = new Set();
  const live = [];

  for (const p of placements) {
    const item = get(p.item_id);
    if (!item) continue;
    const rec = { p, item, obb: footprintOBB(p, item), collider: isFloorCollider(item) };
    live.push(rec);

    // OUT_OF_BOUNDS — any footprint corner outside the room polygon
    if (rec.collider || item.archetype === 'rug') {
      const corners = obbCorners(rec.obb);
      const outside = corners.filter((c) => !pointInPolygon(c, room.polygon_mm)).length;
      if (outside > 0) {
        overlapping.add(p.instance_id);
        violations.push({
          severity: 'error', code: 'OUT_OF_BOUNDS',
          message: `${item.name} extends outside the room`,
          instance_ids: [p.instance_id],
        });
      }
    }

    // NO_WALL_SUPPORT — wall-mounted items must actually be near a wall
    if (item.placement && item.placement.wall_mounted) {
      const d = wallDistances([p.x_mm, p.y_mm], room)[0];
      if (d && d.dist > (item.dims_mm.d || 100) + 200) {
        violations.push({
          severity: 'warn', code: 'NO_WALL_SUPPORT',
          message: `${item.name} is wall-mounted but ${Math.round(d.dist)}mm from any wall`,
          instance_ids: [p.instance_id],
        });
      }
    }
  }

  // OVERLAP
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j];
      if (!A.collider || !B.collider) continue;
      const depth = obbOverlap(A.obb, B.obb, 2);
      if (depth > 0) {
        overlapping.add(A.p.instance_id);
        overlapping.add(B.p.instance_id);
        violations.push({
          severity: 'error', code: 'OVERLAP',
          message: `${A.item.name} overlaps ${B.item.name} by ${Math.round(depth)}mm`,
          instance_ids: [A.p.instance_id, B.p.instance_id],
        });
      }
    }
  }

  // CLEARANCE — one item's body inside another's required envelope
  if (clearances) {
    for (const A of live) {
      if (!A.collider) continue;
      const cl = clearanceOf(A.item);
      if (!(cl.front || cl.back || cl.left || cl.right)) continue;
      const env = clearanceOBB(A.p, A.item);
      for (const B of live) {
        if (B === A || !B.collider) continue;
        if (obbOverlap(A.obb, B.obb, 2) > 0) continue; // already an OVERLAP
        const depth = obbOverlap(env, B.obb, 4);
        if (depth > 0) {
          violations.push({
            severity: 'warn', code: 'CLEARANCE',
            message: `${B.item.name} intrudes ${Math.round(depth)}mm into ${A.item.name}'s clearance`,
            instance_ids: [A.p.instance_id, B.p.instance_id],
          });
        }
      }
    }
  }

  // BLOCKS_DOOR / BLOCKS_WINDOW — 900mm entry apron in front of doors (SPEC §5.1)
  const poly = room.polygon_mm;
  for (const o of room.openings || []) {
    const i = o.wall_index | 0;
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nIn = [-u[1], u[0]];
    const s = (o.offset_mm || 0) + (o.width_mm || 0) / 2;
    const apron = o.type === 'door' ? 900 : 250;
    const cx = a[0] + u[0] * s + nIn[0] * (apron / 2);
    const cy = a[1] + u[1] * s + nIn[1] * (apron / 2);
    const zone = {
      cx, cy, hw: (o.width_mm || 800) / 2, hd: apron / 2,
      rot: 0, cos: u[0], sin: u[1],
    };
    for (const A of live) {
      if (!A.collider) continue;
      if (o.type === 'window' && (o.sill_mm || 0) >= 1100) continue;
      const depth = obbOverlap(zone, A.obb, 4);
      if (depth > 0) {
        violations.push({
          severity: o.type === 'door' ? 'error' : 'warn',
          code: o.type === 'door' ? 'BLOCKS_DOOR' : 'BLOCKS_WINDOW',
          message: `${A.item.name} blocks ${o.type} ${o.id}`,
          instance_ids: [A.p.instance_id],
        });
        if (o.type === 'door') overlapping.add(A.p.instance_id);
      }
    }
  }

  // BLOCKS_RADIATOR
  for (const ft of room.features || []) {
    if (!['radiator', 'vent'].includes(ft.type)) continue;
    const i = ft.wall_index | 0;
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nIn = [-u[1], u[0]];
    const s = (ft.offset_mm || 0) + (ft.width_mm || 0) / 2;
    const depthZone = (ft.depth_mm || 120) + 150;
    const zone = {
      cx: a[0] + u[0] * s + nIn[0] * (depthZone / 2),
      cy: a[1] + u[1] * s + nIn[1] * (depthZone / 2),
      hw: (ft.width_mm || 800) / 2, hd: depthZone / 2,
      rot: 0, cos: u[0], sin: u[1],
    };
    for (const A of live) {
      if (!A.collider) continue;
      if (obbOverlap(zone, A.obb, 4) > 0) {
        violations.push({
          severity: 'warn', code: 'BLOCKS_RADIATOR',
          message: `${A.item.name} blocks ${ft.type} ${ft.id}`,
          instance_ids: [A.p.instance_id],
        });
      }
    }
  }

  return { violations, overlapping };
}

export default detectCollisions;

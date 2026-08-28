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

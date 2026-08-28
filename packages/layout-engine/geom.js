// packages/layout-engine/geom.js
// Dependency-free, DOM-free plan geometry. All lengths in millimetres (§1).
// Plan frame: x -> right, y -> up the page. Rotation rot_deg is CCW positive,
// 0 = the item's depth (local +v) axis faces plan +y.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export function norm360(d) { let x = d % 360; if (x < 0) x += 360; return x; }

/** Local (u,v) -> world for a box centred at (cx,cy) rotated rot degrees CCW. */
export function local2world(box, u, v) {
  const a = box.rot * D2R, ca = Math.cos(a), sa = Math.sin(a);
  return [box.cx + u * ca - v * sa, box.cy + u * sa + v * ca];
}

/** World -> local (u,v). */
export function world2local(box, x, y) {
  const a = -box.rot * D2R, ca = Math.cos(a), sa = Math.sin(a);
  const dx = x - box.cx, dy = y - box.cy;
  return [dx * ca - dy * sa, dx * sa + dy * ca];
}

/** Unit vector of the box's local +v (its "front"/depth) axis in world space. */
export function frontAxis(box) {
  const a = box.rot * D2R;
  return [-Math.sin(a), Math.cos(a)];
}
/** Unit vector of the box's local +u (width) axis. */
export function widthAxis(box) {
  const a = box.rot * D2R;
  return [Math.cos(a), Math.sin(a)];
}

export function obbCorners(b) {
  const hw = b.w / 2, hd = b.d / 2;
  return [
    local2world(b, -hw, -hd), local2world(b, hw, -hd),
    local2world(b, hw, hd), local2world(b, -hw, hd),
  ];
}

export function obbAabb(b) {
  const c = obbCorners(b);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of c) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

function axes(b) {
  const a = b.rot * D2R;
  return [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)]];
}

/** Separating-axis overlap test. Returns penetration depth in mm (0 = no overlap). */
export function obbPenetration(A, B) {
  const ca = obbCorners(A), cb = obbCorners(B);
  const axs = [...axes(A), ...axes(B)];
  let best = Infinity;
  for (const [ax, ay] of axs) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of ca) { const p = x * ax + y * ay; if (p < a0) a0 = p; if (p > a1) a1 = p; }
    for (const [x, y] of cb) { const p = x * ax + y * ay; if (p < b0) b0 = p; if (p > b1) b1 = p; }
    const ov = Math.min(a1, b1) - Math.max(a0, b0);
    if (ov <= 0) return 0;
    if (ov < best) best = ov;
  }
  return best;
}

export function obbOverlaps(A, B, tol = 0) { return obbPenetration(A, B) > tol; }

export function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Minimum distance between two OBBs (0 when they overlap). */
export function obbGap(A, B) {
  if (obbPenetration(A, B) > 0) return 0;
  const ca = obbCorners(A), cb = obbCorners(B);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [x, y] = ca[i];
    for (let j = 0; j < 4; j++) {
      const [bx, by] = cb[j], [bx2, by2] = cb[(j + 1) % 4];
      best = Math.min(best, ptSegDist(x, y, bx, by, bx2, by2));
    }
  }
  for (let j = 0; j < 4; j++) {
    const [x, y] = cb[j];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = ca[i], [ax2, ay2] = ca[(i + 1) % 4];
      best = Math.min(best, ptSegDist(x, y, ax, ay, ax2, ay2));
    }
  }
  return best;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

export function polyCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const cr = x0 * y1 - x1 * y0;
    a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) return [poly[0][0], poly[0][1]];
  return [cx / (6 * a), cy / (6 * a)];
}

export function polyBbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Distance from a point to the polygon boundary (unsigned). */
export function distToBoundary(x, y, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    best = Math.min(best, ptSegDist(x, y, ax, ay, bx, by));
  }
  return best;
}

/** True when every corner of `box` lies inside `poly`. */
export function obbInsidePoly(box, poly) {
  for (const [x, y] of obbCorners(box)) if (!pointInPoly(x, y, poly)) return false;
  return true;
}

/** How far outside the polygon the worst corner of `box` sits (mm). */
export function obbOutsideDepth(box, poly) {
  let worst = 0;
  for (const [x, y] of obbCorners(box)) {
    if (!pointInPoly(x, y, poly)) worst = Math.max(worst, distToBoundary(x, y, poly));
  }
  return worst;
}

// ---- deterministic PRNG (mulberry32) -------------------------------------
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const rng = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  rng.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a2[i]; a2[i] = a2[j]; a2[j] = t;
    }
    return a2;
  };
  return rng;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round = (v) => Math.round(v);

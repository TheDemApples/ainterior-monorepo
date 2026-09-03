/* packages/floorplan/geometry.js
 * Dependency-free, DOM-free rectilinear polygon geometry for the floorplan designer.
 * All coordinates are INTEGER MILLIMETRES in shared absolute plan space (SPEC §1):
 *   x -> right, y -> "up the page" (plan north).
 *
 * SPEC-ASSUMPTION: the builder authors axis-aligned rectangular rooms, so the union /
 * shared-edge routines below are specialised for rectilinear input. Non-rectangular room
 * polygons are reduced to their bounding box for union purposes and flagged by
 * validateFloorplan() with code `non_rect_room`.
 */

export const EPS = 1; // 1 mm — everything is integer mm, so 1mm is the natural tolerance

/* ───────────────────────────── basics ───────────────────────────── */

export function round(n) { return Math.round(n); }

/** Shoelace area. Positive => CCW in a y-up frame. Returns mm². */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function polygonArea(poly) { return Math.abs(signedArea(poly)); }

export function polygonPerimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

/** Force counter-clockwise winding (SPEC §4.4 requires CCW). */
export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

export function isCCW(poly) { return signedArea(poly) > 0; }

export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, d: y1 - y0 };
}

/** Is this polygon an axis-aligned rectangle (4 verts, axis-aligned edges)? */
export function isRect(poly) {
  if (!Array.isArray(poly) || poly.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % 4];
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    if (dx > EPS && dy > EPS) return false;
    if (dx <= EPS && dy <= EPS) return false; // zero-length edge
  }
  return true;
}

export function rectPolygon(x, y, w, d) {
  // CCW in a y-up frame: bottom, right, top, left => wall_index 0..3
  return [
    [round(x), round(y)],
    [round(x + w), round(y)],
    [round(x + w), round(y + d)],
    [round(x), round(y + d)],
  ];
}

/** Rect of a room polygon (bbox; exact for rect rooms). */
export function roomRect(room) {
  const b = bbox(room.polygon_mm);
  return { id: room.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

/* ───────────────────────────── overlap ───────────────────────────── */

/** Area of the axis-aligned intersection of two rects (mm², 0 when only touching). */
export function rectOverlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= EPS || h <= EPS) return 0;
  return w * h;
}

/* ────────────────────── shared-edge detection ────────────────────── */

/**
 * Segments of every polygon edge, as {roomId, wall_index, a, b, axis, at, lo, hi}.
 * axis: 'v' (vertical edge, constant x) | 'h' (horizontal edge, constant y).
 */
export function polygonEdges(room) {
  const poly = room.polygon_mm;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const vertical = Math.abs(b[0] - a[0]) <= EPS;
    const horizontal = Math.abs(b[1] - a[1]) <= EPS;
    if (!vertical && !horizontal) continue; // skew edges are not sharable
    const axis = vertical ? 'v' : 'h';
    const at = vertical ? a[0] : a[1];
    const p0 = vertical ? a[1] : a[0];
    const p1 = vertical ? b[1] : b[0];
    out.push({
      roomId: room.id, wall_index: i, a, b, axis, at,
      lo: Math.min(p0, p1), hi: Math.max(p0, p1),
    });
  }
  return out;
}

/**
 * Find every shared (coincident, overlapping) edge between two distinct rooms.
 * Returns [{ a_room, b_room, a_wall, b_wall, axis, at, lo, hi, a:[x,y], b:[x,y], length_mm }].
 * The returned segment is the OVERLAP only, oriented +x (h) or +y (v), so each shared
 * edge yields exactly ONE record — never two coincident walls.
 */
export function findSharedEdges(rooms, minLength = 200) {
  const edgesByRoom = rooms.map(polygonEdges);
  const out = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      for (const ea of edgesByRoom[i]) {
        for (const eb of edgesByRoom[j]) {
          if (ea.axis !== eb.axis) continue;
          if (Math.abs(ea.at - eb.at) > EPS) continue;
          const lo = Math.max(ea.lo, eb.lo);
          const hi = Math.min(ea.hi, eb.hi);
          const len = hi - lo;
          if (len < minLength) continue;
          const a = ea.axis === 'v' ? [ea.at, lo] : [lo, ea.at];
          const b = ea.axis === 'v' ? [ea.at, hi] : [hi, ea.at];
          out.push({
            a_room: rooms[i].id, b_room: rooms[j].id,
            a_wall: ea.wall_index, b_wall: eb.wall_index,
            axis: ea.axis, at: ea.at, lo, hi,
            a: [round(a[0]), round(a[1])], b: [round(b[0]), round(b[1])],
            length_mm: round(len),
          });
        }
      }
    }
  }
  // Deterministic order so ids are stable.
  out.sort((p, q) => (p.axis === q.axis ? (p.at - q.at || p.lo - q.lo)
    : (p.axis === 'h' ? -1 : 1)));
  return out;
}

/* ────────────────── rectilinear union (outer polygon) ────────────────── */

function uniqSorted(list) {
  const s = Array.from(new Set(list.map(round)));
  s.sort((a, b) => a - b);
  return s;
}

/**
 * Union of axis-aligned rects -> array of rings (arrays of [x,y]).
 * Outer boundaries come back CCW, holes CW. Uses a cell decomposition + boundary
 * trace, so it is exact for integer-mm rectilinear input.
 */
export function unionRects(rects) {
  if (!rects.length) return [];
  const xs = uniqSorted(rects.flatMap(r => [r.x0, r.x1]));
  const ys = uniqSorted(rects.flatMap(r => [r.y0, r.y1]));
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return [];

  const inside = new Uint8Array(nx * ny);
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? 0 : inside[j * nx + i];
  for (let j = 0; j < ny; j++) {
    const cy = (ys[j] + ys[j + 1]) / 2;
    for (let i = 0; i < nx; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      for (const r of rects) {
        if (cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) { inside[j * nx + i] = 1; break; }
      }
    }
  }

  // Directed boundary edges, CCW around filled area.
  const edges = new Map(); // "x,y" -> list of [to, key]
  const push = (from, to) => {
    const k = from.join(',');
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push(to);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue;
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
      if (!at(i, j - 1)) push([x0, y0], [x1, y0]); // bottom, →
      if (!at(i + 1, j)) push([x1, y0], [x1, y1]); // right,  ↑
      if (!at(i, j + 1)) push([x1, y1], [x0, y1]); // top,    ←
      if (!at(i - 1, j)) push([x0, y1], [x0, y0]); // left,   ↓
    }
  }

  const rings = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    let cur = startKey.split(',').map(Number);
    const ring = [cur];
    let guard = 0;
    while (guard++ < 200000) {
      const k = cur.join(',');
      const list = edges.get(k);
      if (!list || !list.length) break;
      const next = list.shift();
      if (!list.length) edges.delete(k);
      cur = next;
      if (cur[0] === ring[0][0] && cur[1] === ring[0][1]) break;
      ring.push(cur);
    }
    if (ring.length >= 4) rings.push(collapseCollinear(ring));
  }
  return rings;
}

/** Drop mid-points of collinear runs and duplicate vertices. */
export function collapseCollinear(ring) {
  const pts = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return !(Math.abs(p[0] - q[0]) <= EPS && Math.abs(p[1] - q[1]) <= EPS);
  });
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) > EPS) out.push([round(cur[0]), round(cur[1])]);
  }
  return out.length >= 3 ? out : pts.map(p => [round(p[0]), round(p[1])]);
}

/** Outer boundary ring (largest by |area|), CCW. */
export function outerRing(rects) {
  const rings = unionRects(rects);
  if (!rings.length) return [];
  let best = rings[0], bestA = polygonArea(rings[0]);
  for (const r of rings.slice(1)) {
    const a = polygonArea(r);
    if (a > bestA) { best = r; bestA = a; }
  }
  return ensureCCW(best);
}

/** Rings that are not the outer boundary — courtyards / holes. */
export function holeRings(rects) {
  const rings = unionRects(rects);
  if (rings.length <= 1) return [];
  let bi = 0, bestA = -1;
  rings.forEach((r, i) => { const a = polygonArea(r); if (a > bestA) { bestA = a; bi = i; } });
  return rings.filter((_, i) => i !== bi);
}

/** Are all rects one connected blob (edge-adjacency, not just corner touching)? */
export function rectsContiguous(rects) {
  if (rects.length <= 1) return true;
  const adj = rects.map(() => []);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const shareV = (Math.abs(a.x1 - b.x0) <= EPS || Math.abs(a.x0 - b.x1) <= EPS)
        && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS;
      const shareH = (Math.abs(a.y1 - b.y0) <= EPS || Math.abs(a.y0 - b.y1) <= EPS)
        && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS;
      const overlaps = rectOverlapArea(a, b) > 0;
      if (shareV || shareH || overlaps) { adj[i].push(j); adj[j].push(i); }
    }
  }
  const seen = new Set([0]); const q = [0];
  while (q.length) for (const n of adj[q.pop()]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen.size === rects.length;
}

/* ─────────────────── walls / openings on a polygon ─────────────────── */

/** Wall i of a polygon: {index, a, b, dir:[ux,uy], length_mm}. */
export function polygonWall(poly, index) {
  const a = poly[index % poly.length];
  const b = poly[(index + 1) % poly.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { index, a, b, dir: [(b[0] - a[0]) / (len || 1), (b[1] - a[1]) / (len || 1)], length_mm: len };
}

export function polygonWalls(poly) {
  return poly.map((_, i) => polygonWall(poly, i));
}

/** Absolute [near, far] endpoints of an opening on a polygon wall. */
export function openingSegment(poly, opening) {
  const w = polygonWall(poly, opening.wall_index);
  const p = [w.a[0] + w.dir[0] * opening.offset_mm, w.a[1] + w.dir[1] * opening.offset_mm];
  const q = [p[0] + w.dir[0] * opening.width_mm, p[1] + w.dir[1] * opening.width_mm];
  return [p, q];
}

/** Project point p onto the infinite line of wall w; returns {t, dist}. */
export function projectOnWall(w, p) {
  const t = (p[0] - w.a[0]) * w.dir[0] + (p[1] - w.a[1]) * w.dir[1];
  const px = w.a[0] + w.dir[0] * t, py = w.a[1] + w.dir[1] * t;
  return { t, dist: Math.hypot(p[0] - px, p[1] - py) };
}

/** m² and ft² for a mm² area. */
export function areaUnits(area_mm2) {
  const m2 = area_mm2 / 1e6;
  return { m2, ft2: m2 * 10.763910416709722 };
}

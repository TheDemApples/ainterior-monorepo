// packages/layout-engine/scoring.js
// Layout quality: rule satisfaction + walkway quality + visual balance +
// focal coherence + wall utilisation + conversation tightness.
// Pure, dependency-free, DOM-free.

import {
  pointInPoly, polyBbox, obbCorners, obbGap, clamp, frontAxis, distToBoundary,
  world2local,
} from './geom.js';
import {
  RULES, buildRoom, expand, checkAll, doorApron, SEVERITY_WEIGHT,
  isSofa, isSeating, isBed, isDiningTable, catGet,
} from './rules.js';

// --------------------------------------------------------------------------
// Free-space grid + clearance field + widest-path (max-bottleneck) reachability.
// This is how walkway_min_mm is measured: the narrowest point on the widest
// available route from the door to every major piece's access point.
// --------------------------------------------------------------------------
export function buildGrid(rm, ents, step) {
  const bb = rm.bbox;
  step = step || clamp(Math.round(Math.max(bb.w, bb.h) / 90 / 10) * 10, 40, 120);
  const nx = Math.max(2, Math.ceil(bb.w / step));
  const ny = Math.max(2, Math.ceil(bb.h / step));
  const inside = new Uint8Array(nx * ny);
  const blocked = new Uint8Array(nx * ny);
  const boxes = ents.filter((e) => e.collider).map((e) => e.box);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bb.x0 + (i + 0.5) * step, y = bb.y0 + (j + 0.5) * step;
      const k = j * nx + i;
      if (!pointInPoly(x, y, rm.poly)) { blocked[k] = 1; continue; }
      inside[k] = 1;
      for (const b of boxes) {
        const [u, v] = world2local(b, x, y);
        if (Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.d / 2) { blocked[k] = 1; break; }
      }
    }
  }
  // chamfer distance transform (cells) from blocked/outside
  const INF = 1e9;
  const dist = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) dist[k] = blocked[k] ? 0 : INF;
  const D1 = 1, D2 = Math.SQRT2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i; let d = dist[k];
      if (i > 0) d = Math.min(d, dist[k - 1] + D1);
      if (j > 0) d = Math.min(d, dist[k - nx] + D1);
      if (i > 0 && j > 0) d = Math.min(d, dist[k - nx - 1] + D2);
      if (i < nx - 1 && j > 0) d = Math.min(d, dist[k - nx + 1] + D2);
      dist[k] = d;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i; let d = dist[k];
      if (i < nx - 1) d = Math.min(d, dist[k + 1] + D1);
      if (j < ny - 1) d = Math.min(d, dist[k + nx] + D1);
      if (i < nx - 1 && j < ny - 1) d = Math.min(d, dist[k + nx + 1] + D2);
      if (i > 0 && j < ny - 1) d = Math.min(d, dist[k + nx - 1] + D2);
      dist[k] = d;
    }
  }
  // clearance in mm = (distance-to-obstacle - half a cell) * step, floored at 0
  const clearance = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    clearance[k] = blocked[k] ? 0 : Math.max(0, (dist[k] - 0.5) * step);
  }
  return {
    nx, ny, step, bb, inside, blocked, clearance,
    idx: (i, j) => j * nx + i,
    cellOf(x, y) {
      const i = clamp(Math.floor((x - bb.x0) / step), 0, nx - 1);
      const j = clamp(Math.floor((y - bb.y0) / step), 0, ny - 1);
      return [i, j];
    },
    centre(i, j) { return [bb.x0 + (i + 0.5) * step, bb.y0 + (j + 0.5) * step]; },
    freeArea() {
      let n = 0;
      for (let k = 0; k < nx * ny; k++) if (!blocked[k]) n++;
      return n * step * step;
    },
  };
}

/** Nearest free cell to (x,y) within `radius` mm; null if none. */
function nearestFree(g, x, y, radius = 1200) {
  const [ci, cj] = g.cellOf(x, y);
  const R = Math.ceil(radius / g.step);
  let best = null, bestD = Infinity;
  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const k = g.idx(i, j);
      if (g.blocked[k]) continue;
      const d = di * di + dj * dj;
      if (d < bestD) { bestD = d; best = [i, j]; }
    }
  }
  return best;
}

/**
 * Max-bottleneck (widest path) field from a source cell. Returns Float64Array
 * where value = the narrowest clearance encountered on the best route there.
 */
export function widestPathField(g, src) {
  const n = g.nx * g.ny;
  const best = new Float64Array(n); // 0 = unreachable
  const s = g.idx(src[0], src[1]);
  best[s] = g.clearance[s];
  // bucketed max-first search (clearance is bounded, buckets keep it O(n))
  const bucketOf = (v) => Math.min(255, Math.floor(v / 25));
  const buckets = new Array(256);
  for (let i = 0; i < 256; i++) buckets[i] = [];
  buckets[bucketOf(best[s])].push(s);
  for (let b = 255; b >= 0; b--) {
    const q = buckets[b];
    while (q.length) {
      const k = q.pop();
      const cur = best[k];
      if (bucketOf(cur) !== b) continue;
      const i = k % g.nx, j = (k - i) / g.nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) continue;
          const nk = g.idx(ni, nj);
          if (g.blocked[nk]) continue;
          const cand = Math.min(cur, g.clearance[nk]);
          if (cand > best[nk]) {
            best[nk] = cand;
            const nb = bucketOf(cand);
            if (nb <= b) buckets[nb].push(nk); else buckets[nb].push(nk);
          }
        }
      }
    }
  }
  return best;
}

const MAJOR = new Set([
  'sofa_2seat', 'sofa_3seat', 'sofa_sectional_l', 'loveseat', 'chaise',
  'bed_single', 'bed_double', 'bed_queen', 'bed_king',
  'desk', 'dining_table_rect', 'dining_table_round',
  'wardrobe', 'dresser', 'bookcase', 'sideboard', 'armchair',
]);

/** Access point in front of an item (used by the editor HUD). */
export function accessPoint(e, reach = 500) {
  const f = frontAxis(e.box);
  return [e.box.cx + f[0] * (e.box.d / 2 + reach), e.box.cy + f[1] * (e.box.d / 2 + reach)];
}

/**
 * The widest available route that gets a person within touching distance of `e`.
 * We take the best approach cell rather than one arbitrary point, so a coffee
 * table deliberately parked 400mm off the sofa is not mistaken for a corridor.
 */
function bestApproach(g, field, e, reach = 900) {
  const box = e.box;
  const half = Math.max(box.w, box.d) / 2 + reach;
  const [i0, j0] = g.cellOf(box.cx - half, box.cy - half);
  const [i1, j1] = g.cellOf(box.cx + half, box.cy + half);
  let best = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = g.idx(i, j);
      if (g.blocked[k] || field[k] <= best) continue;
      const [x, y] = g.centre(i, j);
      const [u, v] = world2local(box, x, y);
      const du = Math.max(0, Math.abs(u) - box.w / 2);
      const dv = Math.max(0, Math.abs(v) - box.d / 2);
      if (Math.hypot(du, dv) > reach) continue;
      best = field[k];
    }
  }
  return best;
}

export function walkwayAnalysis(rm, ents) {
  const g = buildGrid(rm, ents);
  let src = null;
  if (rm.doors.length) {
    const ap = doorApron(rm.doors[0]);
    src = nearestFree(g, ap.cx, ap.cy, 1500);
  }
  if (!src) src = nearestFree(g, rm.centroid[0], rm.centroid[1], 3000);
  if (!src) {
    return { grid: g, walkway_min_mm: 0, unreachable: ents.map((e) => e.id), field: null, primary_mm: 0 };
  }
  const field = widestPathField(g, src);
  let spine = 0;
  for (let k = 0; k < field.length; k++) if (field[k] > spine) spine = field[k];
  spine = Math.round(spine * 2);

  let minW = Infinity;
  const unreachable = [];
  const majors = ents.filter((e) => e.collider && MAJOR.has(e.arche));
  for (const e of majors) {
    const b = bestApproach(g, field, e);
    if (b <= 0) { unreachable.push(e.id); continue; }
    minW = Math.min(minW, b * 2); // clearance is a radius; corridor width = 2r
  }
  if (!majors.length || minW === Infinity) minW = spine;
  return {
    grid: g, field,
    walkway_min_mm: Math.round(clamp(minW, 0, 4000)),
    primary_mm: spine,
    unreachable,
  };
}

// --------------------------------------------------------------------------
// component metrics
// --------------------------------------------------------------------------
export function visualBalance(rm, ents) {
  let m = 0, mx = 0, my = 0;
  for (const e of ents) {
    if (!e.collider) continue;
    const w = e.area * (0.5 + clamp(e.h / 2000, 0.1, 1));
    m += w; mx += e.box.cx * w; my += e.box.cy * w;
  }
  if (m <= 0) return 0.5;
  const cx = mx / m, cy = my / m;
  const diag = Math.hypot(rm.bbox.w, rm.bbox.h) / 2 || 1;
  const off = Math.hypot(cx - rm.centroid[0], cy - rm.centroid[1]);
  return clamp(1 - off / (diag * 0.55), 0, 1);
}

export function wallUtilisation(rm, ents) {
  const wanters = ents.filter((e) => (e.item.placement || {}).against_wall);
  if (!wanters.length) return 1;
  let ok = 0;
  for (const e of wanters) {
    const f = frontAxis(e.box);
    const back = [e.box.cx - f[0] * e.box.d / 2, e.box.cy - f[1] * e.box.d / 2];
    const d = distToBoundary(back[0], back[1], rm.poly);
    if (d <= ((e.item.placement.wall_offset_mm || 40) + 90)) ok++;
  }
  return ok / wanters.length;
}

export function focalCoherence(rm, ents) {
  const anchors = ents.filter((e) => isSofa(e.arche) || isBed(e.arche) || e.arche === 'desk');
  if (!anchors.length) return 0.6;
  const focals = [];
  for (const w of rm.windows) focals.push({ p: w.mid, weight: 1 });
  for (const f of rm.features) if (f.type === 'fireplace') focals.push({ p: f.mid, weight: 1.4 });
  for (const e of ents) if (e.arche === 'tv') focals.push({ p: [e.box.cx, e.box.cy], weight: 1.3 });
  if (!focals.length) return 0.65;
  let total = 0, wsum = 0;
  for (const a of anchors) {
    const f = frontAxis(a.box);
    let best = 0;
    for (const fo of focals) {
      const dx = fo.p[0] - a.box.cx, dy = fo.p[1] - a.box.cy;
      const L = Math.hypot(dx, dy) || 1;
      const dot = (dx / L) * f[0] + (dy / L) * f[1]; // 1 = looking straight at it
      best = Math.max(best, clamp((dot + 0.25) / 1.25, 0, 1) * clamp(fo.weight, 0, 1.4) / 1.4);
    }
    total += best * a.area; wsum += a.area;
  }
  return wsum ? clamp(total / wsum, 0, 1) : 0.6;
}

export function conversationTightness(rm, ents) {
  const seats = ents.filter((e) => isSeating(e.arche) && e.collider);
  if (seats.length < 2) return seats.length ? 0.7 : 0.6;
  let worst = 0;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      worst = Math.max(worst, Math.hypot(
        seats[i].box.cx - seats[j].box.cx, seats[i].box.cy - seats[j].box.cy));
    }
  }
  // 1.8m-2.7m apart is the conversational sweet spot; 3.6m+ is a broken group
  if (worst <= 2700) return clamp(1 - Math.abs(worst - 2300) / 4000, 0.6, 1);
  return clamp(1 - (worst - 2700) / 2200, 0, 0.85);
}

export function walkwayQuality(mm) {
  if (mm >= RULES.WALKWAY_PRIMARY_MM) return clamp(0.85 + (mm - 900) / 4000, 0.85, 1);
  if (mm >= RULES.WALKWAY_SECONDARY_MM) return 0.6 + (mm - 760) / 140 * 0.25;
  if (mm >= RULES.WALKWAY_ABS_MIN_MM) return 0.3 + (mm - 600) / 160 * 0.3;
  return clamp(mm / 600 * 0.3, 0, 0.3);
}

// --------------------------------------------------------------------------
// public API (§5.1)
// --------------------------------------------------------------------------
export function scoreLayout({ room, layout, catalog }) {
  const rm = room && room.walls ? room : buildRoom(room);
  const ents = expand(rm, layout, catalog);
  const functional = layout.__functional || [];
  const violations = checkAll(rm, ents, functional);

  const wk = walkwayAnalysis(rm, ents);
  for (const id of wk.unreachable) {
    const e = ents.find((x) => x.id === id);
    violations.push({
      severity: 'error', code: 'UNREACHABLE',
      message: `${e ? e.item.name : id} cannot be reached from the door without stepping over something.`,
      instance_ids: [id],
    });
  }
  const wmm = wk.walkway_min_mm;
  if (wmm > 0 && wmm < RULES.WALKWAY_ABS_MIN_MM) {
    violations.push({
      severity: 'error', code: 'WALKWAY_TIGHT',
      message: `Tightest route measures ${wmm}mm; ${RULES.WALKWAY_ABS_MIN_MM}mm is the absolute floor.`,
      instance_ids: [],
    });
  } else if (wmm > 0 && wmm < RULES.WALKWAY_SECONDARY_MM) {
    violations.push({
      severity: 'warn', code: 'WALKWAY_TIGHT',
      message: `Tightest route measures ${wmm}mm; secondary walkways want ${RULES.WALKWAY_SECONDARY_MM}mm.`,
      instance_ids: [],
    });
  } else if (wmm > 0 && wmm < RULES.WALKWAY_PRIMARY_MM) {
    violations.push({
      severity: 'info', code: 'WALKWAY_TIGHT',
      message: `Main route measures ${wmm}mm; ${RULES.WALKWAY_PRIMARY_MM}mm is the target for a primary walkway.`,
      instance_ids: [],
    });
  }

  const colliders = ents.filter((e) => e.collider);
  const coverage = rm.area ? colliders.reduce((s, e) => s + e.area, 0) / rm.area : 0;
  const balance = visualBalance(rm, ents);
  const walk = walkwayQuality(wmm);
  const focal = focalCoherence(rm, ents);
  const wallUse = wallUtilisation(rm, ents);
  const convo = conversationTightness(rm, ents);
  // coverage sweet spot ~ 30-45% of the floor
  const cov = clamp(1 - Math.abs(coverage - 0.36) / 0.34, 0, 1);

  // ---- penalties -----------------------------------------------------------
  // Soft (warn/info) penalties accumulate and are capped: a layout with many
  // minor compromises is worse, but never worthless.
  //
  // Errors are DIFFERENT and must dominate the ranking. Without this, the
  // solver is rewarded for giving up: dropping a piece it can't fit removes
  // that piece's clearance conflicts AND frees floor area, so an incomplete
  // layout can out-score a complete valid one. (Observed for real: an 8/9
  // layout with an OUT_OF_BOUNDS error scored 0.702 against 0.645 for the
  // 9/9 zero-error layout.) Shipping that would mean recommending a broken
  // room as "best". So errors apply a multiplicative factor outside the soft
  // cap: no amount of balance/coverage polish can buy back a hard failure.
  const errCount = violations.filter((v) => v.severity === 'error').length;
  let softPenalty = 0;
  for (const v of violations) {
    if (v.severity === 'error') continue;
    softPenalty += SEVERITY_WEIGHT[v.severity] || 0.02;
  }
  softPenalty = Math.min(softPenalty, 0.6);
  const errorFactor = errCount ? Math.pow(RULES.ERROR_SCORE_FACTOR, errCount) : 1;

  const raw = 0.26 * walk + 0.17 * balance + 0.16 * focal
    + 0.14 * wallUse + 0.13 * convo + 0.14 * cov;
  const score = Math.round(clamp(raw * (1 - softPenalty) * errorFactor, 0, 1) * 1000) / 1000;

  return {
    score,
    metrics: {
      walkway_min_mm: wmm,
      coverage: Math.round(coverage * 1000) / 1000,
      balance: Math.round(balance * 1000) / 1000,
      walkway_quality: Math.round(walk * 1000) / 1000,
      focal: Math.round(focal * 1000) / 1000,
      wall_use: Math.round(wallUse * 1000) / 1000,
      conversation: Math.round(convo * 1000) / 1000,
      free_floor_mm2: Math.round(wk.grid.freeArea()),
      errors: errCount,
      error_factor: Math.round(errorFactor * 1000) / 1000,
      warnings: violations.filter((v) => v.severity === 'warn').length,
    },
    violations,
  };
}

export function validatePlacement({ room, layout, catalog, instance_id }) {
  const res = scoreLayout({ room, layout, catalog });
  if (!instance_id) return res.violations;
  return res.violations.filter((v) => (v.instance_ids || []).indexOf(instance_id) >= 0);
}

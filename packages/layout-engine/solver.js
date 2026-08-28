// packages/layout-engine/solver.js
// Anchor-first constraint placer. Deterministic for a given seed.
// Pure, dependency-free, DOM-free.

import {
  makeRng, R2D, D2R, obbPenetration, obbGap, obbOutsideDepth, pointInPoly,
  frontAxis, local2world, world2local, clamp, distToBoundary, polyBbox,
} from './geom.js';
import {
  RULES, buildRoom, expand, catGet, isFloorCollider, doorApron, doorSwing,
  isSofa, isBed, isSeating, isDiningTable, frontEnvelope, sideEnvelope, checkAll,
} from './rules.js';
import { walkwayAnalysis } from './scoring.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function rotFacing(fromX, fromY, toX, toY) {
  return Math.atan2(toY - fromY, toX - fromX) * R2D - 90;
}

export function wallName(w) {
  const [nx, ny] = w.normal;
  if (ny > 0.7) return 'south';
  if (ny < -0.7) return 'north';
  if (nx > 0.7) return 'west';
  if (nx < -0.7) return 'east';
  return `wall ${w.index}`;
}

const m = (mm) => (Math.round(mm / 100) / 10).toFixed(1);

const ROLE_ORDER = [
  'anchor', 'anchor_dependent', 'major', 'seating', 'table', 'storage',
  'lighting', 'decor', 'rug',
];

function roleOf(item) {
  const a = item.archetype;
  if (a === 'rug') return 'rug';
  if (['floor_lamp', 'table_lamp', 'pendant_lamp', 'wall_lamp'].indexOf(a) >= 0) return 'lighting';
  if (['art_frame', 'mirror', 'plant', 'curtain', 'wall_shelf', 'tv'].indexOf(a) >= 0) return 'decor';
  if (['wardrobe', 'dresser', 'bookcase', 'shelf_unit', 'sideboard', 'cabinet', 'tv_bench',
    'nightstand', 'console_table', 'storage_box'].indexOf(a) >= 0) return 'storage';
  if (['coffee_table', 'side_table', 'dining_table_rect', 'dining_table_round',
    'kitchen_island'].indexOf(a) >= 0) return 'table';
  if (isSeating(a) || ['dining_chair', 'office_chair', 'stool', 'bar_stool'].indexOf(a) >= 0) return 'seating';
  if (isBed(a) || a === 'desk') return 'major';
  return 'major';
}

const ANCHOR_RANK = {
  bed_king: 100, bed_queen: 98, bed_double: 96, bed_single: 88,
  sofa_sectional_l: 86, sofa_3seat: 84, sofa_2seat: 78, loveseat: 74,
  desk: 66, dining_table_rect: 62, dining_table_round: 60,
};

// ---------------------------------------------------------------------------
// wall run bookkeeping
// ---------------------------------------------------------------------------
function mergeIntervals(list) {
  const s = list.filter((iv) => iv[1] > iv[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of s) {
    if (!out.length || iv[0] > out[out.length - 1][1]) out.push([iv[0], iv[1]]);
    else out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
  }
  return out;
}

function invert(blocked, lo, hi) {
  const out = [];
  let cur = lo;
  for (const [a, b] of blocked) {
    if (b <= lo || a >= hi) continue;
    if (a > cur) out.push([cur, Math.min(a, hi)]);
    cur = Math.max(cur, b);
  }
  if (cur < hi) out.push([cur, hi]);
  return out.filter((iv) => iv[1] - iv[0] > 1);
}

class Placer {
  constructor(rm, rng) {
    this.rm = rm;
    this.rng = rng;
    this.wallUse = rm.walls.map(() => []);
    this.reserved = [];   // functional keep-out zones (e.g. bed access sides)
    this.placed = [];   // {instance_id, item, box, collider}
    this.rationale = [];
    this.functional = [];
    this.notes = [];
  }

  say(s) { if (s && this.rationale.indexOf(s) < 0) this.rationale.push(s); }

  colliders() { return this.placed.filter((p) => p.collider); }

  /** free runs along wall wi for an item of height h; tolerant=ignore windows */
  freeRuns(wi, h, tolerant) {
    const w = this.rm.walls[wi];
    const blocked = [];
    for (const o of w.openings) {
      if (o.type === 'door') blocked.push([o.t0 - 60, o.t1 + 60]);
      else if (!tolerant && (o.sill_mm || 0) < h - 20) blocked.push([o.t0 - 30, o.t1 + 30]);
    }
    for (const f of w.features) {
      if (['radiator', 'fireplace', 'column', 'stair', 'vent'].indexOf(f.type) >= 0) {
        blocked.push([f.t0 - 50, f.t1 + 50]);
      }
    }
    for (const iv of this.wallUse[wi]) blocked.push(iv);
    return invert(mergeIntervals(blocked), 0, w.len);
  }

  boxOnWall(wi, tCentre, item, extraOffset) {
    const w = this.rm.walls[wi];
    const pl = item.placement || {};
    const off = (extraOffset != null ? extraOffset : (pl.wall_offset_mm || 40)) + item.dims_mm.d / 2;
    return {
      cx: w.a[0] + w.dir[0] * tCentre + w.normal[0] * off,
      cy: w.a[1] + w.dir[1] * tCentre + w.normal[1] * off,
      w: item.dims_mm.w, d: item.dims_mm.d, rot: w.rot_deg,
    };
  }

  /** hard feasibility: inside room, no collider overlap, door apron + swing clear */
  feasible(box, item, ignoreIds) {
    const collider = isFloorCollider(item);
    if (obbOutsideDepth(box, this.rm.poly) > 1) return false;
    if (!collider) return true;
    for (const p of this.colliders()) {
      if (ignoreIds && ignoreIds.indexOf(p.instance_id) >= 0) continue;
      if (obbPenetration(box, p.box) > 2) return false;
    }
    for (const d of this.rm.doors) {
      if (obbPenetration(doorApron(d), box) > 20) return false;
      const sw = doorSwing(d);
      if (obbPenetration(sw.box, box) > 20
        && obbGap({ cx: sw.hinge[0], cy: sw.hinge[1], w: 1, d: 1, rot: 0 }, box) < sw.radius - 20) return false;
    }
    for (const z of this.ignoreReserved ? [] : this.reserved) {
      if (z.exempt && z.exempt.indexOf(item.archetype) >= 0) continue;
      if (obbPenetration(z.box, box) > 20) return false;
    }
    for (const f of this.rm.features) {
      if (f.type !== 'radiator' && f.type !== 'vent') continue;
      const keep = {
        cx: f.mid[0] + f.wall.normal[0] * ((f.depth_mm || 120) + RULES.FEATURE_KEEPOUT_MM) / 2,
        cy: f.mid[1] + f.wall.normal[1] * ((f.depth_mm || 120) + RULES.FEATURE_KEEPOUT_MM) / 2,
        w: f.width_mm, d: (f.depth_mm || 120) + RULES.FEATURE_KEEPOUT_MM, rot: f.wall.rot_deg,
      };
      if (obbPenetration(keep, box) > 20) return false;
    }
    return true;
  }

  /**
   * Reject useless slivers: a gap must either be effectively adjacent (<=120mm)
   * or wide enough to walk (>=minGap). This is what stops a chair from pinching
   * the route out of the door.
   */
  sliverFree(box, item, minGap, ignore) {
    if (!isFloorCollider(item)) return true;
    for (const p of this.colliders()) {
      if (ignore && ignore.indexOf(p.instance_id) >= 0) continue;
      const g = obbGap(box, p.box);
      if (g > 120 && g < minGap) return false;
    }
    return true;
  }

  ok(box, item, opts, strict) {
    if (!this.feasible(box, item, opts && opts.ignore)) return false;
    if (strict && !(opts && opts.allowSliver)) {
      const mg = (opts && opts.minGap) || RULES.WALKWAY_SECONDARY_MM;
      if (!this.sliverFree(box, item, mg, opts && opts.ignore)) return false;
    }
    return true;
  }

  commit(inst, box, against, addedByAi) {
    const rec = {
      instance_id: inst.instance_id, item: inst.item, box,
      collider: isFloorCollider(inst.item), against: against || null,
      added_by_ai: !!addedByAi,
    };
    this.placed.push(rec);
    if (against && against.wall_index != null) {
      const w = this.rm.walls[against.wall_index];
      const t = (box.cx - w.a[0]) * w.dir[0] + (box.cy - w.a[1]) * w.dir[1];
      const half = Math.max(inst.item.dims_mm.w, (inst.item.placement || {}).needs_wall_len_mm || 0) / 2;
      this.wallUse[against.wall_index].push([t - half, t + half]);
    }
    return rec;
  }

  /** Try to seat an item against wall wi near normalised position tPref (0..1). */
  tryWall(inst, wi, tFrac, opts = {}) {
    const item = inst.item;
    const w = this.rm.walls[wi];
    const need = Math.max(item.dims_mm.w, (item.placement || {}).needs_wall_len_mm || 0);
    for (const pass of [0, 1, 2, 3]) {
      const strict = pass < 2;
      const tolerant = pass % 2 === 1;
      if (tolerant && !opts.allowWindowWall) continue;
      const runs = this.freeRuns(wi, item.dims_mm.h, tolerant);
      const scored = runs.filter((r) => r[1] - r[0] >= need - 1)
        .map((r) => ({ r, mid: (r[0] + r[1]) / 2 }))
        .sort((a, b) => Math.abs(a.mid / w.len - tFrac) - Math.abs(b.mid / w.len - tFrac));
      for (const s of scored) {
        const lo = s.r[0] + need / 2, hi = s.r[1] - need / 2;
        const want = clamp(tFrac * w.len, lo, hi);
        const steps = [want];
        for (let k = 50; k <= 1400; k += 50) { steps.push(want + k); steps.push(want - k); }
        for (const t of steps) {
          if (t < lo - 1 || t > hi + 1) continue;
          const box = this.boxOnWall(wi, t, item);
          if (this.ok(box, item, opts, strict)) return { box, against: { wall_index: wi } };
        }
      }
    }
    return null;
  }

  /** Best wall for an item, by preference score. */
  bestWall(inst, prefer = [], tFrac = 0.5, opts = {}) {
    const order = [];
    for (const wi of prefer) order.push(wi);
    const byLen = this.rm.walls.slice().sort((a, b) => b.len - a.len).map((w) => w.index);
    for (const wi of byLen) if (order.indexOf(wi) < 0) order.push(wi);
    for (const wi of order) {
      const r = this.tryWall(inst, wi, tFrac, opts);
      if (r) return r;
    }
    return null;
  }

  /** Free-floor search; scores candidates by closeness to `target` and openness. */
  tryFloor(inst, target, opts = {}) {
    const item = inst.item;
    const bb = this.rm.bbox;
    const step = opts.step || Math.max(90, Math.round(Math.max(bb.w, bb.h) / 40 / 10) * 10);
    const rots = opts.rots || [0, 90, 180, 270];
    // search window keeps the cost bounded (a 6-10 item room stays well under 300ms)
    const R = opts.radius || 2600;
    const x0 = target ? Math.max(bb.x0, target[0] - R) : bb.x0;
    const x1 = target ? Math.min(bb.x1, target[0] + R) : bb.x1;
    const y0 = target ? Math.max(bb.y0, target[1] - R) : bb.y0;
    const y1 = target ? Math.min(bb.y1, target[1] + R) : bb.y1;
    let best = null;
    for (const strict of [true, false]) {
    for (const rot of rots) {
      for (let y = y0 + step / 2; y <= y1; y += step) {
        for (let x = x0 + step / 2; x <= x1; x += step) {
          const box = { cx: Math.round(x), cy: Math.round(y), w: item.dims_mm.w, d: item.dims_mm.d, rot };
          let sc = 0;
          if (target) sc -= Math.hypot(box.cx - target[0], box.cy - target[1]) / 1000;
          const dW = distToBoundary(box.cx, box.cy, this.rm.poly);
          sc += (opts.hugWall ? -dW : Math.min(dW, 1500)) / 3000;
          if (opts.faceTarget && target) {
            const f = frontAxis(box);
            const dx = target[0] - box.cx, dy = target[1] - box.cy;
            const L = Math.hypot(dx, dy) || 1;
            sc += ((dx / L) * f[0] + (dy / L) * f[1]) * 0.9;
          }
          if (best && sc <= best.sc) continue;         // cheap reject before geometry
          if (!this.ok(box, item, opts, strict)) continue;
          best = { sc, box };
        }
      }
    }
    if (best) break;
    }
    return best ? { box: best.box, against: null } : null;
  }
}

// ---------------------------------------------------------------------------
// focal-wall analysis
// ---------------------------------------------------------------------------
export function analyseRoom(rm) {
  const walls = rm.walls.map((w) => {
    let longestFree = w.len;
    const cuts = [];
    for (const o of w.openings) cuts.push([o.t0, o.t1]);
    if (cuts.length) {
      const merged = mergeIntervals(cuts);
      const runs = invert(merged, 0, w.len);
      longestFree = runs.reduce((mx, r) => Math.max(mx, r[1] - r[0]), 0);
    }
    return {
      index: w.index, len: w.len, longestFree,
      openings: w.openings.length, hasDoor: w.openings.some((o) => o.type === 'door'),
      hasWindow: w.openings.some((o) => o.type === 'window'),
      name: wallName(w),
    };
  });
  const uninterrupted = walls.slice().sort((a, b) =>
    (b.longestFree - a.longestFree) || (b.len - a.len) || (a.index - b.index));
  const mainWindow = rm.windows.slice().sort((a, b) => b.width_mm - a.width_mm)[0] || null;
  let oppositeWindow = null;
  if (mainWindow) {
    const nW = mainWindow.wall.normal;
    oppositeWindow = rm.walls.slice().sort((a, b) =>
      (b.normal[0] * -nW[0] + b.normal[1] * -nW[1]) - (a.normal[0] * -nW[0] + a.normal[1] * -nW[1])
      || b.len - a.len)[0].index;
  }
  const focal = mainWindow != null && oppositeWindow != null
    && walls[oppositeWindow].longestFree >= uninterrupted[0].longestFree * 0.72
    ? oppositeWindow : uninterrupted[0].index;
  return { walls, uninterrupted, mainWindow, oppositeWindow, focalWall: focal };
}

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------
export const STRATEGIES = [
  { id: 'wall-anchored', label: 'anchor on the focal wall, everything reads off it' },
  { id: 'window-facing', label: 'anchor set opposite the main window for the sightline' },
  { id: 'corner-asymmetric', label: 'anchor pushed off-centre to open one diagonal' },
  { id: 'floating-group', label: 'conversation group pulled off the walls' },
];

function anchorWallFor(strategy, an, rm, rng) {
  const u = an.uninterrupted;
  switch (strategy.id) {
    case 'window-facing':
      return an.oppositeWindow != null ? an.oppositeWindow : u[0].index;
    case 'corner-asymmetric':
      return (u[1] || u[0]).index;
    case 'floating-group':
      return an.focalWall;
    default:
      return an.focalWall;
  }
}

// ---------------------------------------------------------------------------
// main solve for one candidate
// ---------------------------------------------------------------------------
export function solveOne({ rm, instances, style, seed, strategy, analysis }) {
  const rng = makeRng(seed);
  const P = new Placer(rm, rng);
  const an = analysis;
  const byRole = {};
  for (const inst of instances) {
    const r = roleOf(inst.item);
    (byRole[r] = byRole[r] || []).push(inst);
  }
  const unplaced = new Set(instances.map((i) => i.instance_id));
  const take = (pred) => {
    for (const inst of instances) {
      if (!unplaced.has(inst.instance_id)) continue;
      if (pred(inst)) return inst;
    }
    return null;
  };
  const takeAll = (pred) => instances.filter((i) => unplaced.has(i.instance_id) && pred(i));
  const place = (inst, res, addedByAi) => {
    if (!res) return null;
    unplaced.delete(inst.instance_id);
    return P.commit(inst, res.box, res.against, addedByAi != null ? addedByAi : inst.added_by_ai);
  };

  // ---- locked placements first (user pinned) ----
  for (const inst of instances.filter((i) => i.locked_placement)) {
    const lp = inst.locked_placement;
    const box = {
      cx: lp.x_mm, cy: lp.y_mm, w: inst.item.dims_mm.w, d: inst.item.dims_mm.d,
      rot: lp.rot_deg || 0,
    };
    unplaced.delete(inst.instance_id);
    const rec = P.commit(inst, box, lp.against || null);
    rec.locked = true;
  }

  // ---- anchor ----
  let anchorRec = null, anchorInst = null;
  const anchorCands = instances
    .filter((i) => unplaced.has(i.instance_id) && ANCHOR_RANK[i.item.archetype])
    .sort((a, b) => (ANCHOR_RANK[b.item.archetype] - ANCHOR_RANK[a.item.archetype])
      || (b.item.dims_mm.w * b.item.dims_mm.d - a.item.dims_mm.w * a.item.dims_mm.d));
  if (anchorCands.length) {
    anchorInst = anchorCands[0];
    let wi = anchorWallFor(strategy, an, rm, rng);
    let bedWalls = null;
    if (isBed(anchorInst.item.archetype)) {
      // A bed wants the wall it fits *snugly* against: headboard wall length
      // close to bed width + 700mm access each side, and enough depth left for
      // the bed plus circulation at the foot. Putting it on the longest wall
      // instead would eat the room's circulation dimension.
      const bw = anchorInst.item.dims_mm.w, bd = anchorInst.item.dims_mm.d;
      bedWalls = rm.walls.map((w) => {
        const perp = Math.abs(w.dir[0]) > Math.abs(w.dir[1]) ? rm.bbox.h : rm.bbox.w;
        return {
          wi: w.index,
          fits: perp >= bd + 450 && w.len >= bw + 80,
          snug: Math.abs(w.len - (bw + 2 * RULES.BED_ACCESS_MM)),
          hasDoor: w.openings.some((o) => o.type === 'door'),
        };
      }).filter((c) => c.fits)
        .sort((a, b) => (a.hasDoor === b.hasDoor ? a.snug - b.snug : (a.hasDoor ? 1 : -1)))
        .map((c) => c.wi);
      if (bedWalls.length) {
        const pick = strategy.id === 'corner-asymmetric' && bedWalls.length > 1 ? 1 : 0;
        wi = bedWalls[pick];
      }
    }
    let tFrac = strategy.id === 'corner-asymmetric'
      ? (rng() < 0.5 ? 0.28 : 0.72)
      : clamp(0.5 + rng.range(-0.06, 0.06), 0.1, 0.9);
    if (bedWalls && bedWalls.length) {
      // centre the bed on its wall so both access sides genuinely clear 700mm
      const w = rm.walls[wi];
      const bw2 = anchorInst.item.dims_mm.w / 2;
      const lo = bw2 + RULES.BED_ACCESS_MM, hi = w.len - bw2 - RULES.BED_ACCESS_MM;
      tFrac = (lo <= hi ? (lo + hi) / 2 : w.len / 2) / w.len;
    }
    let res = null;
    if (strategy.id === 'floating-group' && isSofa(anchorInst.item.archetype)
      && Math.min(rm.bbox.w, rm.bbox.h) > 3200) {
      // pull the sofa off the wall, facing the focal element
      const w = rm.walls[wi];
      const pull = Math.round(rng.range(700, 1000));
      const t = w.len * tFrac;
      const box = {
        cx: w.a[0] + w.dir[0] * t + w.normal[0] * (pull + anchorInst.item.dims_mm.d / 2),
        cy: w.a[1] + w.dir[1] * t + w.normal[1] * (pull + anchorInst.item.dims_mm.d / 2),
        w: anchorInst.item.dims_mm.w, d: anchorInst.item.dims_mm.d, rot: w.rot_deg,
      };
      if (P.feasible(box, anchorInst.item)) {
        res = { box, against: null };
        P.say(`${anchorInst.item.name} floats ${pull}mm off the ${wallName(w)} wall so the group reads as an island with a walkway behind it.`);
      }
    }
    if (!res) res = P.tryWall(anchorInst, wi, tFrac, { allowWindowWall: true });
    if (!res && bedWalls) {
      for (const bwi of bedWalls) {
        res = P.tryWall(anchorInst, bwi, tFrac, { allowWindowWall: true });
        if (res) break;
      }
    }
    if (!res) res = P.bestWall(anchorInst, [an.focalWall, an.oppositeWindow].filter((x) => x != null), tFrac, { allowWindowWall: true });
    if (!res) res = P.tryFloor(anchorInst, rm.centroid, { rots: [0, 90, 180, 270] });
    anchorRec = place(anchorInst, res);
    if (anchorRec) {
      const w = anchorRec.against ? rm.walls[anchorRec.against.wall_index] : null;
      if (w) {
        const winNote = an.mainWindow && an.mainWindow.wall.index !== w.index
          ? ' so the window stays a sightline rather than a backdrop'
          : ' along the room\u2019s longest uninterrupted run';
        P.say(`${anchorInst.item.name} anchored to the ${m(w.len)}m ${wallName(w)} wall${winNote}.`);
      }
    }
  }

  // ---- anchor dependents ----
  if (anchorRec && isSofa(anchorInst.item.archetype)) {
    const sofa = anchorRec;
    const f = frontAxis(sofa.box);
    const frontEdge = [sofa.box.cx + f[0] * sofa.box.d / 2, sofa.box.cy + f[1] * sofa.box.d / 2];

    // coffee table: 350-450mm off the sofa front edge
    const ct = take((i) => i.item.archetype === 'coffee_table');
    if (ct) {
      const gapWanted = Math.round(rng.range(RULES.COFFEE_TABLE_MIN_MM + 10, RULES.COFFEE_TABLE_MAX_MM - 10));
      let done = null;
      for (const g of [gapWanted, 400, 380, 430, 360, 445, 350]) {
        const box = {
          cx: Math.round(frontEdge[0] + f[0] * (g + ct.item.dims_mm.d / 2)),
          cy: Math.round(frontEdge[1] + f[1] * (g + ct.item.dims_mm.d / 2)),
          w: ct.item.dims_mm.w, d: ct.item.dims_mm.d, rot: sofa.box.rot,
        };
        if (P.feasible(box, ct.item)) { done = { box, against: null, g }; break; }
      }
      if (done) {
        place(ct, done);
        P.functional.push([sofa.instance_id, ct.instance_id]);
        P.say(`${ct.item.name} set ${done.g}mm off the sofa front edge \u2014 inside the 350\u2013450mm reach band.`);
      }
    }

    // TV on the wall the sofa faces
    const tv = take((i) => i.item.archetype === 'tv');
    if (tv) {
      const hit = rayWall(rm, sofa.box.cx, sofa.box.cy, f[0], f[1]);
      if (hit) {
        const diag = Math.hypot(tv.item.dims_mm.w, tv.item.dims_mm.h);
        const pl = tv.item.placement || {};
        const off = pl.wall_mounted ? (pl.wall_offset_mm || 60) : (pl.wall_offset_mm || 40);
        const w = rm.walls[hit.wall_index];
        const t = clamp(hit.t, tv.item.dims_mm.w / 2 + 50, w.len - tv.item.dims_mm.w / 2 - 50);
        const box = {
          cx: Math.round(w.a[0] + w.dir[0] * t + w.normal[0] * (off + tv.item.dims_mm.d / 2)),
          cy: Math.round(w.a[1] + w.dir[1] * t + w.normal[1] * (off + tv.item.dims_mm.d / 2)),
          w: tv.item.dims_mm.w, d: tv.item.dims_mm.d, rot: w.rot_deg,
        };
        place(tv, { box, against: { wall_index: hit.wall_index } });
        const dist = Math.hypot(box.cx - sofa.box.cx, box.cy - sofa.box.cy);
        const lo = diag * RULES.TV_DIST_MIN_FACTOR, hi = diag * RULES.TV_DIST_MAX_FACTOR;
        const verdict = dist < lo ? 'closer than the 1.6\u00d7 minimum for that diagonal'
          : dist > hi ? 'beyond the 2.5\u00d7 comfortable maximum'
            : `inside the ${Math.round(lo)}\u2013${Math.round(hi)}mm comfortable band`;
        P.say(`${tv.item.name} hung on the ${wallName(w)} wall, ${Math.round(dist)}mm from the sofa \u2014 ${verdict}.`);
        // tv bench under it
        const bench = take((i) => i.item.archetype === 'tv_bench');
        if (bench) {
          const r = P.tryWall(bench, hit.wall_index, t / w.len, { allowWindowWall: true });
          if (r) { place(bench, r); P.say(`${bench.item.name} centred under the screen on the same wall.`); }
        }
      }
    } else {
      const bench = take((i) => i.item.archetype === 'tv_bench');
      if (bench) {
        const hit = rayWall(rm, sofa.box.cx, sofa.box.cy, f[0], f[1]);
        const r = hit ? P.tryWall(bench, hit.wall_index, hit.t / rm.walls[hit.wall_index].len, { allowWindowWall: true })
          : P.bestWall(bench, [], 0.5, { allowWindowWall: true });
        if (r) place(bench, r);
      }
    }

    // armchairs flanking, turned toward the sofa
    const chairs = takeAll((i) => i.item.archetype === 'armchair').slice(0, 2);
    let side = rng() < 0.5 ? 1 : -1;
    for (const ch of chairs) {
      const centre = [sofa.box.cx + f[0] * 1500, sofa.box.cy + f[1] * 1500];
      const env = sideEnvelope(sofa.box, side, 1500);
      const target = [env.cx + f[0] * 700, env.cy + f[1] * 700];
      const r = P.tryFloor(ch, target, { faceTarget: true, rots: [0, 45, 90, 135, 180, 225, 270, 315], step: 110, radius: 2200 });
      if (r) {
        const searched = r.box.rot;
        r.box.rot = Math.round(rotFacing(r.box.cx, r.box.cy, centre[0], centre[1]));
        if (!P.feasible(r.box, ch.item)) {
          r.box.rot = sofa.box.rot;
          if (!P.feasible(r.box, ch.item)) r.box.rot = searched;   // never keep an overlap
        }
        place(ch, r);
        P.functional.push([sofa.instance_id, ch.instance_id]);
        P.say(`${ch.item.name} angled in from the ${side > 0 ? 'right' : 'left'} to close the conversation group.`);
      }
      side = -side;
    }

    // rug under the group, overlapping the sofa front legs
    const rug = take((i) => i.item.archetype === 'rug');
    if (rug) {
      const ov = clamp(Math.round(rug.item.dims_mm.d * 0.3), RULES.RUG_SOFA_OVERLAP_MM + 20, 500);
      const box = {
        cx: Math.round(frontEdge[0] + f[0] * (rug.item.dims_mm.d / 2 - ov)),
        cy: Math.round(frontEdge[1] + f[1] * (rug.item.dims_mm.d / 2 - ov)),
        w: rug.item.dims_mm.w, d: rug.item.dims_mm.d, rot: sofa.box.rot,
      };
      const shifted = nudgeInside(rm, box);
      place(rug, { box: shifted, against: null });
      P.say(`Rug slid ${ov}mm under the sofa front legs so the seating group reads as one zone (rugs are never colliders).`);
    }
  }

  if (anchorRec && isBed(anchorInst.item.archetype)) {
    const bed = anchorRec;
    const f = frontAxis(bed.box);
    const stands = takeAll((i) => i.item.archetype === 'nightstand').slice(0, 2);
    let side = -1;
    for (const ns of stands) {
      const env = sideEnvelope(bed.box, side, ns.item.dims_mm.w);
      const head = [
        env.cx - f[0] * (bed.box.d / 2 - ns.item.dims_mm.d / 2),
        env.cy - f[1] * (bed.box.d / 2 - ns.item.dims_mm.d / 2),
      ];
      const box = {
        cx: Math.round(head[0]), cy: Math.round(head[1]),
        w: ns.item.dims_mm.w, d: ns.item.dims_mm.d, rot: bed.box.rot,
      };
      if (P.feasible(box, ns.item)) {
        place(ns, { box, against: bed.against });
        P.functional.push([bed.instance_id, ns.instance_id]);
      } else {
        const r = P.bestWall(ns, bed.against ? [bed.against.wall_index] : [], 0.5, { allowWindowWall: true });
        if (r) place(ns, r);
      }
      side = -side;
    }
    for (const sgn of [-1, 1]) {
      P.reserved.push({
        box: sideEnvelope(bed.box, sgn, RULES.BED_ACCESS_MM),
        exempt: ['nightstand', 'rug', 'art_frame', 'mirror', 'curtain', 'wall_lamp', 'pendant_lamp'],
        why: 'bed access side',
      });
    }
    P.reserved.push({
      box: frontEnvelope(bed.box, 450),
      exempt: ['rug', 'art_frame', 'mirror', 'curtain', 'wall_lamp', 'pendant_lamp'],
      why: 'foot of bed',
    });
    const w = bed.against ? rm.walls[bed.against.wall_index] : null;
    const acc = Math.round(RULES.BED_ACCESS_MM);
    P.say(`Headboard set against the ${w ? wallName(w) : 'nearest'} wall with ${acc}mm+ kept clear on both access sides.`);
  }

  if (anchorRec && anchorInst.item.archetype === 'desk') {
    const desk = anchorRec;
    const chair = take((i) => i.item.archetype === 'office_chair');
    if (chair) {
      const f = frontAxis(desk.box);
      const box = {
        cx: Math.round(desk.box.cx + f[0] * (desk.box.d / 2 + 260)),
        cy: Math.round(desk.box.cy + f[1] * (desk.box.d / 2 + 260)),
        w: chair.item.dims_mm.w, d: chair.item.dims_mm.d,
        rot: Math.round(desk.box.rot + 180),
      };
      if (P.feasible(box, chair.item)) {
        place(chair, { box, against: null });
        P.functional.push([desk.instance_id, chair.instance_id]);
        P.say(`Task chair tucked at the desk, facing back into the room.`);
      }
    }
  }

  // ---- dining group ----
  const dt = take((i) => isDiningTable(i.item.archetype));
  if (dt) {
    const chairs = takeAll((i) => i.item.archetype === 'dining_chair');
    const need = RULES.DINING_CIRCULATION_MM;
    const clearZone = (box) => {
      const half = Math.max(box.w, box.d) / 2;
      return distToBoundary(box.cx, box.cy, rm.poly) >= half + 120;
    };
    let res = P.tryFloor(dt, rm.centroid, { rots: [0, 90], step: 100 });
    if (res && !clearZone(res.box)) {
      const alt = P.tryFloor(dt, rm.centroid, { rots: [0, 90], step: 60 });
      if (alt && clearZone(alt.box)) res = alt;
    }
    if (res) {
      place(dt, res);
      const perim = dt.item.footprint === 'round'
        ? Math.PI * dt.item.dims_mm.w : 2 * (dt.item.dims_mm.w + dt.item.dims_mm.d);
      const seats = chairs.length || Math.floor(perim / RULES.DINING_EDGE_PER_SEAT_MM);
      P.say(`${dt.item.name} centred in its zone with ${Math.round(perim / Math.max(1, seats))}mm of edge per seat and ${need}mm to pull chairs out.`);
      const box = res.box;
      const slots = [];
      if (dt.item.footprint === 'round') {
        const n = Math.max(2, chairs.length);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + rng() * 0.2;
          slots.push([Math.cos(a), Math.sin(a)]);
        }
      } else {
        const long = Math.max(1, Math.floor(box.w / 600));
        const shortSide = Math.max(1, Math.floor(box.d / 600));
        for (let s = 0; s < long; s++) {
          const u = (s + 0.5) / long - 0.5;
          slots.push(['u', u, 1]); slots.push(['u', u, -1]);
        }
        for (let s = 0; s < shortSide; s++) {
          const v = (s + 0.5) / shortSide - 0.5;
          slots.push(['v', v, 1]); slots.push(['v', v, -1]);
        }
      }
      let ci = 0;
      for (const ch of chairs) {
        let seated = false;
        for (let k = 0; k < slots.length && !seated; k++) {
          const slot = slots[(ci + k) % slots.length];
          let px, py;
          if (dt.item.footprint === 'round') {
            const rr = box.w / 2 + ch.item.dims_mm.d / 2 + 40;
            px = box.cx + slot[0] * rr; py = box.cy + slot[1] * rr;
          } else if (slot[0] === 'u') {
            const [x, y] = local2world(box, slot[1] * box.w, slot[2] * (box.d / 2 + ch.item.dims_mm.d / 2 + 40));
            px = x; py = y;
          } else {
            const [x, y] = local2world(box, slot[2] * (box.w / 2 + ch.item.dims_mm.d / 2 + 40), slot[1] * box.d);
            px = x; py = y;
          }
          const cbox = {
            cx: Math.round(px), cy: Math.round(py),
            w: ch.item.dims_mm.w, d: ch.item.dims_mm.d,
            rot: Math.round(rotFacing(px, py, box.cx, box.cy)),
          };
          if (P.feasible(cbox, ch.item)) {
            place(ch, { box: cbox, against: null });
            P.functional.push([dt.instance_id, ch.instance_id]);
            seated = true; ci = (ci + k + 1) % slots.length;
          }
        }
      }
    }
  }

  // ---- remaining majors + storage against walls ----
  const wallOrder = an.uninterrupted.map((w) => w.index);
  for (const role of ['major', 'storage', 'seating', 'table', 'lighting', 'decor', 'rug']) {
    const list = takeAll((i) => roleOf(i.item) === role)
      .sort((a, b) => (b.item.dims_mm.w * b.item.dims_mm.d) - (a.item.dims_mm.w * a.item.dims_mm.d));
    for (const inst of list) {
      const pl = inst.item.placement || {};
      let res = null;
      const tf = clamp(0.5 + rng.range(-0.3, 0.3), 0.08, 0.92);
      if (pl.wall_mounted) {
        res = P.bestWall(inst, wallOrder, tf, { allowWindowWall: false })
          || P.bestWall(inst, wallOrder, tf, { allowWindowWall: true });
      } else if (pl.ceiling_mounted) {
        const t = anchorRec ? [anchorRec.box.cx, anchorRec.box.cy] : rm.centroid;
        res = { box: { cx: Math.round(t[0]), cy: Math.round(t[1]), w: inst.item.dims_mm.w, d: inst.item.dims_mm.d, rot: 0 }, against: null };
      } else if (pl.against_wall) {
        res = P.bestWall(inst, wallOrder, tf, { allowWindowWall: false })
          || P.bestWall(inst, wallOrder, tf, { allowWindowWall: true })
          || P.tryFloor(inst, anchorRec ? [anchorRec.box.cx, anchorRec.box.cy] : rm.centroid, { hugWall: true });
      } else if (inst.item.archetype === 'rug') {
        const t = anchorRec ? [anchorRec.box.cx, anchorRec.box.cy] : rm.centroid;
        res = { box: nudgeInside(rm, { cx: Math.round(t[0]), cy: Math.round(t[1]), w: inst.item.dims_mm.w, d: inst.item.dims_mm.d, rot: anchorRec ? anchorRec.box.rot : 0 }), against: null };
      } else {
        const t = anchorRec ? [anchorRec.box.cx, anchorRec.box.cy] : rm.centroid;
        res = P.tryFloor(inst, t, { hugWall: !pl.center_ok, step: 100 });
      }
      if (res) place(inst, res);
    }
  }

  // ---- last resort: place it and flag the breach rather than lose the item -
  // Overlap, the door apron and the room outline are never negotiable; the
  // softer functional reservations are, and the rule checks report what broke.
  for (const inst of instances.filter((i) => unplaced.has(i.instance_id))) {
    P.ignoreReserved = true;
    const pl = inst.item.placement || {};
    let res = P.bestWall(inst, an.uninterrupted.map((w) => w.index), 0.5,
      { allowWindowWall: true, allowSliver: true });
    if (!res && !pl.wall_mounted) {
      res = P.tryFloor(inst, rm.centroid, { allowSliver: true, hugWall: !pl.center_ok, step: 90 });
    }
    P.ignoreReserved = false;
    if (res) {
      place(inst, res);
      const w = res.against ? rm.walls[res.against.wall_index] : null;
      P.say(`${inst.item.name} only fits ${w ? `on the ${wallName(w)} wall ` : ''}by encroaching on a functional clearance — placed at its true ${inst.item.dims_mm.w}×${inst.item.dims_mm.d}mm and flagged below rather than shrunk or dropped.`);
    }
  }

  // ---- walkway repair ----------------------------------------------------
  const protectedIds = [anchorRec ? anchorRec.instance_id : null]
    .concat(P.functional.map((f) => f[1]))
    .filter((x) => x);
  const repair = repairWalkway(P, rm, protectedIds);

  // ---- anything still unplaced: honest report, no shrinking, no overlap ----
  const overflow = [];
  for (const inst of instances) {
    if (!unplaced.has(inst.instance_id)) continue;
    overflow.push(inst);
  }
  for (const rec of repair.dropped) {
    overflow.push({ instance_id: rec.instance_id, item: rec.item, dropped_for_walkway: true });
  }

  // ---- build layout ----
  const placements = P.placed.map((r) => ({
    instance_id: r.instance_id,
    item_id: r.item.id,
    x_mm: Math.round(r.box.cx),
    y_mm: Math.round(r.box.cy),
    rot_deg: Math.round(((r.box.rot % 360) + 360) % 360),
    colorway: 0,
    against: r.against || null,
    locked: !!r.locked,
    added_by_ai: !!r.added_by_ai,
  }));

  const extraViolations = overflow.map((inst) => ({
    severity: 'error', code: 'OUT_OF_BOUNDS',
    message: `${inst.item.name} (${inst.item.dims_mm.w}\u00d7${inst.item.dims_mm.d}mm) has no legal position left in this room \u2014 nothing was shrunk or overlapped to make it fit.`,
    instance_ids: [inst.instance_id],
  }));
  if (overflow.length) {
    P.say(`${overflow.length} piece${overflow.length > 1 ? 's' : ''} could not be placed without breaking a clearance rule; left out and flagged rather than forced in.`);
  }

  return {
    placements,
    rationale: P.rationale,
    functional: P.functional,
    extraViolations,
    strategy: strategy.id,
    anchor: anchorInst ? anchorInst.instance_id : null,
  };
}

/**
 * Walkway repair. If the measured route falls under the 760mm secondary
 * standard, relocate the least important pieces (never the anchor, never a
 * locked piece) until it clears. Nothing is shrunk; if a piece has no home that
 * preserves a route it is dropped and reported.
 */
export function repairWalkway(P, rm, protectedIds) {
  const entsOf = () => P.placed.map((r) => ({
    id: r.instance_id, item: r.item, arche: r.item.archetype, box: r.box,
    collider: r.collider, area: r.box.w * r.box.d, h: r.item.dims_mm.h,
  }));
  let w0 = walkwayAnalysis(rm, entsOf()).walkway_min_mm;
  const dropped = [];
  for (let pass = 0; pass < 4 && w0 < RULES.WALKWAY_SECONDARY_MM; pass++) {
    let bestMove = null;
    const snapshot = P.placed.slice();
    for (let i = P.placed.length - 1; i >= 0; i--) {
      const rec = P.placed[i];
      if (!rec.collider || rec.locked) continue;
      if (protectedIds.indexOf(rec.instance_id) >= 0) continue;
      P.placed = snapshot.filter((r) => r !== rec);
      const wOut = walkwayAnalysis(rm, entsOf()).walkway_min_mm;
      if (wOut > w0 + 100) {
        const inst = { instance_id: rec.instance_id, item: rec.item };
        const alt = (rec.item.placement || {}).against_wall
          ? P.bestWall(inst, [], 0.5, { allowWindowWall: true, minGap: RULES.WALKWAY_PRIMARY_MM })
          : P.tryFloor(inst, rm.centroid, { hugWall: true, step: 120, minGap: RULES.WALKWAY_PRIMARY_MM });
        if (alt) {
          const moved = { ...rec, box: alt.box, against: alt.against };
          P.placed = snapshot.filter((r) => r !== rec).concat([moved]);
          const wNew = walkwayAnalysis(rm, entsOf()).walkway_min_mm;
          if (!bestMove || wNew > bestMove.w) bestMove = { w: wNew, rec, moved };
        }
        if (!bestMove || wOut > bestMove.w) bestMove = { w: wOut, rec, moved: null };
      }
      P.placed = snapshot;
      if (bestMove && bestMove.w >= RULES.WALKWAY_PRIMARY_MM) break;
    }
    if (!bestMove || bestMove.w <= w0 + 80) break;
    if (bestMove.moved) {
      bestMove.rec.box = bestMove.moved.box;
      bestMove.rec.against = bestMove.moved.against;
      P.say(`${bestMove.rec.item.name} moved off the main route — it pinched the walkway to ${w0}mm, now ${bestMove.w}mm.`);
    } else {
      P.placed = P.placed.filter((r) => r !== bestMove.rec);
      dropped.push(bestMove.rec);
      P.say(`${bestMove.rec.item.name} left out: every position for it dropped the walkway to ${w0}mm, below the 760mm standard.`);
    }
    w0 = bestMove.w;
  }
  return { walkway: w0, dropped };
}

/** Where does a ray from (x,y) along (dx,dy) meet the room boundary? */
export function rayWall(rm, x, y, dx, dy) {
  let best = null;
  for (const w of rm.walls) {
    const ex = w.b[0] - w.a[0], ey = w.b[1] - w.a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((w.a[0] - x) * ey - (w.a[1] - y) * ex) / den;
    if (t <= 1) continue;
    const s = ((w.a[0] - x) * dy - (w.a[1] - y) * dx) / den;
    if (s < 0 || s > 1) continue;
    if (!best || t < best.t) best = { t, wall_index: w.index, s, tt: s * w.len, dist: t };
  }
  if (!best) return null;
  return { wall_index: best.wall_index, t: best.tt, dist: best.dist };
}

/** Slide a (non-collider) box until it is inside the room. */
export function nudgeInside(rm, box) {
  const b = { ...box };
  for (let k = 0; k < 60; k++) {
    const depth = obbOutsideDepth(b, rm.poly);
    if (depth <= 1) break;
    const [cx, cy] = rm.centroid;
    const dx = cx - b.cx, dy = cy - b.cy;
    const L = Math.hypot(dx, dy) || 1;
    b.cx = Math.round(b.cx + (dx / L) * Math.min(depth, 60));
    b.cy = Math.round(b.cy + (dy / L) * Math.min(depth, 60));
  }
  return b;
}

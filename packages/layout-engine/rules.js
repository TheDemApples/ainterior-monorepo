// packages/layout-engine/rules.js
// The literal rule book from SPEC §5.1 plus the room model every other module
// works against. Dependency-free, DOM-free. Millimetres everywhere (§1).

import {
  D2R, R2D, obbCorners, obbGap, obbPenetration, obbOverlaps, pointInPoly,
  polyArea, polyCentroid, polyBbox, obbOutsideDepth, local2world, world2local,
  frontAxis, clamp, distToBoundary,
} from './geom.js';

export const RULES = {
  // Each error-severity violation multiplies the layout score by this factor,
  // outside the soft-penalty cap, so a hard failure can never out-rank a valid
  // layout no matter how well it scores on balance/coverage. See scoring.js.
  ERROR_SCORE_FACTOR: 0.35,
  WALKWAY_PRIMARY_MM: 900,
  WALKWAY_SECONDARY_MM: 760,
  WALKWAY_ABS_MIN_MM: 600,
  DOOR_APRON_MM: 900,
  COFFEE_TABLE_MIN_MM: 350,
  COFFEE_TABLE_MAX_MM: 450,
  TV_DIST_MIN_FACTOR: 1.6,
  TV_DIST_MAX_FACTOR: 2.5,
  TV_CENTRE_MIN_MM: 1000,
  TV_CENTRE_MAX_MM: 1150,
  DINING_CIRCULATION_MM: 1100,
  DINING_EDGE_PER_SEAT_MM: 600,
  BED_ACCESS_MM: 700,
  RUG_SOFA_OVERLAP_MM: 200,
  LOW_WINDOW_SILL_MM: 1100,
  FEATURE_KEEPOUT_MM: 150,
  WALL_THICKNESS_MM: 100, // drawing + wall-band only, never a placement fudge
};

export const VIOLATION_CODES = [
  'OVERLAP', 'CLEARANCE', 'WALKWAY_TIGHT', 'BLOCKS_DOOR', 'BLOCKS_WINDOW',
  'BLOCKS_RADIATOR', 'OUT_OF_BOUNDS', 'NO_WALL_SUPPORT', 'TV_TOO_CLOSE',
  'TV_TOO_FAR', 'UNREACHABLE', 'FLOATING',
];

// ---- archetype families ---------------------------------------------------
export const FAM = {
  sofa: ['sofa_2seat', 'sofa_3seat', 'sofa_sectional_l', 'loveseat', 'chaise'],
  seating: ['sofa_2seat', 'sofa_3seat', 'sofa_sectional_l', 'loveseat', 'chaise', 'armchair', 'ottoman', 'bench'],
  bed: ['bed_single', 'bed_double', 'bed_queen', 'bed_king', 'crib'],
  bigBed: ['bed_double', 'bed_queen', 'bed_king'],
  diningTable: ['dining_table_rect', 'dining_table_round'],
  diningChair: ['dining_chair'],
  desk: ['desk'],
  coffee: ['coffee_table'],
  rug: ['rug'],
  tv: ['tv'],
  wallDecor: ['art_frame', 'mirror', 'wall_lamp', 'wall_shelf', 'curtain'],
  ceiling: ['pendant_lamp'],
  storage: ['dresser', 'wardrobe', 'bookcase', 'shelf_unit', 'sideboard', 'cabinet', 'tv_bench', 'storage_box', 'nightstand', 'console_table'],
};
const inFam = (a, k) => FAM[k].indexOf(a) >= 0;
export const isSofa = (a) => inFam(a, 'sofa');
export const isBed = (a) => inFam(a, 'bed');
export const isSeating = (a) => inFam(a, 'seating');
export const isDiningTable = (a) => inFam(a, 'diningTable');

export function catGet(catalog, id) {
  if (!catalog) return null;
  if (typeof catalog.get === 'function') return catalog.get(id) || null;
  return catalog[id] || null;
}

/** Wall-mounted / ceiling-mounted / rug items never take part in floor collision (§5.1). */
export function isFloorCollider(item) {
  const pl = item.placement || {};
  if (pl.wall_mounted || pl.ceiling_mounted) return false;
  if (item.archetype === 'rug' || item.category === 'rugs') return false;
  return true;
}

// ---- room model ----------------------------------------------------------
export function buildRoom(room) {
  const poly = room.polygon_mm.map(([x, y]) => [x, y]);
  const n = poly.length;
  const walls = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const dir = [dx / len, dy / len];
    const nrm = [-dir[1], dir[0]]; // CCW polygon => interior is to the left
    walls.push({
      index: i, a, b, dir, normal: nrm, len,
      rot_deg: Math.atan2(nrm[1], nrm[0]) * R2D - 90,
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      openings: [], features: [],
    });
  }
  const openings = (room.openings || []).map((o) => {
    const w = walls[o.wall_index] || walls[0];
    const t0 = o.offset_mm, t1 = o.offset_mm + o.width_mm;
    const p0 = [w.a[0] + w.dir[0] * t0, w.a[1] + w.dir[1] * t0];
    const p1 = [w.a[0] + w.dir[0] * t1, w.a[1] + w.dir[1] * t1];
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const rec = { ...o, wall: w, t0, t1, p0, p1, mid };
    w.openings.push(rec);
    return rec;
  });
  const features = (room.features || []).map((f) => {
    const w = walls[f.wall_index] || walls[0];
    const t0 = f.offset_mm, t1 = f.offset_mm + f.width_mm;
    const mid = [w.a[0] + w.dir[0] * (t0 + t1) / 2, w.a[1] + w.dir[1] * (t0 + t1) / 2];
    const depth = f.depth_mm || 120;
    const rec = {
      ...f, wall: w, t0, t1, mid,
      box: {
        cx: mid[0] + w.normal[0] * depth / 2, cy: mid[1] + w.normal[1] * depth / 2,
        w: f.width_mm, d: depth, rot: w.rot_deg,
      },
    };
    w.features.push(rec);
    return rec;
  });
  const bbox = polyBbox(poly);
  return {
    raw: room, poly, walls, openings, features,
    doors: openings.filter((o) => o.type === 'door'),
    windows: openings.filter((o) => o.type === 'window'),
    bbox, area: polyArea(poly), centroid: polyCentroid(poly),
    height_mm: room.height_mm || 2600,
  };
}

/** 900mm entry apron in front of a door, as an OBB. */
export function doorApron(door, apron = RULES.DOOR_APRON_MM) {
  const w = door.wall;
  return {
    cx: door.mid[0] + w.normal[0] * apron / 2,
    cy: door.mid[1] + w.normal[1] * apron / 2,
    w: door.width_mm, d: apron, rot: w.rot_deg,
  };
}

/** Quarter-disc swing envelope, approximated by its bounding OBB + radial test. */
export function doorSwing(door) {
  const w = door.wall, r = door.width_mm;
  const swing = door.swing || 'in-left';
  const inward = swing.indexOf('out') === 0 ? -1 : 1;
  const hinge = swing.indexOf('right') >= 0 ? door.p1 : door.p0;
  const along = swing.indexOf('right') >= 0 ? -1 : 1;
  const cx = hinge[0] + w.dir[0] * along * r / 2 + w.normal[0] * inward * r / 2;
  const cy = hinge[1] + w.dir[1] * along * r / 2 + w.normal[1] * inward * r / 2;
  return { hinge, radius: r, inward, along, box: { cx, cy, w: r, d: r, rot: w.rot_deg } };
}

/** Openings that must stay clear at floor level: doors + windows with a low sill. */
export function lowOpenings(rm) {
  return rm.openings.filter((o) => o.type === 'door' || (o.sill_mm || 0) < RULES.LOW_WINDOW_SILL_MM);
}

/** Keep-out band in front of a wall opening, depth = d. */
export function openingKeepout(o, d) {
  const w = o.wall;
  return {
    cx: o.mid[0] + w.normal[0] * d / 2, cy: o.mid[1] + w.normal[1] * d / 2,
    w: o.width_mm, d, rot: w.rot_deg,
  };
}

// ---- placement expansion -------------------------------------------------
export function expand(rm, layout, catalog) {
  const out = [];
  for (const p of layout.placements) {
    const item = catGet(catalog, p.item_id);
    if (!item) continue;
    const dm = item.dims_mm;
    out.push({
      p, item,
      id: p.instance_id,
      arche: item.archetype,
      box: { cx: p.x_mm, cy: p.y_mm, w: dm.w, d: dm.d, rot: p.rot_deg || 0 },
      h: dm.h,
      collider: isFloorCollider(item),
      area: dm.w * dm.d,
    });
  }
  return out;
}

const V = (severity, code, message, ids) => ({ severity, code, message, instance_ids: ids });

// ---- individual checks ---------------------------------------------------
export function checkBounds(rm, ents) {
  const out = [];
  for (const e of ents) {
    if (!e.collider && e.arche !== 'rug') continue; // wall/ceiling items handled separately
    const depth = obbOutsideDepth(e.box, rm.poly);
    if (depth > 1) {
      out.push(V('error', 'OUT_OF_BOUNDS',
        `${e.item.name} extends ${Math.round(depth)}mm beyond the room outline.`, [e.id]));
    }
  }
  return out;
}

export function checkOverlaps(rm, ents, functional = []) {
  const out = [];
  const fkey = new Set(functional.map((f) => f.slice().sort().join('|')));
  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      const A = ents[i], B = ents[j];
      if (!A.collider || !B.collider) continue;
      if (fkey.has([A.id, B.id].sort().join('|'))) continue;
      const pen = obbPenetration(A.box, B.box);
      if (pen > 2) {
        out.push(V('error', 'OVERLAP',
          `${A.item.name} and ${B.item.name} overlap by ${Math.round(pen)}mm.`, [A.id, B.id]));
      }
    }
  }
  return out;
}

/** clearance_mm envelope per side; only front/back are enforced as errors-worthy. */
const EXPECTED_IN_FRONT = ['coffee_table', 'side_table', 'rug', 'ottoman', 'dining_chair', 'office_chair', 'nightstand'];

export function checkClearance(rm, ents, functional = []) {
  const out = [];
  const fkey = new Set(functional.map((f) => f.slice().sort().join('|')));
  for (const e of ents) {
    if (!e.collider) continue;
    const cl = e.item.clearance_mm || {};
    const front = cl.front || 0;
    if (front < 50) continue;
    const need = front;
    const fb = frontEnvelope(e.box, need);
    let worst = 0, other = null;
    for (const o of ents) {
      if (o === e || !o.collider) continue;
      if (fkey.has([e.id, o.id].sort().join('|'))) continue;
      if (EXPECTED_IN_FRONT.indexOf(o.arche) >= 0) continue;
      const pen = obbPenetration(fb, o.box);
      if (pen > worst) { worst = pen; other = o; }
    }
    // a wall in the clearance zone counts too
    const outside = obbOutsideDepth(fb, rm.poly);
    if (worst > 60) {
      out.push(V(worst > need * 0.6 ? 'warn' : 'info', 'CLEARANCE',
        `${e.item.name} needs ${need}mm in front; ${other.item.name} eats ${Math.round(worst)}mm of it.`,
        [e.id, other.id]));
    } else if (outside > 60 && !e.item.placement.against_wall) {
      out.push(V('info', 'CLEARANCE',
        `${e.item.name} sits ${Math.round(outside)}mm short of its ${need}mm front clearance against the wall.`, [e.id]));
    }
  }
  return out;
}

export function frontEnvelope(box, depth) {
  const f = frontAxis(box);
  return {
    cx: box.cx + f[0] * (box.d / 2 + depth / 2),
    cy: box.cy + f[1] * (box.d / 2 + depth / 2),
    w: box.w, d: depth, rot: box.rot,
  };
}

export function checkDoors(rm, ents) {
  const out = [];
  for (const d of rm.doors) {
    const apron = doorApron(d);
    const sw = doorSwing(d);
    for (const e of ents) {
      if (!e.collider) continue;
      const pa = obbPenetration(apron, e.box);
      if (pa > 20) {
        out.push(V('error', 'BLOCKS_DOOR',
          `${e.item.name} intrudes ${Math.round(pa)}mm into the ${RULES.DOOR_APRON_MM}mm entry apron of door ${d.id}.`, [e.id]));
        continue;
      }
      const ps = obbPenetration(sw.box, e.box);
      if (ps > 20) {
        const dist = obbGap({ cx: sw.hinge[0], cy: sw.hinge[1], w: 1, d: 1, rot: 0 }, e.box);
        if (dist < sw.radius - 20) {
          out.push(V('error', 'BLOCKS_DOOR',
            `${e.item.name} is inside the ${d.width_mm}mm swing arc of door ${d.id}.`, [e.id]));
        }
      }
    }
  }
  return out;
}

export function checkWindows(rm, ents) {
  const out = [];
  for (const w of rm.windows) {
    const sill = w.sill_mm || 0;
    if (sill >= RULES.LOW_WINDOW_SILL_MM) continue;
    const keep = openingKeepout(w, 200);
    for (const e of ents) {
      if (!e.collider) continue;
      if (e.h <= sill + 20) continue; // low enough to sit under the glass
      const pen = obbPenetration(keep, e.box);
      if (pen > 20) {
        out.push(V(e.h > sill + 400 ? 'warn' : 'info', 'BLOCKS_WINDOW',
          `${e.item.name} (${e.h}mm tall) stands in front of window ${w.id} whose sill is only ${sill}mm.`, [e.id]));
      }
    }
  }
  return out;
}

export function checkFeatures(rm, ents) {
  const out = [];
  for (const f of rm.features) {
    const blocking = f.type === 'radiator' || f.type === 'vent';
    if (!blocking) continue;
    const keep = openingKeepout({ wall: f.wall, mid: f.mid, width_mm: f.width_mm }, (f.depth_mm || 120) + RULES.FEATURE_KEEPOUT_MM);
    for (const e of ents) {
      if (!e.collider) continue;
      const pen = obbPenetration(keep, e.box);
      if (pen > 20) {
        out.push(V('warn', 'BLOCKS_RADIATOR',
          `${e.item.name} blocks ${f.type} ${f.id} by ${Math.round(pen)}mm.`, [e.id]));
      }
    }
  }
  return out;
}

export function checkWallSupport(rm, ents) {
  const out = [];
  for (const e of ents) {
    const pl = e.item.placement || {};
    const wantsWall = pl.against_wall || pl.wall_mounted;
    if (!wantsWall) continue;
    const backCentre = (() => {
      const f = frontAxis(e.box);
      return [e.box.cx - f[0] * e.box.d / 2, e.box.cy - f[1] * e.box.d / 2];
    })();
    const d = distToBoundary(backCentre[0], backCentre[1], rm.poly);
    const tol = (pl.wall_offset_mm || 40) + 120;
    if (d > tol) {
      out.push(V(pl.wall_mounted ? 'error' : 'warn', 'NO_WALL_SUPPORT',
        `${e.item.name} wants a wall behind it but its back is ${Math.round(d)}mm off the nearest wall.`, [e.id]));
    }
  }
  return out;
}

export function checkFloating(rm, ents) {
  const out = [];
  for (const e of ents) {
    const pl = e.item.placement || {};
    if (pl.against_wall || pl.wall_mounted || pl.ceiling_mounted || pl.center_ok) continue;
    if (e.arche === 'rug') continue;
    const dWall = distToBoundary(e.box.cx, e.box.cy, rm.poly);
    let near = Infinity;
    for (const o of ents) {
      if (o === e || !o.collider) continue;
      near = Math.min(near, obbGap(e.box, o.box));
    }
    if (dWall > 1500 && near > 1200) {
      out.push(V('info', 'FLOATING',
        `${e.item.name} floats with no wall or neighbour within 1.2m — it will read as adrift.`, [e.id]));
    }
  }
  return out;
}

export function checkTv(rm, ents) {
  const out = [];
  const tvs = ents.filter((e) => e.arche === 'tv');
  const sofas = ents.filter((e) => isSofa(e.arche));
  for (const tv of tvs) {
    const diag = Math.hypot(tv.item.dims_mm.w, tv.item.dims_mm.h);
    const mount = tv.item.placement || {};
    const centreH = mount.wall_mounted && mount.mount_h_mm != null
      ? mount.mount_h_mm + tv.item.dims_mm.h / 2
      : null;
    if (centreH != null && (centreH < RULES.TV_CENTRE_MIN_MM || centreH > RULES.TV_CENTRE_MAX_MM)) {
      out.push(V('warn', 'CLEARANCE',
        `${tv.item.name} screen centre sits at ${Math.round(centreH)}mm; the comfortable band is ${RULES.TV_CENTRE_MIN_MM}\u2013${RULES.TV_CENTRE_MAX_MM}mm.`, [tv.id]));
    }
    if (!sofas.length) continue;
    let best = null;
    for (const s of sofas) {
      const dist = Math.hypot(s.box.cx - tv.box.cx, s.box.cy - tv.box.cy);
      if (!best || dist < best.dist) best = { s, dist };
    }
    const lo = diag * RULES.TV_DIST_MIN_FACTOR, hi = diag * RULES.TV_DIST_MAX_FACTOR;
    if (best.dist < lo) {
      out.push(V('warn', 'TV_TOO_CLOSE',
        `${Math.round(best.dist)}mm from ${best.s.item.name} to ${tv.item.name}; ${Math.round(lo)}mm is the closest comfortable seat for a ${Math.round(diag)}mm diagonal.`, [tv.id, best.s.id]));
    } else if (best.dist > hi) {
      out.push(V('warn', 'TV_TOO_FAR',
        `${Math.round(best.dist)}mm from ${best.s.item.name} to ${tv.item.name}; beyond ${Math.round(hi)}mm the screen reads too small.`, [tv.id, best.s.id]));
    }
  }
  return out;
}

export function checkCoffeeTable(rm, ents) {
  const out = [];
  const sofas = ents.filter((e) => isSofa(e.arche));
  const cts = ents.filter((e) => e.arche === 'coffee_table');
  for (const ct of cts) {
    if (!sofas.length) continue;
    let best = null;
    for (const s of sofas) {
      const g = obbGap(s.box, ct.box);
      if (!best || g < best.g) best = { s, g };
    }
    if (best.g < RULES.COFFEE_TABLE_MIN_MM - 1) {
      out.push(V('warn', 'CLEARANCE',
        `${ct.item.name} is ${Math.round(best.g)}mm from ${best.s.item.name}; keep ${RULES.COFFEE_TABLE_MIN_MM}\u2013${RULES.COFFEE_TABLE_MAX_MM}mm so knees clear.`, [ct.id, best.s.id]));
    } else if (best.g > RULES.COFFEE_TABLE_MAX_MM + 1) {
      out.push(V('warn', 'CLEARANCE',
        `${ct.item.name} is ${Math.round(best.g)}mm from ${best.s.item.name}; past ${RULES.COFFEE_TABLE_MAX_MM}mm you have to stand up to reach it.`, [ct.id, best.s.id]));
    }
  }
  return out;
}

export function checkBed(rm, ents) {
  const out = [];
  for (const b of ents.filter((e) => isBed(e.arche))) {
    // headboard = local -v edge, must be against a wall
    const f = frontAxis(b.box);
    const head = [b.box.cx - f[0] * b.box.d / 2, b.box.cy - f[1] * b.box.d / 2];
    const dHead = distToBoundary(head[0], head[1], rm.poly);
    if (dHead > 200) {
      out.push(V('warn', 'NO_WALL_SUPPORT',
        `${b.item.name} headboard is ${Math.round(dHead)}mm off the wall; a bed needs a solid head wall.`, [b.id]));
    }
    if (!inFam(b.arche, 'bigBed')) continue;
    const wA = { name: 'left', axis: -1 }, wB = { name: 'right', axis: 1 };
    for (const side of [wA, wB]) {
      const env = sideEnvelope(b.box, side.axis, RULES.BED_ACCESS_MM);
      let worst = 0, who = null;
      for (const o of ents) {
        if (o === b || !o.collider) continue;
        if (o.arche === 'nightstand') continue; // nightstands are expected at the head
        const pen = obbPenetration(env, o.box);
        if (pen > worst) { worst = pen; who = o; }
      }
      const outside = obbOutsideDepth(env, rm.poly);
      const lost = Math.max(worst, outside);
      if (lost > 40) {
        out.push(V(lost > 300 ? 'error' : 'warn', 'UNREACHABLE',
          `Only ${Math.round(RULES.BED_ACCESS_MM - lost)}mm of access on the ${side.name} side of ${b.item.name}; ${RULES.BED_ACCESS_MM}mm is the minimum for a double or larger${who ? ` (blocked by ${who.item.name})` : ''}.`,
          who ? [b.id, who.id] : [b.id]));
      }
    }
  }
  return out;
}

export function sideEnvelope(box, dirU, depth) {
  const a = box.rot * D2R, ux = Math.cos(a), uy = Math.sin(a);
  return {
    cx: box.cx + ux * dirU * (box.w / 2 + depth / 2),
    cy: box.cy + uy * dirU * (box.w / 2 + depth / 2),
    w: depth, d: box.d, rot: box.rot,
  };
}

/** Rug must overlap the sofa's front legs by >= 200mm and never collide. */
export function checkRug(rm, ents) {
  const out = [];
  const rugs = ents.filter((e) => e.arche === 'rug');
  const sofas = ents.filter((e) => isSofa(e.arche));
  if (!rugs.length || !sofas.length) return out;
  for (const s of sofas) {
    let ok = false, bestOv = 0;
    for (const r of rugs) {
      const ov = frontLegOverlap(s.box, r.box);
      bestOv = Math.max(bestOv, ov);
      if (ov >= RULES.RUG_SOFA_OVERLAP_MM) ok = true;
    }
    if (!ok) {
      out.push(V('warn', 'CLEARANCE',
        `Rug overlaps the front legs of ${s.item.name} by only ${Math.round(bestOv)}mm; ${RULES.RUG_SOFA_OVERLAP_MM}mm is the minimum for the group to read as one zone.`,
        [s.id, ...rugs.map((r) => r.id)]));
    }
  }
  return out;
}

/** How far (mm, measured along the sofa's depth axis) the rug reaches under the front edge. */
export function frontLegOverlap(sofa, rug) {
  const hw = Math.max(0, sofa.w / 2 - 100);
  let worst = Infinity;
  for (const u of [-hw, hw]) {
    // walk inwards from the front edge until we leave the rug
    let reach = 0;
    for (let t = 0; t <= Math.min(sofa.d, 600); t += 10) {
      const [x, y] = local2world(sofa, u, sofa.d / 2 - t);
      const [lu, lv] = world2local(rug, x, y);
      if (Math.abs(lu) <= rug.w / 2 && Math.abs(lv) <= rug.d / 2) reach = t + 10;
      else break;
    }
    worst = Math.min(worst, reach);
  }
  return worst === Infinity ? 0 : worst;
}

export function checkDining(rm, ents) {
  const out = [];
  const tables = ents.filter((e) => isDiningTable(e.arche));
  const chairs = ents.filter((e) => e.arche === 'dining_chair');
  for (const t of tables) {
    const seats = chairs.filter((c) => Math.hypot(c.box.cx - t.box.cx, c.box.cy - t.box.cy)
      < Math.max(t.box.w, t.box.d) / 2 + 900).length;
    if (seats > 0) {
      const perim = t.item.footprint === 'round'
        ? Math.PI * t.box.w
        : 2 * (t.box.w + t.box.d);
      const per = perim / seats;
      if (per < RULES.DINING_EDGE_PER_SEAT_MM - 1) {
        out.push(V('warn', 'CLEARANCE',
          `${seats} seats at ${t.item.name} leaves ${Math.round(per)}mm of table edge each; ${RULES.DINING_EDGE_PER_SEAT_MM}mm is the minimum place setting.`, [t.id]));
      }
    }
    for (const c of chairs) {
      const dist = Math.hypot(c.box.cx - t.box.cx, c.box.cy - t.box.cy);
      if (dist > Math.max(t.box.w, t.box.d) / 2 + 900) continue;
      const env = frontEnvelope({ ...c.box, rot: c.box.rot + 180 }, RULES.DINING_CIRCULATION_MM - c.box.d);
      const outside = obbOutsideDepth(env, rm.poly);
      let worst = outside, who = null;
      for (const o of ents) {
        if (o === c || o === t || !o.collider || o.arche === 'dining_chair') continue;
        const pen = obbPenetration(env, o.box);
        if (pen > worst) { worst = pen; who = o; }
      }
      if (worst > 80) {
        out.push(V('warn', 'CLEARANCE',
          `Chair at ${t.item.name} has ${Math.round(RULES.DINING_CIRCULATION_MM - worst)}mm to pull out and pass behind; ${RULES.DINING_CIRCULATION_MM}mm is the rule${who ? ` (blocked by ${who.item.name})` : ''}.`,
          who ? [c.id, who.id] : [c.id]));
      }
    }
  }
  return out;
}

/** Wall-hung and ceiling items must still not cut through an opening. */
export function checkMountedVsOpenings(rm, ents) {
  const out = [];
  for (const e of ents) {
    const pl = e.item.placement || {};
    if (!pl.wall_mounted) continue;
    for (const o of rm.openings) {
      const face = { cx: o.mid[0], cy: o.mid[1], w: o.width_mm, d: 60, rot: o.wall.rot_deg };
      if (obbPenetration(face, { ...e.box, d: 120 }) > 20) {
        const mount = pl.mount_h_mm || 0;
        const zTop = mount + e.h, zBot = mount;
        const oBot = o.sill_mm || 0, oTop = oBot + o.height_mm;
        if (zTop > oBot && zBot < oTop) {
          out.push(V('error', o.type === 'door' ? 'BLOCKS_DOOR' : 'BLOCKS_WINDOW',
            `${e.item.name} is mounted across ${o.type} ${o.id}.`, [e.id]));
        }
      }
    }
  }
  return out;
}

/** Full rule sweep. `functional` lists id-pairs that are intentionally close. */
export function checkAll(rm, ents, functional = []) {
  return [
    ...checkBounds(rm, ents),
    ...checkOverlaps(rm, ents, functional),
    ...checkDoors(rm, ents),
    ...checkWindows(rm, ents),
    ...checkFeatures(rm, ents),
    ...checkWallSupport(rm, ents),
    ...checkMountedVsOpenings(rm, ents),
    ...checkClearance(rm, ents, functional),
    ...checkCoffeeTable(rm, ents),
    ...checkTv(rm, ents),
    ...checkBed(rm, ents),
    ...checkRug(rm, ents),
    ...checkDining(rm, ents),
    ...checkFloating(rm, ents),
  ];
}

export const SEVERITY_WEIGHT = { error: 0.22, warn: 0.055, info: 0.012 };

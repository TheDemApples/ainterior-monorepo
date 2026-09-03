// packages/three-editor/room.js
// Walls / floor / baseboards / real door+window openings from a Room polygon (SPEC §4.4).
// All input mm, all output metres (SPEC §1). Plan -> three: x = px/1000, z = -py/1000.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { TOKENS } from './materials.js';

const MM = 1 / 1000;
export const DEFAULT_WALL_T_MM = 100;
const BASEBOARD_H = 92;   // mm
const BASEBOARD_T = 16;   // mm

export function planToThree(x_mm, y_mm, elev_mm = 0) {
  return new THREE.Vector3(x_mm * MM, elev_mm * MM, -y_mm * MM);
}

/** Signed area *2; >0 means CCW in plan coords (x right, y up). */
export function polygonArea2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

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

/** Per-wall geometry description in plan mm. */
export function wallFrames(room) {
  const poly = room.polygon_mm;
  const ccw = polygonArea2(poly) > 0;
  const pts = ccw ? poly : poly.slice().reverse();
  const frames = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    frames.push({
      index: i,
      a, b, len,
      u: [ux, uy],
      nIn: [-uy, ux],   // interior side for CCW
      nOut: [uy, -ux],
      angle: Math.atan2(dy, dx),
    });
  }
  // If the caller's polygon was CW we reversed it; opening wall_index refers to
  // the ORIGINAL edge order, so remap.
  if (!ccw) {
    const n = poly.length;
    frames.forEach((f, i) => { f.origIndex = (n - 2 - i + n) % n; });
  } else {
    frames.forEach((f) => { f.origIndex = f.index; });
  }
  return frames;
}

export function roomBounds(room) {
  const xs = room.polygon_mm.map((p) => p[0]);
  const ys = room.polygon_mm.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    get w() { return this.maxX - this.minX; },
    get d() { return this.maxY - this.minY; },
    get cx() { return (this.minX + this.maxX) / 2; },
    get cy() { return (this.minY + this.maxY) / 2; },
  };
}

/**
 * Build the room shell.
 * @returns {{group, walls:[{index,group,frame,material,centerThree,normalThree}],
 *            floor, bounds, frames, height_mm, wallT_mm, dispose}}
 */
export function buildRoom(room, mats, opts = {}) {
  const H = room.height_mm || 2600;
  const T = opts.wallThickness_mm || room.wall_thickness_mm || DEFAULT_WALL_T_MM;
  const group = new THREE.Group();
  group.name = 'room';
  const frames = wallFrames(room);
  const bounds = roomBounds(room);
  const geoms = [];

  // ---------------- floor ----------------
  const shape = new THREE.Shape(
    (polygonArea2(room.polygon_mm) > 0 ? room.polygon_mm : room.polygon_mm.slice().reverse())
      .map((p) => new THREE.Vector2(p[0] * MM, p[1] * MM))
  );
  const floorGeom = new THREE.ShapeGeometry(shape);
  floorGeom.rotateX(-Math.PI / 2);   // plan y -> -three.z
  geoms.push(floorGeom);
  const floor = new THREE.Mesh(floorGeom, mats.shell.floor);
  floor.name = 'floor';
  floor.receiveShadow = true;
  group.add(floor);

  // ---------------- floor grid (clipped to the polygon) ----------------
  const gridPts = [];
  const step = 500;
  const poly = room.polygon_mm;
  for (let x = Math.ceil(bounds.minX / step) * step; x <= bounds.maxX; x += step) {
    let run = null;
    for (let y = bounds.minY; y <= bounds.maxY + 1; y += 100) {
      const inside = pointInPolygon([x, Math.min(y, bounds.maxY)], poly);
      if (inside && run === null) run = y;
      else if (!inside && run !== null) { gridPts.push(planToThree(x, run, 2), planToThree(x, y, 2)); run = null; }
    }
    if (run !== null) gridPts.push(planToThree(x, run, 2), planToThree(x, bounds.maxY, 2));
  }
  for (let y = Math.ceil(bounds.minY / step) * step; y <= bounds.maxY; y += step) {
    let run = null;
    for (let x = bounds.minX; x <= bounds.maxX + 1; x += 100) {
      const inside = pointInPolygon([Math.min(x, bounds.maxX), y], poly);
      if (inside && run === null) run = x;
      else if (!inside && run !== null) { gridPts.push(planToThree(run, y, 2), planToThree(x, y, 2)); run = null; }
    }
    if (run !== null) gridPts.push(planToThree(run, y, 2), planToThree(bounds.maxX, y, 2));
  }
  if (gridPts.length) {
    const gg = new THREE.BufferGeometry().setFromPoints(gridPts);
    geoms.push(gg);
    const grid = new THREE.LineSegments(gg, mats.lineMat('#FFFFFF', 0.055));
    grid.name = 'grid';
    group.add(grid);
  }

  // ---------------- walls ----------------
  const openings = (room.openings || []).slice();
  const walls = [];

  for (const f of frames) {
    const wallGroup = new THREE.Group();
    wallGroup.name = 'wall-' + f.origIndex;
    const wallMat = mats.shell.wall.clone();
    wallMat.transparent = true;

    const mine = openings
      .filter((o) => (o.wall_index | 0) === f.origIndex)
      .map((o) => ({
        ...o,
        s0: Math.max(0, o.offset_mm || 0),
        s1: Math.min(f.len, (o.offset_mm || 0) + (o.width_mm || 0)),
        sill: Math.max(0, o.sill_mm || 0),
        top: Math.min(H, (o.sill_mm || 0) + (o.height_mm || 0)),
      }))
      .filter((o) => o.s1 > o.s0)
      .sort((a, b) => a.s0 - b.s0);

    const addSlab = (s, len, zBot, zTop, mat) => {
      if (len <= 1 || zTop - zBot <= 1) return null;
      const g = new THREE.BoxGeometry(len * MM, (zTop - zBot) * MM, T * MM);
      geoms.push(g);
      const m = new THREE.Mesh(g, mat || wallMat);
      const cs = s + len / 2;
      const px = f.a[0] + f.u[0] * cs + f.nOut[0] * (T / 2);
      const py = f.a[1] + f.u[1] * cs + f.nOut[1] * (T / 2);
      m.position.copy(planToThree(px, py, (zBot + zTop) / 2));
      // wall runs along plan u; three yaw = +plan angle (CCW, SPEC §1)
      m.rotation.y = f.angle;
      m.receiveShadow = true;
      wallGroup.add(m);
      return m;
    };

    // extend the slab past both ends by T so corners mitre visually
    let cursor = -T;
    for (const o of mine) {
      addSlab(cursor, o.s0 - cursor, 0, H);
      if (o.sill > 1) addSlab(o.s0, o.s1 - o.s0, 0, o.sill, mats.shell.reveal);      // window sill wall
      if (o.top < H - 1) addSlab(o.s0, o.s1 - o.s0, o.top, H, mats.shell.reveal);    // lintel
      if (o.type === 'window') {
        const g = new THREE.BoxGeometry((o.s1 - o.s0) * MM * 0.96, (o.top - o.sill) * MM * 0.96, T * MM * 0.25);
        geoms.push(g);
        const pane = new THREE.Mesh(g, mats.shell.glassPane);
        const cs = (o.s0 + o.s1) / 2;
        pane.position.copy(planToThree(
          f.a[0] + f.u[0] * cs + f.nOut[0] * (T / 2),
          f.a[1] + f.u[1] * cs + f.nOut[1] * (T / 2),
          (o.sill + o.top) / 2
        ));
        pane.rotation.y = f.angle;
        wallGroup.add(pane);
      }
      cursor = o.s1;
    }
    addSlab(cursor, f.len + T - cursor, 0, H);

    // ---------------- baseboard (skips door openings) ----------------
    const doorRuns = mine.filter((o) => o.sill < 100);
    let bc = 0;
    const bbSegs = [];
    for (const o of doorRuns) { bbSegs.push([bc, o.s0]); bc = o.s1; }
    bbSegs.push([bc, f.len]);
    for (const [s, e] of bbSegs) {
      const len = e - s;
      if (len <= 2) continue;
      const g = new THREE.BoxGeometry(len * MM, BASEBOARD_H * MM, BASEBOARD_T * MM);
      geoms.push(g);
      const m = new THREE.Mesh(g, mats.shell.baseboard);
      const cs = s + len / 2;
      m.position.copy(planToThree(
        f.a[0] + f.u[0] * cs + f.nIn[0] * (BASEBOARD_T / 2),
        f.a[1] + f.u[1] * cs + f.nIn[1] * (BASEBOARD_T / 2),
        BASEBOARD_H / 2
      ));
      m.rotation.y = f.angle;
      wallGroup.add(m);
    }

    group.add(wallGroup);
    const cs = f.len / 2;
    walls.push({
      index: f.origIndex,
      frame: f,
      group: wallGroup,
      material: wallMat,
      centerThree: planToThree(
        f.a[0] + f.u[0] * cs + f.nOut[0] * (T / 2),
        f.a[1] + f.u[1] * cs + f.nOut[1] * (T / 2),
        H / 2
      ),
      normalThree: new THREE.Vector3(f.nOut[0], 0, -f.nOut[1]).normalize(),
    });
  }

  // ---------------- door swing arcs on the floor ----------------
  const swingGroup = new THREE.Group();
  swingGroup.name = 'door-swings';
  for (const o of openings) {
    if (o.type !== 'door') continue;
    const f = frames.find((fr) => fr.origIndex === (o.wall_index | 0));
    if (!f) continue;
    const w = o.width_mm || 800;
    const s0 = o.offset_mm || 0;
    const swing = o.swing || 'in-left';
    const inward = !swing.startsWith('out');
    const nrm = inward ? f.nIn : f.nOut;
    const left = swing.endsWith('left');
    const hs = left ? s0 : s0 + w;      // hinge position along the wall
    const dirSign = left ? 1 : -1;      // closed leaf points along +u from a left hinge
    const hx = f.a[0] + f.u[0] * hs, hy = f.a[1] + f.u[1] * hs;
    const pts = [];
    const closed = [f.u[0] * dirSign, f.u[1] * dirSign];
    const steps = 18;
    // rotate from the closed direction toward the swing normal over 90deg
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, a = (Math.PI / 2) * t;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = closed[0] * ca + nrm[0] * sa;
      const dy = closed[1] * ca + nrm[1] * sa;
      const l = Math.hypot(dx, dy) || 1;
      pts.push(planToThree(hx + (dx / l) * w, hy + (dy / l) * w, 4));
    }
    const arcG = new THREE.BufferGeometry().setFromPoints(pts);
    geoms.push(arcG);
    swingGroup.add(new THREE.Line(arcG, mats.lineMat(TOKENS.blueprint, 0.75)));
    const legG = new THREE.BufferGeometry().setFromPoints([
      planToThree(hx, hy, 4), pts[0].clone(),
      planToThree(hx, hy, 4), pts[pts.length - 1].clone(),
    ]);
    geoms.push(legG);
    swingGroup.add(new THREE.LineSegments(legG, mats.lineMat(TOKENS.blueprint, 0.55)));
    // the leaf itself, standing open
    const leafG = new THREE.BoxGeometry(w * MM, (o.height_mm || 2040) * MM, 38 * MM);
    geoms.push(leafG);
    const leaf = new THREE.Mesh(leafG, mats.shell.baseboard);
    const openDir = [nrm[0], nrm[1]];
    leaf.position.copy(planToThree(hx + openDir[0] * (w / 2), hy + openDir[1] * (w / 2), (o.height_mm || 2040) / 2));
    leaf.rotation.y = Math.atan2(openDir[1], openDir[0]);
    swingGroup.add(leaf);
  }
  group.add(swingGroup);

  // ---------------- features (radiators etc.) ----------------
  for (const ft of room.features || []) {
    const f = frames.find((fr) => fr.origIndex === (ft.wall_index | 0));
    if (!f) continue;
    const fw = ft.width_mm || 800, fd = ft.depth_mm || 120;
    const h = ft.type === 'radiator' ? 580 : (room.height_mm || 2600);
    const g = new THREE.BoxGeometry(fw * MM, h * MM, fd * MM);
    geoms.push(g);
    const m = new THREE.Mesh(g, mats.get('metal'));
    const cs = (ft.offset_mm || 0) + fw / 2;
    m.position.copy(planToThree(
      f.a[0] + f.u[0] * cs + f.nIn[0] * (fd / 2),
      f.a[1] + f.u[1] * cs + f.nIn[1] * (fd / 2),
      ft.type === 'radiator' ? 90 + h / 2 : h / 2
    ));
    m.rotation.y = f.angle;
    m.userData.feature = ft;
    group.add(m);
  }

  // ---------------- interior walls (SPEC2 §G2) ----------------
  // Multi-room floorplans from packages/floorplan emit one `interior_wall` per
  // shared room edge. Without this the studio drew only the outer envelope, so a
  // 2-bed apartment rendered as a single empty box. Interior walls are centred on
  // their edge (exterior walls sit offset outward by T/2) and get baseboards on
  // both faces.
  for (const iw of (room.interior_walls || [])) {
    if (!iw || !Array.isArray(iw.a) || !Array.isArray(iw.b)) continue;
    const len = Math.hypot(iw.b[0] - iw.a[0], iw.b[1] - iw.a[1]);
    if (len < 1) continue;
    const u = [(iw.b[0] - iw.a[0]) / len, (iw.b[1] - iw.a[1]) / len];
    const n = [-u[1], u[0]];
    const angle = Math.atan2(u[1], u[0]);
    const iT = iw.thickness_mm || Math.max(60, Math.round(T * 0.55));

    const wallGroup = new THREE.Group();
    wallGroup.name = 'interior-wall-' + (iw.id || walls.length);
    const wallMat = mats.shell.wall.clone();
    wallMat.transparent = true;

    const mine = (iw.openings || [])
      .map((o) => ({
        ...o,
        s0: Math.max(0, o.offset_mm || 0),
        s1: Math.min(len, (o.offset_mm || 0) + (o.width_mm || 0)),
        sill: Math.max(0, o.sill_mm || 0),
        top: Math.min(H, (o.sill_mm || 0) + (o.height_mm || 0)),
      }))
      .filter((o) => o.s1 > o.s0)
      .sort((x, y) => x.s0 - y.s0);

    const addSlab = (s, l, zBot, zTop, mat) => {
      if (l <= 1 || zTop - zBot <= 1) return;
      const g = new THREE.BoxGeometry(l * MM, (zTop - zBot) * MM, iT * MM);
      geoms.push(g);
      const m = new THREE.Mesh(g, mat || wallMat);
      const cs = s + l / 2;
      m.position.copy(planToThree(
        iw.a[0] + u[0] * cs, iw.a[1] + u[1] * cs, (zBot + zTop) / 2,
      ));
      m.rotation.y = angle;
      m.castShadow = true;
      m.receiveShadow = true;
      wallGroup.add(m);
    };

    let cursor = 0;
    for (const o of mine) {
      addSlab(cursor, o.s0 - cursor, 0, H);
      if (o.sill > 1) addSlab(o.s0, o.s1 - o.s0, 0, o.sill, mats.shell.reveal);
      if (o.top < H - 1) addSlab(o.s0, o.s1 - o.s0, o.top, H, mats.shell.reveal);
      cursor = o.s1;
    }
    addSlab(cursor, len - cursor, 0, H);

    // baseboards, both faces, skipping door runs
    const doorRuns = mine.filter((o) => o.sill < 100);
    for (const side of [1, -1]) {
      let bc = 0;
      const segs = [];
      for (const o of doorRuns) { segs.push([bc, o.s0]); bc = o.s1; }
      segs.push([bc, len]);
      for (const [s, e] of segs) {
        const l = e - s;
        if (l <= 2) continue;
        const g = new THREE.BoxGeometry(l * MM, BASEBOARD_H * MM, BASEBOARD_T * MM);
        geoms.push(g);
        const m = new THREE.Mesh(g, mats.shell.baseboard);
        const cs = s + l / 2;
        m.position.copy(planToThree(
          iw.a[0] + u[0] * cs + n[0] * side * (iT / 2 + BASEBOARD_T / 2),
          iw.a[1] + u[1] * cs + n[1] * side * (iT / 2 + BASEBOARD_T / 2),
          BASEBOARD_H / 2,
        ));
        m.rotation.y = angle;
        wallGroup.add(m);
      }
    }

    // door swing arc on the floor, matching the exterior-wall treatment
    for (const o of doorRuns) {
      const r = o.s1 - o.s0;
      const pts = [];
      const hinge = [iw.a[0] + u[0] * o.s0, iw.a[1] + u[1] * o.s0];
      for (let i = 0; i <= 16; i++) {
        const t = (i / 16) * (Math.PI / 2);
        pts.push(planToThree(
          hinge[0] + u[0] * Math.cos(t) * r + n[0] * Math.sin(t) * r,
          hinge[1] + u[1] * Math.cos(t) * r + n[1] * Math.sin(t) * r,
          4,
        ));
      }
      const ag = new THREE.BufferGeometry().setFromPoints(pts);
      geoms.push(ag);
      wallGroup.add(new THREE.Line(ag, mats.lineMat('#FFFFFF', 0.16)));
    }

    group.add(wallGroup);
    const cs = len / 2;
    walls.push({
      index: walls.length,
      origIndex: -1,
      interior: true,
      group: wallGroup,
      frame: { a: iw.a, b: iw.b, u, nIn: n, nOut: [-n[0], -n[1]], len, angle },
      material: wallMat,
      centerThree: planToThree(iw.a[0] + u[0] * cs, iw.a[1] + u[1] * cs, H / 2),
      normalThree: new THREE.Vector3(n[0], 0, -n[1]).normalize(),
    });
  }

  // ---------------- per-room floor materials (SPEC2 §G2) ----------------
  // Distinct flooring is what makes adjoining rooms read as separate spaces.
  if (Array.isArray(room.rooms) && room.rooms.length && mats.floorMaterial) {
    for (const r of room.rooms) {
      if (!r || !Array.isArray(r.polygon_mm) || r.polygon_mm.length < 3) continue;
      const mat = mats.floorMaterial(r.floor_material || 'oak');
      if (!mat) continue;
      const ring = polygonArea2(r.polygon_mm) > 0 ? r.polygon_mm : r.polygon_mm.slice().reverse();
      const sh = new THREE.Shape(ring.map((p) => new THREE.Vector2(p[0] * MM, p[1] * MM)));
      const g = new THREE.ShapeGeometry(sh);
      g.rotateX(-Math.PI / 2);
      geoms.push(g);
      const m = new THREE.Mesh(g, mat);
      m.name = 'floor:' + (r.id || r.name || '');
      m.position.y = 0.0015;              // just above the base floor, no z-fighting
      m.receiveShadow = true;
      group.add(m);
    }
  }

  return {
    group, floor, walls, frames, bounds,
    height_mm: H, wallT_mm: T,
    openings: room.openings || [],
    interior_walls: room.interior_walls || [],
    dispose() {
      geoms.forEach((g) => g.dispose());
      walls.forEach((w) => w.material.dispose());
      group.clear();
    },
  };
}

export default buildRoom;

// packages/three-editor/mesh-import.js
// Import, clean and SCALE a photogrammetry / image-to-3D mesh so it can become
// a real ainterior `user_item` (SPEC §4.1).
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Image-to-3D models (Hunyuan3D-2.1 et al.) hand you a mesh with two defects
// that make it unusable for a dimensionally-honest interior planner:
//
//   1. A GROUND PLANE IS BAKED IN. Even with background removal enabled, the
//      floor/shadow under the subject is reconstructed as a large flat slab.
//      Measured on our test chair: overall bbox [1.9868, 0.5387, 1.9861] --
//      the slab dominates X and Z while the chair is a small part of it.
//      `stripGroundPlane()` finds and deletes it.
//
//   2. THERE IS NO REAL-WORLD SCALE. Output is normalised to ~unit size.
//      SPEC §8.8 forbids inventing a measurement, so we NEVER guess. Either
//      the user supplies one real dimension (`fitToDimension`) and we report
//      `scale_confidence:'user-measured'`, or we report `'unscaled'` and
//      `dims_mm: null`.
//
// ─── UNITS (SPEC §1) ─────────────────────────────────────────────────────────
// Three.js scene = METRES (floats). Stored data = MILLIMETRES (integers).
// Everything crossing the boundary goes through mm2m/m2mm and Math.round().
//
// ─── IMPORTMAP REQUIREMENT (read this before you debug a blank screen) ───────
// GLTFLoader imports the BARE specifier 'three'. A browser cannot resolve that
// on its own, so ANY page loading this module MUST declare an importmap BEFORE
// the module script, using the pinned 0.169.0 build (SPEC §8.2):
//
//   <script type="importmap">
//   {
//     "imports": {
//       "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
//       "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
//     }
//   }
//   </script>
//   <script type="module" src="./app.js"></script>
//
// Without it you get: "Failed to resolve module specifier \"three\"".

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const mm2m = (mm) => mm / 1000;
export const m2mm = (m) => m * 1000;

/** Tunables for slab detection. Exported so callers can tighten per-domain. */
export const GROUND_PLANE_DEFAULTS = {
  // A component is "planar" when its thinnest axis is <= this fraction of its
  // largest axis. A floor slab is extremely flat; a chair never is.
  flatnessRatio: 0.12,
  // A component "sits on the floor" when its bottom is within this fraction of
  // the whole mesh's height of the global minimum.
  bottomBandFrac: 0.10,
  // A component is "big" when its XZ footprint covers at least this fraction
  // of the whole mesh's XZ footprint area.
  footprintFrac: 0.35,
  // Safety net: never delete so much that NOTHING is left.
  // Deliberately low: on real Hunyuan3D output the floor slab is genuinely
  // ~87% of the triangles (measured: 285,835 of 297,684 on the test chair),
  // so a high fraction here would reject every legitimate removal. The
  // absolute floor below is what actually protects against wiping the mesh.
  minSurvivingTriFrac: 0.02,
  minSurvivingTris: 200,
  // Vertex welding grid, as a fraction of the mesh diagonal.
  weldFrac: 1e-4,

  // ── stage B (fused slab carve) ──
  // XZ grid resolution across the larger horizontal extent.
  gridN: 192,
  // A column counts as "object" when its vertical extent is at least this
  // fraction of the tallest column in the mesh.
  columnThickFrac: 0.15,
  // ...and at least this fraction of the whole mesh height (absolute floor).
  minColumnAbsFrac: 0.05,
  // Set false to disable the fused-slab carve entirely.
  carveFusedSlab: true,

  // ── stage C (floor-band shave) ──
  // The column carve keeps the floor that sits INSIDE the object's own
  // columns (the patch directly under the legs). Anything lying within this
  // fraction of the mesh height above the detected floor plane, and facing
  // up/down, is floor. Costs the bottom few mm of the legs, which is invisible
  // once the piece is recentred onto y=0.
  floorBandFrac: 0.03,
  // Only shave triangles this horizontal (|normal.y|), so vertical leg walls
  // that dip into the band survive.
  floorBandNormalY: 0.7,
  shaveFloorBand: true,
  // Guard for stage C, measured against what SURVIVED the carve -- not against
  // the original triangle count, which is dominated by the floor itself.
  minShaveSurvivalFrac: 0.4,
};

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. LOAD                                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * loadScannedMesh(source) -> Promise<THREE.Group>
 * @param {string|ArrayBuffer|Uint8Array} source  URL or raw .glb bytes.
 */
export function loadScannedMesh(source, { loader = new GLTFLoader() } = {}) {
  return new Promise((resolve, reject) => {
    const onDone = (gltf) => {
      const group = new THREE.Group();
      group.name = 'scanned-mesh';
      while (gltf.scene.children.length) group.add(gltf.scene.children[0]);
      group.updateMatrixWorld(true);
      resolve(group);
    };
    if (typeof source === 'string') {
      loader.load(source, onDone, undefined, reject);
    } else {
      const buf = source instanceof Uint8Array
        ? source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
        : source;
      loader.parse(buf, '', onDone, reject);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. GEOMETRY HELPERS                                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

function collectMeshes(group) {
  const out = [];
  group.updateMatrixWorld(true);
  group.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) out.push(o); });
  return out;
}

/** World-space bbox of a group. */
export function bboxOf(group) {
  const box = new THREE.Box3();
  const meshes = collectMeshes(group);
  if (!meshes.length) return box.makeEmpty();
  for (const m of meshes) box.expandByObject(m);
  return box;
}

/** Per-mesh world-space triangle soup: Float32Array of 9 floats per triangle. */
function triangleSoup(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const tris = new Float32Array(triCount * 9);
  const v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  const mw = mesh.matrixWorld;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      v.fromBufferAttribute(pos, vi).applyMatrix4(mw);
      tris[t * 9 + k * 3 + 0] = v.x;
      tris[t * 9 + k * 3 + 1] = v.y;
      tris[t * 9 + k * 3 + 2] = v.z;
    }
  }
  return { tris, triCount };
}

/** Union-find over welded vertices -> per-triangle component label. */
function connectedComponents(tris, triCount, weld) {
  const parent = new Int32Array(triCount * 3).fill(-1);
  const map = new Map();
  const ids = new Int32Array(triCount * 3);
  let next = 0;

  const inv = 1 / weld;
  for (let i = 0; i < triCount * 3; i++) {
    const x = Math.round(tris[i * 3 + 0] * inv);
    const y = Math.round(tris[i * 3 + 1] * inv);
    const z = Math.round(tris[i * 3 + 2] * inv);
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) { id = next++; map.set(key, id); }
    ids[i] = id;
  }

  const uf = new Int32Array(next);
  for (let i = 0; i < next; i++) uf[i] = i;
  const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) uf[rb] = ra; };

  for (let t = 0; t < triCount; t++) {
    const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
    union(a, b); union(b, c);
  }

  const label = new Int32Array(triCount);
  const rootToComp = new Map();
  let comps = 0;
  for (let t = 0; t < triCount; t++) {
    const r = find(ids[t * 3]);
    let c = rootToComp.get(r);
    if (c === undefined) { c = comps++; rootToComp.set(r, c); }
    label[t] = c;
  }
  void parent;
  return { label, comps };
}

/** Per-component stats in world space. */
function componentStats(tris, triCount, label, comps) {
  const s = Array.from({ length: comps }, () => ({
    tri: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  }));
  for (let t = 0; t < triCount; t++) {
    const c = s[label[t]];
    c.tri++;
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      for (let a = 0; a < 3; a++) {
        const val = tris[o + a];
        if (val < c.min[a]) c.min[a] = val;
        if (val > c.max[a]) c.max[a] = val;
      }
    }
  }
  for (const c of s) {
    c.size = [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]];
    c.footprint = c.size[0] * c.size[2];
  }
  return s;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. GROUND PLANE REMOVAL                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */
//
// TWO STAGES, because real output needs both.
//
// STAGE A — component slab: split into connected components and drop any that
//   is (a) planar, (b) at the bottom, (c) broad in footprint. This catches the
//   easy case where the floor is a detached sheet.
//
// STAGE B — FUSED slab: Hunyuan3D-2.1 emits a WATERTIGHT mesh, so on our test
//   chair the floor slab is welded to the chair and stage A finds exactly ONE
//   component (measured: components=1, bbox unchanged at [1.9868, 0.5387,
//   1.9861]). Component splitting can never work there. So we carve by
//   XZ-column thickness instead: bin every triangle into an XZ grid and record
//   each cell's vertical extent. A floor slab is a paper-thin sheet — its
//   columns have near-zero height — while any real object has tall columns.
//   Keep the flood-filled cluster of tall columns containing the tallest cell;
//   everything else is floor.
//
// Both stages are guarded: if what survives is too small, we keep the original
// mesh and report ground_plane_removed:false rather than returning nothing.

/** Stage B: mark triangles that belong to the tall-column cluster. */
function carveByColumnThickness(tris, triCount, keepMask, global, o) {
  const { minX, minZ, sizeX, sizeZ, height } = global;
  const span = Math.max(sizeX, sizeZ) || 1;
  const n = Math.max(24, Math.min(o.gridN, 384));
  const cell = span / n;
  const nx = Math.max(1, Math.ceil(sizeX / cell));
  const nz = Math.max(1, Math.ceil(sizeZ / cell));

  const cMin = new Float32Array(nx * nz).fill(Infinity);
  const cMax = new Float32Array(nx * nz).fill(-Infinity);
  const cCnt = new Int32Array(nx * nz);
  const triCell = new Int32Array(triCount).fill(-1);

  const cellOf = (x, z) => {
    let ix = Math.floor((x - minX) / cell); if (ix < 0) ix = 0; if (ix >= nx) ix = nx - 1;
    let iz = Math.floor((z - minZ) / cell); if (iz < 0) iz = 0; if (iz >= nz) iz = nz - 1;
    return iz * nx + ix;
  };

  for (let t = 0; t < triCount; t++) {
    if (!keepMask[t]) continue;
    const o9 = t * 9;
    const cx = (tris[o9] + tris[o9 + 3] + tris[o9 + 6]) / 3;
    const cz = (tris[o9 + 2] + tris[o9 + 5] + tris[o9 + 8]) / 3;
    const ci = cellOf(cx, cz);
    triCell[t] = ci;
    cCnt[ci]++;
    for (let k = 0; k < 3; k++) {
      const y = tris[o9 + k * 3 + 1];
      if (y < cMin[ci]) cMin[ci] = y;
      if (y > cMax[ci]) cMax[ci] = y;
    }
  }

  // tallest column anchors the object
  let best = -1, bestThick = 0;
  const thick = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) {
    if (!cCnt[i]) continue;
    thick[i] = cMax[i] - cMin[i];
    if (thick[i] > bestThick) { bestThick = thick[i]; best = i; }
  }
  if (best < 0 || bestThick <= 0) return { changed: false, kept: keepMask, cells: 0 };

  const thresh = Math.max(o.columnThickFrac * bestThick, o.minColumnAbsFrac * height);

  // flood fill 8-connected over "tall" cells from the tallest one
  const inCluster = new Uint8Array(nx * nz);
  const stack = [best];
  inCluster[best] = 1;
  let clusterCells = 1;
  while (stack.length) {
    const i = stack.pop();
    const ix = i % nx, iz = (i - ix) / nx;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const j = jz * nx + jx;
        if (inCluster[j] || !cCnt[j] || thick[j] < thresh) continue;
        inCluster[j] = 1; clusterCells++; stack.push(j);
      }
    }
  }

  const out = new Uint8Array(triCount);
  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keepMask[t]) continue;
    if (inCluster[triCell[t]]) { out[t] = 1; kept++; }
  }
  return { changed: true, kept: out, keptCount: kept, cells: clusterCells, thresh, bestThick, grid: [nx, nz] };
}

/**
 * Stage C: shave the residual floor that lives inside the object's own
 * columns. Returns a new mask, or null if it would remove too much.
 */
function shaveFloorBand(tris, triCount, keepMask, floorY, height, o) {
  const band = floorY + o.floorBandFrac * height;
  const out = new Uint8Array(triCount);
  let kept = 0, dropped = 0;
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    if (!keepMask[t]) continue;
    const o9 = t * 9;
    const y0 = tris[o9 + 1], y1 = tris[o9 + 4], y2 = tris[o9 + 7];
    const maxY = Math.max(y0, y1, y2);
    if (maxY <= band) {
      ax.set(tris[o9], y0, tris[o9 + 2]);
      bx.set(tris[o9 + 3], y1, tris[o9 + 5]);
      cx.set(tris[o9 + 6], y2, tris[o9 + 8]);
      e1.subVectors(bx, ax); e2.subVectors(cx, ax);
      nrm.crossVectors(e1, e2);
      const len = nrm.length() || 1;
      if (Math.abs(nrm.y / len) >= o.floorBandNormalY) { dropped++; continue; }
    }
    out[t] = 1; kept++;
  }
  return dropped ? { mask: out, kept, dropped } : null;
}

/**
 * stripGroundPlane(group, opts) -> report
 *
 * The survivor is recentred to the SPEC §4.1 proxy origin: footprint centre at
 * (0, ·, 0) with the lowest point resting on y = 0.
 */
export function stripGroundPlane(group, opts = {}) {
  const o = { ...GROUND_PLANE_DEFAULTS, ...opts };
  const meshes = collectMeshes(group);
  const before = bboxOf(group);
  const report = {
    group,
    ground_plane_removed: false,
    method: null,
    reason: null,
    bbox_before: boxToPlain(before),
    bbox_after: null,
    removed_components: 0,
    removed_triangles: 0,
    total_triangles: 0,
    components: 0,
  };
  if (!meshes.length || before.isEmpty()) { report.reason = 'empty mesh'; return report; }

  const gSize = before.getSize(new THREE.Vector3());
  const diag = gSize.length() || 1;
  const weld = Math.max(diag * o.weldFrac, 1e-7);
  const globalMinY = before.min.y;
  const globalFootprint = Math.max(gSize.x * gSize.z, 1e-9);
  const bottomBand = globalMinY + gSize.y * o.bottomBandFrac;
  const globalGrid = {
    minX: before.min.x, minZ: before.min.z,
    sizeX: gSize.x, sizeZ: gSize.z, height: gSize.y,
  };

  const perMesh = [];
  let totalTri = 0, doomedTri = 0, doomedComps = 0, compCount = 0;
  let usedCarve = false, shavedTri = 0;

  for (const mesh of meshes) {
    const { tris, triCount } = triangleSoup(mesh);
    const { label, comps } = connectedComponents(tris, triCount, weld);
    const stats = componentStats(tris, triCount, label, comps);
    compCount += comps;
    totalTri += triCount;

    // ---- STAGE A: detached planar floor components ----
    const kill = new Uint8Array(comps);
    stats.forEach((c, i) => {
      const sorted = [...c.size].sort((a, b) => a - b);
      const isPlanar = sorted[0] <= o.flatnessRatio * (sorted[2] || 1e-9);
      const isLow = c.min[1] <= bottomBand;
      const isBroad = c.footprint >= o.footprintFrac * globalFootprint;
      if (isPlanar && isLow && isBroad) { kill[i] = 1; doomedComps++; doomedTri += c.tri; }
    });

    let keepMask = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) keepMask[t] = kill[label[t]] ? 0 : 1;

    // ---- STAGE B: fused floor slab, carved by XZ column thickness ----
    let carve = null;
    if (o.carveFusedSlab !== false) {
      carve = carveByColumnThickness(tris, triCount, keepMask, globalGrid, o);
      if (carve.changed) {
        const survivors = carve.keptCount;
        const basis = totalTriOf(keepMask);
        // only accept the carve if it actually removed something meaningful
        // AND left a healthy object behind
        if (survivors >= Math.max(o.minSurvivingTris, o.minSurvivingTriFrac * triCount)
            && survivors < basis * 0.995) {
          keepMask = carve.kept;
          usedCarve = true;
        }
      }
    }

    // ---- STAGE C: shave the floor patch left inside the object's columns ----
    if (o.shaveFloorBand) {
      const survivorsBefore = totalTriOf(keepMask);
      const shaved = shaveFloorBand(tris, triCount, keepMask, globalMinY, gSize.y, o);
      // NOTE: the guard is relative to survivorsBefore. Comparing against the
      // raw triCount would reject legitimate shaves, because after the carve
      // the object is only ~17% of the original triangles.
      if (shaved && shaved.kept >= o.minShaveSurvivalFrac * survivorsBefore) {
        keepMask = shaved.mask;
        shavedTri += shaved.dropped;
      }
    }
    perMesh.push({ mesh, tris, triCount, keepMask });
  }

  report.total_triangles = totalTri;
  report.components = compCount;

  let survivingTotal = 0;
  for (const pm of perMesh) survivingTotal += totalTriOf(pm.keepMask);

  if (survivingTotal === totalTri) {
    report.reason = 'no floor slab detected (no planar bottom component, no thin-column region)';
    finishRecentre(group, report);
    return report;
  }
  if (survivingTotal < Math.max(o.minSurvivingTris, o.minSurvivingTriFrac * totalTri)) {
    report.reason = `refused: removal would leave only ${survivingTotal} triangles `
      + `(${(100 * survivingTotal / totalTri).toFixed(1)}%) -- keeping the original mesh`;
    finishRecentre(group, report);
    return report;
  }

  for (const pm of perMesh) {
    const keep = [];
    for (let t = 0; t < pm.triCount; t++) if (pm.keepMask[t]) keep.push(t);
    if (keep.length === pm.triCount) continue;
    if (!keep.length) { pm.mesh.parent?.remove(pm.mesh); continue; }

    const positions = new Float32Array(keep.length * 9);
    for (let i = 0; i < keep.length; i++) {
      positions.set(pm.tris.subarray(keep[i] * 9, keep[i] * 9 + 9), i * 9);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    pm.mesh.geometry.dispose?.();
    pm.mesh.geometry = geo;           // positions are WORLD space...
    pm.mesh.position.set(0, 0, 0);    // ...so neutralise the old transform
    pm.mesh.quaternion.identity();
    pm.mesh.scale.set(1, 1, 1);
    pm.mesh.updateMatrixWorld(true);
  }

  group.updateMatrixWorld(true);
  report.ground_plane_removed = true;
  report.method = [doomedComps ? 'component' : null, usedCarve ? 'column-carve' : null,
                   shavedTri ? 'floor-band-shave' : null].filter(Boolean).join('+') || 'none';
  report.shaved_triangles = shavedTri;
  report.removed_components = doomedComps;
  report.removed_triangles = totalTri - survivingTotal;
  report.reason = `removed ${totalTri - survivingTotal} floor triangles via ${report.method}`;
  finishRecentre(group, report);
  return report;
}

function totalTriOf(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Footprint centre to origin, lowest point to y=0 (SPEC §4.1). */
export function recentreToFootprint(group) {
  group.updateMatrixWorld(true);
  const box = bboxOf(group);
  if (box.isEmpty()) return group;
  const c = box.getCenter(new THREE.Vector3());
  group.position.x -= c.x;
  group.position.z -= c.z;
  group.position.y -= box.min.y;
  group.updateMatrixWorld(true);
  return group;
}

function finishRecentre(group, report) {
  recentreToFootprint(group);
  report.bbox_after = boxToPlain(bboxOf(group));
  return report;
}

function boxToPlain(b) {
  if (b.isEmpty()) return null;
  const s = b.getSize(new THREE.Vector3());
  return {
    min: [r6(b.min.x), r6(b.min.y), r6(b.min.z)],
    max: [r6(b.max.x), r6(b.max.y), r6(b.max.z)],
    size: [r6(s.x), r6(s.y), r6(s.z)],
  };
}
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. SCALE -- the honest part                                                */
/* ══════════════════════════════════════════════════════════════════════════ */

const AXIS_KEY = { w: 'x', width: 'x', x: 'x', d: 'z', depth: 'z', z: 'z', h: 'y', height: 'y', y: 'y' };

/**
 * fitToDimension(group, axis, mm) -> { scale, scale_confidence, dims_mm }
 *
 * Takes ONE real measurement the user physically took ("this chair is 780mm
 * wide") and scales the mesh UNIFORMLY so that axis measures exactly that.
 * Uniform scaling is deliberate: a single measurement cannot justify
 * non-uniform correction, and faking per-axis scale would be inventing data.
 *
 * @param {'w'|'d'|'h'|'x'|'y'|'z'} axis
 * @param {number} mm  real-world millimetres (integer, SPEC §1)
 */
export function fitToDimension(group, axis, mm) {
  const key = AXIS_KEY[String(axis).toLowerCase()];
  if (!key) throw new Error(`fitToDimension: unknown axis "${axis}" (use w|d|h)`);
  const target = Number(mm);
  if (!(target > 0)) throw new Error('fitToDimension: mm must be a positive number');

  group.updateMatrixWorld(true);
  const size = bboxOf(group).getSize(new THREE.Vector3());
  const current = size[key];
  if (!(current > 1e-9)) throw new Error(`fitToDimension: mesh has zero extent on ${key}`);

  const factor = mm2m(target) / current;
  group.scale.multiplyScalar(factor);
  group.updateMatrixWorld(true);
  recentreToFootprint(group);

  return {
    scale: factor,
    axis: key,
    scale_confidence: 'user-measured',
    dims_mm: measure(group),
  };
}

/** measure(group) -> { w_mm, d_mm, h_mm } — integers, SPEC §1. */
export function measure(group) {
  group.updateMatrixWorld(true);
  const box = bboxOf(group);
  if (box.isEmpty()) return { w_mm: 0, d_mm: 0, h_mm: 0 };
  const s = box.getSize(new THREE.Vector3());
  return {
    w_mm: Math.round(m2mm(s.x)),
    d_mm: Math.round(m2mm(s.z)),
    h_mm: Math.round(m2mm(s.y)),
  };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 5. ONE-CALL PIPELINE                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * importScannedItem(source, { measurement, name, ... })
 *   -> { group, dims_mm, scale_confidence, ground_plane_removed, report }
 *
 * `measurement` is `{ axis:'w'|'d'|'h', mm:Number }` or null.
 * With no measurement the result is honestly reported as 'unscaled' and
 * `dims_mm` is null -- callers MUST NOT persist a size in that case
 * (SPEC §8.8).
 */
export async function importScannedItem(source, { measurement = null, name = 'Scanned piece', groundPlane = {} } = {}) {
  const group = await loadScannedMesh(source);
  const report = stripGroundPlane(group, groundPlane);

  let scale_confidence = 'unscaled';
  let dims_mm = null;
  let scale = 1;

  if (measurement && Number(measurement.mm) > 0) {
    const fit = fitToDimension(group, measurement.axis || 'w', measurement.mm);
    scale_confidence = fit.scale_confidence;
    dims_mm = fit.dims_mm;
    scale = fit.scale;
  }

  return {
    group,
    name,
    dims_mm,                                    // null when unscaled — never guessed
    scale,
    scale_confidence,                           // 'user-measured' | 'unscaled'
    normalised_dims: measure(group),            // raw extents, meaningless until scaled
    ground_plane_removed: report.ground_plane_removed,
    report,
  };
}

/**
 * Shape a cleaned import into the SPEC §4.1 `user_item` fields. Refuses to
 * emit dims for an unscaled mesh.
 */
export function toUserItem(imported, extra = {}) {
  if (imported.scale_confidence !== 'user-measured') {
    return {
      ok: false,
      error: 'NO_SCALE',
      message: 'This scan has no real-world size yet. Enter one measurement (e.g. total width in mm) to continue.',
    };
  }
  const { w_mm, d_mm, h_mm } = imported.dims_mm;
  return {
    ok: true,
    item: {
      id: extra.id || `user-${Date.now().toString(36)}`,
      brand: extra.brand || null,
      name: imported.name,
      product_type: extra.product_type || 'scanned object',
      sku: null,
      category: extra.category || 'decor',
      archetype: extra.archetype || 'misc',
      dims_mm: { w: w_mm, d: d_mm, h: h_mm },
      seat_h_mm: extra.seat_h_mm ?? null,
      footprint: 'rect',
      l_shape_mm: null,
      source: 'scan',
      scale_confidence: imported.scale_confidence,
      mesh_url: extra.mesh_url || null,
    },
  };
}

export default {
  loadScannedMesh, stripGroundPlane, recentreToFootprint, fitToDimension,
  measure, importScannedItem, toUserItem, bboxOf, mm2m, m2mm, GROUND_PLANE_DEFAULTS,
};

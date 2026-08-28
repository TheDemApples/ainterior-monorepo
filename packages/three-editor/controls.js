// packages/three-editor/controls.js
// Orbit / pan / zoom clamped above the floor, first-person walk mode,
// drag-translate snapping (10mm grid, 120mm wall snap, neighbour edge-align)
// and the rotate ring with 15deg snapping.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { TOKENS } from './materials.js';
import { footprintOBB, obbCorners, distPointSeg } from './collision.js';

const MM = 1 / 1000;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------
export function createOrbitControls(camera, dom, opts = {}) {
  const state = {
    target: new THREE.Vector3(0, 0.8, 0),
    distance: 8,
    theta: Math.PI * 0.25,      // azimuth
    phi: Math.PI * 0.32,        // polar from +Y
    minDistance: opts.minDistance ?? 0.8,
    maxDistance: opts.maxDistance ?? 60,
    minPhi: 0.06,
    maxPhi: Math.PI / 2 - 0.035,  // never below the floor plane
    enabled: true,
    dragging: null,
    last: { x: 0, y: 0 },
    damping: 0.16,
    desired: { theta: Math.PI * 0.25, phi: Math.PI * 0.32, distance: 8 },
    minY: opts.minY ?? 0.12,
  };

  function begin(ev, mode) {
    if (!state.enabled) return;
    state.dragging = mode;
    state.last.x = ev.clientX;
    state.last.y = ev.clientY;
  }

  function onMove(ev) {
    if (!state.dragging || !state.enabled) return;
    const dx = ev.clientX - state.last.x;
    const dy = ev.clientY - state.last.y;
    state.last.x = ev.clientX;
    state.last.y = ev.clientY;
    if (state.dragging === 'rotate') {
      state.desired.theta -= dx * 0.006;
      state.desired.phi = clamp(state.desired.phi - dy * 0.005, state.minPhi, state.maxPhi);
    } else if (state.dragging === 'pan') {
      const scale = state.distance * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();
      state.target.addScaledVector(right, -dx * scale);
      state.target.addScaledVector(fwd, -dy * scale);
      state.target.y = clamp(state.target.y, 0, 3);
    }
  }

  function onUp() { state.dragging = null; }

  function onWheel(ev) {
    if (!state.enabled) return;
    ev.preventDefault();
    const f = Math.exp(ev.deltaY * 0.0012);
    state.desired.distance = clamp(state.desired.distance * f, state.minDistance, state.maxDistance);
  }

  function onContext(ev) { ev.preventDefault(); }

  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('contextmenu', onContext);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  function update() {
    const d = state.damping;
    state.theta += (state.desired.theta - state.theta) * d;
    state.phi += (state.desired.phi - state.phi) * d;
    state.distance += (state.desired.distance - state.distance) * d;
    const sp = Math.sin(state.phi), cp = Math.cos(state.phi);
    camera.position.set(
      state.target.x + state.distance * sp * Math.sin(state.theta),
      state.target.y + state.distance * cp,
      state.target.z + state.distance * sp * Math.cos(state.theta)
    );
    // hard clamp: camera can never go under the floor (SPEC §5.3)
    if (camera.position.y < state.minY) camera.position.y = state.minY;
    camera.lookAt(state.target);
  }

  function frame(bounds, height_mm) {
    const cx = ((bounds.minX + bounds.maxX) / 2) * MM;
    const cz = -((bounds.minY + bounds.maxY) / 2) * MM;
    state.target.set(cx, ((height_mm || 2600) * MM) * 0.28, cz);
    const span = Math.max(bounds.w, bounds.d) * MM;
    state.desired.distance = clamp(span * 1.55, state.minDistance, state.maxDistance);
    state.distance = state.desired.distance;
  }

  function dispose() {
    dom.removeEventListener('wheel', onWheel);
    dom.removeEventListener('contextmenu', onContext);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }

  return {
    state, begin, update, frame, dispose,
    get enabled() { return state.enabled; },
    set enabled(v) { state.enabled = v; },
    get target() { return state.target; },
  };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ---------------------------------------------------------------------------
// First person
// ---------------------------------------------------------------------------
export function createFirstPerson(camera, dom, opts = {}) {
  const st = {
    pos: new THREE.Vector3(0, 1.6, 0),
    yaw: 0, pitch: 0,
    eye: opts.eye ?? 1.6,
    speed: 2.6,
    keys: new Set(),
    dragging: false,
    last: { x: 0, y: 0 },
    active: false,
    inside: opts.inside || (() => true),
  };

  function begin(ev) { st.dragging = true; st.last.x = ev.clientX; st.last.y = ev.clientY; }
  function onMove(ev) {
    if (!st.dragging || !st.active) return;
    st.yaw -= (ev.clientX - st.last.x) * 0.004;
    st.pitch = clamp(st.pitch - (ev.clientY - st.last.y) * 0.003, -1.1, 1.1);
    st.last.x = ev.clientX; st.last.y = ev.clientY;
  }
  function onUp() { st.dragging = false; }
  function onKeyDown(e) { if (st.active) st.keys.add(e.key.toLowerCase()); }
  function onKeyUp(e) { st.keys.delete(e.key.toLowerCase()); }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function update(dt) {
    if (!st.active) return;
    const fwd = new THREE.Vector3(-Math.sin(st.yaw), 0, -Math.cos(st.yaw));
    const right = new THREE.Vector3(Math.cos(st.yaw), 0, -Math.sin(st.yaw));
    const step = st.speed * Math.min(dt, 0.05);
    const next = st.pos.clone();
    if (st.keys.has('w') || st.keys.has('arrowup')) next.addScaledVector(fwd, step);
    if (st.keys.has('s') || st.keys.has('arrowdown')) next.addScaledVector(fwd, -step);
    if (st.keys.has('a') || st.keys.has('arrowleft')) next.addScaledVector(right, -step);
    if (st.keys.has('d') || st.keys.has('arrowright')) next.addScaledVector(right, step);
    if (st.inside(next)) st.pos.copy(next);
    st.pos.y = st.eye;
    camera.position.copy(st.pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(st.yaw);
    camera.rotateX(st.pitch);
  }

  function place(bounds) {
    st.pos.set(((bounds.minX + bounds.maxX) / 2) * MM, st.eye, -(bounds.minY + 900) * MM);
    st.yaw = Math.PI; st.pitch = -0.05;
  }

  function dispose() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  return { state: st, begin, update, place, dispose,
    get active() { return st.active; }, set active(v) { st.active = v; } };
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------
export const GRID_MM = 10;
export const WALL_SNAP_MM = 120;
export const EDGE_ALIGN_MM = 60;
export const ROT_SNAP_DEG = 15;

export function snapToGrid(v, step = GRID_MM) { return Math.round(v / step) * step; }

/**
 * Full drag snap resolution.
 * @param {object} a {x_mm,y_mm,rot_deg,item,room,neighbours:[{placement,item}],free}
 * @returns {{x_mm,y_mm,rot_deg,snapped:string[],guides:[[x,y],[x,y]][]}}
 */
export function resolveSnap({ x_mm, y_mm, rot_deg, item, room, neighbours = [], free = false }) {
  const snapped = [];
  const guides = [];
  let x = free ? x_mm : snapToGrid(x_mm);
  let y = free ? y_mm : snapToGrid(y_mm);
  let rot = rot_deg;
  if (free) return { x_mm: x, y_mm: y, rot_deg: rot, snapped, guides };
  snapped.push('grid');

  const poly = room.polygon_mm;
  const dims = item.dims_mm;

  // ---- wall snap (<=120mm) -------------------------------------------------
  let bestWall = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const nIn = [-u[1], u[0]];
    // perpendicular distance from centre to the wall line
    const perp = (x - a[0]) * nIn[0] + (y - a[1]) * nIn[1];
    const along = (x - a[0]) * u[0] + (y - a[1]) * u[1];
    if (along < -400 || along > len + 400) continue;
    // the item's half-extent along the wall normal, given its rotation
    const rr = rot * D2R;
    const ax = [Math.cos(rr), Math.sin(rr)];
    const ay = [-Math.sin(rr), Math.cos(rr)];
    const half = Math.abs(ax[0] * nIn[0] + ax[1] * nIn[1]) * dims.w / 2 +
                 Math.abs(ay[0] * nIn[0] + ay[1] * nIn[1]) * dims.d / 2;
    const gap = perp - half;                            // gap between item edge and wall
    const offset = (item.placement && item.placement.wall_offset_mm) || 0;
    if (Math.abs(gap - offset) <= WALL_SNAP_MM && (!bestWall || Math.abs(gap - offset) < bestWall.err)) {
      bestWall = { i, nIn, u, a, err: Math.abs(gap - offset), push: offset - gap, len };
    }
  }
  if (bestWall) {
    x = snapToGrid(x + bestWall.nIn[0] * bestWall.push);
    y = snapToGrid(y + bestWall.nIn[1] * bestWall.push);
    snapped.push('wall:' + bestWall.i);
    // align rotation to the wall when we're already close (within 22deg)
    const wallFacing = wallFacingRotation(bestWall.u, bestWall.nIn);
    const delta = angDelta(rot, wallFacing);
    if (Math.abs(delta) <= 22) { rot = wallFacing; snapped.push('wall-align'); }
    guides.push([[bestWall.a[0], bestWall.a[1]],
      [bestWall.a[0] + bestWall.u[0] * bestWall.len, bestWall.a[1] + bestWall.u[1] * bestWall.len]]);
  }

  // ---- neighbour edge-align ----------------------------------------------
  const me = footprintOBB({ x_mm: x, y_mm: y, rot_deg: rot }, item);
  const mine = aabbOf(me);
  for (const nb of neighbours) {
    const nOb = footprintOBB(nb.placement, nb.item);
    const na = aabbOf(nOb);
    for (const [mk, nk] of [['minX', 'minX'], ['maxX', 'maxX'], ['minX', 'maxX'], ['maxX', 'minX'],
      ['cx', 'cx']]) {
      const d = na[nk] - mine[mk];
      if (Math.abs(d) > 0.5 && Math.abs(d) <= EDGE_ALIGN_MM) {
        x = snapToGrid(x + d); snapped.push('align-x');
        guides.push([[na[nk], na.minY - 400], [na[nk], na.maxY + 400]]);
        break;
      }
    }
    for (const [mk, nk] of [['minY', 'minY'], ['maxY', 'maxY'], ['minY', 'maxY'], ['maxY', 'minY'],
      ['cy', 'cy']]) {
      const d = na[nk] - mine[mk];
      if (Math.abs(d) > 0.5 && Math.abs(d) <= EDGE_ALIGN_MM) {
        y = snapToGrid(y + d); snapped.push('align-y');
        guides.push([[na.minX - 400, na[nk]], [na.maxX + 400, na[nk]]]);
        break;
      }
    }
  }

  return { x_mm: Math.round(x), y_mm: Math.round(y), rot_deg: rot, snapped, guides };
}

function aabbOf(obb) {
  const c = obbCorners(obb);
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    cx: obb.cx, cy: obb.cy,
  };
}

/** rot_deg such that the item's depth axis (+local y) points along the interior normal. */
export function wallFacingRotation(u, nIn) {
  // rot 0 => local +y is plan +y. We want local +y along nIn.
  let deg = Math.atan2(nIn[1], nIn[0]) * (180 / Math.PI) - 90;
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg / ROT_SNAP_DEG) * ROT_SNAP_DEG % 360;
}

export function angDelta(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d;
}

export function snapRotation(deg, free = false) {
  if (free) return ((deg % 360) + 360) % 360;
  return (Math.round(deg / ROT_SNAP_DEG) * ROT_SNAP_DEG % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------
// Rotate ring gizmo
// ---------------------------------------------------------------------------
export function createRotateRing(mats) {
  const group = new THREE.Group();
  group.name = 'rotate-ring';
  group.visible = false;
  const geoms = [];

  const ringGeom = new THREE.TorusGeometry(1, 0.012, 8, 72);
  ringGeom.rotateX(-Math.PI / 2);
  geoms.push(ringGeom);
  const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.blueprint), transparent: true, opacity: 0.9, depthTest: false,
  }));
  ring.renderOrder = 20;
  group.add(ring);

  // 15deg ticks
  const tickPts = [];
  for (let d = 0; d < 360; d += ROT_SNAP_DEG) {
    const a = d * D2R;
    const inner = d % 90 === 0 ? 0.86 : 0.93;
    tickPts.push(new THREE.Vector3(Math.cos(a) * inner, 0, Math.sin(a) * inner));
    tickPts.push(new THREE.Vector3(Math.cos(a) * 1.06, 0, Math.sin(a) * 1.06));
  }
  const tickGeom = new THREE.BufferGeometry().setFromPoints(tickPts);
  geoms.push(tickGeom);
  const ticks = new THREE.LineSegments(tickGeom, new THREE.LineBasicMaterial({
    color: new THREE.Color(TOKENS.blueprint), transparent: true, opacity: 0.55, depthTest: false,
  }));
  ticks.renderOrder = 20;
  group.add(ticks);

  // Invisible fat torus so the 12mm visual ring is actually grabbable
  // (an 8mm-wide screen target is unusable with a mouse).
  const pickGeom = new THREE.TorusGeometry(1, 0.075, 6, 48);
  pickGeom.rotateX(-Math.PI / 2);
  geoms.push(pickGeom);
  const pick = new THREE.Mesh(pickGeom, new THREE.MeshBasicMaterial({ visible: false }));
  pick.name = 'rotate-ring-pick';
  group.add(pick);

  // handle showing the item's facing direction
  const handleGeom = new THREE.ConeGeometry(0.055, 0.14, 12);
  handleGeom.rotateX(Math.PI / 2);
  geoms.push(handleGeom);
  const handle = new THREE.Mesh(handleGeom, new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.clay), depthTest: false,
  }));
  handle.renderOrder = 21;
  group.add(handle);

  /** @param {number} radius_m ring radius in metres, @param {number} rot_deg */
  function fit(radius_m, rot_deg) {
    const r = Math.max(0.35, radius_m);
    group.scale.set(r, 1, r);
    // handle sits on the ring pointing along the item's +local y (plan) => -three.z at 0deg
    const a = rot_deg * D2R;
    // plan +y rotated CCW by a  => plan (-sin a, cos a) => three (-sin a, ., -cos a)
    handle.position.set(-Math.sin(a) * 1.0, 0, -Math.cos(a) * 1.0);
    handle.rotation.set(0, a, 0);
    handle.scale.set(1 / r, 1, 1 / r);
  }

  function dispose() { geoms.forEach((g) => g.dispose()); }

  return { group, fit, dispose, ring, ticks, handle, pick };
}

export default createOrbitControls;

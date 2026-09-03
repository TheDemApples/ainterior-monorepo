// packages/three-editor/controls.js
// SPEC2 §D (camera) + §E (walk mode) + the snapping helpers used by §F.
//
// Camera rules that this file exists to enforce:
//   * damped spherical orbit around a target, polar clamped to
//     [0.05, PI/2 - 0.02] so the camera can never flip or dip under the floor;
//   * no delta accumulation across frames — pointer handlers only record state,
//     the rAF loop damps toward it;
//   * pointer capture for the whole drag, released on pointerup /
//     pointercancel / lostpointercapture / blur so a dropped pointerup can
//     never leave the camera spinning;
//   * zoom to cursor: the world point under the cursor stays under the cursor,
//     in both the perspective and the ortho (plan) view.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { TOKENS } from './materials.js';
import { footprintOBB, obbCorners, distPointSeg, pointInPolygon } from './collision.js';

const MM = 1 / 1000;
const D2R = Math.PI / 180;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/** Time-based ease-out lerp factor. `tau` seconds ⇒ ~95% travelled in 3·tau. */
export function easeK(dt, tau) {
  return 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-4, tau));
}

// ---------------------------------------------------------------------------
// Orbit / pan / zoom (3D view) — SPEC2 §D
// ---------------------------------------------------------------------------
export const MIN_PHI = 0.05;
export const MAX_PHI = Math.PI / 2 - 0.02;
export const MIN_DIST = 0.6;
export const MAX_DIST = 60;

export function createOrbitControls(camera, dom, opts = {}) {
  const state = {
    target: new THREE.Vector3(0, 0.8, 0),
    distance: 8,
    theta: Math.PI * 0.25,
    phi: Math.PI * 0.32,
    minDistance: opts.minDistance ?? MIN_DIST,
    maxDistance: opts.maxDistance ?? MAX_DIST,
    minPhi: MIN_PHI,
    maxPhi: MAX_PHI,
    enabled: true,
    dragging: null,          // 'orbit' | 'pan' | 'pan-invert'
    pointerId: null,
    last: { x: 0, y: 0 },
    damping: 0.12,
    desired: { theta: Math.PI * 0.25, phi: Math.PI * 0.32, distance: 8 },
    desiredTarget: new THREE.Vector3(0, 0.8, 0),
    minY: opts.minY ?? 0.12,
    orbitSpeed: 0.0062,
    panSpeed: 0.0016,
  };

  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ray = new THREE.Raycaster();
  const _v = new THREE.Vector3();

  /** True while a pointer is driving the camera. */
  function isDragging() { return !!state.dragging; }

  function begin(ev, mode) {
    if (!state.enabled) return false;
    state.dragging = mode;
    state.pointerId = ev.pointerId;
    state.last.x = ev.clientX;
    state.last.y = ev.clientY;
    try { dom.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ }
    return true;
  }

  /** Pointer handlers record state only — no camera work here (SPEC2 §D). */
  function onMove(ev) {
    if (!state.dragging || !state.enabled) return;
    if (state.pointerId != null && ev.pointerId != null && ev.pointerId !== state.pointerId) return;
    const dx = ev.clientX - state.last.x;
    const dy = ev.clientY - state.last.y;
    state.last.x = ev.clientX;
    state.last.y = ev.clientY;

    if (state.dragging === 'orbit') {
      state.desired.theta -= dx * state.orbitSpeed;
      state.desired.phi = clamp(state.desired.phi - dy * state.orbitSpeed * 0.82,
        state.minPhi, state.maxPhi);
      return;
    }
    // pan / pan-invert
    const scale = state.distance * state.panSpeed;
    const right = _v.set(0, 0, 0).setFromMatrixColumn(camera.matrix, 0).setY(0);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();
    // SPEC2 §A/#4b: middle-drag is vertically inverted — a positive (downward)
    // screen dy advances the camera along its forward vector.
    const fwdSign = state.dragging === 'pan-invert' ? +1 : -1;
    state.desiredTarget.addScaledVector(right, dx * scale);
    state.desiredTarget.addScaledVector(fwd, fwdSign * dy * scale);
    state.desiredTarget.y = clamp(state.desiredTarget.y, 0, 3);
  }

  function end() {
    if (state.pointerId != null) {
      try { dom.releasePointerCapture(state.pointerId); } catch (e) { /* already gone */ }
    }
    state.dragging = null;
    state.pointerId = null;
  }

  /**
   * Exponential zoom whose fixed point is the world point under the cursor.
   * camera' - W === f·(camera - W) when target' = W + f·(target - W) and
   * distance' = f·distance with the view direction unchanged.
   */
  function zoomAt(ndc, deltaY) {
    if (!state.enabled) return;
    const raw = Math.exp(deltaY * 0.0012);
    const next = clamp(state.desired.distance * raw, state.minDistance, state.maxDistance);
    const f = next / state.desired.distance;
    if (Math.abs(f - 1) > 1e-6) {
      const W = floorPointAt(ndc);
      if (W) {
        state.desiredTarget.set(
          W.x + (state.desiredTarget.x - W.x) * f,
          W.y + (state.desiredTarget.y - W.y) * f,
          W.z + (state.desiredTarget.z - W.z) * f,
        );
      }
      state.desired.distance = next;
    }
  }

  function floorPointAt(ndc) {
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hit = new THREE.Vector3();
    if (Math.abs(ray.ray.direction.y) < 1e-4) return null;
    if (!ray.ray.intersectPlane(floorPlane, hit)) return null;
    if (!isFinite(hit.x) || Math.abs(hit.x) > 1e5) return null;
    return hit;
  }

  function place() {
    const sp = Math.sin(state.phi), cp = Math.cos(state.phi);
    camera.position.set(
      state.target.x + state.distance * sp * Math.sin(state.theta),
      state.target.y + state.distance * cp,
      state.target.z + state.distance * sp * Math.cos(state.theta),
    );
    if (camera.position.y < state.minY) camera.position.y = state.minY;
    camera.lookAt(state.target);
    camera.updateMatrixWorld();
  }

  function update() {
    const d = state.damping;
    state.desired.phi = clamp(state.desired.phi, state.minPhi, state.maxPhi);
    state.desired.distance = clamp(state.desired.distance, state.minDistance, state.maxDistance);
    state.theta += (state.desired.theta - state.theta) * d;
    state.phi += (state.desired.phi - state.phi) * d;
    state.distance += (state.desired.distance - state.distance) * d;
    state.phi = clamp(state.phi, state.minPhi, state.maxPhi);
    state.target.lerp(state.desiredTarget, d);
    place();
  }

  /** Jump straight to the damped destination (snapshots + deterministic tests). */
  function settle() {
    state.desired.phi = clamp(state.desired.phi, state.minPhi, state.maxPhi);
    state.desired.distance = clamp(state.desired.distance, state.minDistance, state.maxDistance);
    state.theta = state.desired.theta;
    state.phi = state.desired.phi;
    state.distance = state.desired.distance;
    state.target.copy(state.desiredTarget);
    place();
  }

  function frame(bounds, height_mm) {
    const cx = ((bounds.minX + bounds.maxX) / 2) * MM;
    const cz = -((bounds.minY + bounds.maxY) / 2) * MM;
    state.target.set(cx, ((height_mm || 2600) * MM) * 0.28, cz);
    state.desiredTarget.copy(state.target);
    const span = Math.max(bounds.w, bounds.d) * MM;
    state.desired.distance = clamp(span * 1.55, state.minDistance, state.maxDistance);
    state.distance = state.desired.distance;
    state.desired.theta = Math.PI * 0.25;
    state.desired.phi = Math.PI * 0.32;
    state.theta = state.desired.theta;
    state.phi = state.desired.phi;
    place();
  }

  function onLost(ev) {
    if (state.pointerId != null && ev.pointerId != null && ev.pointerId !== state.pointerId) return;
    state.dragging = null;
    state.pointerId = null;
  }
  function onBlur() { end(); }

  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('lostpointercapture', onLost);
  window.addEventListener('blur', onBlur);

  function dispose() {
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', end);
    dom.removeEventListener('pointercancel', end);
    dom.removeEventListener('lostpointercapture', onLost);
    window.removeEventListener('blur', onBlur);
  }

  return {
    state, begin, onMove, end, update, settle, frame, zoomAt, floorPointAt,
    isDragging, dispose,
    get enabled() { return state.enabled; },
    set enabled(v) { state.enabled = v; if (!v) end(); },
    get target() { return state.target; },
  };
}

// ---------------------------------------------------------------------------
// Plan (ortho) pan + zoom — SPEC2 §D / defect #8
// ---------------------------------------------------------------------------
/**
 * The plan camera looks straight down with `up = (0,0,-1)`, so screen-right is
 * world +x and screen-up is world -z (= plan +y, "up the page", SPEC §1).
 */
export function createPlanControls(camera, dom, opts = {}) {
  const st = {
    cx: 0, cz: 0, halfH: 5, aspect: 1,
    minHalf: opts.minHalf ?? 0.25,
    maxHalf: opts.maxHalf ?? 60,
    enabled: true,
    dragging: false,
    pointerId: null,
    last: { x: 0, y: 0 },
    viewport: { w: 640, h: 420 },
    height: opts.height ?? 12,
  };

  function apply() {
    const halfW = st.halfH * st.aspect;
    camera.left = -halfW; camera.right = halfW;
    camera.top = st.halfH; camera.bottom = -st.halfH;
    camera.zoom = 1;
    camera.position.set(st.cx, st.height, st.cz);
    camera.up.set(0, 0, -1);
    camera.lookAt(st.cx, 0, st.cz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  /** Explicit re-frame. Called on fit + resize only, never per frame. */
  function fit(bounds, viewport) {
    if (viewport) setViewport(viewport.w, viewport.h);
    const pad = 1.16;
    let halfW = (bounds.w * MM * pad) / 2;
    let halfH = (bounds.d * MM * pad) / 2;
    if (halfW / halfH < st.aspect) halfW = halfH * st.aspect; else halfH = halfW / st.aspect;
    st.halfH = clamp(halfH, st.minHalf, st.maxHalf);
    st.cx = ((bounds.minX + bounds.maxX) / 2) * MM;
    st.cz = -((bounds.minY + bounds.maxY) / 2) * MM;
    apply();
  }

  function setViewport(w, h) {
    st.viewport.w = Math.max(1, w);
    st.viewport.h = Math.max(1, h);
    st.aspect = st.viewport.w / st.viewport.h;
  }

  /** Resize keeps the user's zoom (halfH) and centre — SPEC2 §D. */
  function resize(w, h) { setViewport(w, h); apply(); }

  function begin(ev) {
    if (!st.enabled) return false;
    st.dragging = true;
    st.pointerId = ev.pointerId;
    st.last.x = ev.clientX; st.last.y = ev.clientY;
    try { dom.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    return true;
  }

  function onMove(ev) {
    if (!st.dragging || !st.enabled) return;
    if (st.pointerId != null && ev.pointerId != null && ev.pointerId !== st.pointerId) return;
    const dx = ev.clientX - st.last.x;
    const dy = ev.clientY - st.last.y;
    st.last.x = ev.clientX; st.last.y = ev.clientY;
    const wpp = (st.halfH * 2) / st.viewport.h;   // world metres per CSS px
    st.cx += dx * wpp;      // drag right ⇒ pan right
    st.cz += dy * wpp;      // screen-down is world +z
    apply();
  }

  function end() {
    if (st.pointerId != null) {
      try { dom.releasePointerCapture(st.pointerId); } catch (e) { /* gone */ }
    }
    st.dragging = false;
    st.pointerId = null;
  }

  /** World point under an NDC cursor position (the plan is a flat projection). */
  function worldAt(ndc) {
    return {
      x: st.cx + ndc.x * st.halfH * st.aspect,
      z: st.cz - ndc.y * st.halfH,
    };
  }

  /** Zoom at the cursor: the world point under it is the fixed point. */
  function zoomAt(ndc, deltaY) {
    if (!st.enabled) return;
    const raw = Math.exp(deltaY * 0.0012);
    const next = clamp(st.halfH * raw, st.minHalf, st.maxHalf);
    const f = next / st.halfH;
    if (Math.abs(f - 1) < 1e-9) return;
    const W = worldAt(ndc);
    st.cx = W.x + (st.cx - W.x) * f;
    st.cz = W.z + (st.cz - W.z) * f;
    st.halfH = next;
    apply();
  }

  function onLost(ev) {
    if (st.pointerId != null && ev.pointerId != null && ev.pointerId !== st.pointerId) return;
    st.dragging = false; st.pointerId = null;
  }
  function onBlur() { end(); }

  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('lostpointercapture', onLost);
  window.addEventListener('blur', onBlur);

  function dispose() {
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', end);
    dom.removeEventListener('pointercancel', end);
    dom.removeEventListener('lostpointercapture', onLost);
    window.removeEventListener('blur', onBlur);
  }

  return {
    state: st, fit, resize, setViewport, apply, begin, onMove, end, zoomAt, worldAt, dispose,
    isDragging: () => st.dragging,
    get enabled() { return st.enabled; },
    set enabled(v) { st.enabled = v; if (!v) end(); },
  };
}

// ---------------------------------------------------------------------------
// First person walk — SPEC2 §E
// ---------------------------------------------------------------------------
export const WALK_MPS = 1.35;
export const SPRINT_MPS = 3.2;
export const CROUCH_MPS = 0.7;
export const EYE_STAND_M = 1.62;
export const EYE_CROUCH_M = 0.95;
export const FOV_BASE = 68;
export const FOV_SPRINT = 74;
export const BODY_RADIUS_MM = 250;
/** ~180ms ease-out (3·tau ≈ 95% travelled). */
export const EASE_TAU = 0.06;

export function createFirstPerson(camera, dom, opts = {}) {
  const st = {
    pos: new THREE.Vector3(0, EYE_STAND_M, 0),
    yaw: 0, pitch: 0,
    eye: EYE_STAND_M,
    eyeTarget: EYE_STAND_M,
    speed: WALK_MPS,
    speedTarget: WALK_MPS,
    fov: FOV_BASE,
    fovTarget: FOV_BASE,
    keys: new Set(),
    sprint: false,
    crouch: false,
    dragging: false,
    pointerId: null,
    last: { x: 0, y: 0 },
    active: false,
    /** (x_m, z_m) ⇒ boolean; supplied by the editor (walls + furniture). */
    canStand: opts.canStand || (() => true),
  };

  camera.fov = FOV_BASE;
  camera.updateProjectionMatrix();

  function begin(ev) {
    st.dragging = true;
    st.pointerId = ev.pointerId;
    st.last.x = ev.clientX; st.last.y = ev.clientY;
    try { dom.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
  }
  function onMove(ev) {
    if (!st.dragging || !st.active) return;
    if (st.pointerId != null && ev.pointerId != null && ev.pointerId !== st.pointerId) return;
    st.yaw -= (ev.clientX - st.last.x) * 0.004;
    st.pitch = clamp(st.pitch - (ev.clientY - st.last.y) * 0.003, -1.1, 1.1);
    st.last.x = ev.clientX; st.last.y = ev.clientY;
  }
  function end() {
    if (st.pointerId != null) {
      try { dom.releasePointerCapture(st.pointerId); } catch (e) { /* gone */ }
    }
    st.dragging = false; st.pointerId = null;
  }

  function onKeyDown(e) {
    if (!st.active) return;
    const k = (e.key || '').toLowerCase();
    if (k === ' ' || k === 'spacebar') { e.preventDefault(); return; }  // SPEC2 §E: no jumping
    st.keys.add(k);
    if (e.shiftKey) st.sprint = true;
    if (e.ctrlKey || e.metaKey || k === 'c') st.crouch = true;
    if (k === 'shift') st.sprint = true;
    if (k === 'control') st.crouch = true;
  }
  function onKeyUp(e) {
    const k = (e.key || '').toLowerCase();
    st.keys.delete(k);
    if (k === 'shift') st.sprint = false;
    if (k === 'control' || k === 'meta' || k === 'c') st.crouch = false;
    if (!e.shiftKey) st.sprint = false;
    if (!e.ctrlKey && !e.metaKey && !st.keys.has('c')) st.crouch = false;
  }
  function onBlur() { st.keys.clear(); st.sprint = false; st.crouch = false; end(); }

  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('lostpointercapture', end);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function update(dt) {
    if (!st.active) return;
    // Anti-teleport clamp: a long stall must not fling the walker through a
    // wall. 100ms still covers a 10fps session honestly.
    const step = Math.min(Math.max(dt, 0), 0.1);

    // ---- state targets ----
    st.speedTarget = st.crouch ? CROUCH_MPS : (st.sprint ? SPRINT_MPS : WALK_MPS);
    st.eyeTarget = st.crouch ? EYE_CROUCH_M : EYE_STAND_M;
    st.fovTarget = (st.sprint && !st.crouch) ? FOV_SPRINT : FOV_BASE;

    // ---- time-based ease-out (never snap) ----
    const k = easeK(step, EASE_TAU);
    st.speed += (st.speedTarget - st.speed) * k;
    st.eye += (st.eyeTarget - st.eye) * k;
    st.fov += (st.fovTarget - st.fov) * k;
    if (Math.abs(camera.fov - st.fov) > 0.01) {
      camera.fov = st.fov;
      camera.updateProjectionMatrix();
    }

    // ---- movement ----
    const fwd = new THREE.Vector3(-Math.sin(st.yaw), 0, -Math.cos(st.yaw));
    const right = new THREE.Vector3(Math.cos(st.yaw), 0, -Math.sin(st.yaw));
    const dir = new THREE.Vector3();
    if (st.keys.has('w') || st.keys.has('arrowup')) dir.add(fwd);
    if (st.keys.has('s') || st.keys.has('arrowdown')) dir.sub(fwd);
    if (st.keys.has('a') || st.keys.has('arrowleft')) dir.sub(right);
    if (st.keys.has('d') || st.keys.has('arrowright')) dir.add(right);
    if (dir.lengthSq() > 1e-9) {
      dir.normalize().multiplyScalar(st.speed * step);
      const nx = st.pos.x + dir.x;
      const nz = st.pos.z + dir.z;
      if (st.canStand(nx, nz)) {
        st.pos.x = nx; st.pos.z = nz;
      } else {
        // slide along the obstacle instead of stopping dead
        if (st.canStand(nx, st.pos.z)) st.pos.x = nx;
        else if (st.canStand(st.pos.x, nz)) st.pos.z = nz;
      }
    }
    st.pos.y = st.eye;
    camera.position.copy(st.pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(st.yaw);
    camera.rotateX(st.pitch);
    camera.updateMatrixWorld();
  }

  function place(bounds) {
    st.pos.set(((bounds.minX + bounds.maxX) / 2) * MM, st.eye, -(bounds.minY + 900) * MM);
    st.yaw = Math.PI; st.pitch = -0.05;
    st.eye = EYE_STAND_M; st.eyeTarget = EYE_STAND_M;
    st.speed = WALK_MPS; st.speedTarget = WALK_MPS;
    st.fov = FOV_BASE; st.fovTarget = FOV_BASE;
    camera.fov = FOV_BASE; camera.updateProjectionMatrix();
    camera.position.copy(st.pos);
  }

  function dispose() {
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', end);
    dom.removeEventListener('pointercancel', end);
    dom.removeEventListener('lostpointercapture', end);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  }

  return {
    state: st, begin, onMove, end, update, place, dispose,
    setCanStand(fn) { st.canStand = typeof fn === 'function' ? fn : (() => true); },
    get active() { return st.active; },
    set active(v) {
      st.active = !!v;
      if (!v) { st.keys.clear(); st.sprint = false; st.crouch = false; end(); }
    },
  };
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
 * Wall snapping + neighbour edge-align for a proposed position. The 10mm grid
 * snap now lives in the gizmo (SPEC2 §B), so this runs on an already-snapped
 * value and only adds the wall / neighbour refinements.
 * @returns {{x_mm,y_mm,rot_deg,snapped:string[],guides:[[x,y],[x,y]][],wall_index:number|null}}
 */
export function resolveSnap({ x_mm, y_mm, rot_deg, item, room, neighbours = [], free = false }) {
  const snapped = [];
  const guides = [];
  let x = free ? x_mm : snapToGrid(x_mm);
  let y = free ? y_mm : snapToGrid(y_mm);
  let rot = rot_deg;
  if (free) return { x_mm: x, y_mm: y, rot_deg: rot, snapped, guides, wall_index: null };
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
    const perp = (x - a[0]) * nIn[0] + (y - a[1]) * nIn[1];
    const along = (x - a[0]) * u[0] + (y - a[1]) * u[1];
    if (along < -400 || along > len + 400) continue;
    const rr = rot * D2R;
    const ax = [Math.cos(rr), Math.sin(rr)];
    const ay = [-Math.sin(rr), Math.cos(rr)];
    const half = Math.abs(ax[0] * nIn[0] + ax[1] * nIn[1]) * dims.w / 2 +
                 Math.abs(ay[0] * nIn[0] + ay[1] * nIn[1]) * dims.d / 2;
    const gap = perp - half;
    const offset = (item.placement && item.placement.wall_offset_mm) || 0;
    if (Math.abs(gap - offset) <= WALL_SNAP_MM && (!bestWall || Math.abs(gap - offset) < bestWall.err)) {
      bestWall = { i, nIn, u, a, err: Math.abs(gap - offset), push: offset - gap, len };
    }
  }
  let wallIndex = null;
  if (bestWall) {
    x = snapToGrid(x + bestWall.nIn[0] * bestWall.push);
    y = snapToGrid(y + bestWall.nIn[1] * bestWall.push);
    snapped.push('wall:' + bestWall.i);
    wallIndex = bestWall.i;
    // Only rotate to face the room for pieces that are meant to sit against it.
    const againstWall = !(item.placement && item.placement.against_wall === false);
    const wallFacing = wallFacingRotation(bestWall.u, bestWall.nIn);
    const delta = angDelta(rot, wallFacing);
    if (againstWall && Math.abs(delta) <= 22) { rot = wallFacing; snapped.push('wall-align'); }
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

  return { x_mm: Math.round(x), y_mm: Math.round(y), rot_deg: rot, snapped, guides, wall_index: wallIndex };
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
  let deg = Math.atan2(nIn[1], nIn[0]) * (180 / Math.PI) - 90;
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg / ROT_SNAP_DEG) * ROT_SNAP_DEG % 360;
}

export function angDelta(a, b) {
  return ((b - a) % 360 + 540) % 360 - 180;
}

export function snapRotation(deg, free = false) {
  if (free) return ((deg % 360) + 360) % 360;
  return (Math.round(deg / ROT_SNAP_DEG) * ROT_SNAP_DEG % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------
// Legacy rotate ring — superseded by gizmo.js (SPEC2 §B). Kept exported so
// nothing that still imports it breaks; the editor no longer instantiates it.
// ---------------------------------------------------------------------------
export function createRotateRing(mats) {
  const group = new THREE.Group();
  group.name = 'rotate-ring-legacy';
  group.visible = false;
  const geoms = [];
  const ringGeom = new THREE.TorusGeometry(1, 0.012, 8, 72);
  ringGeom.rotateX(-Math.PI / 2);
  geoms.push(ringGeom);
  const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.blueprint), transparent: true, opacity: 0.9, depthTest: false,
  }));
  group.add(ring);
  const pickGeom = new THREE.TorusGeometry(1, 0.075, 6, 48);
  pickGeom.rotateX(-Math.PI / 2);
  geoms.push(pickGeom);
  const pick = new THREE.Mesh(pickGeom, new THREE.MeshBasicMaterial({ visible: false }));
  group.add(pick);
  const handleGeom = new THREE.ConeGeometry(0.055, 0.14, 12);
  handleGeom.rotateX(Math.PI / 2);
  geoms.push(handleGeom);
  const handle = new THREE.Mesh(handleGeom, new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.clay), depthTest: false,
  }));
  group.add(handle);
  function fit(radius_m, rot_deg) {
    const r = Math.max(0.35, radius_m);
    group.scale.set(r, 1, r);
    const a = rot_deg * D2R;
    handle.position.set(-Math.sin(a) * 1.0, 0, -Math.cos(a) * 1.0);
    handle.rotation.set(0, a, 0);
    handle.scale.set(1 / r, 1, 1 / r);
  }
  function dispose() { geoms.forEach((g) => g.dispose()); }
  return { group, fit, dispose, ring, handle, pick, ticks: null };
}

/** Point-in-polygon with a body radius, sampled on the 4 cardinal offsets. */
export function polygonAdmits(x_mm, y_mm, poly, radius_mm) {
  if (!pointInPolygon([x_mm, y_mm], poly)) return false;
  const r = radius_mm || 0;
  if (r <= 0) return true;
  const offs = [[r, 0], [-r, 0], [0, r], [0, -r]];
  for (const [dx, dy] of offs) {
    if (!pointInPolygon([x_mm + dx, y_mm + dy], poly)) return false;
  }
  // also keep clear of the wall lines themselves
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (distPointSeg([x_mm, y_mm], a, b).dist < r) return false;
  }
  return true;
}

export default createOrbitControls;

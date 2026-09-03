// packages/three-editor/gizmo.js
// SPEC2 §B — the manipulation gizmo.
//
// Three axis arrows (constrained translation), one planar floor handle (the
// everyday 2D move) and three rotation rings. Screen-constant size. All drag
// maths is **projective with an anchor**: on pointer-down we record the ray /
// plane intersection once, and every move re-intersects the *same* plane and
// applies `current - anchor` to the transform captured at pointer-down. Nothing
// is accumulated per frame and nothing is re-derived from the object's live
// position — that combination is what produced the reported shake and drift.
//
// Frames (SPEC §1): storage is mm in the plan frame (x right, y up-the-page),
// the scene is metres with three.x = plan.x/1000, three.z = -plan.y/1000,
// three.y = elevation. rot_deg is CCW positive about the vertical axis.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

const MM = 1 / 1000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Dedicated raycast layer so only gizmo handles are hit (SPEC2 §C.1). */
export const GIZMO_LAYER = 3;
/** Target on-screen width of the whole gizmo, in CSS px (SPEC2 §B). */
export const GIZMO_SPAN_PX = 110;
/** The gizmo is authored in "unit" space; the yaw ring's diameter is the span. */
const SPAN_UNITS = 2.0;

export const AXIS_HEX = { x: '#DC6B47', y: '#3B6EF6', z: '#7E9B6B' };
export const TRANSLATE_SNAP_MM = 10;
export const ROTATE_SNAP_DEG = 15;

/** Rays flatter than 4° to the drag plane are refused (SPEC2 §B degenerate guard). */
const MIN_RAY_DOT = Math.sin(4 * D2R);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const snapTo = (v, step) => Math.round(v / step) * step;
const norm360 = (d) => ((d % 360) + 360) % 360;

/** Shortest signed difference b-a in degrees, unwrapped across ±180. */
export function unwrapDeg(a, b) {
  return ((b - a) % 360 + 540) % 360 - 180;
}

function basicMat(hex, opacity) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex),
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/**
 * Invisible-but-pickable material. `visible` stays true on the mesh (SPEC2 §C.3
 * skips invisible candidates) — we simply draw nothing.
 */
function pickMat() {
  return new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    colorWrite: false, side: THREE.DoubleSide,
  });
}

/**
 * @returns {object} gizmo controller. `group` goes straight into the scene.
 */
export function createGizmo() {
  const group = new THREE.Group();
  group.name = 'gizmo';
  group.visible = false;
  group.renderOrder = 30;
  // The gizmo is never lit and never a shadow caster.
  group.matrixAutoUpdate = true;

  const geoms = [];
  const mats = [];
  /** @type {Array<{id:string,kind:string,axis:string,pick:THREE.Mesh,parts:THREE.Mesh[],baseHex:string,baseOpacity:number}>} */
  const handles = [];
  const pickMeshes = [];

  function keep(g) { geoms.push(g); return g; }
  function keepM(m) { mats.push(m); return m; }

  /** Visual parts are decoration: never raycast targets (SPEC2 §C.1). */
  function decorate(mesh, order) {
    mesh.raycast = () => {};
    mesh.renderOrder = 30 + (order || 0);
    mesh.frustumCulled = false;
    return mesh;
  }

  function registerHandle(def) {
    const pick = def.pick;
    pick.name = 'gizmo-pick:' + def.id;
    pick.frustumCulled = false;
    pick.renderOrder = 40;
    pick.layers.set(GIZMO_LAYER);
    pick.userData.gizmo = { id: def.id, kind: def.kind, axis: def.axis };
    group.add(pick);
    pickMeshes.push(pick);
    const h = {
      id: def.id, kind: def.kind, axis: def.axis, pick,
      parts: def.parts, baseHex: def.baseHex,
      baseOpacity: def.baseOpacity == null ? 0.94 : def.baseOpacity,
      root: def.root || null,
    };
    handles.push(h);
    return h;
  }

  // ---------------------------------------------------------------- arrows --
  const ARROW_LEN = 0.80;
  const SHAFT_R = 0.0165;
  const HEAD_R = 0.052;
  const HEAD_H = 0.17;

  const AXIS_DIR = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
  };

  function buildArrow(axis) {
    const hex = AXIS_HEX[axis];
    const mat = keepM(basicMat(hex, 0.96));
    const root = new THREE.Group();
    root.name = 'gizmo-arrow:' + axis;

    const shaftG = keep(new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, ARROW_LEN - HEAD_H, 10, 1));
    const shaft = decorate(new THREE.Mesh(shaftG, mat), 1);
    shaft.position.y = (ARROW_LEN - HEAD_H) / 2;
    root.add(shaft);

    const headG = keep(new THREE.ConeGeometry(HEAD_R, HEAD_H, 14));
    const head = decorate(new THREE.Mesh(headG, mat), 1);
    head.position.y = ARROW_LEN - HEAD_H / 2;
    root.add(head);

    // Orient local +Y onto the world axis.
    if (axis === 'x') root.rotation.z = -Math.PI / 2;
    else if (axis === 'z') root.rotation.x = Math.PI / 2;
    group.add(root);

    const pickG = keep(new THREE.CylinderGeometry(0.085, 0.085, ARROW_LEN + 0.06, 8, 1));
    const pick = new THREE.Mesh(pickG, keepM(pickMat()));
    pick.position.copy(AXIS_DIR[axis]).multiplyScalar((ARROW_LEN + 0.06) / 2);
    if (axis === 'x') pick.rotation.z = -Math.PI / 2;
    else if (axis === 'z') pick.rotation.x = Math.PI / 2;

    return registerHandle({
      id: 'axis-' + axis, kind: 'axis', axis, pick,
      parts: [shaft, head], baseHex: hex, baseOpacity: 0.96, root,
    });
  }

  const hAxisX = buildArrow('x');
  const hAxisY = buildArrow('y');
  const hAxisZ = buildArrow('z');

  // ---------------------------------------------------- planar floor handle --
  // Deliberately generous: SPEC2 §B calls this "the everyday interaction" and
  // says it must be the easiest to hit.
  const PLANE_HALF = 0.20;
  const planeMat = keepM(basicMat('#F5F2ED', 0.30));
  const planeG = keep(new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2));
  planeG.rotateX(-Math.PI / 2);
  const planeFace = decorate(new THREE.Mesh(planeG, planeMat), 0);
  planeFace.position.y = 0.004;
  group.add(planeFace);

  const planeEdgeMat = keepM(new THREE.LineBasicMaterial({
    color: new THREE.Color('#F5F2ED'), transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false,
  }));
  const planeEdgeG = keep(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-PLANE_HALF, 0.005, -PLANE_HALF),
    new THREE.Vector3(PLANE_HALF, 0.005, -PLANE_HALF),
    new THREE.Vector3(PLANE_HALF, 0.005, PLANE_HALF),
    new THREE.Vector3(-PLANE_HALF, 0.005, PLANE_HALF),
    new THREE.Vector3(-PLANE_HALF, 0.005, -PLANE_HALF),
  ]));
  const planeEdge = new THREE.Line(planeEdgeG, planeEdgeMat);
  planeEdge.raycast = () => {};
  planeEdge.renderOrder = 32;
  planeEdge.frustumCulled = false;
  group.add(planeEdge);

  const planePickG = keep(new THREE.BoxGeometry(PLANE_HALF * 2.35, 0.10, PLANE_HALF * 2.35));
  const hPlanar = registerHandle({
    id: 'planar', kind: 'planar', axis: 'y',
    pick: new THREE.Mesh(planePickG, keepM(pickMat())),
    parts: [planeFace], baseHex: '#F5F2ED', baseOpacity: 0.30,
  });

  // ------------------------------------------------------- rotation rings ---
  function buildRing(axis, radius, tube, opacity) {
    const hex = AXIS_HEX[axis];
    const mat = keepM(basicMat(hex, opacity));
    const g = keep(new THREE.TorusGeometry(radius, tube, 8, 96));
    const ring = decorate(new THREE.Mesh(g, mat), 2);
    // Torus lies in local XY; rotate its normal onto the target axis.
    if (axis === 'y') ring.rotation.x = -Math.PI / 2;
    else if (axis === 'x') ring.rotation.y = Math.PI / 2;
    group.add(ring);

    const pg = keep(new THREE.TorusGeometry(radius, Math.max(0.062, tube * 4.2), 6, 48));
    const pick = new THREE.Mesh(pg, keepM(pickMat()));
    if (axis === 'y') pick.rotation.x = -Math.PI / 2;
    else if (axis === 'x') pick.rotation.y = Math.PI / 2;

    return registerHandle({
      id: 'rot-' + axis, kind: 'rotate', axis, pick,
      parts: [ring], baseHex: hex, baseOpacity: opacity,
    });
  }

  // Yaw is the primary rotation: largest radius, most reachable.
  const hRotY = buildRing('y', 1.0, 0.0155, 0.95);
  const hRotX = buildRing('x', 0.62, 0.011, 0.6);
  const hRotZ = buildRing('z', 0.62, 0.011, 0.6);

  // 15° ticks on the yaw ring so the snap is legible.
  const tickPts = [];
  for (let d = 0; d < 360; d += ROTATE_SNAP_DEG) {
    const a = d * D2R;
    const inner = d % 90 === 0 ? 0.87 : 0.935;
    tickPts.push(new THREE.Vector3(Math.cos(a) * inner, 0, Math.sin(a) * inner));
    tickPts.push(new THREE.Vector3(Math.cos(a) * 1.055, 0, Math.sin(a) * 1.055));
  }
  const tickG = keep(new THREE.BufferGeometry().setFromPoints(tickPts));
  const ticks = new THREE.LineSegments(tickG, keepM(new THREE.LineBasicMaterial({
    color: new THREE.Color(AXIS_HEX.y), transparent: true, opacity: 0.5,
    depthTest: false, depthWrite: false,
  })));
  ticks.raycast = () => {};
  ticks.renderOrder = 31;
  ticks.frustumCulled = false;
  group.add(ticks);

  // Facing marker: shows which way the item's depth axis points.
  const faceMat = keepM(basicMat('#F5F2ED', 0.95));
  const faceG = keep(new THREE.ConeGeometry(0.05, 0.14, 12));
  faceG.rotateX(Math.PI / 2);
  const facing = decorate(new THREE.Mesh(faceG, faceMat), 3);
  group.add(facing);

  // ------------------------------------------------------------- state ------
  const target = {
    x_mm: 0, y_mm: 0, elev_mm: 0, rot_deg: 0,
    tilt_x_deg: 0, tilt_z_deg: 0,
    allowY: false, locked: false,
  };
  let mode = 'both';           // 'translate' | 'rotate' | 'both'
  let hovered = null;
  /** @type {null|object} */
  let drag = null;

  const _v = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _plane = new THREE.Plane();

  function originWorld(out) {
    return (out || _v).set(target.x_mm * MM, target.elev_mm * MM, -target.y_mm * MM);
  }

  function setTarget(t) {
    if (!t) { group.visible = false; return; }
    target.x_mm = t.x_mm || 0;
    target.y_mm = t.y_mm || 0;
    target.elev_mm = t.elev_mm || 0;
    target.rot_deg = t.rot_deg || 0;
    target.tilt_x_deg = t.tilt_x_deg || 0;
    target.tilt_z_deg = t.tilt_z_deg || 0;
    target.allowY = !!t.allowY;
    target.locked = !!t.locked;
    group.position.copy(originWorld());
    applyVisibility();
    const a = target.rot_deg * D2R;
    facing.position.set(-Math.sin(a) * 1.0, 0.006, -Math.cos(a) * 1.0);
    facing.rotation.set(0, a, 0);
  }

  function applyVisibility() {
    const showT = mode !== 'rotate';
    const showR = mode !== 'translate';
    for (const h of handles) {
      let on = h.kind === 'rotate' ? showR : showT;
      // SPEC2 §B: the elevation arrow is *hidden* for floor-standing pieces so
      // it can never be grabbed by accident.
      if (h.id === 'axis-y' && !target.allowY) on = false;
      if (target.locked) on = false;
      if (h.root) h.root.visible = on;
      h.parts.forEach((p) => { p.visible = on; });
      h.pick.visible = on;
      if (h.id === 'planar') { planeEdge.visible = on; }
    }
    ticks.visible = showR;
    facing.visible = showR;
  }

  function setMode(m) {
    mode = ['translate', 'rotate', 'both'].includes(m) ? m : 'both';
    applyVisibility();
    return mode;
  }
  function getMode() { return mode; }

  // ------------------------------------------------------- screen scale -----
  /** SPEC2 §B: ~110 CSS px across at any zoom, any item size. */
  function update(camera, viewportHeightPx) {
    if (!group.visible) return;
    const h = Math.max(1, viewportHeightPx || 1);
    let worldPerPx;
    if (camera.isOrthographicCamera) {
      worldPerPx = ((camera.top - camera.bottom) / (camera.zoom || 1)) / h;
    } else {
      const d = Math.max(1e-4, camera.position.distanceTo(group.position));
      worldPerPx = (2 * Math.tan((camera.fov * D2R) / 2) * d) / h;
    }
    const s = clamp((GIZMO_SPAN_PX * worldPerPx) / SPAN_UNITS, 1e-4, 1e4);
    group.scale.setScalar(s);
  }

  // --------------------------------------------------------- hit testing ----
  /**
   * @param {THREE.Raycaster} raycaster caller must have set the ray already
   * @returns {null|{handle:object,point:THREE.Vector3,distance:number}}
   */
  function hitTest(raycaster) {
    if (!group.visible) return null;
    // Same caveat as furniture picking: the raycaster does not refresh world
    // matrices, and the gizmo is re-scaled every frame.
    group.updateMatrixWorld(true);
    const prev = raycaster.layers.mask;
    raycaster.layers.set(GIZMO_LAYER);
    const hits = raycaster.intersectObjects(pickMeshes, false);
    raycaster.layers.mask = prev;
    if (!hits.length) return null;
    // Planar handle wins ties within a hair — it is the primary interaction and
    // sits inside every ring.
    let best = hits[0];
    for (const h of hits) {
      if (h.object.userData.gizmo.kind === 'planar' && h.distance < best.distance + 0.35) {
        best = h; break;
      }
    }
    const id = best.object.userData.gizmo.id;
    const handle = handles.find((x) => x.id === id) || null;
    if (!handle) return null;
    return { handle, point: best.point.clone(), distance: best.distance };
  }

  function setHover(handle) {
    if (hovered === handle) return;
    hovered = handle;
    refreshTint();
  }

  function refreshTint() {
    const active = drag ? drag.handle : null;
    const lit = active || hovered;
    for (const h of handles) {
      const isLit = h === lit;
      const dim = !!lit && !isLit;
      for (const p of h.parts) {
        const m = p.material;
        if (!m || !m.color) continue;
        m.color.set(h.baseHex);
        if (isLit) m.color.offsetHSL(0, 0.05, 0.22);
        m.opacity = isLit ? Math.min(1, h.baseOpacity + 0.2)
          : (dim ? h.baseOpacity * 0.42 : h.baseOpacity);
      }
    }
  }

  // ------------------------------------------------------- drag math --------
  /**
   * Choose the plane containing `axis` whose normal most faces the camera.
   * SPEC2 §B: "intersect the pointer ray with the plane through the item that
   * contains the axis and most faces the camera".
   */
  function axisDragPlane(axis, camera, origin) {
    const a = AXIS_DIR[axis];
    const cand = ['x', 'y', 'z'].filter((k) => k !== axis).map((k) => AXIS_DIR[k]);
    const view = _p.copy(camera.position).sub(origin).normalize();
    let n = cand[0], bestDot = -1;
    for (const c of cand) {
      const d = Math.abs(c.dot(view));
      if (d > bestDot) { bestDot = d; n = c; }
    }
    void a;
    return _plane.setFromNormalAndCoplanarPoint(n.clone(), origin);
  }

  function ringPlane(axis, origin) {
    return _plane.setFromNormalAndCoplanarPoint(AXIS_DIR[axis].clone(), origin);
  }

  /** Ray/plane intersection with the ≤4° degenerate guard. */
  function planeHit(raycaster, plane, out) {
    const dot = raycaster.ray.direction.dot(plane.normal);
    if (Math.abs(dot) < MIN_RAY_DOT) return null;
    const p = raycaster.ray.intersectPlane(plane, out || new THREE.Vector3());
    return p || null;
  }

  /** Ring angle, in *plan* degrees for yaw and local degrees for x/z rings. */
  function ringAngle(axis, origin, p) {
    const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
    if (axis === 'y') return Math.atan2(-dz, dx) * R2D;   // plan CCW
    if (axis === 'x') return Math.atan2(dy, -dz) * R2D;
    return Math.atan2(dy, dx) * R2D;                      // axis === 'z'
  }

  /**
   * Begin a drag. Records the anchor once; nothing after this reads the live
   * object transform (SPEC2 §B).
   */
  function beginDrag(handle, raycaster, camera) {
    if (!handle || target.locked) return null;
    const origin = originWorld(new THREE.Vector3());
    const start = {
      x_mm: target.x_mm, y_mm: target.y_mm, elev_mm: target.elev_mm,
      rot_deg: target.rot_deg, tilt_x_deg: target.tilt_x_deg, tilt_z_deg: target.tilt_z_deg,
    };
    let plane, anchorPoint, anchorScalar = 0, anchorAngle = 0;

    if (handle.kind === 'planar') {
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0), origin);
      anchorPoint = planeHit(raycaster, plane);
      if (!anchorPoint) return null;
    } else if (handle.kind === 'axis') {
      plane = axisDragPlane(handle.axis, camera, origin).clone();
      anchorPoint = planeHit(raycaster, plane);
      if (!anchorPoint) return null;
      anchorScalar = anchorPoint.clone().sub(origin).dot(AXIS_DIR[handle.axis]);
    } else {
      plane = ringPlane(handle.axis, origin).clone();
      anchorPoint = planeHit(raycaster, plane);
      if (!anchorPoint) return null;
      anchorAngle = ringAngle(handle.axis, origin, anchorPoint);
    }

    drag = {
      handle, plane, origin, start,
      anchorPoint, anchorScalar, anchorAngle,
      lastGood: { ...start },
      accumDeg: 0,
      prevAngle: anchorAngle,
      moved: false,
    };
    refreshTint();
    return drag;
  }

  /**
   * @param {THREE.Raycaster} raycaster
   * @param {object} opts { free:boolean } — Ctrl held ⇒ free (SPEC2 §A/§B)
   * @returns {null|object} proposed transform in mm/deg, or null if the ray is
   *          degenerate (caller should hold the previous value).
   */
  function moveDrag(raycaster, opts = {}) {
    if (!drag) return null;
    const free = !!opts.free;
    const p = planeHit(raycaster, drag.plane);
    if (!p) return { ...drag.lastGood, degenerate: true };
    const out = { ...drag.start };
    const h = drag.handle;

    if (h.kind === 'planar') {
      const dx = p.x - drag.anchorPoint.x;
      const dz = p.z - drag.anchorPoint.z;
      let x = drag.start.x_mm + dx / MM;
      let y = drag.start.y_mm - dz / MM;         // plan y = -three.z
      if (!free) { x = snapTo(x, TRANSLATE_SNAP_MM); y = snapTo(y, TRANSLATE_SNAP_MM); }
      out.x_mm = x; out.y_mm = y;
    } else if (h.kind === 'axis') {
      const s = p.clone().sub(drag.origin).dot(AXIS_DIR[h.axis]);
      let delta = (s - drag.anchorScalar) / MM;  // mm along the world axis
      if (h.axis === 'x') {
        let x = drag.start.x_mm + delta;
        if (!free) x = snapTo(x, TRANSLATE_SNAP_MM);
        out.x_mm = x;
      } else if (h.axis === 'z') {
        // world +z is plan -y
        let yv = drag.start.y_mm - delta;
        if (!free) yv = snapTo(yv, TRANSLATE_SNAP_MM);
        out.y_mm = yv;
      } else {
        let e = drag.start.elev_mm + delta;
        if (!free) e = snapTo(e, TRANSLATE_SNAP_MM);
        out.elev_mm = Math.max(0, e);            // never below the floor
      }
    } else {
      const ang = ringAngle(h.axis, drag.origin, p);
      // Unwrap incrementally so a drag through the ±180 seam never jumps 360°.
      drag.accumDeg += unwrapDeg(drag.prevAngle, ang);
      drag.prevAngle = ang;
      const total = drag.accumDeg;
      if (h.axis === 'y') {
        let r = drag.start.rot_deg + total;
        if (!free) r = snapTo(r, ROTATE_SNAP_DEG);
        out.rot_deg = norm360(r);
      } else if (h.axis === 'x') {
        let r = drag.start.tilt_x_deg + total;
        if (!free) r = snapTo(r, ROTATE_SNAP_DEG);
        out.tilt_x_deg = clamp(r, -90, 90);
      } else {
        let r = drag.start.tilt_z_deg + total;
        if (!free) r = snapTo(r, ROTATE_SNAP_DEG);
        out.tilt_z_deg = clamp(r, -90, 90);
      }
    }
    drag.lastGood = { ...out };
    drag.moved = true;
    return out;
  }

  function endDrag() {
    const d = drag;
    drag = null;
    refreshTint();
    return d;
  }

  function isDragging() { return !!drag; }
  function activeHandle() { return drag ? drag.handle : null; }

  function dispose() {
    geoms.forEach((g) => g.dispose && g.dispose());
    mats.forEach((m) => m.dispose && m.dispose());
    geoms.length = 0; mats.length = 0;
    if (group.parent) group.parent.remove(group);
  }

  applyVisibility();

  return {
    group, handles, pickMeshes,
    setTarget, setMode, getMode, update, hitTest, setHover,
    beginDrag, moveDrag, endDrag, isDragging, activeHandle,
    get visible() { return group.visible; },
    set visible(v) { group.visible = !!v; if (v) applyVisibility(); },
    get target() { return { ...target }; },
    dispose,
  };
}

export default createGizmo;

// packages/three-editor/editor.js
// createEditor(...) — implements SPEC §5.3 verbatim.
// Storage is mm (SPEC §1); the scene is metres; three.x = plan.x/1000, three.z = -plan.y/1000,
// rotation is CCW degrees about the vertical axis and maps directly to group.rotation.y.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { createMaterialLibrary, TOKENS } from './materials.js';
import { buildRoom, roomBounds, pointInPolygon, planToThree } from './room.js';
import {
  buildProxy, disposeProxy, setProxyImage, clearProxyImage, contactShadow,
} from './proxies.js';
import { applyRenderer, createEnvironment, createLighting, enableShadows }
  from './lighting.js';
import {
  detectCollisions, footprintOBB, obbCorners, obbWallDistances, clearanceOBB, isFloorCollider,
  clampToRoom, snapToWallPlane, obbInsideRoom,
} from './collision.js';
import {
  createOrbitControls, createPlanControls, createFirstPerson,
  resolveSnap, snapRotation, GRID_MM, polygonAdmits,
  BODY_RADIUS_MM, WALK_MPS, SPRINT_MPS, CROUCH_MPS, EYE_STAND_M, EYE_CROUCH_M,
} from './controls.js';
import { createGizmo, GIZMO_LAYER, GIZMO_SPAN_PX } from './gizmo.js';

const MM = 1 / 1000;
const D2R = Math.PI / 180;

/**
 * SPEC2 §C.1 — a dedicated raycast layer. Only item proxy meshes join it, so
 * `raycaster.layers.set(PICK_LAYER)` can never reach a helper mesh. Belt and
 * braces on top of the no-op `raycast` methods.
 */
export const PICK_LAYER = 2;
/** SPEC2 §C.5 — depth window in which a non-rug beats a rug. */
const RUG_DEPTH_TOL_M = 0.15;

// ---------------------------------------------------------------------------
// units (SPEC §1 — display only, never stored)
// ---------------------------------------------------------------------------
export function fmtLen(mm, unit = 'cm') {
  if (mm == null || !isFinite(mm)) return '—';
  if (unit === 'mm') return `${Math.round(mm)} mm`;
  if (unit === 'cm') {
    const v = mm / 10;
    return `${(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))} cm`;
  }
  // ft-in
  const totalIn = mm / 25.4;
  let ft = Math.floor(totalIn / 12);
  let inch = totalIn - ft * 12;
  let frac = Math.round(inch * 2) / 2;   // nearest 1/2"
  if (frac >= 12) { ft += 1; frac -= 12; }
  const fracStr = Number.isInteger(frac) ? `${frac}` : `${Math.floor(frac)}½`;
  return `${ft}'${fracStr}"`;
}
export const mm2m = (mm) => mm / 1000;
export const m2mm = (m) => Math.round(m * 1000);

function normalizeCatalog(catalog) {
  const map = new Map();
  if (!catalog) return map;
  if (catalog instanceof Map) return new Map(catalog);
  const items = Array.isArray(catalog) ? catalog : (catalog.items || Object.values(catalog));
  for (const it of items) if (it && it.id) map.set(it.id, it);
  return map;
}

function emptyLayout() {
  return {
    id: 'layout_editor', seed: 1, mode: 'use-mine', style: 'neutral', score: 0,
    placements: [], rationale: [], violations: [], metrics: {},
  };
}

/** SPEC §5.3 */
export function createEditor({
  mount, room, catalog, layout, unit = 'cm',
  onChange, onSelect, onViolations,
  wallThickness_mm, background = TOKENS.ink, clearances = false,
} = {}) {
  if (!mount) throw new Error('createEditor: `mount` element is required');

  // ---------------- core state ----------------
  const S = {
    room: room || defaultRoom(),
    catalog: normalizeCatalog(catalog),
    placements: [],
    unit,
    mode: 'translate',
    view: '3d',
    selection: null,
    showClearances: !!clearances,
    violations: [],
    overlapping: new Set(),
    instances: new Map(),   // instance_id -> {placement, item, group, overlay, outline, clearance}
    seq: 0,
    undo: [], redo: [],
    layoutMeta: { id: 'layout_editor', seed: 1, mode: 'use-mine', style: 'neutral', rationale: [] },
    disposed: false,
    wallThickness_mm,
  };

  // ---------------- renderer / scene ----------------
  mount.classList.add('ai-editor-mount');
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';

  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: false, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(background), 1);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.setAttribute('tabindex', '0');
  renderer.domElement.setAttribute('aria-label', 'Room 3D editor viewport');
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  const mats = createMaterialLibrary();

  // Lighting: the §G realism rig replaces the four flat lights that used to live
  // here (hemi + dir + fill + ambient, no shadows at all). See REALISM.md §1.
  // Shadow maps are rendered on demand — `renderer.shadowMap.autoUpdate` is false
  // — because regenerating them every frame cost ~85% of the frame budget on a
  // software renderer (5.4fps vs 135fps). Anything that moves geometry must call
  // `rig.invalidateShadows()`.
  applyRenderer(renderer);
  const env = createEnvironment(renderer);
  scene.environment = env.texture;
  const rig = createLighting({ scene, renderer });

  // cameras
  const persp = new THREE.PerspectiveCamera(48, 1, 0.05, 300);
  const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, -50, 200);
  const fpCam = new THREE.PerspectiveCamera(68, 1, 0.03, 200);
  let camera = persp;

  const orbit = createOrbitControls(persp, renderer.domElement, { minDistance: 0.6, maxDistance: 60 });
  const plan = createPlanControls(ortho, renderer.domElement, {});
  const fp = createFirstPerson(fpCam, renderer.domElement, { canStand });
  // SPEC2 §B — the manipulation gizmo replaces "drag the mesh across the floor".
  const gizmo = createGizmo();
  scene.add(gizmo.group);

  // furniture container
  const furniture = new THREE.Group();
  furniture.name = 'furniture';
  scene.add(furniture);

  // snap guides
  const guideGeom = new THREE.BufferGeometry();
  guideGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(120), 3));
  const guides = new THREE.LineSegments(guideGeom, mats.lineMat(TOKENS.clay, 0.85));
  guides.frustumCulled = false;
  guides.visible = false;
  guides.raycast = () => {};              // SPEC2 §C.1 — never a pick target
  scene.add(guides);

  // Wall-snap indicator (SPEC2 §F: "snapping must be visibly indicated").
  // Owned here rather than by room.js, whose wall material is shared.
  const wallHiGeom = new THREE.BufferGeometry();
  wallHiGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const wallHi = new THREE.Line(wallHiGeom, mats.lineMat(TOKENS.clay, 0.95));
  wallHi.raycast = () => {};
  wallHi.frustumCulled = false;
  wallHi.visible = false;
  scene.add(wallHi);

  // ---------------- HUD ----------------
  const hud = document.createElement('div');
  hud.className = 'ai-editor-hud';
  hud.setAttribute('role', 'status');
  hud.style.cssText = [
    'position:absolute', 'pointer-events:none', 'left:0', 'top:0', 'z-index:5',
    'font:11px/1.5 "JetBrains Mono", ui-monospace, monospace',
    'letter-spacing:.02em', 'color:#F5F2ED',
    'background:rgba(18,18,21,.86)', 'border:1px solid rgba(255,255,255,.16)',
    'border-radius:8px', 'padding:7px 9px', 'white-space:pre',
    'backdrop-filter:blur(10px)', 'display:none', 'transform:translate(-50%,-100%)',
  ].join(';');
  mount.appendChild(hud);

  const badge = document.createElement('div');
  badge.className = 'ai-editor-viewbadge';
  badge.style.cssText = [
    'position:absolute', 'right:10px', 'bottom:10px', 'z-index:5', 'pointer-events:none',
    'font:10px/1 "JetBrains Mono", ui-monospace, monospace', 'letter-spacing:.14em',
    'text-transform:uppercase', 'color:#8A8A93',
  ].join(';');
  mount.appendChild(badge);

  // ---------------- room shell ----------------
  let shell = null;
  function rebuildRoom() {
    if (shell) { scene.remove(shell.group); shell.dispose(); }
    shell = buildRoom(S.room, mats, { wallThickness_mm: S.wallThickness_mm });
    scene.add(shell.group);
    // Tight shadow camera == crisp contact shadows (REALISM.md §1.3). `buildRoom`
    // does not surface `openings`, so hand them over for the window daylight.
    rig.fit({ ...shell, openings: S.room.openings || [] });
    orbit.frame(shell.bounds, shell.height_mm);
    fp.place(shell.bounds);
    fitOrtho();
  }

  /** Explicit plan re-frame. SPEC2 §D: only on fit or resize, never per frame. */
  function fitOrtho() {
    if (!shell) return;
    plan.fit(shell.bounds, { w: size.w, h: size.h });
  }

  // ---------------- sizing ----------------
  const size = { w: 640, h: 420 };
  function resize() {
    const r = mount.getBoundingClientRect();
    size.w = Math.max(120, Math.round(r.width || 640));
    size.h = Math.max(120, Math.round(r.height || 420));
    renderer.setSize(size.w, size.h, false);
    persp.aspect = size.w / size.h; persp.updateProjectionMatrix();
    fpCam.aspect = size.w / size.h; fpCam.updateProjectionMatrix();
    // Resize keeps the user's plan zoom + centre (SPEC2 §D).
    plan.resize(size.w, size.h);
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(mount);
  window.addEventListener('resize', resize);

  // ---------------- instances ----------------
  function itemOf(placement) { return S.catalog.get(placement.item_id); }

  function elevationOf(item) {
    const pl = item.placement || {};
    if (pl.wall_mounted && pl.mount_h_mm) return pl.mount_h_mm;
    if (pl.ceiling_mounted) return (S.room.height_mm || 2600) - (item.dims_mm.h || 0);
    return 0;
  }

  function elevOf(rec) {
    return rec.placement.elev_mm != null ? rec.placement.elev_mm : elevationOf(rec.item);
  }

  function applyTransform(rec) {
    const p = rec.placement;
    rec.group.position.set(p.x_mm * MM, elevOf(rec) * MM, -p.y_mm * MM);
    // rot_deg is CCW positive about the vertical axis (SPEC §1). tilt_x/tilt_z
    // are the gizmo's secondary rotation rings (SPEC2 §B) and default to 0.
    rec.group.rotation.order = 'YXZ';
    rec.group.rotation.set(
      (p.tilt_x_deg || 0) * D2R,
      (p.rot_deg || 0) * D2R,
      (p.tilt_z_deg || 0) * D2R,
    );
  }

  function buildInstance(placement) {
    const item = itemOf(placement);
    if (!item) { console.warn('[editor] unknown item_id', placement.item_id); return null; }
    const group = new THREE.Group();
    group.name = 'inst:' + placement.instance_id;
    const hex = (item.colorways && item.colorways[placement.colorway | 0])
      ? item.colorways[placement.colorway | 0].hex : null;
    const proxy = buildProxy(item, { materials: mats, colorwayHex: hex });
    enableShadows(proxy);
    // SPEC2 §C.1/§C.2 — proxy meshes are the ONLY pickable geometry.
    proxy.traverse((o) => {
      if (o.isMesh) {
        o.layers.enable(PICK_LAYER);
        o.userData.instance_id = placement.instance_id;
      }
    });
    group.add(proxy);

    const d = item.dims_mm;
    // collision tint overlay (--err @ 35%)
    const ovGeom = new THREE.BoxGeometry(d.w * MM * 1.005, d.h * MM * 1.005, d.d * MM * 1.005);
    const overlay = new THREE.Mesh(ovGeom, mats.errTint);
    overlay.position.y = (d.h * MM) / 2;
    overlay.visible = false;
    overlay.renderOrder = 8;
    // SPEC2 §C root cause: this box spans the item's whole bounding volume and
    // three.js raycasts invisible objects, so it used to steal neighbours'
    // clicks. Neutralised.
    overlay.raycast = () => {};
    group.add(overlay);

    // selection outline (footprint + bbox edges)
    const boxGeom = new THREE.BoxGeometry(d.w * MM, d.h * MM, d.d * MM);
    const edges = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();
    const outline = new THREE.LineSegments(edges, mats.lineMat(TOKENS.clay, 0.95));
    outline.position.y = (d.h * MM) / 2;
    outline.visible = false;
    outline.renderOrder = 12;
    outline.raycast = () => {};           // SPEC2 §C.1
    group.add(outline);

    // clearance envelope, dashed --blueprint footprint
    const cl = item.clearance_mm || {};
    const cw = d.w + (cl.left || 0) + (cl.right || 0);
    const cd = d.d + (cl.front || 0) + (cl.back || 0);
    const offX = ((cl.right || 0) - (cl.left || 0)) / 2;
    const offY = ((cl.front || 0) - (cl.back || 0)) / 2;
    const pts = [
      new THREE.Vector3(-cw / 2, 0, -cd / 2), new THREE.Vector3(cw / 2, 0, -cd / 2),
      new THREE.Vector3(cw / 2, 0, cd / 2), new THREE.Vector3(-cw / 2, 0, cd / 2),
      new THREE.Vector3(-cw / 2, 0, -cd / 2),
    ].map((v) => new THREE.Vector3(v.x * MM + offX * MM, 0.006, v.z * MM - offY * MM));
    const clGeom = new THREE.BufferGeometry().setFromPoints(pts);
    const clearance = new THREE.Line(clGeom, mats.lineMat(TOKENS.blueprint, 0.9, true));
    clearance.computeLineDistances();
    clearance.visible = false;
    // The worst offender: a sofa's clearance footprint reaches 750mm past its
    // front edge. SPEC2 §C.1 — no-op raycast.
    clearance.raycast = () => {};
    group.add(clearance);

    furniture.add(group);
    const rec = { placement, item, group, proxy, overlay, outline, clearance, ovGeom, edges, clGeom };
    if (S.view === 'top') {
      outline.visible = true;
      outline.material.color.set(TOKENS.bone);
      outline.material.opacity = 0.34;
    }
    applyTransform(rec);
    S.instances.set(placement.instance_id, rec);
    return rec;
  }

  function destroyInstance(id) {
    const rec = S.instances.get(id);
    if (!rec) return;
    furniture.remove(rec.group);
    disposeProxy(rec.proxy);
    rec.ovGeom.dispose(); rec.edges.dispose(); rec.clGeom.dispose();
    S.instances.delete(id);
  }

  function clearInstances() {
    [...S.instances.keys()].forEach(destroyInstance);
  }

  // ---------------- history ----------------
  function historySnapshot() {
    return JSON.stringify({ p: S.placements, sel: S.selection });
  }
  let suppressHistory = false;
  function pushHistory() {
    if (suppressHistory) return;
    S.undo.push(historySnapshot());
    if (S.undo.length > 60) S.undo.shift();
    S.redo.length = 0;
  }
  function restore(json) {
    const st = JSON.parse(json);
    suppressHistory = true;
    setPlacements(st.p);
    select(st.sel, { silent: false });
    suppressHistory = false;
  }
  function undo() {
    if (!S.undo.length) return false;
    S.redo.push(historySnapshot());
    restore(S.undo.pop());
    emitChange();
    return true;
  }
  function redo() {
    if (!S.redo.length) return false;
    S.undo.push(historySnapshot());
    restore(S.redo.pop());
    emitChange();
    return true;
  }

  // ---------------- placements ----------------
  function setPlacements(list) {
    clearInstances();
    S.placements = (list || []).map((p) => ({
      instance_id: p.instance_id || nextId(),
      item_id: p.item_id,
      x_mm: Math.round(p.x_mm || 0),
      y_mm: Math.round(p.y_mm || 0),
      rot_deg: ((p.rot_deg || 0) % 360 + 360) % 360,
      colorway: p.colorway | 0,
      against: p.against || null,
      locked: !!p.locked,
      added_by_ai: !!p.added_by_ai,
      // Additive gizmo fields (SPEC2 §B). Absent ⇒ 0 / mount default.
      tilt_x_deg: Math.round(p.tilt_x_deg || 0),
      tilt_z_deg: Math.round(p.tilt_z_deg || 0),
      ...(p.elev_mm != null ? { elev_mm: Math.round(p.elev_mm) } : {}),
    }));
    for (const p of S.placements) {
      const n = parseInt(String(p.instance_id).replace(/\D/g, ''), 10);
      if (isFinite(n) && n > S.seq) S.seq = n;
    }
    S.placements.forEach(buildInstance);
    if (S.selection && !S.instances.has(S.selection)) S.selection = null;
    revalidate();
  }
  function nextId() { S.seq += 1; return 'i' + S.seq; }

  function findPlacement(id) { return S.placements.find((p) => p.instance_id === id) || null; }

  // ---------------- validation ----------------
  let externalValidate = null;   // optional layout-engine hook
  function revalidate() {
    const res = detectCollisions({
      room: S.room, placements: S.placements, catalog: S.catalog, clearances: true,
    });
    let violations = res.violations;
    if (typeof externalValidate === 'function') {
      try {
        const extra = externalValidate({ room: S.room, layout: getLayout(true), catalog: S.catalog }) || [];
        // The layout engine and the editor's own collision pass cover the same
        // rule domain: clearance intrusions, out-of-bounds, blocked openings.
        // Concatenating them double-reported every conflict (a layout the engine
        // scored 0.639 with 6 findings surfaced 21 rows), and they word the same
        // finding differently — "LANDSKRONA needs 750mm in front; TULLSTA eats
        // 307mm of it" next to "LISABO intrudes 349mm into LANDSKRONA's
        // clearance" — so key-based de-duplication cannot reliably pair them.
        //
        // When an engine validator is wired it is the single authority for the
        // violations panel: one consistent voice, and the list always agrees with
        // the score the engine reported. The internal pass still runs, because
        // `res.overlapping` drives the red collision tint in the viewport.
        if (extra.length || S.placements.length) violations = extra;
      } catch (e) { /* engine is optional — never break the editor */ }
    }
    S.violations = violations;
    S.overlapping = res.overlapping;
    for (const [id, rec] of S.instances) {
      rec.overlay.visible = S.overlapping.has(id);
      rec.clearance.visible = S.showClearances && isFloorCollider(rec.item);
    }
    if (onViolations) onViolations(S.violations);
  }

  function emitChange() {
    // Shadow maps are on-demand (autoUpdate=false); anything that moved geometry
    // must mark them dirty or the scene keeps stale shadows.
    rig.invalidateShadows();
    updateHud();
    if (onChange) onChange(getLayout());
  }

  // ---------------- outlines ----------------
  /**
   * In 3D only the selected piece is outlined. In the plan view every piece gets
   * a light outline, the way a real floor plan is drawn — without it dark items
   * vanish into the dark floor. LANDSKRONA's default colorway is "Glose black
   * leather" (#232326), so from above the sofa rendered as an unreadable void
   * and looked like missing geometry rather than furniture.
   */
  function applyOutlineStyle() {
    const plan = S.view === 'top';
    for (const [k, rec] of S.instances) {
      const isSel = k === S.selection;
      rec.outline.visible = isSel || plan;
      const m = rec.outline.material;
      if (!m) continue;
      if (isSel) { m.color.set(TOKENS.clay); m.opacity = 0.95; }
      else if (plan) { m.color.set(TOKENS.bone); m.opacity = 0.34; }
      m.needsUpdate = true;
    }
  }


  /**
   * Bounds/mount constraint for programmatic placement changes (SPEC2 §F).
   * The drag path already clamps; this gives `setPosition` / `setRotation` the
   * same guarantee so no caller can park furniture outside the floor polygon.
   * Wall- and ceiling-mounted pieces are governed by their mount instead.
   */
  function constrainProgrammatic(rec, prop) {
    const x = Math.round(prop.x_mm), y = Math.round(prop.y_mm);
    const rot = ((Math.round(prop.rot_deg || 0) % 360) + 360) % 360;
    if (!rec || !rec.item) return { x_mm: x, y_mm: y, rot_deg: rot };
    const mount = rec.item.placement || {};
    if (mount.wall_mounted) {
      const w = snapToWallPlane({ x_mm: x, y_mm: y, rot_deg: rot }, rec.item, S.room);
      return { x_mm: Math.round(w.x_mm), y_mm: Math.round(w.y_mm), rot_deg: rot };
    }
    if (mount.ceiling_mounted) return { x_mm: x, y_mm: y, rot_deg: rot };
    const cl = clampToRoom({ x_mm: x, y_mm: y, rot_deg: rot }, rec.item, S.room,
      { snap: false, snap_mm: 0, grid_mm: 0 });
    return { x_mm: Math.round(cl.x_mm), y_mm: Math.round(cl.y_mm), rot_deg: rot };
  }

  // ---------------- selection ----------------
  function select(id, { silent = false } = {}) {
    if (id && !S.instances.has(id)) id = null;
    S.selection = id || null;
    applyOutlineStyle();
    const rec = S.selection ? S.instances.get(S.selection) : null;
    if (rec) syncGizmoTo(rec);
    else gizmo.visible = false;
    updateHud();
    if (!silent && onSelect) onSelect(rec ? { ...rec.placement, item: rec.item } : null);
  }

  /**
   * Point the gizmo at a record. Safe to call mid-drag: the drag's anchor,
   * plane and start transform live inside gizmo.js and are never re-derived
   * from this (SPEC2 §B — that re-derivation is the shake bug).
   */
  function syncGizmoTo(rec) {
    if (!rec) { gizmo.visible = false; return; }
    const pl = rec.item.placement || {};
    gizmo.setTarget({
      x_mm: rec.placement.x_mm,
      y_mm: rec.placement.y_mm,
      elev_mm: elevOf(rec),
      rot_deg: rec.placement.rot_deg || 0,
      tilt_x_deg: rec.placement.tilt_x_deg || 0,
      tilt_z_deg: rec.placement.tilt_z_deg || 0,
      // SPEC2 §B: the Y arrow only exists for mounted pieces.
      allowY: !!(pl.wall_mounted || pl.ceiling_mounted),
      locked: !!rec.placement.locked,
    });
    gizmo.visible = S.mode !== 'scale-none' && S.view !== 'first-person';
    gizmo.update(camera, size.h);
  }

  /** Wall segment highlight while a snap is active (SPEC2 §F). */
  function highlightWall(idx) {
    if (idx == null) { wallHi.visible = false; return; }
    const poly = S.room.polygon_mm || [];
    const a = poly[idx], b = poly[(idx + 1) % poly.length];
    if (!a || !b) { wallHi.visible = false; return; }
    const arr = wallHiGeom.attributes.position.array;
    arr[0] = a[0] * MM; arr[1] = 0.024; arr[2] = -a[1] * MM;
    arr[3] = b[0] * MM; arr[4] = 0.024; arr[5] = -b[1] * MM;
    wallHiGeom.attributes.position.needsUpdate = true;
    wallHi.visible = true;
  }

  /**
   * SPEC2 §E — where the walking body may stand: inside the room polygon with a
   * 250mm body radius, and outside every floor collider's footprint.
   */
  function canStand(x_m, z_m) {
    const x_mm = x_m / MM, y_mm = -z_m / MM;
    if (!polygonAdmits(x_mm, y_mm, S.room.polygon_mm, BODY_RADIUS_MM)) return false;
    for (const [, rec] of S.instances) {
      if (!isFloorCollider(rec.item)) continue;
      const o = footprintOBB(rec.placement, rec.item);
      const dx = x_mm - o.cx, dy = y_mm - o.cy;
      const lx = dx * o.cos + dy * o.sin;
      const ly = -dx * o.sin + dy * o.cos;
      if (Math.abs(lx) <= o.hw + BODY_RADIUS_MM && Math.abs(ly) <= o.hd + BODY_RADIUS_MM) return false;
    }
    return true;
  }

  // ---------------- HUD ----------------
  const tmpV = new THREE.Vector3();
  function updateHud() {
    const rec = S.selection ? S.instances.get(S.selection) : null;
    if (!rec || S.view === 'first-person') { hud.style.display = 'none'; return; }
    const d = rec.item.dims_mm;
    const obb = footprintOBB(rec.placement, rec.item);
    const wd = obbWallDistances(obb, S.room).slice(0, 2);
    const u = S.unit;
    const lines = [
      `${rec.item.name}  ${rec.item.product_type || ''}`.trim(),
      `${fmtLen(d.w, u)} × ${fmtLen(d.d, u)} × ${fmtLen(d.h, u)}`,
      `rot ${Math.round(rec.placement.rot_deg || 0)}°   x ${fmtLen(rec.placement.x_mm, u)}  y ${fmtLen(rec.placement.y_mm, u)}`,
    ];
    wd.forEach((w) => lines.push(`wall ${w.wall_index}  ${fmtLen(w.dist, u)}`));
    if (S.overlapping.has(rec.placement.instance_id)) lines.push('⚠ collision');
    hud.textContent = lines.join('\n');
    hud.style.display = 'block';
    tmpV.set(rec.placement.x_mm * MM, (d.h + 120) * MM, -rec.placement.y_mm * MM);
    tmpV.project(camera);
    const x = (tmpV.x * 0.5 + 0.5) * size.w;
    const y = (-tmpV.y * 0.5 + 0.5) * size.h;
    hud.style.left = Math.max(70, Math.min(size.w - 70, x)) + 'px';
    hud.style.top = Math.max(74, Math.min(size.h - 8, y)) + 'px';
  }

  /** World point -> client (page) coordinates through the active camera. */
  function worldToClient(v) {
    camera.updateMatrixWorld();
    const r = renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(camera);
    return {
      x: r.left + (p.x * 0.5 + 0.5) * r.width,
      y: r.top + (-p.y * 0.5 + 0.5) * r.height,
      ndc: { x: p.x, y: p.y, z: p.z },
    };
  }

  // ---------------- picking ----------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function toNdc(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    return ndc;
  }
  function floorPoint(ev) {
    raycaster.setFromCamera(toNdc(ev), camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(floorPlane, hit)) return null;
    return { x_mm: hit.x / MM, y_mm: -hit.z / MM, v: hit };
  }
  /**
   * Every proxy mesh currently in the scene. Nothing else is pickable.
   *
   * `Raycaster.intersectObjects` does NOT refresh world matrices — it assumes
   * the renderer already did. A pick issued between `add()` and the next
   * rendered frame therefore tested meshes still sitting at the origin and
   * silently missed everything, which made programmatic picks (and the first
   * click after adding an item) unreliable. Refresh explicitly.
   */
  function pickTargets() {
    furniture.updateMatrixWorld(true);
    const out = [];
    for (const [, rec] of S.instances) {
      if (!rec.group.visible) continue;
      rec.proxy.traverse((o) => { if (o.isMesh && o.visible) out.push(o); });
    }
    return out;
  }

  /** SPEC2 §C.3 — an invisible ancestor disqualifies a candidate. */
  function ancestorsVisible(o) {
    let n = o;
    while (n && n !== scene) { if (!n.visible) return false; n = n.parent; }
    return true;
  }

  function instanceIdOf(obj) {
    let o = obj;
    while (o && o.parent !== furniture) o = o.parent;
    return (o && typeof o.name === 'string' && o.name.startsWith('inst:')) ? o.name.slice(5) : null;
  }

  function isRug(rec) {
    return !!rec && (rec.item.archetype === 'rug' || rec.item.category === 'rugs');
  }

  /**
   * SPEC2 §C. Raycast **only** item proxy meshes, on PICK_LAYER, skipping
   * anything invisible. Nearest hit wins, except that a rug never shadows the
   * thing standing on it.
   * @returns {null|{id:string,rec:object,distance:number,rug:boolean}}
   */
  function pickFurniture(ev) {
    raycaster.setFromCamera(toNdc(ev), camera);
    const prevMask = raycaster.layers.mask;
    raycaster.layers.set(PICK_LAYER);
    let hits;
    try {
      hits = raycaster.intersectObjects(pickTargets(), false);
    } finally {
      raycaster.layers.mask = prevMask;
    }
    const ranked = [];
    const seen = new Set();
    for (const h of hits) {
      if (!h.object.visible || !ancestorsVisible(h.object)) continue;
      const id = instanceIdOf(h.object);
      if (!id || seen.has(id)) continue;
      const rec = S.instances.get(id);
      if (!rec) continue;
      seen.add(id);
      ranked.push({ id, rec, distance: h.distance, rug: isRug(rec) });
    }
    if (!ranked.length) return null;
    const nearest = ranked[0];
    if (nearest.rug) {
      // SPEC2 §C.5 — flat floor-level pieces must not win a near-tie.
      const alt = ranked.find((r) => !r.rug && (r.distance - nearest.distance) <= RUG_DEPTH_TOL_M);
      if (alt) return alt;
    }
    return nearest;
  }

  /** Combined pick. Gizmo handles always take priority (SPEC2 §C.4). */
  function pick(ev) {
    raycaster.setFromCamera(toNdc(ev), camera);
    const g = gizmo.visible ? gizmo.hitTest(raycaster) : null;
    const f = pickFurniture(ev);
    return {
      gizmo: g,
      instance: f ? f.id : null,
      instanceD: f ? f.distance : Infinity,
      furniture: f,
    };
  }
  function pickInstance(ev) { return pick(ev).instance; }

  // ---------------- interaction (SPEC2 §A — the only bindings) -------------
  // Left click: select furniture, nothing else. Left drag on a gizmo handle:
  // manipulate. Left drag on empty space: nothing. Right drag: orbit (3D) /
  // pan (plan) / look (walk) and NEVER selects. Middle drag: pan, vertically
  // inverted in 3D. Wheel: zoom at the cursor. Ctrl+drag: free transform.
  const drag = {
    active: false, kind: null, id: null, start: null, moved: false,
    pointerId: null, free: false, moves: 0,
  };
  /** Set by a right/middle drag so the trailing `click` can't select. */
  let suppressClick = false;

  const isFree = (ev) => !!(ev && (ev.ctrlKey || ev.metaKey));

  function capture(ev) {
    drag.pointerId = ev.pointerId != null ? ev.pointerId : null;
    if (drag.pointerId == null) return;
    try { renderer.domElement.setPointerCapture(drag.pointerId); } catch (e) { /* synthetic */ }
  }
  function releaseCapture() {
    if (drag.pointerId == null) return;
    try { renderer.domElement.releasePointerCapture(drag.pointerId); } catch (e) { /* gone */ }
    drag.pointerId = null;
  }

  function beginGizmoDrag(handle, ev, id) {
    const rec = S.instances.get(id);
    if (!rec || rec.placement.locked) return false;
    const d = gizmo.beginDrag(handle, raycaster, camera);
    if (!d) return false;
    drag.active = true; drag.kind = 'gizmo'; drag.id = id;
    drag.start = historySnapshot(); drag.moved = false; drag.moves = 0;
    drag.free = isFree(ev);
    capture(ev);
    orbit.enabled = false;
    plan.enabled = false;
    return true;
  }

  function onPointerDown(ev) {
    if (S.disposed) return;
    renderer.domElement.focus({ preventScroll: true });

    // ---- walk view: right drag looks. Nothing else. ----
    if (S.view === 'first-person') {
      if (ev.button === 2) { ev.preventDefault(); suppressClick = true; fp.begin(ev); }
      return;
    }

    // ---- right drag: orbit in 3D, pan in plan. Never picks. ----
    if (ev.button === 2) {
      ev.preventDefault();
      suppressClick = true;
      if (S.view === 'top') { plan.enabled = true; plan.begin(ev); }
      else { orbit.enabled = true; orbit.begin(ev, 'orbit'); }
      return;
    }

    // ---- middle drag: pan. Vertically inverted in 3D (SPEC2 §A #4b). ----
    if (ev.button === 1) {
      ev.preventDefault();
      suppressClick = true;
      if (S.view === 'top') { plan.enabled = true; plan.begin(ev); }
      else { orbit.enabled = true; orbit.begin(ev, 'pan-invert'); }
      return;
    }

    if (ev.button !== 0) return;

    raycaster.setFromCamera(toNdc(ev), camera);
    // Gizmo handles take priority over everything (SPEC2 §C.4).
    if (gizmo.visible && S.selection) {
      const g = gizmo.hitTest(raycaster);
      if (g && beginGizmoDrag(g.handle, ev, S.selection)) return;
    }

    const hit = pickFurniture(ev);
    if (hit) {
      if (hit.id !== S.selection) select(hit.id);
      // Ctrl+drag straight off the body = free transform (SPEC2 §A; Alt no
      // longer does this).
      if (isFree(ev)) {
        raycaster.setFromCamera(toNdc(ev), camera);
        const planar = gizmo.handles.find((h) => h.id === 'planar');
        if (planar) beginGizmoDrag(planar, ev, hit.id);
      }
      return;
    }

    // Left click on empty space deselects; a left DRAG there does nothing.
    if (S.selection) select(null);
  }

  function onPointerMove(ev) {
    if (S.disposed || S.view === 'first-person') return;

    if (!drag.active) {
      // Hover feedback on the gizmo (SPEC2 §B).
      if (gizmo.visible && !orbit.isDragging() && !plan.isDragging()) {
        raycaster.setFromCamera(toNdc(ev), camera);
        const g = gizmo.hitTest(raycaster);
        gizmo.setHover(g ? g.handle : null);
        renderer.domElement.style.cursor = g ? 'grab' : '';
      }
      return;
    }
    if (drag.pointerId != null && ev.pointerId != null && ev.pointerId !== drag.pointerId) return;
    const rec = S.instances.get(drag.id);
    if (!rec) return;

    raycaster.setFromCamera(toNdc(ev), camera);
    const free = drag.free || isFree(ev);
    const prop = gizmo.moveDrag(raycaster, { free });
    if (!prop) return;
    drag.moves += 1;
    if (prop.degenerate) return;          // held last good value; do not commit
    drag.moved = true;
    applyProposal(rec, prop, free);
  }

  /**
   * Take the gizmo's projective proposal and land it: snapping (unless Ctrl),
   * then the SPEC2 §F bounds clamp, then the scene + HUD + validation.
   */
  function applyProposal(rec, prop, free) {
    const p = rec.placement;
    const handle = gizmo.activeHandle();
    const rotating = !!handle && handle.kind === 'rotate';
    let x = prop.x_mm, y = prop.y_mm, rot = prop.rot_deg;
    let guideList = [];
    let markWall = null;

    if (!free && !rotating) {
      const neighbours = S.placements
        .filter((q) => q.instance_id !== p.instance_id && S.catalog.get(q.item_id))
        .map((q) => ({ placement: q, item: S.catalog.get(q.item_id) }));
      const snap = resolveSnap({
        x_mm: x, y_mm: y, rot_deg: rot, item: rec.item, room: S.room, neighbours, free: false,
      });
      x = snap.x_mm; y = snap.y_mm; rot = snap.rot_deg;
      guideList = snap.guides;
      markWall = snap.wall_index;
    }

    const mount = rec.item.placement || {};
    if (mount.wall_mounted) {
      const w = snapToWallPlane({ x_mm: x, y_mm: y, rot_deg: rot }, rec.item, S.room);
      x = w.x_mm; y = w.y_mm;
      if (!rotating) rot = w.rot_deg;
      markWall = w.wall_index;
    } else if (!mount.ceiling_mounted) {
      // SPEC2 §F — every OBB corner stays inside the floor polygon. Corrections
      // run along wall normals only, so a drag into a wall keeps tracking
      // sideways instead of sticking.
      const cl = clampToRoom({ x_mm: x, y_mm: y, rot_deg: rot }, rec.item, S.room, {
        snap: !free, snap_mm: free ? 0 : 120, grid_mm: free ? 0 : GRID_MM,
      });
      x = cl.x_mm; y = cl.y_mm;
      if (cl.snapped_wall != null) markWall = cl.snapped_wall;
      else if (cl.clamped && cl.clamped_walls.length && markWall == null) markWall = cl.clamped_walls[0];
    }

    p.x_mm = Math.round(x);
    p.y_mm = Math.round(y);
    p.rot_deg = ((Math.round(rot) % 360) + 360) % 360;
    if (prop.tilt_x_deg != null) p.tilt_x_deg = Math.round(prop.tilt_x_deg);
    if (prop.tilt_z_deg != null) p.tilt_z_deg = Math.round(prop.tilt_z_deg);
    if (prop.elev_mm != null && (mount.wall_mounted || mount.ceiling_mounted)) {
      p.elev_mm = Math.max(0, Math.round(prop.elev_mm));
    }

    applyTransform(rec);
    drawGuides(guideList);
    highlightWall(markWall);
    if (S.selection === rec.placement.instance_id) syncGizmoTo(rec);
    revalidate();
    updateHud();
  }

  function finishDrag(commit) {
    if (drag.active && drag.kind === 'gizmo') {
      gizmo.endDrag();
      // One history entry per completed drag, not per frame (SPEC2 §B).
      if (commit && drag.moved && drag.start) {
        S.undo.push(drag.start);
        if (S.undo.length > 60) S.undo.shift();
        S.redo.length = 0;
        emitChange();
      }
      releaseCapture();
    }
    drag.active = false; drag.kind = null; drag.id = null;
    drag.free = false; drag.moved = false; drag.start = null; drag.moves = 0;
    drag.pointerId = null;
    guides.visible = false;
    wallHi.visible = false;
    orbit.enabled = S.view === '3d';
    plan.enabled = S.view === 'top';
  }

  function onPointerUp(ev) {
    if (S.view === 'first-person') { fp.end(); return; }
    finishDrag(true);
    void ev;
  }
  function onPointerCancel() {
    if (S.view === 'first-person') { fp.end(); return; }
    finishDrag(true);
  }
  function onLostCapture() { if (drag.active) finishDrag(true); }

  /** SPEC2 §A — the click that follows an orbit/pan must not select. */
  function onClick(ev) {
    if (suppressClick) { ev.stopPropagation(); suppressClick = false; }
  }
  function onContextMenu(ev) { ev.preventDefault(); }

  function onWheel(ev) {
    ev.preventDefault();
    if (S.view === 'first-person') return;
    const n = toNdc(ev);
    const at = { x: n.x, y: n.y };
    if (S.view === 'top') plan.zoomAt(at, ev.deltaY);
    else orbit.zoomAt(at, ev.deltaY);
  }

  function drawGuides(list) {
    if (!list || !list.length) { guides.visible = false; return; }
    const arr = guideGeom.attributes.position.array;
    let n = 0;
    for (const g of list.slice(0, 20)) {
      arr[n++] = g[0][0] * MM; arr[n++] = 0.007; arr[n++] = -g[0][1] * MM;
      arr[n++] = g[1][0] * MM; arr[n++] = 0.007; arr[n++] = -g[1][1] * MM;
    }
    for (let i = n; i < arr.length; i++) arr[i] = 0;
    guideGeom.attributes.position.needsUpdate = true;
    guideGeom.setDrawRange(0, n / 3);
    guides.visible = true;
  }

  // Everything is bound to the canvas. Pointer capture retargets moves/ups
  // here for the whole drag, so leaving the canvas cannot desync (SPEC2 §B/§D).
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerCancel);
  dom.addEventListener('lostpointercapture', onLostCapture);
  dom.addEventListener('click', onClick, true);
  dom.addEventListener('contextmenu', onContextMenu);
  dom.addEventListener('wheel', onWheel, { passive: false });

  // ---------------- keyboard ----------------
  function onKeyDown(ev) {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const meta = ev.metaKey || ev.ctrlKey;
    const k = (ev.key || '').toLowerCase();
    // In walk view the only editor binding is Esc; W/A/S/D, Shift and Ctrl
    // belong to the walker (SPEC2 §A/§E).
    if (S.view === 'first-person') {
      if (k === 'escape') { api.setView('3d'); }
      return;
    }
    if (meta && k === 'd') { ev.preventDefault(); if (S.selection) api.duplicate(S.selection); return; }
    if (meta && k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if ((meta && k === 'z' && ev.shiftKey) || (meta && k === 'y')) { ev.preventDefault(); redo(); return; }
    if (k === 'delete' || k === 'backspace') {
      if (S.selection) { ev.preventDefault(); api.remove(S.selection); }
      return;
    }
    if (k === 'escape') { select(null); return; }
    const nudge = { arrowleft: [-GRID_MM, 0], arrowright: [GRID_MM, 0], arrowup: [0, GRID_MM], arrowdown: [0, -GRID_MM] }[k];
    if (nudge && S.selection) {
      ev.preventDefault();
      const p = findPlacement(S.selection);
      if (p && !p.locked) {
        pushHistory();
        const mult = ev.shiftKey ? 10 : 1;
        p.x_mm += nudge[0] * mult; p.y_mm += nudge[1] * mult;
        syncOne(S.selection); emitChange();
      }
    }
  }
  window.addEventListener('keydown', onKeyDown);

  function syncOne(id) {
    const rec = S.instances.get(id);
    if (!rec) return;
    applyTransform(rec);
    if (S.selection === id) syncGizmoTo(rec);
    revalidate();
    updateHud();
  }

  // ---------------- wall fade ----------------
  function updateWallFade() {
    if (!shell) return;
    const camPos = camera.position;
    const insideRoom = pointInPolygon([camPos.x / MM, -camPos.z / MM], S.room.polygon_mm);
    for (const w of shell.walls) {
      let target = 1;
      if (!insideRoom && S.view !== 'top') {
        const v = new THREE.Vector3().subVectors(camPos, w.centerThree).normalize();
        const facing = v.dot(w.normalThree);
        // Camera is on this wall's outer side => it occludes the interior.
        // A proportional fade looks reasonable per-wall but stacks: in a normal
        // orbit view two near walls sit at oblique angles, each landing around
        // 0.6-0.7 opacity, and the interior ends up read through two translucent
        // dark layers. Occluding walls step aside almost completely instead —
        // standard architectural-viz behaviour — leaving a ghost edge for context.
        if (facing > 0.04) target = 0.045;
      }
      if (S.view === 'top') target = 0.92;
      w.material.opacity += (target - w.material.opacity) * 0.18;
      w.material.needsUpdate = false;
      w.group.visible = w.material.opacity > 0.02;
    }
  }

  // ---------------- render loop ----------------
  let raf = 0;
  let lastT = performance.now();
  function tick() {
    if (S.disposed) return;
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = (now - lastT) / 1000; lastT = now;
    if (S.view === '3d') orbit.update();
    if (S.view === 'first-person') fp.update(dt);
    // Screen-constant gizmo: re-scaled every frame against the live camera.
    if (gizmo.visible) gizmo.update(camera, size.h);
    updateWallFade();
    if (S.selection) updateHud();
    renderer.render(scene, camera);
  }

  // ---------------- public API (SPEC §5.3) ----------------
  function getLayout(lean = false) {
    const metrics = {};
    const errs = S.violations.filter((v) => v.severity === 'error').length;
    // Rough internal fallback only. This is NOT a design-quality score: it
    // ignores walkway width, visual balance, focal coherence, wall use and
    // coverage. Anything user-facing should prefer layout-engine's scoreLayout()
    // — this reported 0.94 for a layout the engine scored 0.742. Kept so the
    // editor still returns a number when no engine is wired.
    const score = Math.max(0, 1 - errs * 0.15 - S.violations.length * 0.02);
    const out = {
      ...S.layoutMeta,
      score: Number(score.toFixed(3)),
      placements: S.placements.map((p) => ({ ...p })),
      violations: lean ? [] : S.violations.map((v) => ({ ...v })),
      metrics,
    };
    if (!out.rationale) out.rationale = [];
    return out;
  }

  const api = {
    // --- required §5.3 -----------------------------------------------------
    setRoom(nextRoom) {
      S.room = nextRoom || S.room;
      rebuildRoom();
      revalidate();
      emitChange();
      return api;
    },
    setLayout(nextLayout) {
      const l = nextLayout || emptyLayout();
      S.layoutMeta = {
        id: l.id || 'layout_editor', seed: l.seed ?? 1, mode: l.mode || 'use-mine',
        style: l.style || 'neutral', rationale: l.rationale || [],
      };
      pushHistory();
      setPlacements(l.placements || []);
      select(null, { silent: true });
      emitChange();
      return api;
    },
    getLayout() { return getLayout(); },
    add(item_id, at = {}) {
      const item = S.catalog.get(item_id);
      if (!item) { console.warn('[editor] add(): unknown item_id ' + item_id); return null; }
      pushHistory();
      const b = shell ? shell.bounds : roomBounds(S.room);
      const placement = {
        instance_id: at.instance_id || nextId(),
        item_id,
        x_mm: Math.round(at.x_mm != null ? at.x_mm : b.cx),
        y_mm: Math.round(at.y_mm != null ? at.y_mm : b.cy),
        rot_deg: ((at.rot_deg || 0) % 360 + 360) % 360,
        colorway: at.colorway | 0,
        against: at.against || null,
        locked: !!at.locked,
        added_by_ai: !!at.added_by_ai,
        tilt_x_deg: Math.round(at.tilt_x_deg || 0),
        tilt_z_deg: Math.round(at.tilt_z_deg || 0),
        ...(at.elev_mm != null ? { elev_mm: Math.round(at.elev_mm) } : {}),
      };
      S.placements.push(placement);
      buildInstance(placement);
      revalidate();
      select(placement.instance_id);
      emitChange();
      return placement.instance_id;
    },
    duplicate(instance_id) {
      const src = findPlacement(instance_id || S.selection);
      if (!src) return null;
      const item = S.catalog.get(src.item_id);
      const step = item ? Math.max(150, Math.round(item.dims_mm.w * 0.35 / 10) * 10) : 300;
      pushHistory();
      const copy = { ...src, instance_id: nextId(), x_mm: src.x_mm + step, y_mm: src.y_mm - step, locked: false };
      S.placements.push(copy);
      buildInstance(copy);
      revalidate();
      select(copy.instance_id);
      emitChange();
      return copy.instance_id;
    },
    remove(instance_id) {
      const id = instance_id || S.selection;
      const i = S.placements.findIndex((p) => p.instance_id === id);
      if (i < 0) return false;
      pushHistory();
      S.placements.splice(i, 1);
      destroyInstance(id);
      if (S.selection === id) select(null);
      revalidate();
      emitChange();
      return true;
    },
    select(instance_id) { select(instance_id); return api; },
    setMode(mode) {
      S.mode = ['translate', 'rotate', 'scale-none'].includes(mode) ? mode : 'translate';
      // The gizmo mode follows: 'translate' hides the rings, 'rotate' hides the
      // arrows, and setGizmoMode() can override it explicitly.
      gizmo.setMode(S.mode === 'translate' ? 'both' : (S.mode === 'rotate' ? 'rotate' : 'both'));
      if (S.selection) syncGizmoTo(S.instances.get(S.selection));
      else gizmo.visible = false;
      return api;
    },
    setView(view) {
      S.view = ['3d', 'top', 'first-person'].includes(view) ? view : '3d';
      finishDrag(false);
      fp.active = S.view === 'first-person';
      if (S.view === '3d') {
        camera = persp; orbit.enabled = true; plan.enabled = false;
      } else if (S.view === 'top') {
        camera = ortho; orbit.enabled = false; plan.enabled = true;
        plan.setViewport(size.w, size.h);
        plan.apply();                      // keeps the user's zoom (SPEC2 §D)
      } else {
        camera = fpCam; orbit.enabled = false; plan.enabled = false;
        fp.setCanStand(canStand);
        fp.place(shell ? shell.bounds : roomBounds(S.room));
      }
      badge.textContent = S.view === 'first-person'
        ? 'walk · wasd · shift sprint · ctrl crouch · right-drag look'
        : S.view;
      applyOutlineStyle();
      if (S.selection) syncGizmoTo(S.instances.get(S.selection));
      updateHud();
      return api;
    },
    setUnit(u) {
      S.unit = ['mm', 'cm', 'ft'].includes(u) ? u : 'cm';
      updateHud();
      if (onChange) onChange(getLayout());
      return api;
    },
    snapshot({ width = 1600, height = 1000, transparent = false } = {}) {
      const prevW = size.w, prevH = size.h;
      const prevRatio = renderer.getPixelRatio();
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      if (camera === persp || camera === fpCam) {
        camera.aspect = width / height; camera.updateProjectionMatrix();
      } else {
        const aspect = width / height;
        const halfH = plan.state.halfH;
        ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
        ortho.top = halfH; ortho.bottom = -halfH;
        ortho.updateProjectionMatrix();
      }
      if (transparent) renderer.setClearAlpha(0);
      hud.style.display = 'none';
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      if (transparent) renderer.setClearAlpha(1);
      renderer.setPixelRatio(prevRatio);
      renderer.setSize(prevW, prevH, false);
      if (camera === persp || camera === fpCam) {
        camera.aspect = prevW / prevH; camera.updateProjectionMatrix();
      } else plan.resize(prevW, prevH);
      renderer.render(scene, camera);
      updateHud();
      return url;
    },
    dispose() {
      if (S.disposed) return;
      S.disposed = true;
      cancelAnimationFrame(raf);
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerCancel);
      dom.removeEventListener('lostpointercapture', onLostCapture);
      dom.removeEventListener('click', onClick, true);
      dom.removeEventListener('contextmenu', onContextMenu);
      dom.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      orbit.dispose(); plan.dispose(); fp.dispose(); gizmo.dispose();
      clearInstances();
      if (shell) shell.dispose();
      guideGeom.dispose();
      wallHiGeom.dispose();
      mats.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      hud.remove(); badge.remove();
    },

    // --- SPEC2 additions --------------------------------------------------
    /** SPEC2 §B — 'translate' | 'rotate' | 'both'. */
    setGizmoMode(m) {
      gizmo.setMode(m);
      if (S.selection) syncGizmoTo(S.instances.get(S.selection));
      return api;
    },
    getGizmoMode: () => gizmo.getMode(),
    /** Jump the damped orbit camera to its destination (snapshots / tests). */
    settleCamera() { if (S.view === '3d') orbit.settle(); return api; },
    /** Explicit plan re-frame (SPEC2 §D "keep an explicit fit action"). */
    fitPlan() { fitOrtho(); return api; },
    frameView() { if (S.view === 'top') fitOrtho(); else if (shell) orbit.frame(shell.bounds, shell.height_mm); return api; },
    /** Reposition the walker (SPEC2 §E tooling + tests). */
    setWalk({ x_mm, y_mm, yaw_deg, pitch, reset, eye_m, speed_mps } = {}) {
      const st = fp.state;
      if (x_mm != null) st.pos.x = x_mm * MM;
      if (y_mm != null) st.pos.z = -y_mm * MM;
      if (yaw_deg != null) st.yaw = yaw_deg * D2R;
      if (eye_m != null) st.eye = eye_m;
      if (speed_mps != null) st.speed = speed_mps;
      if (pitch != null) st.pitch = pitch;
      if (reset) {
        st.keys.clear(); st.sprint = false; st.crouch = false;
        st.speed = WALK_MPS; st.speedTarget = WALK_MPS;
        st.eye = EYE_STAND_M; st.eyeTarget = EYE_STAND_M;
      }
      st.pos.y = st.eye;
      fpCam.position.copy(st.pos);
      return api;
    },
    /**
     * Advance the walk simulation by `frames` fixed steps of `dt` seconds.
     * Makes "travel over a fixed number of frames" measurable independently of
     * how fast the GPU happens to be presenting.
     */
    stepWalk(dt = 1 / 60, frames = 60) {
      const st = fp.state;
      const a = st.pos.clone();
      const eyes = [], speeds = [];
      for (let i = 0; i < frames; i++) {
        fp.update(dt);
        eyes.push(Number(st.eye.toFixed(5)));
        speeds.push(Number(st.speed.toFixed(5)));
      }
      return {
        dist: Math.hypot(st.pos.x - a.x, st.pos.z - a.z),
        simTime: dt * frames, frames, eyes, speeds,
        speed: st.speed, eye: st.eye, fov: st.fov,
      };
    },
    getWalkState() {
      const st = fp.state;
      return {
        speed: st.speed, speedTarget: st.speedTarget,
        eye: st.eye, eyeTarget: st.eyeTarget,
        fov: st.fov, fovTarget: st.fovTarget,
        sprint: st.sprint, crouch: st.crouch,
        yaw: st.yaw, pitch: st.pitch,
        pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z },
        limits: { walk: WALK_MPS, sprint: SPRINT_MPS, crouch: CROUCH_MPS, eye: EYE_STAND_M, eyeCrouch: EYE_CROUCH_M },
      };
    },
    getCameraState() {
      return {
        view: S.view,
        theta: orbit.state.theta, phi: orbit.state.phi, distance: orbit.state.distance,
        desired: { ...orbit.state.desired },
        clamp: { minPhi: orbit.state.minPhi, maxPhi: orbit.state.maxPhi },
        dragging: !!orbit.state.dragging,
        target: { x: orbit.state.target.x, y: orbit.state.target.y, z: orbit.state.target.z },
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        plan: { cx: plan.state.cx, cz: plan.state.cz, halfH: plan.state.halfH, dragging: plan.isDragging() },
      };
    },
    getGizmoState() {
      const h = gizmo.activeHandle();
      return {
        visible: gizmo.visible, dragging: gizmo.isDragging(),
        handle: h ? h.id : null, scale: gizmo.group.scale.x,
        mode: gizmo.getMode(), spanPx: GIZMO_SPAN_PX,
        target: gizmo.target,
        handles: gizmo.handles.map((x) => ({ id: x.id, kind: x.kind, axis: x.axis, visible: x.pick.visible })),
      };
    },
    /** Screen (client) coords of an item's world origin, for tests + tooling. */
    screenOf(instance_id, opts = {}) {
      const rec = S.instances.get(instance_id);
      if (!rec) return null;
      const frac = opts.heightFrac || 0;
      const v = new THREE.Vector3(
        rec.placement.x_mm * MM,
        (elevOf(rec) + (rec.item.dims_mm.h || 0) * frac) * MM,
        -rec.placement.y_mm * MM,
      );
      return worldToClient(v);
    },
    screenOfWorld(x, y, z) { return worldToClient(new THREE.Vector3(x, y, z)); },
    /** Client coords of a probe point on a gizmo handle (tests + tooling). */
    gizmoProbe(id, deg = 0) {
      if (!gizmo.visible) return null;
      gizmo.update(camera, size.h);
      const s = gizmo.group.scale.x;
      const o = gizmo.group.position;
      const a = deg * D2R;
      let w = null;
      if (id === 'planar') w = o.clone();
      else if (id === 'axis-x') w = o.clone().add(new THREE.Vector3(0.55 * s, 0, 0));
      else if (id === 'axis-y') w = o.clone().add(new THREE.Vector3(0, 0.55 * s, 0));
      else if (id === 'axis-z') w = o.clone().add(new THREE.Vector3(0, 0, 0.55 * s));
      else if (id === 'rot-y') w = o.clone().add(new THREE.Vector3(Math.cos(a) * s, 0, -Math.sin(a) * s));
      else if (id === 'rot-x') w = o.clone().add(new THREE.Vector3(0, Math.sin(a) * 0.62 * s, -Math.cos(a) * 0.62 * s));
      else if (id === 'rot-z') w = o.clone().add(new THREE.Vector3(Math.cos(a) * 0.62 * s, Math.sin(a) * 0.62 * s, 0));
      if (!w) return null;
      const c = worldToClient(w);
      return { ...c, world: { x: w.x, y: w.y, z: w.z }, scale: s };
    },
    /** Floor-plane world point under a client cursor position. */
    worldUnderCursor(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1,
      ), camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(floorPlane, hit)) return null;
      return { x: hit.x, y: hit.y, z: hit.z };
    },
    /** What a click at these client coords would select. */
    pickAt(clientX, clientY) {
      const f = pickFurniture({ clientX, clientY });
      return f ? { instance_id: f.id, distance: f.distance, rug: f.rug } : null;
    },
    /** SPEC2 §F check: is every OBB corner inside the floor polygon? */
    isInBounds(instance_id) {
      const rec = S.instances.get(instance_id || S.selection);
      if (!rec) return null;
      return obbInsideRoom(rec.placement, rec.item, S.room, 1.5);
    },
    obbCornersOf(instance_id) {
      const rec = S.instances.get(instance_id || S.selection);
      if (!rec) return null;
      return obbCorners(footprintOBB(rec.placement, rec.item));
    },

    // --- editor extras used by the demo harness ---------------------------
    undo, redo,
    clearHistory() { S.undo.length = 0; S.redo.length = 0; return api; },
    _debug: () => ({
      drag: { active: drag.active, kind: drag.kind, id: drag.id, moved: drag.moved, moves: drag.moves, free: drag.free },
      mode: S.mode, view: S.view, undo: S.undo.length, redo: S.redo.length,
      gizmo: { visible: gizmo.visible, dragging: gizmo.isDragging(), scale: gizmo.group.scale.x },
      camera: { phi: orbit.state.phi, distance: orbit.state.distance, dragging: !!orbit.state.dragging },
    }),
    canUndo: () => S.undo.length > 0,
    canRedo: () => S.redo.length > 0,
    getViolations: () => S.violations.map((v) => ({ ...v })),
    getSelection: () => S.selection,
    getUnit: () => S.unit,
    getView: () => S.view,
    getMode: () => S.mode,
    getRoom: () => S.room,
    getCatalog: () => S.catalog,
    setCatalog(next) { S.catalog = normalizeCatalog(next); setPlacements(S.placements); return api; },
    setClearances(on) {
      S.showClearances = !!on;
      for (const [, rec] of S.instances) rec.clearance.visible = S.showClearances && isFloorCollider(rec.item);
      return api;
    },
    getClearances: () => S.showClearances,
    setRotation(instance_id, deg) {
      const p = findPlacement(instance_id);
      if (!p || p.locked) return false;
      pushHistory();
      p.rot_deg = ((Math.round(deg) % 360) + 360) % 360;
      // a rotation near a wall can swing a corner outside the polygon
      const rc = S.instances.get(instance_id);
      const cc = constrainProgrammatic(rc, { x_mm: p.x_mm, y_mm: p.y_mm, rot_deg: p.rot_deg });
      p.x_mm = cc.x_mm; p.y_mm = cc.y_mm;
      syncOne(instance_id); emitChange();
      return true;
    },
    setPosition(instance_id, x_mm, y_mm) {
      const p = findPlacement(instance_id);
      if (!p || p.locked) return false;
      const rec = S.instances.get(instance_id);
      pushHistory();
      // SPEC2 §F applies to the API too, not just to dragging. Writing raw
      // coordinates here let callers (and the AI seeding path) push a piece
      // clean outside the plan — `setPosition(id, 99999, 99999)` used to stick.
      const c = constrainProgrammatic(rec, { x_mm, y_mm, rot_deg: p.rot_deg || 0 });
      p.x_mm = c.x_mm; p.y_mm = c.y_mm;
      syncOne(instance_id); emitChange();
      return true;
    },
    setColorway(instance_id, index) {
      const p = findPlacement(instance_id);
      if (!p) return false;
      pushHistory();
      p.colorway = index | 0;
      destroyInstance(instance_id);
      buildInstance(p);
      revalidate();
      if (S.selection === instance_id) select(instance_id, { silent: true });
      emitChange();
      return true;
    },
    setLocked(instance_id, locked) {
      const p = findPlacement(instance_id);
      if (!p) return false;
      pushHistory();
      p.locked = !!locked;
      emitChange();
      return true;
    },
    frameRoom() { orbit.frame(shell.bounds, shell.height_mm); return api; },
    setValidator(fn) { externalValidate = typeof fn === 'function' ? fn : null; revalidate(); return api; },
    getDimensions(instance_id) {
      const rec = S.instances.get(instance_id || S.selection);
      if (!rec) return null;
      const obb = footprintOBB(rec.placement, rec.item);
      return {
        item: rec.item,
        placement: { ...rec.placement },
        dims_mm: rec.item.dims_mm,
        walls: obbWallDistances(obb, S.room).slice(0, 2),
        corners: obbCorners(obb),
      };
    },
    get scene() { return scene; },
    get renderer() { return renderer; },
    get camera() { return camera; },
    /**
     * §G3 — put a user photo in a poster/frame/canvas. 25 catalog items (ids
     * starting `ai-`) carry an `image_slot` part. The image is aspect-fit via the
     * texture matrix, so a 3:2 photo letterboxes inside a square frame instead of
     * stretching.
     */
    setInstanceImage(instance_id, imageOrURL) {
      const rec = S.instances.get(instance_id || S.selection);
      if (!rec) return false;
      const ok = setProxyImage(rec.group, imageOrURL);
      rig.invalidateShadows();
      return ok;
    },
    clearInstanceImage(instance_id) {
      const rec = S.instances.get(instance_id || S.selection);
      if (!rec) return false;
      const ok = clearProxyImage(rec.group);
      rig.invalidateShadows();
      return ok;
    },
    /**
     * Graphics quality tier. The §G realism layer (PBR maps + IBL environment +
     * soft shadows) costs roughly 5x the frame time of flat materials. On a GPU
     * that is irrelevant; on a software rasteriser (or a weak integrated GPU) it
     * is the difference between usable and not, so the host page can step down.
     *   high   — everything on (default)
     *   medium — shadows off, maps + environment kept
     *   low    — shadows + environment off, pixel ratio 1
     */
    setQualityTier(tier) {
      const t = ['high', 'medium', 'low'].includes(tier) ? tier : 'high';
      S.qualityTier = t;
      renderer.shadowMap.enabled = t === 'high';
      if (t === 'high') { rig.setQuality('high'); rig.invalidateShadows(); }
      scene.environment = t === 'low' ? null : env.texture;
      renderer.setPixelRatio(t === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1));
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of [].concat(o.material)) m.needsUpdate = true;
      });
      resize();
      return api;
    },
    getQualityTier() { return S.qualityTier || 'high'; },
    /** Shadow maps render on demand; call this after moving geometry. */
    invalidateShadows() { rig.invalidateShadows(); return api; },
    setShadowQuality(q) { rig.setQuality(q); return api; },
    get three() { return THREE; },
    fmtLen,
  };

  // ---------------- boot ----------------
  rebuildRoom();
  resize();
  api.setLayout(layout || emptyLayout());
  S.undo.length = 0; S.redo.length = 0;
  api.setView('3d');
  badge.textContent = '3d';
  tick();

  return api;
}

/** A sane default room so the editor never boots empty (SPEC §4.4 shape). */
export function defaultRoom() {
  return {
    id: 'room_default', name: 'Living room',
    polygon_mm: [[0, 0], [4200, 0], [4200, 3600], [0, 3600]],
    height_mm: 2600,
    openings: [
      { id: 'd1', type: 'door', wall_index: 0, offset_mm: 300, width_mm: 900, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
      { id: 'w1', type: 'window', wall_index: 2, offset_mm: 1200, width_mm: 1600, height_mm: 1400, sill_mm: 800, swing: null },
    ],
    features: [],
    source: 'manual', confidence: 1,
  };
}

export default createEditor;

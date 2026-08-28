// packages/three-editor/editor.js
// createEditor(...) — implements SPEC §5.3 verbatim.
// Storage is mm (SPEC §1); the scene is metres; three.x = plan.x/1000, three.z = -plan.y/1000,
// rotation is CCW degrees about the vertical axis and maps directly to group.rotation.y.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { createMaterialLibrary, TOKENS } from './materials.js';
import { buildRoom, roomBounds, pointInPolygon, planToThree } from './room.js';
import { buildProxy, disposeProxy } from './proxies.js';
import {
  detectCollisions, footprintOBB, obbCorners, obbWallDistances, clearanceOBB, isFloorCollider,
} from './collision.js';
import {
  createOrbitControls, createFirstPerson, createRotateRing,
  resolveSnap, snapRotation, GRID_MM,
} from './controls.js';

const MM = 1 / 1000;
const D2R = Math.PI / 180;

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

  // lights
  const hemi = new THREE.HemisphereLight(0xdfe6f2, 0x2a2a2e, 0.85);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff4e8, 1.05);
  dir.position.set(3.2, 6.4, 2.4);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x9fb6d8, 0.42);
  fill.position.set(-4, 3, -3.4);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));

  // cameras
  const persp = new THREE.PerspectiveCamera(48, 1, 0.05, 300);
  const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, -50, 200);
  const fpCam = new THREE.PerspectiveCamera(72, 1, 0.03, 200);
  let camera = persp;

  const orbit = createOrbitControls(persp, renderer.domElement, { minDistance: 0.9, maxDistance: 60 });
  const fp = createFirstPerson(fpCam, renderer.domElement, {
    inside: (v) => pointInPolygon([v.x / MM, -v.z / MM], S.room.polygon_mm),
  });
  const ring = createRotateRing(mats);
  scene.add(ring.group);

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
  scene.add(guides);

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
    orbit.frame(shell.bounds, shell.height_mm);
    fp.place(shell.bounds);
    fitOrtho();
  }

  function fitOrtho() {
    if (!shell) return;
    const b = shell.bounds;
    const aspect = Math.max(0.2, size.w / Math.max(1, size.h));
    const padded = 1.16;
    let halfW = (b.w * MM * padded) / 2;
    let halfH = (b.d * MM * padded) / 2;
    if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;
    ortho.left = -halfW; ortho.right = halfW; ortho.top = halfH; ortho.bottom = -halfH;
    ortho.position.set(b.cx * MM, 12, -b.cy * MM);
    ortho.up.set(0, 0, -1);
    ortho.lookAt(b.cx * MM, 0, -b.cy * MM);
    ortho.updateProjectionMatrix();
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
    fitOrtho();
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

  function applyTransform(rec) {
    const p = rec.placement;
    rec.group.position.set(p.x_mm * MM, elevationOf(rec.item) * MM, -p.y_mm * MM);
    rec.group.rotation.y = (p.rot_deg || 0) * D2R;   // CCW positive (SPEC §1)
  }

  function buildInstance(placement) {
    const item = itemOf(placement);
    if (!item) { console.warn('[editor] unknown item_id', placement.item_id); return null; }
    const group = new THREE.Group();
    group.name = 'inst:' + placement.instance_id;
    const hex = (item.colorways && item.colorways[placement.colorway | 0])
      ? item.colorways[placement.colorway | 0].hex : null;
    const proxy = buildProxy(item, { materials: mats, colorwayHex: hex });
    group.add(proxy);

    const d = item.dims_mm;
    // collision tint overlay (--err @ 35%)
    const ovGeom = new THREE.BoxGeometry(d.w * MM * 1.005, d.h * MM * 1.005, d.d * MM * 1.005);
    const overlay = new THREE.Mesh(ovGeom, mats.errTint);
    overlay.position.y = (d.h * MM) / 2;
    overlay.visible = false;
    overlay.renderOrder = 8;
    group.add(overlay);

    // selection outline (footprint + bbox edges)
    const boxGeom = new THREE.BoxGeometry(d.w * MM, d.h * MM, d.d * MM);
    const edges = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();
    const outline = new THREE.LineSegments(edges, mats.lineMat(TOKENS.clay, 0.95));
    outline.position.y = (d.h * MM) / 2;
    outline.visible = false;
    outline.renderOrder = 12;
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

  // ---------------- selection ----------------
  function select(id, { silent = false } = {}) {
    if (id && !S.instances.has(id)) id = null;
    S.selection = id || null;
    applyOutlineStyle();
    const rec = S.selection ? S.instances.get(S.selection) : null;
    if (rec) {
      const d = rec.item.dims_mm;
      ring.group.visible = S.mode !== 'scale-none';
      ring.group.position.set(rec.placement.x_mm * MM, 0.026, -rec.placement.y_mm * MM);
      ring.fit(Math.hypot(d.w, d.d) * MM * 0.62, rec.placement.rot_deg || 0);
    } else {
      ring.group.visible = false;
    }
    updateHud();
    if (!silent && onSelect) onSelect(rec ? { ...rec.placement, item: rec.item } : null);
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
   * One raycast, then compare depths: the rotate ring lies on the floor and its
   * far arc often sits *behind* the item along the same ray, so a naive
   * ring-first test would steal every item click. Nearest hit wins.
   */
  function pick(ev) {
    raycaster.setFromCamera(toNdc(ev), camera);
    let instance = null, instanceD = Infinity;
    for (const h of raycaster.intersectObjects(furniture.children, true)) {
      let o = h.object;
      while (o && o.parent !== furniture) o = o.parent;
      if (o && o.name.startsWith('inst:')) { instance = o.name.slice(5); instanceD = h.distance; break; }
    }
    let ringD = Infinity, ringOutsideBody = false;
    if (ring.group.visible && S.mode !== 'scale-none') {
      const rh = raycaster.intersectObjects([ring.pick, ring.handle], false);
      if (rh.length) {
        ringD = rh[0].distance;
        // The ring renders with depthTest:false, so it is always visually on top.
        // Picking mirrors that: a ring hit OUTSIDE the selected item's footprint
        // rotates; a hit over the body translates. That keeps tall neighbours
        // (a floor lamp, a bookcase) from stealing a ring grab, without letting
        // the ring's far arc steal clicks on the item itself.
        const rec = S.selection ? S.instances.get(S.selection) : null;
        if (rec) {
          const pl = rec.placement;
          const a = (pl.rot_deg || 0) * D2R;
          const dx = rh[0].point.x / MM - pl.x_mm;
          const dy = -rh[0].point.z / MM - pl.y_mm;
          const lx = dx * Math.cos(a) + dy * Math.sin(a);
          const ly = -dx * Math.sin(a) + dy * Math.cos(a);
          ringOutsideBody = Math.abs(lx) > rec.item.dims_mm.w / 2 + 25 ||
                            Math.abs(ly) > rec.item.dims_mm.d / 2 + 25;
        }
      }
    }
    const ringWins = ringD < Infinity && (ringOutsideBody || ringD < instanceD);
    return { instance, instanceD, ringD, ring: ringWins };
  }
  function pickInstance(ev) { return pick(ev).instance; }

  // ---------------- interaction ----------------
  const drag = { active: false, kind: null, id: null, start: null, offset: null, moved: false, startRot: 0, startAngle: 0 };

  function onPointerDown(ev) {
    renderer.domElement.focus({ preventScroll: true });
    if (S.view === 'first-person') { fp.begin(ev); return; }

    const wantPan = ev.button === 1 || ev.button === 2 || (ev.shiftKey && ev.button === 0 && !S.selection);
    const hit = ev.button === 0 ? pick(ev) : { instance: null, ring: false };

    if (ev.button === 0 && hit.ring) {
      const rec = S.instances.get(S.selection);
      const fpt = floorPoint(ev);
      if (rec && fpt && !rec.placement.locked) {
        drag.active = true; drag.kind = 'rotate'; drag.id = S.selection; drag.moved = false;
        drag.startRot = rec.placement.rot_deg || 0;
        drag.startAngle = Math.atan2(fpt.y_mm - rec.placement.y_mm, fpt.x_mm - rec.placement.x_mm) / D2R;
        drag.start = historySnapshot();
        orbit.enabled = false;
        return;
      }
    }

    if (ev.button === 0 && !wantPan) {
      const id = hit.instance;
      if (id) {
        if (id !== S.selection) select(id);
        const rec = S.instances.get(id);
        const fpt = floorPoint(ev);
        if (rec && fpt && !rec.placement.locked && S.mode === 'translate') {
          drag.active = true; drag.kind = 'translate'; drag.id = id; drag.moved = false;
          drag.offset = { dx: rec.placement.x_mm - fpt.x_mm, dy: rec.placement.y_mm - fpt.y_mm };
          drag.start = historySnapshot();
          orbit.enabled = false;
        }
        return;
      }
      drag.active = true; drag.kind = 'maybe-deselect'; drag.moved = false;
      if (S.view === '3d') orbit.begin(ev, 'rotate');
      return;
    }
    if (S.view === '3d') orbit.begin(ev, wantPan ? 'pan' : 'rotate');
  }

  function onPointerMove(ev) {
    if (!drag.active) return;
    if (drag.kind === 'maybe-deselect') { drag.moved = true; return; }
    const rec = S.instances.get(drag.id);
    if (!rec) return;
    const fpt = floorPoint(ev);
    if (!fpt) return;
    drag.moved = true;

    if (drag.kind === 'translate') {
      const raw = { x: fpt.x_mm + drag.offset.dx, y: fpt.y_mm + drag.offset.dy };
      const neighbours = S.placements
        .filter((p) => p.instance_id !== drag.id && S.catalog.get(p.item_id))
        .map((p) => ({ placement: p, item: S.catalog.get(p.item_id) }));
      const snap = resolveSnap({
        x_mm: raw.x, y_mm: raw.y, rot_deg: rec.placement.rot_deg || 0,
        item: rec.item, room: S.room, neighbours, free: ev.altKey,
      });
      rec.placement.x_mm = snap.x_mm;
      rec.placement.y_mm = snap.y_mm;
      rec.placement.rot_deg = snap.rot_deg;
      applyTransform(rec);
      drawGuides(snap.guides);
    } else if (drag.kind === 'rotate') {
      const a = Math.atan2(fpt.y_mm - rec.placement.y_mm, fpt.x_mm - rec.placement.x_mm) / D2R;
      // plan CCW angle delta maps straight onto rot_deg
      const delta = a - drag.startAngle;
      rec.placement.rot_deg = snapRotation(drag.startRot + delta, ev.shiftKey);
      applyTransform(rec);
    }
    if (S.selection === drag.id) {
      ring.group.position.set(rec.placement.x_mm * MM, 0.026, -rec.placement.y_mm * MM);
      ring.fit(Math.hypot(rec.item.dims_mm.w, rec.item.dims_mm.d) * MM * 0.62, rec.placement.rot_deg);
    }
    revalidate();
    updateHud();
  }

  function onPointerUp() {
    if (drag.active) {
      if (drag.kind === 'maybe-deselect' && !drag.moved) select(null);
      if ((drag.kind === 'translate' || drag.kind === 'rotate') && drag.moved) {
        S.undo.push(drag.start);
        if (S.undo.length > 60) S.undo.shift();
        S.redo.length = 0;
        emitChange();
      }
    }
    drag.active = false; drag.kind = null; drag.id = null;
    guides.visible = false;
    orbit.enabled = true;
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

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // ---------------- keyboard ----------------
  function onKeyDown(ev) {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const meta = ev.metaKey || ev.ctrlKey;
    const k = ev.key.toLowerCase();
    if (meta && k === 'd') { ev.preventDefault(); if (S.selection) api.duplicate(S.selection); return; }
    if (meta && k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if ((meta && k === 'z' && ev.shiftKey) || (meta && k === 'y')) { ev.preventDefault(); redo(); return; }
    if (k === 'delete' || k === 'backspace') {
      if (S.selection) { ev.preventDefault(); api.remove(S.selection); }
      return;
    }
    if (k === 'escape') { select(null); return; }
    if (k === 'r' && S.selection) {
      const p = findPlacement(S.selection);
      if (p && !p.locked) { pushHistory(); p.rot_deg = snapRotation((p.rot_deg || 0) + 15); syncOne(S.selection); emitChange(); }
      return;
    }
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
    if (S.selection === id) {
      ring.group.position.set(rec.placement.x_mm * MM, 0.026, -rec.placement.y_mm * MM);
      ring.fit(Math.hypot(rec.item.dims_mm.w, rec.item.dims_mm.d) * MM * 0.62, rec.placement.rot_deg);
    }
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
      ring.group.visible = !!S.selection && S.mode !== 'scale-none';
      return api;
    },
    setView(view) {
      S.view = ['3d', 'top', 'first-person'].includes(view) ? view : '3d';
      fp.active = S.view === 'first-person';
      if (S.view === '3d') { camera = persp; orbit.enabled = true; }
      else if (S.view === 'top') { camera = ortho; orbit.enabled = false; fitOrtho(); }
      else { camera = fpCam; orbit.enabled = false; fp.place(shell ? shell.bounds : roomBounds(S.room)); }
      badge.textContent = S.view === 'first-person' ? 'first-person · wasd + drag' : S.view;
      applyOutlineStyle();
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
        const halfH = (ortho.top - ortho.bottom) / 2;
        ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
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
      } else fitOrtho();
      renderer.render(scene, camera);
      updateHud();
      return url;
    },
    dispose() {
      if (S.disposed) return;
      S.disposed = true;
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      orbit.dispose(); fp.dispose(); ring.dispose();
      clearInstances();
      if (shell) shell.dispose();
      guideGeom.dispose();
      mats.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      hud.remove(); badge.remove();
    },

    // --- editor extras used by the demo harness ---------------------------
    undo, redo,
    clearHistory() { S.undo.length = 0; S.redo.length = 0; return api; },
    _debug: () => ({ drag: { ...drag }, mode: S.mode, view: S.view, undo: S.undo.length }),
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
      syncOne(instance_id); emitChange();
      return true;
    },
    setPosition(instance_id, x_mm, y_mm) {
      const p = findPlacement(instance_id);
      if (!p || p.locked) return false;
      pushHistory();
      p.x_mm = Math.round(x_mm); p.y_mm = Math.round(y_mm);
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

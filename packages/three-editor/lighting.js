// packages/three-editor/lighting.js
// SPEC2 §G.1/§G.2/§G.7 — renderer config, room-fitted lighting rig, gradient env.
//
// Everything here is additive: `editor.js` is not modified. The integrator calls
//   applyRenderer(renderer);
//   const env = createEnvironment(renderer);        // scene.environment = env.texture
//   const rig = createLighting({ scene, room: shell, renderer });
//   rig.fit(shell);                                  // after every rebuildRoom()
// See REALISM.md for the exact three lines to add.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { setRendererCaps } from './textures.js';

const MM = 1 / 1000;

/**
 * §G.1 — ACESFilmic + SRGB + PCFSoft + capped pixel ratio.
 * Idempotent; safe to call on an already-configured renderer.
 */
export function applyRenderer(renderer, opts = {}) {
  if (!renderer) return renderer;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // PERF (§G.8): the scene is static between edits, so re-rendering the shadow
  // map every frame is pure waste — on SwiftShader it costs ~85% of the frame
  // budget. Render it on demand instead; call rig.invalidateShadows() (or set
  // renderer.shadowMap.needsUpdate = true) after any add/move/remove/rebuild.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  try {
    renderer.setPixelRatio(Math.min(
      (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      opts.maxPixelRatio ?? 2
    ));
  } catch (_) { /* noop */ }
  setRendererCaps(renderer);
  return renderer;
}

/**
 * §G.7 — vertical gradient environment so metal/glass reflect *something*.
 * Rendered once into a PMREM cube; ~1ms and it kills the flat-black look.
 */
export function createEnvironment(renderer, opts = {}) {
  const sky = new THREE.Color(opts.sky || '#dfe8f5');
  const horizon = new THREE.Color(opts.horizon || '#c8c3b8');
  const ground = new THREE.Color(opts.ground || '#4a453f');

  // paint the gradient on a 2x256 canvas -> equirect texture (cheap, no shaders)
  const cvs = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(4, 256)
    : Object.assign(document.createElement('canvas'), { width: 4, height: 256 });
  cvs.width = 4; cvs.height = 256;
  const ctx = cvs.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#' + sky.getHexString());
  g.addColorStop(0.46, '#' + sky.clone().lerp(horizon, 0.72).getHexString());
  g.addColorStop(0.52, '#' + horizon.getHexString());
  g.addColorStop(1.00, '#' + ground.getHexString());
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);

  const tex = new THREE.CanvasTexture(cvs);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  let envTex = tex;
  let pmrem = null;
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    envTex = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
  } catch (_) {
    envTex = tex;                      // headless fallback: raw equirect still works
  }
  return {
    texture: envTex,
    dispose() {
      if (envTex && envTex.dispose) envTex.dispose();
      if (pmrem) pmrem.dispose();
    },
  };
}

/** Bounds (mm) -> {cx, cz, w, d, radius} in metres, three-space. */
function boundsMetres(shell) {
  const b = (shell && shell.bounds) || { minX: 0, maxX: 4000, minY: 0, maxY: 4000 };
  const w = Math.max(0.5, (b.maxX - b.minX) * MM);
  const d = Math.max(0.5, (b.maxY - b.minY) * MM);
  const cx = (b.minX + b.maxX) / 2 * MM;
  const cz = -(b.minY + b.maxY) / 2 * MM;
  return { cx, cz, w, d, radius: Math.hypot(w, d) / 2 };
}

/**
 * §G.2 — the rig.
 *   key    warm directional, shadow-casting, shadow camera FITTED to room bounds
 *   sky    cool hemisphere (sky/bounce fill)
 *   fill   cool directional from the opposite side, no shadows
 *   bounce warm up-light from the floor
 *   window one soft PointLight just inside each window opening
 *
 * Returns { group, key, fit(shell), setQuality(n), dispose() }.
 */
export function createLighting({ scene, room, renderer, quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'lighting-rig';

  // ---- key: warm sun -------------------------------------------------------
  const key = new THREE.DirectionalLight(0xffe9cf, 2.35);
  key.castShadow = true;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 2.2;                    // PCFSoft blur, keeps contact tight
  group.add(key);
  group.add(key.target);

  // ---- sky / bounce fill ---------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xcfe0f5, 0x6b5f52, 0.62);
  group.add(hemi);

  const fill = new THREE.DirectionalLight(0xa8c4e8, 0.42);
  fill.castShadow = false;
  group.add(fill);

  // warm bounce coming back up off the floor
  const bounce = new THREE.DirectionalLight(0xffd9b0, 0.22);
  bounce.castShadow = false;
  group.add(bounce);

  const ambient = new THREE.AmbientLight(0xffffff, 0.10);
  group.add(ambient);

  const windowLights = [];
  let shadowSize = quality === 'ultra' ? 2048 : (quality === 'low' ? 512 : 1024);

  function clearWindows() {
    for (const l of windowLights) { group.remove(l); if (l.dispose) l.dispose(); }
    windowLights.length = 0;
  }

  /**
   * Fit the rig to a built room shell. Called after every rebuildRoom().
   * The shadow camera is sized to the room bounds *exactly* (plus a small
   * margin) — that is what keeps contact shadows crisp instead of mush.
   */
  function fit(shell) {
    const M = boundsMetres(shell);
    const H = ((shell && shell.height_mm) || 2600) * MM;

    // key comes over the "front-right" shoulder at ~52 degrees elevation
    const dist = Math.max(6, M.radius * 2.6);
    key.position.set(M.cx + dist * 0.62, H + dist * 0.86, M.cz + dist * 0.52);
    key.target.position.set(M.cx, 0.35, M.cz);
    key.target.updateMatrixWorld();

    const cam = key.shadow.camera;
    const half = M.radius * 1.12 + 0.4;         // tight: bounds + 40cm
    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    cam.near = 0.5;
    cam.far = dist * 2.4 + H * 2;
    cam.updateProjectionMatrix();
    key.shadow.mapSize.set(shadowSize, shadowSize);
    if (key.shadow.map && key.shadow.map.setSize) {
      key.shadow.map.setSize(shadowSize, shadowSize);
    }

    fill.position.set(M.cx - dist * 0.7, H + dist * 0.34, M.cz - dist * 0.62);
    fill.target.position.set(M.cx, H * 0.5, M.cz);
    fill.target.updateMatrixWorld();
    group.add(fill.target);

    bounce.position.set(M.cx, -0.8, M.cz);
    bounce.target.position.set(M.cx, H, M.cz);
    bounce.target.updateMatrixWorld();
    group.add(bounce.target);

    // ---- §G.2 "windows should read as light sources" ----------------------
    clearWindows();
    const frames = (shell && shell.frames) || [];
    const openings = (shell && shell.openings)
      || (shell && shell.room && shell.room.openings)
      || [];
    const wins = openings.filter((o) => o && o.type === 'window');
    for (const o of wins.slice(0, 3)) {          // cap: 3 point lights max (perf)
      const f = frames.find((fr) => fr.origIndex === (o.wall_index | 0))
             || frames[o.wall_index | 0];
      if (!f) continue;
      const cs = (o.offset_mm || 0) + (o.width_mm || 900) / 2;
      const inset = 420;                          // mm inboard of the glazing
      const px = f.a[0] + f.u[0] * cs + f.nIn[0] * inset;
      const py = f.a[1] + f.u[1] * cs + f.nIn[1] * inset;
      const pz = (o.sill_mm || 0) + (o.height_mm || 1400) / 2;
      const w = (o.width_mm || 900) * MM;
      const lamp = new THREE.PointLight(0xdcebff, 1.5 * Math.max(0.6, w), Math.max(4, M.radius * 2.1), 1.7);
      lamp.position.set(px * MM, pz * MM, -py * MM);
      lamp.castShadow = false;                    // shadow-casting points are the fps killer
      group.add(lamp);
      windowLights.push(lamp);
    }

    // no windows in the plan? nudge the hemisphere so the room isn't gloomy
    hemi.intensity = wins.length ? 0.62 : 0.80;
    if (renderer) renderer.shadowMap.needsUpdate = true;   // room changed
    return rig;
  }

  /**
   * Queue ONE shadow-map refresh on the next render. Call after add / move /
   * remove / rebuildRoom / setQuality. Cheap: it is a single boolean.
   */
  function invalidateShadows() {
    if (renderer) renderer.shadowMap.needsUpdate = true;
    return rig;
  }

  function setQuality(q) {
    shadowSize = q === 'low' ? 512 : (q === 'ultra' ? 2048 : 1024);
    key.shadow.mapSize.set(shadowSize, shadowSize);
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    if (renderer) renderer.shadowMap.needsUpdate = true;
    return rig;
  }

  function dispose() {
    clearWindows();
    group.traverse((o) => { if (o.dispose && o !== group) o.dispose(); });
    if (group.parent) group.parent.remove(group);
    group.clear();
  }

  const rig = { group, key, hemi, fill, bounce, ambient, windowLights,
                fit, setQuality, invalidateShadows, dispose };

  if (scene) scene.add(group);
  if (room) fit(room);
  if (renderer) applyRenderer(renderer);
  return rig;
}

/**
 * Convenience for the integrator: turn on shadow casting/receiving across a
 * furniture group. Floor-standing solids cast; thin planes (rugs, art) only
 * receive. Cheap heuristic, big visual payoff.
 */
export function enableShadows(root) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData && o.userData.noShadow) return;
    const g = o.geometry;
    if (g && !g.boundingBox) g.computeBoundingBox();
    const bb = g && g.boundingBox;
    const thin = bb ? (bb.max.y - bb.min.y) < 0.03 : false;
    o.castShadow = !thin;
    o.receiveShadow = true;
  });
}

export default createLighting;

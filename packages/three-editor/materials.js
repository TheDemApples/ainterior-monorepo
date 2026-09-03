// packages/three-editor/materials.js
// Named colour roles for procedural furniture proxies (SPEC §4.1 `proxy.parts[].color`)
// plus the §2 design tokens used by the editor's 3D overlays.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import {
  floorAlbedo, floorRoughness, plasterAlbedo, plasterBump, fabricWeave,
  rugPile, woodGrain, metalBrush, tiled, FLOOR_MATERIALS,
} from './textures.js';

/** §2 authoritative tokens (subset needed in the 3D scene). */
export const TOKENS = {
  ink: '#0B0B0C',
  surface: '#121215',
  surface2: '#1A1A1E',
  surface3: '#232329',
  bone: '#F5F2ED',
  boneDim: '#C9C4BB',
  muted: '#8A8A93',
  clay: '#DC6B47',
  clayDim: '#A94E31',
  blueprint: '#3B6EF6',
  blueprintDim: '#2A4FB8',
  ok: '#4FA97C',
  warn: '#E0A33C',
  err: '#E05B4A',
};

/**
 * The six named colour roles. `body` is overridden per-instance by the active
 * colourway hex; the other five are material-like and stay constant.
 */
export const ROLES = {
  // SPEC2 §G.3 — believable roughness/metalness per role.
  body:   { hex: '#D8D2C4', roughness: 0.72, metalness: 0.0, tex: 'none' },
  wood:   { hex: '#A87B4E', roughness: 0.54, metalness: 0.0, tex: 'wood',
            bumpScale: 0.006, envIntensity: 0.55 },
  metal:  { hex: '#9DA3A9', roughness: 0.28, metalness: 0.92, tex: 'metal',
            envIntensity: 1.25 },
  // "transmissive-looking but cheap" — no MeshPhysicalMaterial transmission
  // (that costs a scene render pass). Low-roughness + low-opacity + strong env
  // reads as glass at a fraction of the price.
  glass:  { hex: '#CBDCE8', roughness: 0.05, metalness: 0.0, opacity: 0.24,
            transparent: true, envIntensity: 2.0, tex: 'none' },
  fabric: { hex: '#B7AFA2', roughness: 0.94, metalness: 0.0, tex: 'fabric',
            bumpScale: 0.0035, sheen: 0.5, envIntensity: 0.35 },
  dark:   { hex: '#26262B', roughness: 0.48, metalness: 0.12, tex: 'none',
            envIntensity: 0.7 },
  // additive roles (not referenced by editor.js; safe to add)
  rug:    { hex: '#9C9284', roughness: 1.0, metalness: 0.0, tex: 'rug',
            bumpScale: 0.005, sheen: 0.25, envIntensity: 0.2 },
  leather:{ hex: '#7A5340', roughness: 0.62, metalness: 0.0, tex: 'fabric',
            bumpScale: 0.002, sheen: 0.3, envIntensity: 0.6 },
};

export function isHex(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

/** Slightly perturb a hex colour's lightness. Used to keep parts readable. */
export function shade(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return '#' + c.getHexString();
}

/**
 * Material library. Caches by `role|hex` so a 100+ item catalog doesn't
 * allocate thousands of materials.
 */
export function createMaterialLibrary() {
  const cache = new Map();
  const owned = [];

  function make(def, hexOverride) {
    const hex = hexOverride || def.hex;
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: def.roughness ?? 0.8,
      metalness: def.metalness ?? 0.0,
      transparent: !!def.transparent,
      opacity: def.opacity ?? 1,
      side: THREE.FrontSide,
    });
    // ---- SPEC2 §G.3/§G.4: attach the shared procedural maps ---------------
    // All maps come from the module-level cache in textures.js, so a hundred
    // fabric materials reference ONE weave texture.
    try {
      switch (def.tex) {
        case 'wood':
          m.bumpMap = woodGrain();
          m.bumpScale = def.bumpScale ?? 0.005;
          m.roughnessMap = woodGrain();
          break;
        case 'fabric':
          m.bumpMap = fabricWeave();
          m.bumpScale = def.bumpScale ?? 0.0035;
          m.roughnessMap = fabricWeave();
          break;
        case 'rug':
          m.bumpMap = rugPile();
          m.bumpScale = def.bumpScale ?? 0.005;
          m.roughnessMap = rugPile();
          break;
        case 'metal':
          m.roughnessMap = metalBrush();
          break;
        default: break;
      }
    } catch (_) { /* canvas unavailable (SSR/tests) — plain colour is fine */ }
    if (def.envIntensity != null) m.envMapIntensity = def.envIntensity;
    // MeshStandardMaterial gained `sheen` in r132+; guard anyway.
    if (def.sheen != null && 'sheen' in m) {
      m.sheen = def.sheen;
      m.sheenRoughness = 0.85;
      m.sheenColor = new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), 0.55);
    }
    owned.push(m);
    return m;
  }

  /**
   * @param {string} role  one of ROLES keys, or a literal `#RRGGBB`
   * @param {string} [bodyHex] active colourway hex, applied when role==='body'
   */
  function get(role, bodyHex) {
    let key, def, hexOverride = null;
    if (isHex(role)) {
      key = 'lit|' + role;
      def = ROLES.body;
      hexOverride = role;
    } else if (role === 'body' || role === 'fabric') {
      const h = bodyHex && isHex(bodyHex) ? bodyHex : ROLES[role].hex;
      hexOverride = role === 'fabric' && bodyHex ? shade(h, -0.03) : h;
      key = role + '|' + hexOverride;
      def = ROLES[role];
    } else {
      def = ROLES[role] || ROLES.body;
      key = (ROLES[role] ? role : 'body') + '|' + def.hex;
    }
    if (!cache.has(key)) cache.set(key, make(def, hexOverride));
    return cache.get(key);
  }

  // ---- shell / overlay materials ------------------------------------------
  // SPEC2 §G.4: the shell reads as plaster + real flooring, not grey blocks.
  // These are *shared* materials; room.js retints/tiles clones where it needs to.
  const floorMatCache = new Map();

  /**
   * Floor material for a given `floor_material` token (§G2:
   * oak | ash | concrete | tile | carpet). Cached per kind and reused across
   * every room in a multi-room plan.
   */
  function floorMaterial(kind = 'oak') {
    const k = FLOOR_MATERIALS.indexOf(kind) >= 0 ? kind : 'oak';
    if (floorMatCache.has(k)) return floorMatCache.get(k);
    let m;
    try {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#ffffff'),
        map: floorAlbedo(k),
        roughnessMap: floorRoughness(k),
        roughness: 1.0,
        metalness: 0.0,
        envMapIntensity: k === 'tile' ? 0.85 : (k === 'carpet' ? 0.10 : 0.35),
        side: THREE.FrontSide,
      });
      if (k === 'carpet' || k === 'oak' || k === 'ash') {
        m.bumpMap = k === 'carpet' ? rugPile() : woodGrain();
        m.bumpScale = k === 'carpet' ? 0.004 : 0.0018;
      }
    } catch (_) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color('#A88A62'), roughness: 0.9 });
    }
    owned.push(m);
    floorMatCache.set(k, m);
    return m;
  }

  let wallMat;
  try {
    wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#EFEAE1'),
      map: plasterAlbedo(),
      bumpMap: plasterBump(),
      bumpScale: 0.0025,
      roughness: 0.93,
      metalness: 0,
      transparent: true,
      opacity: 1,
      envMapIntensity: 0.35,
      side: THREE.DoubleSide,
    });
  } catch (_) {
    wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#EFEAE1'), roughness: 0.94, metalness: 0,
      transparent: true, opacity: 1, side: THREE.DoubleSide,
    });
  }

  const shell = {
    // default floor stays available under the original key/signature
    floor: floorMaterial('oak'),
    floorMaterial,
    wall: wallMat,
    baseboard: make({ hex: '#F2EDE4', roughness: 0.44, metalness: 0.0, envIntensity: 0.5 }),
    // thin dark reveal where wall meets floor / window returns (§G.6)
    reveal: make({ hex: '#D9D2C6', roughness: 0.86, metalness: 0 }),
    glassPane: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#DCEAF6'),
      roughness: 0.04,
      metalness: 0.0,
      transparent: true,
      opacity: 0.16,
      envMapIntensity: 2.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    ceiling: make({ hex: '#F6F2EA', roughness: 0.96, metalness: 0 }),
  };
  owned.push(shell.wall, shell.glassPane);

  /** Error tint overlay: --err at 35% opacity (SPEC §5.3). */
  const errTint = new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.err),
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  owned.push(errTint);

  const selectTint = new THREE.MeshBasicMaterial({
    color: new THREE.Color(TOKENS.clay),
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  owned.push(selectTint);

  function lineMat(hex, opacity = 1, dashed = false) {
    const m = dashed
      ? new THREE.LineDashedMaterial({
          color: new THREE.Color(hex), transparent: true, opacity,
          dashSize: 0.09, gapSize: 0.06, depthWrite: false,
        })
      : new THREE.LineBasicMaterial({
          color: new THREE.Color(hex), transparent: true, opacity, depthWrite: false,
        });
    owned.push(m);
    return m;
  }

  function dispose() {
    owned.forEach((m) => m.dispose && m.dispose());
    cache.clear();
    floorMatCache.clear();
    owned.length = 0;
    // NOTE: shared textures are intentionally NOT disposed here — they live in
    // the textures.js module cache and outlive any single material library.
    // Call disposeTextures() from textures.js on full teardown.
  }

  // Contract (unchanged, editor.js depends on it):
  //   { get, shell, errTint, selectTint, lineMat, dispose, TOKENS, ROLES }
  // Everything after `ROLES` is additive.
  return {
    get, shell, errTint, selectTint, lineMat, dispose, TOKENS, ROLES,
    floorMaterial, tiled,
  };
}

export default createMaterialLibrary;

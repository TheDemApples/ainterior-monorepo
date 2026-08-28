// packages/three-editor/materials.js
// Named colour roles for procedural furniture proxies (SPEC §4.1 `proxy.parts[].color`)
// plus the §2 design tokens used by the editor's 3D overlays.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

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
  body: { hex: '#D8D2C4', roughness: 0.82, metalness: 0.0 },
  wood: { hex: '#A87B4E', roughness: 0.62, metalness: 0.0 },
  metal: { hex: '#9DA3A9', roughness: 0.34, metalness: 0.85 },
  glass: { hex: '#C6D8E4', roughness: 0.08, metalness: 0.0, opacity: 0.3, transparent: true },
  fabric: { hex: '#B7AFA2', roughness: 1.0, metalness: 0.0 },
  dark: { hex: '#26262B', roughness: 0.55, metalness: 0.1 },
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
  const shell = {
    floor: make({ hex: '#2B2B30', roughness: 0.95, metalness: 0 }),
    wall: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#3A3A41'),
      roughness: 0.94,
      metalness: 0,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    }),
    baseboard: make({ hex: '#4A4A52', roughness: 0.7, metalness: 0 }),
    reveal: make({ hex: '#1A1A1E', roughness: 0.9, metalness: 0 }),
    glassPane: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#8FB6D8'),
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    }),
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
    owned.length = 0;
  }

  return { get, shell, errTint, selectTint, lineMat, dispose, TOKENS, ROLES };
}

export default createMaterialLibrary;

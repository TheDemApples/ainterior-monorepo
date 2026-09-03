// packages/three-editor/textures.js
// SPEC2 §G.4 — procedural, canvas-generated textures. No downloads, no deps.
//
// Rules enforced here:
//   * every texture is <=512px
//   * every texture is generated ONCE and cached in a module-level Map, then
//     shared across every instance that asks for it (never per-item)
//   * mipmaps + anisotropy on, RepeatWrapping, tiled by *world size* via
//     `tileTo(tex, worldW, worldH, metresPerTile)` so scale reads correctly
//
// Colour-space discipline: albedo maps are SRGBColorSpace, data maps
// (roughness / normal / alpha) stay in the default linear space.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

const CACHE = new Map();
let MAX_ANISO = 4;

/** Called once by createEnvironment/applyRenderer so we can set anisotropy. */
export function setRendererCaps(renderer) {
  try {
    const m = renderer.capabilities.getMaxAnisotropy();
    MAX_ANISO = Math.max(1, Math.min(8, m || 1));
    CACHE.forEach((t) => { if (t && t.isTexture) { t.anisotropy = MAX_ANISO; t.needsUpdate = true; } });
  } catch (_) { /* headless / no caps */ }
}

function canvas(size) {
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  c.width = size; c.height = size;
  return c;
}

function finish(cvs, { srgb = true, repeat = 1 } = {}) {
  const t = new THREE.CanvasTexture(cvs);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = MAX_ANISO;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Deterministic hash noise — same texture every reload, no Math.random drift. */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap value-noise field, tileable by wrapping the lattice. */
function valueNoise(size, cells, seed) {
  const rnd = mulberry(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  const sc = cells / size;
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = y * sc, y0 = Math.floor(fy), ty = sm(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = x * sc, x0 = Math.floor(fx), tx = sm(fx - x0);
      const i00 = (y0 % cells) * cells + (x0 % cells);
      const i10 = (y0 % cells) * cells + ((x0 + 1) % cells);
      const i01 = ((y0 + 1) % cells) * cells + (x0 % cells);
      const i11 = ((y0 + 1) % cells) * cells + ((x0 + 1) % cells);
      const a = g[i00] + (g[i10] - g[i00]) * tx;
      const b = g[i01] + (g[i11] - g[i01]) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fbm(size, seed, octaves = 4, base = 4) {
  const out = new Float32Array(size * size);
  let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, base << o, seed + o * 977);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

// ---------------------------------------------------------------- floors ---

const FLOOR_PALETTE = {
  oak:      { base: [176, 138, 96], dark: [128, 94, 60], plankW: 0.14, plankL: 0.62, grain: 0.10, rough: [0.42, 0.62] },
  ash:      { base: [206, 188, 162], dark: [166, 146, 118], plankW: 0.14, plankL: 0.62, grain: 0.07, rough: [0.44, 0.62] },
  concrete: { base: [150, 148, 145], dark: [126, 124, 122], plankW: 0,    plankL: 0,    grain: 0.03, rough: [0.72, 0.88] },
  tile:     { base: [216, 214, 208], dark: [176, 174, 168], plankW: 0.5,  plankL: 0.5,  grain: 0.02, rough: [0.24, 0.36] },
  carpet:   { base: [150, 142, 130], dark: [124, 116, 106], plankW: 0,    plankL: 0,    grain: 0.06, rough: [0.92, 1.0] },
};

export const FLOOR_MATERIALS = Object.keys(FLOOR_PALETTE);

/**
 * Wood-plank / slab albedo. `kind` = oak|ash|concrete|tile|carpet.
 * 512px, one texture per kind, cached forever.
 */
export function floorAlbedo(kind = 'oak') {
  const key = 'floor:' + kind;
  if (CACHE.has(key)) return CACHE.get(key);
  const P = FLOOR_PALETTE[kind] || FLOOR_PALETTE.oak;
  const S = 512;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const rnd = mulberry(kind.length * 7717 + 13);

  ctx.fillStyle = `rgb(${P.base[0]},${P.base[1]},${P.base[2]})`;
  ctx.fillRect(0, 0, S, S);

  if (kind === 'carpet') {
    // dense short pile: thousands of tiny tufts
    const noise = fbm(S, 41, 3, 16);
    const img = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < S * S; i++) {
      const n = (noise[i] - 0.5) * 46 + (rnd() - 0.5) * 26;
      img.data[i * 4] = Math.max(0, Math.min(255, P.base[0] + n));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, P.base[1] + n));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, P.base[2] + n));
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === 'concrete') {
    const n1 = fbm(S, 7, 5, 3);
    const img = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < S * S; i++) {
      const n = (n1[i] - 0.5) * 34 + (rnd() - 0.5) * 8;
      img.data[i * 4] = Math.max(0, Math.min(255, P.base[0] + n));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, P.base[1] + n));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, P.base[2] + n));
    }
    ctx.putImageData(img, 0, 0);
  } else {
    // planks: rows offset per course, per-plank tint, longitudinal grain
    const pw = Math.round(S * (kind === 'tile' ? 0.5 : 0.25));   // plank width in px
    const rows = Math.round(S / pw);
    const n1 = fbm(S, 23, 4, 6);
    for (let r = 0; r < rows; r++) {
      const y0 = r * pw;
      const offset = (r % 2) * (S * 0.37);
      const plankLen = kind === 'tile' ? S * 0.5 : S * 0.74;
      for (let sx = -plankLen; sx < S; sx += plankLen) {
        const x0 = sx + offset;
        const tint = (rnd() - 0.5) * 2;
        const lerp = 0.30 + rnd() * 0.30 + tint * 0.06;
        const cr = P.base[0] + (P.dark[0] - P.base[0]) * lerp;
        const cg = P.base[1] + (P.dark[1] - P.base[1]) * lerp;
        const cb = P.base[2] + (P.dark[2] - P.base[2]) * lerp;
        ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        ctx.fillRect(x0, y0, plankLen, pw);
        // seam: dark groove on the right + bottom edge -> reads as a real joint
        ctx.fillStyle = 'rgba(30,20,12,0.55)';
        ctx.fillRect(x0 + plankLen - 1.5, y0, 1.5, pw);
      }
      ctx.fillStyle = 'rgba(30,20,12,0.45)';
      ctx.fillRect(0, y0 + pw - 1.5, S, 1.5);
    }
    // grain: horizontal streaks modulated by fbm
    if (P.grain > 0) {
      const img = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const streak = Math.sin(x * 0.09 + n1[i] * 22) * 0.5 + 0.5;
          const g = (streak - 0.5) * 255 * P.grain + (n1[i] - 0.5) * 255 * P.grain * 0.7;
          img.data[i * 4] = Math.max(0, Math.min(255, img.data[i * 4] + g));
          img.data[i * 4 + 1] = Math.max(0, Math.min(255, img.data[i * 4 + 1] + g * 0.88));
          img.data[i * 4 + 2] = Math.max(0, Math.min(255, img.data[i * 4 + 2] + g * 0.72));
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  }
  const t = finish(cvs, { srgb: true });
  t.userData = { kind, rough: P.rough };
  CACHE.set(key, t);
  return t;
}

/** Matching roughness map for a floor kind (linear, greyscale). */
export function floorRoughness(kind = 'oak') {
  const key = 'floorR:' + kind;
  if (CACHE.has(key)) return CACHE.get(key);
  const P = FLOOR_PALETTE[kind] || FLOOR_PALETTE.oak;
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const n = fbm(S, 91, 4, 6);
  const img = ctx.createImageData(S, S);
  const [r0, r1] = P.rough;
  for (let i = 0; i < S * S; i++) {
    const v = (r0 + (r1 - r0) * n[i]) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });
  CACHE.set(key, t);
  return t;
}

// ----------------------------------------------------------------- walls ---

/** Wall plaster: near-white with *very* subtle mottling (§G.4). */
export function plasterAlbedo() {
  const key = 'plaster';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const n = fbm(S, 313, 5, 3);
  const fine = fbm(S, 517, 2, 32);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 236 + (n[i] - 0.5) * 13 + (fine[i] - 0.5) * 5;
    img.data[i * 4] = Math.max(0, Math.min(255, v));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, v - 1));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, v - 3));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: true });
  CACHE.set(key, t);
  return t;
}

/** Cheap bumpMap for plaster — greyscale, drives a tiny bumpScale. */
export function plasterBump() {
  const key = 'plasterB';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const n = fbm(S, 733, 4, 8);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 110 + (n[i] - 0.5) * 90;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });
  CACHE.set(key, t);
  return t;
}

// ---------------------------------------------------------------- fabric ---

/** Fine woven fabric: warp/weft crosshatch + slub noise. Used as bump + albedo tint. */
export function fabricWeave() {
  const key = 'fabric';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const slub = fbm(S, 1201, 3, 16);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      // 2x2 twill: alternating over/under
      const warp = Math.sin(x * Math.PI / 2) * 0.5 + 0.5;
      const weft = Math.sin(y * Math.PI / 2) * 0.5 + 0.5;
      const over = ((x >> 1) + (y >> 1)) % 2 === 0;
      const w = over ? warp : weft;
      const v = 200 + (w - 0.5) * 54 + (slub[i] - 0.5) * 30;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });   // used as bump/rough, keep linear
  CACHE.set(key, t);
  return t;
}

/** Rug / carpet pile — chunkier than upholstery weave. */
export function rugPile() {
  const key = 'rug';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const n = fbm(S, 1607, 3, 24);
  const rnd = mulberry(88);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 170 + (n[i] - 0.5) * 96 + (rnd() - 0.5) * 44;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });
  CACHE.set(key, t);
  return t;
}

/** Wood grain bump for furniture (finer than the floor planks). */
export function woodGrain() {
  const key = 'woodgrain';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const n = fbm(S, 2003, 4, 5);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      // rings warped by noise -> anisotropic-ish grain along x (§G.3)
      const rings = Math.sin((y * 0.42) + n[i] * 13.0) * 0.5 + 0.5;
      const v = 128 + (rings - 0.5) * 96 + (n[i] - 0.5) * 30;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });
  CACHE.set(key, t);
  return t;
}

/** Brushed-metal roughness variation. */
export function metalBrush() {
  const key = 'metalbrush';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 128;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  const rnd = mulberry(4409);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const row = (rnd() - 0.5) * 26;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const v = 96 + row + (rnd() - 0.5) * 12;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(cvs, { srgb: false });
  CACHE.set(key, t);
  return t;
}

// ------------------------------------------------------- contact shadow ---

/**
 * §G.5 — radial-gradient decal used as an alphaMap on a floor-hugging plane
 * under every floor-standing item. One texture, shared by every instance.
 */
export function contactShadowTex() {
  const key = 'contact';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 128;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.86)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.32)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cvs);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  CACHE.set(key, t);
  return t;
}

/** Neutral placeholder for an unset image slot (§G3). */
export function imagePlaceholder() {
  const key = 'imgph';
  if (CACHE.has(key)) return CACHE.get(key);
  const S = 256;
  const cvs = canvas(S);
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#3A3A41'; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(245,242,237,0.20)';
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, S - 28, S - 28);
  // little mountain-and-sun glyph so an empty frame still reads as a picture
  ctx.fillStyle = 'rgba(245,242,237,0.24)';
  ctx.beginPath();
  ctx.moveTo(46, 196); ctx.lineTo(104, 112); ctx.lineTo(146, 166);
  ctx.lineTo(176, 130); ctx.lineTo(214, 196);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(178, 82, 18, 0, Math.PI * 2); ctx.fill();
  const t = finish(cvs, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  CACHE.set(key, t);
  return t;
}

// ------------------------------------------------------------- utilities ---

/**
 * §G.4 "tiled by world size so scale reads correctly".
 * Returns a *shared* texture — so we clone only when the tiling differs, and
 * we cache those clones too, keyed by the repeat pair. Two 4m walls share one
 * texture object; a 4m and a 7m wall share two.
 */
export function tiled(tex, repeatX, repeatY) {
  if (!tex) return null;
  const rx = Math.max(0.05, Math.round(repeatX * 4) / 4);
  const ry = Math.max(0.05, Math.round(repeatY * 4) / 4);
  if (Math.abs(tex.repeat.x - rx) < 1e-6 && Math.abs(tex.repeat.y - ry) < 1e-6) return tex;
  const key = 'tile:' + (tex.uuid) + ':' + rx + 'x' + ry;
  if (CACHE.has(key)) return CACHE.get(key);
  const c = tex.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(rx, ry);
  c.needsUpdate = true;
  CACHE.set(key, c);
  return c;
}

/** metres-per-tile helper: a 4.2m wall with 1.2m tiles -> repeat 3.5 */
export function repeatsFor(worldW, worldH, metresPerTile = 1) {
  return [worldW / metresPerTile, worldH / metresPerTile];
}

export function textureCacheSize() { return CACHE.size; }

export function disposeTextures() {
  CACHE.forEach((t) => t && t.dispose && t.dispose());
  CACHE.clear();
}

export default {
  floorAlbedo, floorRoughness, plasterAlbedo, plasterBump, fabricWeave,
  rugPile, woodGrain, metalBrush, contactShadowTex, imagePlaceholder,
  tiled, repeatsFor, setRendererCaps, disposeTextures, FLOOR_MATERIALS,
};

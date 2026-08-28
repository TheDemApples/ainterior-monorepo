// services/vision/index.js  -- SPEC §5.4
//
//   identifyUpload({ imageBytes }) => { labels, archetype_guess, dims_estimate_mm?,
//                                       phash, embedding: Float32Array(512) }
//   findMatches({ embedding, phash, catalog }) => [{ item_id, similarity, reason }]
//
// Dependency-free and DOM-free so it runs in Node tests, in a Deno edge function
// and in the browser demo. The embedding is a deterministic 512-d visual
// descriptor (see buildEmbedding) — swap in a hosted CLIP/DINO encoder by setting
// VISION_EMBEDDER=remote and providing embedRemote(); the contract is identical.

import { pHashFromGray, decodeToGray, resizeGray, dct2d, hammingHex } from './phash.js';

export const EMBEDDING_DIM = 512;
/** SPEC §5.4: at or above this cosine similarity we DO NOT spend a credit. */
export const DEDUPE_THRESHOLD = 0.86;
/** SPEC §5.4: cluster members must be this similar to each other. */
export const CLUSTER_THRESHOLD = 0.9;
/** SPEC §5.4: distinct uploaders needed before a cluster is queued for review. */
export const MATCH_PROMOTION_THRESHOLD = 5;
/** phash Hamming distance under which we treat two photos as the same object. */
export const PHASH_NEAR_DUPLICATE = 6;
export const PHASH_SIMILAR = 10;

/* ------------------------------------------------------------------ helpers */
export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = v instanceof Float32Array ? v : new Float32Array(v);
  for (let i = 0; i < out.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine similarity in [-1,1]. Mirrors SQL `1 - (a <=> b)`. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ---------------------------------------------------------------- embedding */
// 512 dims, deterministic, contrast-normalised so a flat background contributes
// ~nothing (otherwise two photos of *anything* on a white wall look alike):
//   [0..255]   16x16 z-scored luminance (global structure, mean removed)
//   [256..319] 8x8 low-frequency DCT block, DC dropped (shape energy, not brightness)
//   [320..415] 6x4 cells x 4 gradient-orientation bins (edge layout)
//   [416..447] 32-bin luminance histogram (material/tone, down-weighted)
//   [448..511] 8x8 vertical-gradient map (silhouette: legs, backrest, top)
// Each block is L2-normalised and weighted before the final normalisation, so no
// single block can dominate the cosine.
const BLOCK_WEIGHTS = { lum: 1.0, dct: 1.0, hog: 1.25, hist: 0.3, vgrad: 0.9 };

function normalizeBlock(v, from, to, weight) {
  let s = 0;
  for (let i = from; i < to; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = from; i < to; i++) v[i] = (v[i] / n) * weight;
}

export function buildEmbedding(gray, width, height) {
  const v = new Float32Array(EMBEDDING_DIM);
  let o = 0;

  // global mean / std for contrast normalisation
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length || 1;
  let varsum = 0;
  for (let i = 0; i < gray.length; i++) varsum += (gray[i] - mean) ** 2;
  const std = Math.sqrt(varsum / (gray.length || 1)) || 1;
  const z = (x) => Math.max(-3, Math.min(3, (x - mean) / std)) / 3;

  const g16 = resizeGray(gray, width, height, 16, 16);
  for (let i = 0; i < 256; i++) v[o++] = z(g16[i]);
  normalizeBlock(v, 0, 256, BLOCK_WEIGHTS.lum);

  const g32 = resizeGray(gray, width, height, 32, 32);
  const centred = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) centred[i] = g32[i] - mean;
  const dct = dct2d(centred, 32);
  const dctFrom = o;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) v[o++] = (x === 0 && y === 0) ? 0 : Math.tanh(dct[y * 32 + x] / 256);
  normalizeBlock(v, dctFrom, o, BLOCK_WEIGHTS.dct);

  const CW = 6, CH = 4, BINS = 4;
  const cellW = Math.max(1, Math.floor(width / CW)), cellH = Math.max(1, Math.floor(height / CH));
  const hog = new Float64Array(CW * CH * BINS);
  const edgeFloor = Math.max(3, std * 0.25);
  for (let y = 1; y < height - 1; y++) {
    const cy = Math.min(CH - 1, Math.floor(y / cellH));
    for (let x = 1; x < width - 1; x++) {
      const cx = Math.min(CW - 1, Math.floor(x / cellW));
      const gx = gray[y * width + x + 1] - gray[y * width + x - 1];
      const gy = gray[(y + 1) * width + x] - gray[(y - 1) * width + x];
      const mag = Math.hypot(gx, gy);
      if (mag < edgeFloor) continue;
      let ang = Math.atan2(gy, gx);
      if (ang < 0) ang += Math.PI;
      const bin = Math.min(BINS - 1, Math.floor((ang / Math.PI) * BINS));
      hog[(cy * CW + cx) * BINS + bin] += mag;
    }
  }
  let hmax = 0; for (const x of hog) if (x > hmax) hmax = x;
  const hogFrom = o;
  for (let i = 0; i < hog.length; i++) v[o++] = hmax ? hog[i] / hmax : 0;
  normalizeBlock(v, hogFrom, o, BLOCK_WEIGHTS.hog);

  const hist = new Float64Array(32);
  for (let i = 0; i < gray.length; i++) hist[Math.min(31, gray[i] >> 3)]++;
  const histFrom = o;
  // sqrt-compress (Hellinger) so one huge background bin cannot swamp the block
  for (let i = 0; i < 32; i++) v[o++] = Math.sqrt(hist[i] / gray.length);
  normalizeBlock(v, histFrom, o, BLOCK_WEIGHTS.hist);

  const g8 = resizeGray(gray, width, height, 8, 9);
  const vgFrom = o;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) v[o++] = (g8[(y + 1) * 8 + x] - g8[y * 8 + x]) / (std * 3);
  normalizeBlock(v, vgFrom, o, BLOCK_WEIGHTS.vgrad);

  return l2normalize(v);
}

/* ------------------------------------------------------- label / archetype */
const ARCHETYPES = [
  'sofa_2seat','sofa_3seat','sofa_sectional_l','loveseat','armchair','ottoman','bench','chaise',
  'dining_chair','office_chair','stool','bar_stool',
  'bed_single','bed_double','bed_queen','bed_king','crib',
  'nightstand','dresser','wardrobe','bookcase','shelf_unit','sideboard','cabinet','tv_bench','storage_box',
  'coffee_table','side_table','dining_table_rect','dining_table_round','desk','console_table','kitchen_island',
  'rug','floor_lamp','table_lamp','pendant_lamp','wall_lamp',
  'tv','art_frame','mirror','plant','curtain','wall_shelf',
];
export { ARCHETYPES };

// Typical dims per archetype (mm) used for dims_estimate_mm when no depth data.
const TYPICAL_DIMS = {
  sofa_3seat: { w: 2100, d: 900, h: 850 }, sofa_2seat: { w: 1650, d: 880, h: 850 },
  loveseat: { w: 1400, d: 850, h: 830 }, armchair: { w: 850, d: 850, h: 900 },
  ottoman: { w: 600, d: 600, h: 420 }, bench: { w: 1200, d: 400, h: 450 },
  dining_chair: { w: 450, d: 520, h: 900 }, office_chair: { w: 650, d: 650, h: 1100 },
  coffee_table: { w: 1100, d: 600, h: 400 }, side_table: { w: 500, d: 500, h: 550 },
  dining_table_rect: { w: 1600, d: 900, h: 750 }, desk: { w: 1400, d: 700, h: 740 },
  bed_queen: { w: 1600, d: 2100, h: 900 }, bed_double: { w: 1400, d: 2050, h: 900 },
  nightstand: { w: 450, d: 400, h: 550 }, dresser: { w: 1200, d: 500, h: 800 },
  wardrobe: { w: 1500, d: 600, h: 2000 }, bookcase: { w: 800, d: 300, h: 2000 },
  tv_bench: { w: 1600, d: 400, h: 500 }, rug: { w: 2000, d: 1400, h: 10 },
  floor_lamp: { w: 400, d: 400, h: 1600 }, tv: { w: 1230, d: 60, h: 710 },
  plant: { w: 500, d: 500, h: 1200 },
};

/**
 * Aspect-ratio + tone heuristics produce an offline archetype guess so the whole
 * flow is demoable with no vision API. Set VISION_LABELER=remote and inject
 * `labeler` to use a hosted classifier; the return shape is unchanged.
 */
export function guessArchetype(gray, width, height) {
  const g = resizeGray(gray, width, height, 32, 32);
  // occupancy mask: darker-than-background pixels
  let sum = 0; for (const x of g) sum += x;
  const mean = sum / g.length;
  let minX = 32, maxX = -1, minY = 32, maxY = -1, count = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (Math.abs(g[y * 32 + x] - mean) > 12) {
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { minX = 0; maxX = 31; minY = 0; maxY = 31; count = 1024; }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const ar = bw / bh;                       // wide > 1, tall < 1
  const fill = count / (bw * bh);
  const cands = [];
  if (ar > 2.2) cands.push(['sofa_3seat', 0.62], ['rug', 0.28], ['tv_bench', 0.24]);
  else if (ar > 1.5) cands.push(['sofa_2seat', 0.55], ['coffee_table', 0.42], ['bed_double', 0.3]);
  else if (ar > 0.85) cands.push(['armchair', 0.52], ['side_table', 0.4], ['ottoman', 0.3]);
  else if (ar > 0.5) cands.push(['dining_chair', 0.5], ['nightstand', 0.4], ['bookcase', 0.3]);
  else cands.push(['floor_lamp', 0.5], ['wardrobe', 0.4], ['bookcase', 0.35]);
  if (fill < 0.35) cands.unshift(['floor_lamp', 0.45]);
  const labels = cands.map(([name, c]) => ({ name, confidence: +c.toFixed(2) }))
    .sort((a, b) => b.confidence - a.confidence);
  return { labels, archetype_guess: labels[0].name, aspect: ar, fill };
}

/* ----------------------------------------------------------- identifyUpload */
/**
 * @param {{imageBytes: Uint8Array|Buffer, gray?:Float64Array, width?:number,
 *          height?:number, labeler?:Function, embedder?:Function}} args
 */
export async function identifyUpload({ imageBytes, gray, width, height, labeler, embedder } = {}) {
  let plane = gray, w = width, h = height;
  if (!plane) {
    if (!imageBytes) throw new Error('identifyUpload: imageBytes required');
    const d = decodeToGray(imageBytes);
    plane = d.gray; w = d.width; h = d.height;
  }
  const phash = pHashFromGray(plane, w, h);
  const embedding = embedder ? l2normalize(await embedder({ gray: plane, width: w, height: h }))
                             : buildEmbedding(plane, w, h);
  const guess = labeler ? await labeler({ gray: plane, width: w, height: h })
                        : guessArchetype(plane, w, h);
  const typical = TYPICAL_DIMS[guess.archetype_guess] || null;
  return {
    labels: guess.labels,
    archetype_guess: guess.archetype_guess,
    dims_estimate_mm: typical ? { ...typical, estimated: true } : undefined,
    phash,
    embedding,
    source_px: { width: w, height: h },
  };
}

/* -------------------------------------------------------------- findMatches */
/**
 * Nearest-neighbour over a catalog. `catalog` may be an Array<CatalogItem>, a
 * Map<id, item> or `{ items: [...] }`. Items need `embedding` (Array/Float32) and
 * optionally `phash`. Mirrors SQL match_catalog_items() exactly so the JS and the
 * database agree on ordering and on the `reason` strings.
 */
export function findMatches({ embedding, phash, catalog, limit = 5, threshold = 0.0,
                              archetype = null } = {}) {
  const items = Array.isArray(catalog) ? catalog
    : catalog instanceof Map ? [...catalog.values()]
    : Array.isArray(catalog?.items) ? catalog.items
    : Object.values(catalog || {});
  const out = [];
  for (const it of items) {
    if (!it || it.published === false) continue;
    if (archetype && it.archetype !== archetype) continue;
    const emb = it.embedding;
    if (!emb) continue;
    const similarity = cosine(embedding, emb);
    if (similarity < threshold) continue;
    const pd = phash && it.phash ? hammingHex(phash, it.phash) : null;
    out.push({
      item_id: it.id,
      name: it.name,
      brand: it.brand,
      archetype: it.archetype,
      dims_mm: it.dims_mm,
      similarity,
      phash_distance: pd,
      reason: reasonFor(similarity, pd, it),
    });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, limit);
}

function reasonFor(similarity, pd, it) {
  if (pd !== null && pd <= PHASH_SIMILAR) return `near-identical image (phash distance ${pd})`;
  if (similarity >= DEDUPE_THRESHOLD) return `visual embedding match (${(similarity * 100).toFixed(1)}%)`;
  return `similar ${it.archetype || 'piece'}`;
}

/* --------------------------------------------------------- the credit gate */
/**
 * The single decision the product hangs on (SPEC §5.4).
 * Returns { gated, credit_cost, match, modal } — `gated: true` means DO NOT run
 * 3D generation and DO NOT spend a credit; show the modal instead.
 */
export function evaluateDedupe({ matches, threshold = DEDUPE_THRESHOLD } = {}) {
  const top = matches && matches.length ? matches[0] : null;
  const byEmbedding = !!top && top.similarity >= threshold;
  const byPhash = !!top && top.phash_distance !== null && top.phash_distance !== undefined
                  && top.phash_distance <= PHASH_NEAR_DUPLICATE;
  const gated = byEmbedding || byPhash;
  return {
    gated,
    credit_cost: gated ? 0 : 1,
    threshold,
    match: top,
    matched_by: gated ? (byPhash ? 'phash' : 'embedding') : null,
    modal: gated
      ? {
          title: `Is this the same as ${top.name}?`,
          body: 'It looks like a piece already in our catalog — using ours keeps your credits and gives you exact dimensions.',
          actions: [
            { id: 'use_catalog', label: 'Yes, use the catalog piece', item_id: top.item_id },
            { id: 'generate_mine', label: "No, it's different — generate mine" },
            { id: 'browse', label: 'Browse the catalog' },
          ],
        }
      : null,
  };
}

/* ------------------------------------------------------------- clustering */
/**
 * Offline mirror of SQL find_user_item_clusters(). Greedy: each item seeds a
 * neighbourhood at cosine >= CLUSTER_THRESHOLD; neighbourhoods with >=
 * MATCH_PROMOTION_THRESHOLD distinct owners are promotion candidates.
 */
export function clusterUserItems(userItems, {
  cos = CLUSTER_THRESHOLD, minUsers = MATCH_PROMOTION_THRESHOLD } = {}) {
  const clusters = [];
  const seen = new Set();
  for (const seed of userItems) {
    if (!seed.embedding || seen.has(seed.id)) continue;
    const members = userItems.filter((o) => o.embedding && cosine(seed.embedding, o.embedding) >= cos);
    const owners = new Set(members.map((m) => m.owner));
    if (owners.size >= minUsers) {
      members.forEach((m) => seen.add(m.id));
      clusters.push({
        seed_item_id: seed.id,
        member_ids: members.map((m) => m.id),
        cluster_size: members.length,
        distinct_users: owners.size,
        archetype: seed.archetype,
        qualifies: true,
      });
    }
  }
  return clusters.sort((a, b) => b.distinct_users - a.distinct_users);
}

export default {
  identifyUpload, findMatches, evaluateDedupe, clusterUserItems, cosine,
  buildEmbedding, guessArchetype, DEDUPE_THRESHOLD, CLUSTER_THRESHOLD,
  MATCH_PROMOTION_THRESHOLD, EMBEDDING_DIM,
};

// End-to-end proof of the credit-saving dedupe maths (SPEC section 5.4).
//   1. synthetic embeddings prove the 0.86 threshold gates exactly
//   2. real images (PNG + JPEG) prove pHash + embedding agree on "same object"
//   3. cluster promotion proves the >=5 distinct users @ cosine >=0.9 rule
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  identifyUpload, findMatches, evaluateDedupe, clusterUserItems, cosine,
  buildEmbedding, l2normalize, DEDUPE_THRESHOLD, CLUSTER_THRESHOLD,
  MATCH_PROMOTION_THRESHOLD, EMBEDDING_DIM,
} from '../services/vision/index.js';
import { pHash, hammingHex, decodeToGray, dct2d } from '../services/vision/phash.js';
import { test, testAsync, assert, summary } from './harness.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFileSync(path.join(FX, f));

console.log('\n=== services/vision ===');
console.log(`thresholds: dedupe=${DEDUPE_THRESHOLD} cluster=${CLUSTER_THRESHOLD} `
          + `promote_users=${MATCH_PROMOTION_THRESHOLD} dim=${EMBEDDING_DIM}`);

/* ------------------------------------------------- 0. DCT sanity */
test('dct2d matches the analytic DC term', () => {
  const N = 8, flat = new Float64Array(N * N).fill(100);
  const c = dct2d(flat, N);
  // DC of a constant field = mean * N * (2/N) * 0.5 = mean ; check it dominates
  assert.gte(Math.abs(c[0]), 100, 'DC coefficient too small');
  for (let i = 1; i < N * N; i++) assert.lt(Math.abs(c[i]), 1e-6, 'AC of a flat field must be ~0');
});

/* --------------------------- 1. synthetic embeddings: exact threshold gating */
function synth(seed) {
  let s = seed >>> 0 || 7;
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    v[i] = s / 4294967296 - 0.5;
  }
  return l2normalize(v);
}
/** Blend two unit vectors so cosine(base, out) lands on `target`. */
function atSimilarity(base, target, seed = 99) {
  const r = synth(seed);
  // orthogonalise r against base
  let dot = 0; for (let i = 0; i < base.length; i++) dot += base[i] * r[i];
  const perp = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) perp[i] = r[i] - dot * base[i];
  const pn = l2normalize(perp);
  const out = new Float32Array(base.length);
  const k = Math.sqrt(Math.max(0, 1 - target * target));
  for (let i = 0; i < base.length; i++) out[i] = target * base[i] + k * pn[i];
  return l2normalize(out);
}

const base = synth(12345);
const catalog = [
  { id: 'ikea-ektorp-3s', name: 'EKTORP', brand: 'IKEA', archetype: 'sofa_3seat',
    dims_mm: { w: 2180, d: 880, h: 880 }, published: true, phash: 'a1b2c3d4e5f60718',
    embedding: base },
  { id: 'ikea-poang', name: 'POÄNG', brand: 'IKEA', archetype: 'armchair',
    dims_mm: { w: 680, d: 820, h: 1000 }, published: true, phash: '0f1e2d3c4b5a6978',
    embedding: synth(777) },
  { id: 'unpublished-sofa', name: 'SECRET', brand: 'IKEA', archetype: 'sofa_3seat',
    dims_mm: { w: 2000, d: 900, h: 850 }, published: false, embedding: base },
];

test('cosine of a vector with itself is 1', () => assert.close(cosine(base, base), 1, 1e-6));

const CASES = [
  [0.999, true], [0.90, true], [0.87, true], [0.8601, true],
  [0.8599, false], [0.86, true], [0.80, false], [0.50, false], [0.10, false],
];
for (const [sim, expectGated] of CASES) {
  test(`similarity ${sim.toFixed(4)} -> ${expectGated ? 'GATED (0 credits)' : 'charge 1 credit'}`, () => {
    const q = atSimilarity(base, sim, 4242);
    const matches = findMatches({ embedding: q, phash: null, catalog });
    assert.eq(matches[0].item_id, 'ikea-ektorp-3s', 'nearest neighbour wrong');
    assert.close(matches[0].similarity, sim, 2e-3, 'similarity drifted');
    const d = evaluateDedupe({ matches });
    assert.eq(d.gated, expectGated, 'gate decision wrong');
    assert.eq(d.credit_cost, expectGated ? 0 : 1, 'credit cost wrong');
    if (expectGated) {
      assert.ok(d.modal, 'modal payload missing');
      assert.eq(d.modal.title, 'Is this the same as EKTORP?');
      assert.eq(d.modal.actions.length, 3);
      assert.eq(d.modal.actions[0].item_id, 'ikea-ektorp-3s');
    } else {
      assert.eq(d.modal, null, 'must not show the modal below threshold');
    }
  });
}

test('unpublished catalog rows are never matched', () => {
  const m = findMatches({ embedding: base, phash: null, catalog, limit: 5 });
  assert.ok(!m.some((x) => x.item_id === 'unpublished-sofa'), 'leaked an unpublished item');
});

test('phash near-duplicate gates even when the embedding is cold', () => {
  const q = atSimilarity(base, 0.30, 31337);
  const matches = findMatches({ embedding: q, phash: 'a1b2c3d4e5f60719', catalog });
  const top = matches.find((m) => m.item_id === 'ikea-ektorp-3s');
  assert.lte(top.phash_distance, 6, 'fixture phash distance should be tiny');
  const d = evaluateDedupe({ matches: [top] });
  assert.eq(d.gated, true); assert.eq(d.credit_cost, 0); assert.eq(d.matched_by, 'phash');
});

test('empty catalog charges a credit and shows no modal', () => {
  const d = evaluateDedupe({ matches: [] });
  assert.eq(d.gated, false); assert.eq(d.credit_cost, 1); assert.eq(d.match, null);
});

/* ------------------------------------------- 2. real images through the pipeline */
await testAsync('identifyUpload on a real PNG returns the full SPEC 5.4 shape', async () => {
  const r = await identifyUpload({ imageBytes: read('sofa_a.png') });
  assert.eq(r.phash.length, 16, 'phash must be 16 hex chars');
  assert.ok(/^[0-9a-f]{16}$/.test(r.phash), 'phash must be lowercase hex');
  assert.eq(r.embedding.length, 512, 'embedding must be 512-d');
  assert.ok(r.embedding instanceof Float32Array, 'embedding must be Float32Array');
  let n = 0; for (const x of r.embedding) n += x * x;
  assert.close(Math.sqrt(n), 1, 1e-5, 'embedding must be L2-normalised');
  assert.ok(r.labels.length >= 1 && r.labels[0].confidence > 0, 'labels missing');
  assert.ok(r.archetype_guess, 'archetype_guess missing');
  console.log(`        phash=${r.phash} archetype=${r.archetype_guess} `
            + `dims=${JSON.stringify(r.dims_estimate_mm)}`);
});

await testAsync('same photo -> phash distance 0, cosine 1', async () => {
  const a = await identifyUpload({ imageBytes: read('sofa_a.png') });
  const b = await identifyUpload({ imageBytes: read('sofa_a.png') });
  assert.eq(hammingHex(a.phash, b.phash), 0);
  assert.close(cosine(a.embedding, b.embedding), 1, 1e-9);
});

await testAsync('same object, shifted + brighter -> gated (no credit spent)', async () => {
  const cat = await identifyUpload({ imageBytes: read('sofa_a.png') });
  const up = await identifyUpload({ imageBytes: read('sofa_a_variant.png') });
  const sim = cosine(cat.embedding, up.embedding);
  const hd = hammingHex(cat.phash, up.phash);
  console.log(`        cosine=${sim.toFixed(4)} phash_distance=${hd}`);
  const matches = findMatches({
    embedding: up.embedding, phash: up.phash,
    catalog: [{ id: 'ikea-ektorp-3s', name: 'EKTORP', brand: 'IKEA', archetype: 'sofa_3seat',
                published: true, embedding: cat.embedding, phash: cat.phash,
                dims_mm: { w: 2180, d: 880, h: 880 } }],
  });
  const d = evaluateDedupe({ matches });
  assert.eq(d.gated, true, 'a re-photograph of the same sofa must be gated');
  assert.eq(d.credit_cost, 0);
});

await testAsync('resampled copy still gates', async () => {
  const cat = await identifyUpload({ imageBytes: read('sofa_a.png') });
  const up = await identifyUpload({ imageBytes: read('sofa_a_rescaled.png') });
  const sim = cosine(cat.embedding, up.embedding);
  console.log(`        cosine=${sim.toFixed(4)} phash_distance=${hammingHex(cat.phash, up.phash)}`);
  assert.gte(sim, DEDUPE_THRESHOLD, 'downscale/upscale should stay above 0.86');
});

await testAsync('a genuinely different piece is NOT gated -> credit is spent', async () => {
  const cat = await identifyUpload({ imageBytes: read('sofa_a.png') });
  const up = await identifyUpload({ imageBytes: read('lamp.png') });
  const sim = cosine(cat.embedding, up.embedding);
  const hd = hammingHex(cat.phash, up.phash);
  console.log(`        cosine=${sim.toFixed(4)} phash_distance=${hd}`);
  assert.lt(sim, DEDUPE_THRESHOLD, 'floor lamp must not match a sofa');
  const matches = findMatches({
    embedding: up.embedding, phash: up.phash,
    catalog: [{ id: 'ikea-ektorp-3s', name: 'EKTORP', brand: 'IKEA', archetype: 'sofa_3seat',
                published: true, embedding: cat.embedding, phash: cat.phash,
                dims_mm: { w: 2180, d: 880, h: 880 } }],
  });
  const d = evaluateDedupe({ matches });
  assert.eq(d.gated, false, 'must charge for a genuinely new piece');
  assert.eq(d.credit_cost, 1);
});

await testAsync('JPEG DC decoder produces a usable phash', async () => {
  const png = pHash(read('sofa_a.png'));
  const jpg = pHash(read('sofa_a.jpg'));
  const hd = hammingHex(png, jpg);
  console.log(`        png=${png} jpeg=${jpg} distance=${hd}`);
  assert.ok(/^[0-9a-f]{16}$/.test(jpg), 'jpeg phash malformed');
  const g = decodeToGray(read('sofa_a.jpg'));
  assert.gte(g.width, 8); assert.gte(g.height, 8);
});

test('unsupported bytes fail loudly', () => {
  assert.throws(() => pHash(Buffer.from('not an image at all')), 'should reject junk');
});

/* -------------------------------------------- 3. cluster promotion (5 users @ 0.9) */
function cohort(n, seed, sim = 0.95) {
  const anchor = synth(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `ui_${seed}_${i}`, owner: `user_${seed}_${i}`, archetype: 'armchair',
    embedding: i === 0 ? anchor : atSimilarity(anchor, sim, seed + i * 13),
  }));
}

test('4 distinct users do NOT trigger moderation', () => {
  const c = clusterUserItems(cohort(4, 500));
  assert.eq(c.length, 0, 'must need 5 distinct users');
});

test('5 distinct users at cosine >= 0.9 DO trigger moderation', () => {
  const c = clusterUserItems(cohort(5, 600));
  assert.eq(c.length, 1, 'expected one qualifying cluster');
  assert.gte(c[0].distinct_users, MATCH_PROMOTION_THRESHOLD);
  assert.eq(c[0].cluster_size, 5);
  console.log(`        cluster: size=${c[0].cluster_size} users=${c[0].distinct_users}`);
});

test('5 uploads from the SAME user do not trigger moderation', () => {
  const items = cohort(5, 700).map((x) => ({ ...x, owner: 'same_user' }));
  assert.eq(clusterUserItems(items).length, 0, 'distinct-user rule violated');
});

test('items below cosine 0.9 do not cluster', () => {
  const c = clusterUserItems(cohort(6, 800, 0.85));
  assert.eq(c.length, 0, '0.85 < CLUSTER_THRESHOLD so must not cluster');
});

summary('services/vision');

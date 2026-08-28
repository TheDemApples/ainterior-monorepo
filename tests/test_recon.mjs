// Mock recon provider: full job lifecycle + SPEC section 4.4 Room validation,
// plus interface parity with the real Meshy implementation (SPEC section 5.5).
import { createReconProvider, normalizeJob, PROVIDERS } from '../services/recon/index.js';
import { synthesizeRoom, synthesizeObject } from '../services/recon/mock.js';
import { roomFromBBox } from '../services/recon/meshy.js';
import { test, testAsync, assert, summary } from './harness.mjs';

console.log('\n=== services/recon ===');

const ARCHETYPE_FREE = true;   // recon returns Rooms, not catalog items

/* ---------------------------------------------------- SPEC 4.4 Room validator */
function validateRoom(room, label = 'room') {
  assert.ok(room, `${label}: missing`);
  assert.ok(typeof room.id === 'string' && room.id.length, `${label}: id`);
  assert.ok(Array.isArray(room.polygon_mm), `${label}: polygon_mm must be an array`);
  assert.gte(room.polygon_mm.length, 4, `${label}: need >= 4 vertices`);
  for (const [x, y] of room.polygon_mm) {
    assert.eq(Number.isInteger(x), true, `${label}: polygon x must be an integer mm`);
    assert.eq(Number.isInteger(y), true, `${label}: polygon y must be an integer mm`);
  }
  // origin at bbox min corner (SPEC section 1)
  const minX = Math.min(...room.polygon_mm.map((p) => p[0]));
  const minY = Math.min(...room.polygon_mm.map((p) => p[1]));
  assert.eq(minX, 0, `${label}: bbox min x must be 0`);
  assert.eq(minY, 0, `${label}: bbox min y must be 0`);
  // CCW winding (shoelace > 0 with y up the page)
  let area2 = 0;
  const n = room.polygon_mm.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = room.polygon_mm[i];
    const [x2, y2] = room.polygon_mm[(i + 1) % n];
    area2 += x1 * y2 - x2 * y1;
  }
  assert.ok(area2 > 0, `${label}: polygon must be CCW (shoelace ${area2})`);
  assert.gte(area2 / 2, 4e6, `${label}: implausibly small room (${area2 / 2} mm2)`);

  assert.eq(Number.isInteger(room.height_mm), true, `${label}: height_mm integer`);
  assert.gte(room.height_mm, 2100, `${label}: ceiling too low`);
  assert.lte(room.height_mm, 4000, `${label}: ceiling implausible`);

  const doors = room.openings.filter((o) => o.type === 'door');
  const windows = room.openings.filter((o) => o.type === 'window');
  assert.eq(doors.length, 1, `${label}: exactly one door expected`);
  assert.eq(windows.length, 1, `${label}: exactly one window expected`);

  for (const o of room.openings) {
    assert.ok(o.wall_index >= 0 && o.wall_index < n, `${label}: wall_index out of range`);
    const a = room.polygon_mm[o.wall_index];
    const b = room.polygon_mm[(o.wall_index + 1) % n];
    const wallLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.gte(o.offset_mm, 0, `${label}: negative offset`);
    assert.lte(o.offset_mm + o.width_mm, wallLen,
      `${label}: opening ${o.id} overflows wall ${o.wall_index} (${o.offset_mm}+${o.width_mm} > ${Math.round(wallLen)})`);
    assert.eq(Number.isInteger(o.width_mm), true, `${label}: width_mm integer`);
    assert.eq(Number.isInteger(o.height_mm), true, `${label}: height_mm integer`);
    assert.eq(Number.isInteger(o.sill_mm), true, `${label}: sill_mm integer`);
    if (o.type === 'door') {
      assert.eq(o.sill_mm, 0, `${label}: door sill must be 0`);
      assert.ok(['in-left', 'in-right', 'out-left', 'out-right'].includes(o.swing),
        `${label}: bad swing ${o.swing}`);
    } else {
      assert.eq(o.swing, null, `${label}: window swing must be null`);
      assert.gte(o.sill_mm, 1, `${label}: window sill must be > 0`);
      assert.lte(o.sill_mm + o.height_mm, room.height_mm, `${label}: window taller than the wall`);
    }
  }
  const FEATURES = ['radiator', 'column', 'fireplace', 'stair', 'niche', 'tv_outlet', 'vent'];
  for (const f of room.features) {
    assert.ok(FEATURES.includes(f.type), `${label}: bad feature type ${f.type}`);
    assert.ok(f.wall_index >= 0 && f.wall_index < n, `${label}: feature wall_index`);
  }
  assert.ok(['photogrammetry', 'blueprint', 'manual'].includes(room.source),
    `${label}: bad source ${room.source}`);
  assert.ok(room.confidence >= 0 && room.confidence <= 1, `${label}: confidence range`);
}

/* ------------------------------------------------------------- construction */
test('createReconProvider defaults to mock and needs no API key', () => {
  delete process.env.MESHY_API_KEY;
  const p = createReconProvider();
  assert.eq(p.kind, 'mock');
  for (const m of ['createRoomFromImages', 'createRoomFromBlueprint',
                   'createObjectFromImages', 'getJob']) {
    assert.eq(typeof p[m], 'function', `mock missing ${m}`);
  }
});

test('unknown provider fails loudly', () => {
  assert.throws(() => createReconProvider('luma-ai'), 'should reject unknown provider');
});

test('meshy exposes the identical interface (constructed with a fake key)', () => {
  const p = createReconProvider('meshy', { apiKey: 'test-key', fetch: async () => new Response('{}') });
  assert.eq(p.kind, 'meshy');
  for (const m of ['createRoomFromImages', 'createRoomFromBlueprint',
                   'createObjectFromImages', 'getJob']) {
    assert.eq(typeof p[m], 'function', `meshy missing ${m}`);
  }
  assert.eq(PROVIDERS.join(','), 'mock,meshy');
});

test('meshy refuses to construct without a key (so mock stays the offline default)', () => {
  const saved = process.env.MESHY_API_KEY; delete process.env.MESHY_API_KEY;
  assert.throws(() => createReconProvider('meshy'), 'should require MESHY_API_KEY');
  if (saved) process.env.MESHY_API_KEY = saved;
});

/* ------------------------------------------------------ full job lifecycle */
await testAsync('room job walks queued -> running -> succeeded with a valid Room', async () => {
  let clock = 1_000_000;
  const p = createReconProvider('mock', { durationMs: 4000, now: () => clock });
  const { job_id } = p.createRoomFromImages({
    images: [{ storage_path: 'proj/sess/a.jpg' }, { storage_path: 'proj/sess/b.jpg' }],
    hints: { seed: 'lifecycle-test' },
  });
  assert.ok(job_id.startsWith('mock_'), 'job_id shape');

  const seen = [];
  const progress = [];
  for (const dt of [0, 200, 1000, 2000, 3000, 4100]) {
    clock = 1_000_000 + dt;
    const j = normalizeJob(p.getJob(job_id));
    seen.push(j.status); progress.push(j.progress);
  }
  console.log(`        statuses: ${seen.join(' -> ')}`);
  console.log(`        progress: ${progress.map((x) => x.toFixed(2)).join(' ')}`);
  assert.eq(seen[0], 'queued');
  assert.ok(seen.includes('running'), 'never reported running');
  assert.eq(seen[seen.length - 1], 'succeeded');
  for (let i = 1; i < progress.length; i++) {
    assert.gte(progress[i], progress[i - 1], 'progress must be monotonic');
  }
  assert.eq(progress[progress.length - 1], 1, 'final progress must be 1');

  clock += 10_000;
  const final = normalizeJob(p.getJob(job_id));
  assert.eq(final.status, 'succeeded', 'terminal state must be sticky');
  validateRoom(final.result.room, 'mock room');
  console.log(`        room: ${JSON.stringify(final.result.room.polygon_mm)} h=${final.result.room.height_mm} `
            + `conf=${final.result.room.confidence} openings=${final.result.room.openings.map((o) => o.type).join('+')}`);
});

await testAsync('blueprint job returns source=blueprint', async () => {
  let clock = 5_000_000;
  const p = createReconProvider('mock', { durationMs: 10, now: () => clock });
  const { job_id } = p.createRoomFromBlueprint({
    file: { storage_path: 'proj/plan.pdf' }, scale_hint: 50,
  });
  clock += 1000;
  const j = normalizeJob(p.getJob(job_id));
  assert.eq(j.status, 'succeeded');
  assert.eq(j.result.room.source, 'blueprint');
  assert.eq(j.result.scale_hint, 50);
  validateRoom(j.result.room, 'blueprint room');
});

await testAsync('object job returns a proxy mesh + estimated dims_mm', async () => {
  let clock = 6_000_000;
  const p = createReconProvider('mock', { durationMs: 10, now: () => clock });
  const { job_id } = p.createObjectFromImages({
    images: [{ storage_path: 'u/1.jpg' }], name: 'Grandad chair',
  });
  clock += 500;
  const j = normalizeJob(p.getJob(job_id));
  assert.eq(j.status, 'succeeded');
  assert.ok(j.result.mesh_url.startsWith('mock://'), 'mesh_url missing');
  for (const k of ['w', 'd', 'h']) {
    assert.eq(Number.isInteger(j.result.dims_mm[k]), true, `dims_mm.${k} must be integer mm`);
    assert.gte(j.result.dims_mm[k], 100);
  }
  assert.gte(j.result.proxy.parts.length, 1, 'proxy parts missing');
  for (const part of j.result.proxy.parts) {
    assert.ok(['box', 'cyl', 'sphere', 'plane'].includes(part.shape), 'bad proxy shape');
    assert.eq(part.pos.length, 3); assert.eq(part.size.length, 3);
  }
  console.log(`        object dims=${JSON.stringify(j.result.dims_mm)} parts=${j.result.proxy.parts.length}`);
});

await testAsync('failure path reports status=failed with an error string', async () => {
  let clock = 7_000_000;
  const p = createReconProvider('mock', { durationMs: 10, failRate: 1, now: () => clock });
  const { job_id } = p.createRoomFromImages({ images: [{ storage_path: 'x.jpg' }] });
  clock += 500;
  const j = normalizeJob(p.getJob(job_id));
  assert.eq(j.status, 'failed');
  assert.ok(j.error && j.error.includes('MOCK_RECON_FAILED'), 'error message missing');
  console.log(`        error: ${j.error}`);
});

test('unknown job id is reported, not thrown', () => {
  const p = createReconProvider('mock');
  const j = normalizeJob(p.getJob('mock_nope'));
  assert.eq(j.status, 'failed'); assert.eq(j.error, 'UNKNOWN_JOB');
});

test('__advance helper drives a job to completion immediately', () => {
  const p = createReconProvider('mock', { durationMs: 60_000 });
  const { job_id } = p.createRoomFromImages({ images: ['a.jpg'] });
  assert.eq(p.getJob(job_id).status, 'queued');
  const done = p.__advance(job_id);
  assert.eq(done.status, 'succeeded');
  validateRoom(done.result.room, 'advanced room');
});

/* ---------------------------------------------------------- determinism */
test('same seed -> identical Room; different seed -> different Room', () => {
  const a = synthesizeRoom('seed-A'), b = synthesizeRoom('seed-A'), c = synthesizeRoom('seed-B');
  assert.eq(JSON.stringify(a), JSON.stringify(b), 'not deterministic');
  assert.ok(JSON.stringify(a) !== JSON.stringify(c), 'different seeds produced identical rooms');
});

test('200 synthesized rooms are all SPEC 4.4 valid', () => {
  const shapes = new Set();
  for (let i = 0; i < 200; i++) {
    const r = synthesizeRoom(`bulk-${i}`);
    validateRoom(r, `bulk-${i}`);
    shapes.add(r.polygon_mm.length);
  }
  console.log(`        vertex counts seen: ${[...shapes].sort().join(', ')}`);
  assert.gte(shapes.size, 2, 'mock should produce more than one room shape');
});

test('200 synthesized objects have plausible integer dims', () => {
  for (let i = 0; i < 200; i++) {
    const o = synthesizeObject(`obj-${i}`, 'thing');
    for (const k of ['w', 'd', 'h']) assert.eq(Number.isInteger(o.dims_mm[k]), true);
  }
});

test('meshy roomFromBBox yields a SPEC 4.4 Room', () => {
  validateRoom(roomFromBBox({ w: 4200, d: 3600, h: 2600 }), 'meshy bbox room');
  validateRoom(roomFromBBox({ w: 900, d: 800, h: 1000 }), 'meshy tiny bbox room');  // clamped
});

test('normalizeJob clamps progress and defaults status', () => {
  assert.eq(normalizeJob({ progress: 5, status: 'running' }).progress, 1);
  assert.eq(normalizeJob({ progress: -2, status: 'weird' }).status, 'queued');
  assert.eq(normalizeJob(null).status, 'failed');
});

summary('services/recon');

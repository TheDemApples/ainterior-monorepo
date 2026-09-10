// tools/scan-once.mjs -- live smoke test for the huggingface recon provider.
// usage: node tools/scan-once.mjs <image> [outfile.glb]
import fs from 'node:fs';
import { createHuggingFaceProvider } from '../services/recon/huggingface.js';

const img = process.argv[2] || '/home/user/test_chair.jpeg';
const out = process.argv[3] || '/home/user/w/scan.glb';

const p = createHuggingFaceProvider();
console.log(`[scan] space=${p.__origin} anonymous=${p.__anonymous}`);

const t0 = Date.now();
const { job_id } = p.createObjectFromImages({
  images: [{ bytes: new Uint8Array(fs.readFileSync(img)), name: 'chair.jpeg', type: 'image/jpeg' }],
  name: 'Test chair',
});
console.log(`[scan] job=${job_id}`);

const job = await p.waitFor(job_id, { timeoutMs: 600000, intervalMs: 2000 });
const wall = Date.now() - t0;

if (job.status !== 'succeeded') {
  console.log(JSON.stringify({ ok: false, wall_ms: wall, error: job.error }, null, 2));
  process.exit(1);
}

const r = await fetch(job.result.mesh_url);
const buf = Buffer.from(await r.arrayBuffer());
fs.writeFileSync(out, buf);

console.log(JSON.stringify({
  ok: true,
  wall_ms: wall,
  wall_s: +(wall / 1000).toFixed(1),
  bytes: buf.length,
  mb: +(buf.length / 1048576).toFixed(2),
  mesh_url: job.result.mesh_url,
  scale_confidence: job.result.scale_confidence,
  dims_mm: job.result.dims_mm,
  saved: out,
}, null, 2));

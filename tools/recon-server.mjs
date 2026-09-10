#!/usr/bin/env node
// tools/recon-server.mjs
// Tiny zero-dependency dev server that puts the services/recon adapter behind
// HTTP so the static demo (which cannot import Node modules) can scan photos.
//
//   POST /api/scan       multipart/form-data  (field: image)   -> { job_id }
//                     or application/json     { image_base64 | image_url,
//                                               name, scale_hint:{axis,mm} }
//   GET  /api/scan/:id                                        -> job envelope
//   GET  /api/mesh?url=<space file url>                       -> CORS-safe proxy
//   GET  /api/health                                          -> provider info
//
// RUN IT (no npm install, ever):
//   cd /path/to/ainterior
//   RECON_PROVIDER=huggingface node tools/recon-server.mjs
//   # optional: PORT=8787  HF_TOKEN=hf_xxx  HF_SPACE=tencent/Hunyuan3D-2.1
//
// SMOKE TEST:
//   curl -s -F image=@test_chair.jpeg http://127.0.0.1:8787/api/scan
//   curl -s http://127.0.0.1:8787/api/scan/<job_id> | head -c 400
//
// Offline / no network? Use the default mock provider:
//   node tools/recon-server.mjs           # RECON_PROVIDER defaults to 'mock'

import http from 'node:http';
import { createReconProvider } from '../services/recon/index.js';

const PORT = Number(process.env.PORT || 8787);
const KIND = process.env.RECON_PROVIDER || 'mock';
const provider = createReconProvider(KIND);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...CORS });
  res.end(body);
};

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data parser -- enough for one image field. */
function parseMultipart(buf, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const next = buf.indexOf(sep, i + sep.length);
    if (next < 0) break;
    let chunk = buf.slice(i + sep.length, next);
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
    const hdrEnd = chunk.indexOf('\r\n\r\n');
    if (hdrEnd > 0) {
      const headers = chunk.slice(0, hdrEnd).toString();
      let content = chunk.slice(hdrEnd + 4);
      if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2);
      const name = /name="([^"]*)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      const type = /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      parts.push({ name, filename, type, content });
    }
    i = next;
  }
  return parts;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true, provider: provider.kind,
      space: provider.__origin || null,
      anonymous: provider.__anonymous ?? null,
      note: 'meshes are UNSCALED; supply one real measurement client-side (SPEC §8.8)',
    });
  }

  // CORS-safe mesh proxy: the HF Space does not send permissive CORS headers,
  // so the browser cannot fetch the .glb directly.
  if (url.pathname === '/api/mesh' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target || !/^https:\/\/[\w.-]+\.hf\.space\//.test(target)) {
      return send(res, 400, { error: 'url must be an https *.hf.space link' });
    }
    try {
      const up = await fetch(target);
      if (!up.ok) return send(res, 502, { error: `upstream HTTP ${up.status}` });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': buf.length, ...CORS });
      return res.end(buf);
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    try {
      const ctype = req.headers['content-type'] || '';
      const body = await readBody(req);
      let image = null;
      let name = 'Scanned piece';
      let scale_hint = null;

      if (ctype.startsWith('multipart/form-data')) {
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
        const b = boundary?.[1] || boundary?.[2];
        if (!b) return send(res, 400, { error: 'missing multipart boundary' });
        for (const p of parseMultipart(body, b.trim())) {
          if (p.name === 'image' && p.content?.length) {
            image = { bytes: new Uint8Array(p.content), name: p.filename || 'upload.jpg', type: p.type || 'image/jpeg' };
          } else if (p.name === 'name') name = p.content.toString();
          else if (p.name === 'scale_mm') scale_hint = { ...(scale_hint || {}), mm: Number(p.content.toString()) };
          else if (p.name === 'scale_axis') scale_hint = { ...(scale_hint || {}), axis: p.content.toString() };
        }
      } else {
        const j = JSON.parse(body.toString() || '{}');
        name = j.name || name;
        scale_hint = j.scale_hint || null;
        if (j.image_base64) image = j.image_base64;
        else if (j.image_url) image = { url: j.image_url };
      }

      if (!image) return send(res, 400, { error: 'no image supplied (multipart field "image", or image_base64 / image_url)' });

      const { job_id } = provider.createObjectFromImages({ images: [image], name, scale_hint });
      return send(res, 202, { job_id, provider: provider.kind, poll: `/api/scan/${job_id}` });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  const m = /^\/api\/scan\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const job = provider.getJob(m[1]);
    if (job.result?.mesh_url) {
      job.result.proxy_url = `/api/mesh?url=${encodeURIComponent(job.result.mesh_url)}`;
    }
    return send(res, 200, job);
  }

  return send(res, 404, { error: 'not found', routes: ['POST /api/scan', 'GET /api/scan/:id', 'GET /api/mesh?url=', 'GET /api/health'] });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[recon-server] provider=${provider.kind} listening on http://127.0.0.1:${PORT}`);
  if (provider.kind === 'huggingface') {
    console.log(`[recon-server] space=${provider.__origin} anonymous=${provider.__anonymous}`);
    console.log('[recon-server] NOTE: results are UNSCALED. Scale client-side with fitToDimension().');
  }
});

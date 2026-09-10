// services/recon/huggingface.js  -- SPEC §5.5
// FREE photo -> 3D provider backed by a public Hugging Face Space running
// tencent/Hunyuan3D-2.1 (image-to-3D shape generation).
//
// Design notes
// ------------
// * ZERO npm dependencies. We speak the Gradio REST API directly with global
//   fetch/FormData/File (Node >= 18, tested on Node 20):
//       1. POST /gradio_api/upload            -> server-side temp path
//       2. POST /gradio_api/call/<endpoint>   -> { event_id }
//       3. GET  /gradio_api/call/<endpoint>/<event_id>  -> SSE event stream
//   We parse the SSE stream by hand; no eventsource package needed.
// * Anonymous by default (the public Space genuinely works with no token).
//   Set HF_TOKEN for a personal quota, which is what you want in production.
// * Interface is byte-identical to mock.js / meshy.js so swapping providers is
//   a pure config change (RECON_PROVIDER=huggingface).
//
// HONESTY CONTRACT (SPEC §8.8 -- never invent a measurement)
// ----------------------------------------------------------
// Hunyuan3D returns a mesh normalised to roughly unit size. It carries NO
// real-world scale. This provider therefore reports:
//     scale_confidence: 'unscaled'   and   dims_mm: null
// unless the caller supplies a real measurement via `scale_hint`
// ({ axis:'w'|'d'|'h', mm:Number }), in which case it reports
//     scale_confidence: 'user-measured'  and real dims_mm.
// It will NEVER guess a size. Ground-plane removal + final scaling happen in
// packages/three-editor/mesh-import.js, which owns the geometry.

/**
 * Environment lookup that also works in a browser. This module is deliberately
 * isomorphic: the same provider drives the Node dev server AND the in-studio
 * scan button, because the Hugging Face Space sends permissive CORS headers
 * (verified: cross-origin /config and /upload both return 200), so the browser
 * can talk to it directly with no proxy.
 */
function envVar(name) {
  try {
    if (typeof process !== 'undefined' && process && process.env) return process.env[name];
  } catch (e) { /* not Node */ }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.AINTERIOR_ENV) {
      return globalThis.AINTERIOR_ENV[name];
    }
  } catch (e) { /* no override */ }
  return undefined;
}

const DEFAULT_SPACE = envVar('HF_SPACE') || 'tencent/Hunyuan3D-2.1';

/** "tencent/Hunyuan3D-2.1" -> "https://tencent-hunyuan3d-2-1.hf.space" */
export function spaceOrigin(space) {
  if (/^https?:\/\//i.test(space)) return space.replace(/\/+$/, '');
  const slug = String(space)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `https://${slug}.hf.space`;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Gradio 5 serves its REST API under /gradio_api/*, Gradio 4 under /*.
// tencent/Hunyuan3D-2.1 is currently a Gradio 4 Space, so we probe once and
// cache. This keeps the provider working if/when the Space is upgraded.
const _apiRootCache = new Map();
export async function resolveApiRoot(origin, { token, fetchImpl = fetch } = {}) {
  if (_apiRootCache.has(origin)) return _apiRootCache.get(origin);
  let root = '';
  try {
    const r = await fetchImpl(`${origin}/gradio_api/info`, { headers: { ...authHeaders(token) } });
    if (r.ok) root = '/gradio_api';
    try { r.body?.cancel?.(); } catch { /* noop */ }
  } catch { /* fall back to legacy root */ }
  _apiRootCache.set(origin, root);
  return root;
}

/** Random id that does not need `crypto` to be imported. */
function rid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalise the many shapes an image can arrive in into { bytes, name, type }.
 * Accepts: Buffer/Uint8Array/ArrayBuffer, { bytes|buffer|data }, { base64|dataUrl },
 * { url } (remote, fetched), or a bare base64 / data: string.
 */
export async function toImageBytes(image, fetchImpl = fetch) {
  if (!image) throw new Error('image required');

  if (image instanceof Uint8Array) return { bytes: image, name: 'image.png', type: 'image/png' };
  if (image instanceof ArrayBuffer) return { bytes: new Uint8Array(image), name: 'image.png', type: 'image/png' };

  if (typeof image === 'string') {
    if (/^data:/.test(image)) return decodeDataUrl(image);
    if (/^https?:\/\//i.test(image)) return fetchImage(image, fetchImpl);
    return { bytes: b64ToBytes(image), name: 'image.png', type: 'image/png' };
  }

  const name = image.name || image.filename || image.orig_name || 'image.png';
  const type = image.type || image.mime_type || guessMime(name);

  const raw = image.bytes || image.buffer || image.data;
  if (raw) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return { bytes, name, type };
  }
  if (image.dataUrl || image.data_url) return decodeDataUrl(image.dataUrl || image.data_url);
  if (image.base64 || image.b64) return { bytes: b64ToBytes(image.base64 || image.b64), name, type };
  if (image.url || image.href) return fetchImage(image.url || image.href, fetchImpl, name);

  throw new Error('unsupported image input: expected bytes, base64, dataUrl or url');
}

function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[ext] || 'image/png';
}

function b64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('malformed data URL');
  const type = m[1] || 'image/png';
  const bytes = m[2] ? b64ToBytes(m[3]) : new Uint8Array([...decodeURIComponent(m[3])].map((c) => c.charCodeAt(0)));
  return { bytes, name: `image.${(type.split('/')[1] || 'png')}`, type };
}

async function fetchImage(url, fetchImpl, name) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`failed to fetch image ${url}: HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const type = r.headers.get('content-type') || guessMime(url);
  return { bytes: buf, name: name || url.split('/').pop() || 'image.png', type };
}

/* ------------------------------------------------------------------ */
/* Gradio REST plumbing                                                */
/* ------------------------------------------------------------------ */

/** POST /gradio_api/upload -> server temp path, wrapped as a Gradio FileData. */
export async function uploadFile(origin, { bytes, name, type }, { token, fetchImpl = fetch, apiRoot } = {}) {
  const root = apiRoot ?? (await resolveApiRoot(origin, { token, fetchImpl }));
  const fd = new FormData();
  fd.append('files', new File([bytes], name, { type }), name);
  const uploadId = rid('u');
  const res = await fetchImpl(`${origin}${root}/upload?upload_id=${uploadId}`, {
    method: 'POST',
    headers: { ...authHeaders(token) },
    body: fd,
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const paths = await res.json();
  const path = Array.isArray(paths) ? paths[0] : paths;
  if (!path) throw new Error('upload returned no path');
  return {
    path,
    url: `${origin}${root}/file=${path}`,
    orig_name: name,
    size: bytes.length,
    mime_type: type,
    meta: { _type: 'gradio.FileData' },
  };
}

/** GET /config (cached) -- gives us fn_index + the true input arity. */
const _cfgCache = new Map();
export async function getConfig(origin, { token, fetchImpl = fetch, apiRoot } = {}) {
  if (_cfgCache.has(origin)) return _cfgCache.get(origin);
  const root = apiRoot ?? (await resolveApiRoot(origin, { token, fetchImpl }));
  const res = await fetchImpl(`${origin}${root}/config`, { headers: { ...authHeaders(token) } });
  if (!res.ok) throw new Error(`config fetch failed: HTTP ${res.status}`);
  const cfg = await res.json();
  _cfgCache.set(origin, cfg);
  return cfg;
}

/**
 * Map a public api_name to its fn_index and expand the caller's argument list
 * to the handler's true arity.
 *
 * WHY THIS EXISTS: view_api() advertises 12 named parameters for
 * /shape_generation, but the Gradio event handler actually declares 13 inputs
 * -- component 0 is a hidden `state`. Posting 12 values gets you a hard
 * "didn't receive enough input values (needed: 13, got: 12)". We read /config,
 * walk the real input component list, and inject `null` for every non-user
 * component (state / any slot the caller didn't supply).
 */
export function buildArgs(cfg, apiName, provided) {
  const deps = cfg.dependencies || [];
  const ep = String(apiName).replace(/^\//, '');
  const dep = deps.find((d) => d.api_name === ep);
  if (!dep) throw new Error(`endpoint "${ep}" not found in space config`);
  const byId = new Map((cfg.components || []).map((c) => [c.id, c]));

  const queue = [...provided];
  const data = dep.inputs.map((cid) => {
    const c = byId.get(cid) || {};
    if (c.type === 'state') return null;      // hidden slot -- never user supplied
    return queue.length ? queue.shift() : null;
  });
  return { fn_index: dep.id, trigger_id: dep.targets?.[0]?.[0] ?? null, data };
}

/**
 * Run a named endpoint through the Gradio queue protocol:
 *   POST /queue/join          -> { event_id }
 *   GET  /queue/data?session_hash=..  -> SSE until msg === 'process_completed'
 *
 * The queue protocol works on both Gradio 4 and 5, whereas the newer
 * /call/<ep> REST route is rejected outright by this Space.
 * Returns the raw output `data` array.
 */
export async function callEndpoint(origin, endpoint, data, { token, fetchImpl = fetch, signal, apiRoot, onProgress } = {}) {
  const root = apiRoot ?? (await resolveApiRoot(origin, { token, fetchImpl }));
  const cfg = await getConfig(origin, { token, fetchImpl, apiRoot: root });
  const { fn_index, trigger_id, data: full } = buildArgs(cfg, endpoint, data);
  const session_hash = rid('s').slice(2);

  const join = await fetchImpl(`${origin}${root}/queue/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ data: full, event_data: null, fn_index, trigger_id, session_hash }),
    signal,
  });
  if (!join.ok) throw new Error(`queue/join failed: HTTP ${join.status} ${(await join.text()).slice(0, 300)}`);
  const joined = await join.json();
  if (joined.event_id == null && joined.detail) throw new Error(`queue/join rejected: ${JSON.stringify(joined.detail).slice(0, 300)}`);

  const stream = await fetchImpl(`${origin}${root}/queue/data?session_hash=${session_hash}`, {
    headers: { Accept: 'text/event-stream', ...authHeaders(token) },
    signal,
  });
  if (!stream.ok) throw new Error(`queue/data failed: HTTP ${stream.status}`);
  return consumeQueueSSE(stream, ep_label(endpoint), onProgress);
}

function ep_label(e) { return String(e).replace(/^\//, ''); }

/** Hand-rolled SSE reader for the queue protocol -- no eventsource dependency. */
async function consumeQueueSSE(res, label, onProgress) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      let m;
      try { m = JSON.parse(line.slice(5)); } catch { continue; }

      if (m.msg === 'estimation' && onProgress) onProgress({ phase: 'queued', rank: m.rank, eta: m.rank_eta });
      if (m.msg === 'process_starts' && onProgress) onProgress({ phase: 'running', eta: m.eta });
      if (m.msg === 'process_completed') {
        reader.cancel().catch(() => {});
        if (m.output?.error) throw new Error(`${label} errored: ${String(m.output.error).slice(0, 400)}`);
        if (m.success === false) throw new Error(`${label} failed`);
        return m.output?.data ?? [];
      }
      if (m.msg === 'unexpected_error' || m.msg === 'close_stream') {
        if (m.message) throw new Error(`${label}: ${String(m.message).slice(0, 300)}`);
      }
    }
  }
  throw new Error(`${label}: queue stream closed before completion`);
}

/** Pull the first file-ish thing (a .glb ideally) out of a Gradio result array. */
export function pickMeshFile(data, origin, apiRoot = '') {
  const seen = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const valuePath = (typeof n.value === 'string' && /\.(glb|obj|ply|stl)$/i.test(n.value)) ? n.value : '';
    if (typeof n.path === 'string' || typeof n.url === 'string' || valuePath) {
      const path = n.path || valuePath || '';
      const url = n.url || (path ? `${origin}${apiRoot}/file=${path}` : '');
      if (url) seen.push({ url, path, name: n.orig_name || path.split('/').pop() || 'mesh.glb' });
      return;
    }
    Object.values(n).forEach(walk);
  };
  walk(data);
  return seen.find((f) => /\.glb$/i.test(f.name || f.url)) || seen[0] || null;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export const HF_DEFAULTS = {
  space: DEFAULT_SPACE,
  endpoint: '/shape_generation',   // geometry only, ~25s. '/generation_all' adds texture (slower).
  steps: 30,
  guidance_scale: 5,
  seed: 1234,
  octree_resolution: 256,
  check_box_rembg: true,           // background removal -- helps, but does NOT remove the
                                   // floor slab; that is handled in mesh-import.js
  num_chunks: 8000,
  randomize_seed: false,
};

export function createHuggingFaceProvider(cfg = {}) {
  const space = cfg.space || DEFAULT_SPACE;
  const origin = spaceOrigin(space);
  const token = cfg.token || envVar('HF_TOKEN') || envVar('HUGGINGFACE_TOKEN') || null;
  const fetchImpl = cfg.fetch || globalThis.fetch;
  const opts = { ...HF_DEFAULTS, ...cfg };
  const jobs = new Map();

  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch unavailable -- Node 18+ required for the huggingface provider');
  }

  function newJob(kind, meta = {}) {
    const job = {
      job_id: rid('hf'),
      kind,
      status: 'queued',
      progress: 0,
      started: Date.now(),
      result: null,
      error: null,
      ...meta,
    };
    jobs.set(job.job_id, job);
    return job;
  }

  function fail(job, err) {
    job.status = 'failed';
    job.progress = 0;
    job.error = err instanceof Error ? err.message : String(err);
    return job;
  }

  async function runObject(job, { images, name, scale_hint }) {
    try {
      job.status = 'running';
      job.progress = 0.05;

      const apiRoot = await resolveApiRoot(origin, { token, fetchImpl });
      const primary = await toImageBytes(images[0], fetchImpl);
      job.progress = 0.15;

      const fileData = await uploadFile(origin, primary, { token, fetchImpl, apiRoot });
      job.progress = 0.3;

      // Optional multi-view slots (front/back/left/right). Hunyuan3D accepts
      // nulls; extra views measurably improve the unseen sides.
      const extras = [];
      for (let i = 1; i <= 4; i++) {
        if (images[i]) {
          const b = await toImageBytes(images[i], fetchImpl);
          extras.push(await uploadFile(origin, b, { token, fetchImpl, apiRoot }));
        } else extras.push(null);
      }
      job.progress = 0.35;

      const payload = [
        fileData,
        extras[0], extras[1], extras[2], extras[3],
        opts.steps,
        opts.guidance_scale,
        opts.seed,
        opts.octree_resolution,
        opts.check_box_rembg,
        opts.num_chunks,
        opts.randomize_seed,
      ];

      const data = await callEndpoint(origin, opts.endpoint, payload, { token, fetchImpl, apiRoot });
      job.progress = 0.9;

      const file = pickMeshFile(data, origin, apiRoot);
      if (!file) throw new Error('space returned no mesh file');

      const scaled = scale_hint && Number(scale_hint.mm) > 0;
      job.status = 'succeeded';
      job.progress = 1;
      job.result = {
        mesh_url: file.url,
        format: /\.(glb|obj|ply|stl)$/i.exec(file.name || file.url)?.[1]?.toLowerCase() || 'glb',
        name: name || 'Scanned piece',
        provider: 'huggingface',
        space,
        endpoint: opts.endpoint,
        elapsed_ms: Date.now() - job.started,

        // SPEC §8.8: no invented measurements. The mesh is normalised; real
        // dims only exist once the client applies a user measurement.
        dims_mm: null,
        scale_confidence: scaled ? 'user-measured' : 'unscaled',
        scale_hint: scaled ? { axis: scale_hint.axis || 'w', mm: Math.round(Number(scale_hint.mm)) } : null,

        // Post-processing the browser MUST run (see packages/three-editor/mesh-import.js)
        needs_post_processing: {
          ground_plane_removal: true,
          recentre_to_footprint: true,
          scale_from_measurement: !scaled,
        },
      };
    } catch (err) {
      fail(job, err);
    }
    return job;
  }

  const UNSUPPORTED =
    'huggingface provider does room-scale reconstruction NOT AT ALL: Hunyuan3D-2.1 is a ' +
    'single-object image-to-3D model. Use RECON_PROVIDER=mock for rooms, or supply a blueprint.';

  return {
    createObjectFromImages({ images = [], name = 'Scanned piece', scale_hint = null } = {}) {
      const list = Array.isArray(images) ? images.filter(Boolean) : [images].filter(Boolean);
      if (!list.length) throw new Error('at least one image required');
      const job = newJob('object', { name });
      // fire-and-forget; getJob() polls the in-memory record
      runObject(job, { images: list, name, scale_hint });
      return { job_id: job.job_id };
    },

    createRoomFromImages() {
      const job = newJob('room');
      fail(job, UNSUPPORTED);
      return { job_id: job.job_id };
    },

    createRoomFromBlueprint() {
      const job = newJob('blueprint');
      fail(job, UNSUPPORTED);
      return { job_id: job.job_id };
    },

    getJob(job_id) {
      const job = jobs.get(job_id);
      if (!job) return { job_id, status: 'failed', progress: 0, error: 'UNKNOWN_JOB' };
      return {
        job_id: job.job_id,
        status: job.status,
        progress: job.progress,
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
      };
    },

    /** Convenience for servers/tests: await terminal state. Not part of §5.5. */
    async waitFor(job_id, { timeoutMs = 300000, intervalMs = 1000 } = {}) {
      const t0 = Date.now();
      for (;;) {
        const j = this.getJob(job_id);
        if (j.status === 'succeeded' || j.status === 'failed') return j;
        if (Date.now() - t0 > timeoutMs) return { ...j, status: 'failed', error: 'TIMEOUT' };
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },

    /** Re-export the mesh in another format via /on_export_click, when available. */
    async exportAs(job_id, fmt = 'obj') {
      const j = jobs.get(job_id);
      if (!j || j.status !== 'succeeded') throw new Error('job not ready');
      const apiRoot = await resolveApiRoot(origin, { token, fetchImpl });
      const data = await callEndpoint(origin, '/on_export_click', [fmt, false, false], { token, fetchImpl, apiRoot });
      const f = pickMeshFile(data, origin, apiRoot);
      return f ? f.url : null;
    },

    __origin: origin,
    __anonymous: !token,
  };
}

export default { createHuggingFaceProvider, spaceOrigin, uploadFile, callEndpoint, toImageBytes, HF_DEFAULTS };

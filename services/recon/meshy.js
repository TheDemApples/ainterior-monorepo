// services/recon/meshy.js  -- SPEC §5.5
// Real Meshy.ai implementation behind the identical interface as mock.js.
// Selected with RECON_PROVIDER=meshy + MESHY_API_KEY. Nothing upstream changes.
//
// Meshy has no first-class "room from photos" endpoint, so:
//   * createObjectFromImages  -> POST /openapi/v1/multi-image-to-3d (or image-to-3d)
//   * createRoomFromImages    -> same multi-image task, tagged as a room shell;
//                                the returned mesh bbox becomes dims_mm and, when
//                                RECON_ROOM_FIT=bbox, a rectangular Room shell is
//                                derived from it (SPEC §4.4 shape).
//   * createRoomFromBlueprint -> not supported by Meshy; delegated to
//                                cfg.blueprintProvider if supplied, else a clear error.
// SPEC-ASSUMPTION: Meshy returns dimensions in metres; we convert to integer mm.

const API_BASE = 'https://api.meshy.ai';

function mapStatus(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PENDING': case 'QUEUED': return 'queued';
    case 'IN_PROGRESS': case 'RUNNING': return 'running';
    case 'SUCCEEDED': case 'SUCCESS': return 'succeeded';
    case 'FAILED': case 'CANCELED': case 'EXPIRED': return 'failed';
    default: return 'queued';
  }
}

const mm = (metres) => Math.max(1, Math.round(Number(metres || 0) * 1000));

/** Derive a rectangular Room (SPEC §4.4) from a mesh bounding box in mm. */
export function roomFromBBox(dims_mm, hints = {}) {
  // Clamp to a habitable minimum: a mesh bbox smaller than this is a bad scan,
  // not a room, and downstream layout maths must never see a 1m x 1m "room".
  const w = Math.max(2200, dims_mm.w || 4000);
  const d = Math.max(2200, dims_mm.d || 3500);
  const h = Math.max(2100, dims_mm.h || 2600);
  const doorW = 900;
  return {
    id: `room_meshy_${Date.now().toString(36)}`,
    name: hints.name || 'Room',
    polygon_mm: [[0, 0], [w, 0], [w, d], [0, d]],
    height_mm: h,
    openings: [
      { id: 'd1', type: 'door', wall_index: 0, offset_mm: Math.round((w - doorW) / 2),
        width_mm: doorW, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
      { id: 'w1', type: 'window', wall_index: 2, offset_mm: Math.round(w * 0.3),
        width_mm: Math.min(1600, Math.round(w * 0.35)),
        // clamp the head so it clears the ceiling even on a low-ceiling scan
        height_mm: Math.max(600, Math.min(1400, h - 800 - 100)), sill_mm: 800, swing: null },
    ],
    features: [],
    source: 'photogrammetry',
    confidence: hints.confidence ?? 0.6,
  };
}

export function createMeshyProvider(cfg = {}) {
  const apiKey = cfg.apiKey || process.env.MESHY_API_KEY;
  const base = cfg.baseUrl || process.env.MESHY_API_BASE || API_BASE;
  const fetchImpl = cfg.fetch || globalThis.fetch;
  const roomFit = cfg.roomFit || process.env.RECON_ROOM_FIT || 'bbox';
  if (!apiKey) {
    throw new Error('MESHY_API_KEY is required for RECON_PROVIDER=meshy (use RECON_PROVIDER=mock offline)');
  }
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  // job_id -> { provider_task_id, kind }
  const meta = new Map();

  async function call(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`meshy ${res.status}: ${json?.message || json?.error || text?.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function toImageUrls(images = []) {
    return images
      .map((i) => (typeof i === 'string' ? i : i.url || i.signed_url || i.data_url || i.storage_path))
      .filter(Boolean);
  }

  async function createTask(kind, body) {
    const endpoint = body.image_urls && body.image_urls.length > 1
      ? '/openapi/v1/multi-image-to-3d'
      : '/openapi/v1/image-to-3d';
    const payload = body.image_urls && body.image_urls.length > 1
      ? { image_urls: body.image_urls, should_texture: true, ai_model: 'meshy-5',
          topology: 'triangle', symmetry_mode: 'auto' }
      : { image_url: body.image_urls?.[0], should_texture: true, ai_model: 'meshy-5',
          enable_pbr: false };
    const json = await call(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    const task_id = json.result || json.id || json.task_id;
    if (!task_id) throw new Error('meshy: no task id in response');
    const job_id = `meshy_${task_id}`;
    meta.set(job_id, { task_id, kind, hints: body.hints || {}, name: body.name });
    return { job_id, provider_job_id: task_id };
  }

  return {
    kind: 'meshy',

    async createRoomFromImages({ images = [], hints = {} } = {}) {
      const urls = toImageUrls(images);
      if (!urls.length) throw new Error('createRoomFromImages: at least one image URL required');
      return createTask('room', { image_urls: urls, hints });
    },

    async createRoomFromBlueprint({ file, scale_hint } = {}) {
      if (cfg.blueprintProvider) {
        return cfg.blueprintProvider.createRoomFromBlueprint({ file, scale_hint });
      }
      throw new Error('meshy: blueprint reconstruction unsupported — set RECON_BLUEPRINT_PROVIDER=mock');
    },

    async createObjectFromImages({ images = [], name = 'My piece' } = {}) {
      const urls = toImageUrls(images);
      if (!urls.length) throw new Error('createObjectFromImages: at least one image URL required');
      return createTask('object', { image_urls: urls, name });
    },

    async getJob(job_id) {
      const m = meta.get(job_id) || { task_id: String(job_id).replace(/^meshy_/, ''), kind: 'object', hints: {} };
      let json;
      try {
        json = await call(`/openapi/v1/image-to-3d/${m.task_id}`, { method: 'GET' });
      } catch (e) {
        if (e.status === 404) {
          json = await call(`/openapi/v1/multi-image-to-3d/${m.task_id}`, { method: 'GET' });
        } else {
          return { job_id, status: 'failed', progress: 0, error: e.message };
        }
      }
      const status = mapStatus(json.status);
      const progress = Math.max(0, Math.min(1, (Number(json.progress) || 0) / 100));
      if (status === 'failed') {
        return { job_id, status, progress, error: json.task_error?.message || 'meshy task failed' };
      }
      if (status !== 'succeeded') return { job_id, status, progress };

      const mesh_url = json.model_urls?.glb || json.model_url || json.model_urls?.obj || null;
      const bbox = json.bounding_box || json.bbox || null;
      const dims_mm = bbox
        ? { w: mm(bbox.x ?? bbox.width), d: mm(bbox.y ?? bbox.depth), h: mm(bbox.z ?? bbox.height) }
        : undefined;

      if (m.kind === 'room') {
        if (roomFit === 'bbox' && dims_mm) {
          return { job_id, status, progress: 1,
                   result: { room: roomFromBBox(dims_mm, m.hints), mesh_url, dims_mm } };
        }
        return { job_id, status, progress: 1, result: { mesh_url, dims_mm } };
      }
      return { job_id, status, progress: 1,
               result: { mesh_url, dims_mm, name: m.name, thumbnail: json.thumbnail_url } };
    },
  };
}

export default { createMeshyProvider, roomFromBBox };

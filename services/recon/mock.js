// services/recon/mock.js  -- SPEC §5.5
// Fully functional offline provider. No API key, no network. Jobs progress on a
// wall-clock timer so the entire capture -> reconstruct -> edit flow is demoable.
//
// Returns a plausible Room per SPEC §4.4: rectangular-ish polygon (mm, CCW,
// origin at bbox min corner), one door, one window, occasionally a radiator.
// Object jobs return a proxy mesh URL + estimated dims_mm.

const DEFAULT_DURATION_MS = 6000;

/* --------------------------------------------------------- deterministic rng */
function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
const round10 = (n) => Math.round(n / 10) * 10;

/* --------------------------------------------------------------- room maker */
/**
 * Plausible Room (SPEC §4.4). Rectangular-ish: a true rectangle, or a rectangle
 * with one chamfered/notched corner so downstream code exercises non-convex
 * polygons too. Always exactly one door and one window on different walls.
 */
export function synthesizeRoom(seed, hints = {}) {
  const rnd = rngFrom(hashString(seed));
  const w = round10(hints.width_mm || 3200 + rnd() * 2600);   // 3.2 - 5.8 m
  const d = round10(hints.depth_mm || 2800 + rnd() * 2200);   // 2.8 - 5.0 m
  const height_mm = Math.round(hints.height_mm || 2500 + Math.round(rnd() * 3) * 50);

  let polygon_mm;
  const shape = rnd();
  if (shape < 0.65) {
    polygon_mm = [[0, 0], [w, 0], [w, d], [0, d]];                     // rectangle
  } else if (shape < 0.85) {
    const nw = round10(600 + rnd() * 500), nd = round10(500 + rnd() * 500);
    // notch out the far-right corner -> L-ish but still rectangular-dominant
    polygon_mm = [[0, 0], [w, 0], [w, d - nd], [w - nw, d - nd], [w - nw, d], [0, d]];
  } else {
    const c = round10(400 + rnd() * 400);                              // chamfer
    polygon_mm = [[0, 0], [w - c, 0], [w, c], [w, d], [0, d]];
  }

  // wall 0 = polygon[0] -> polygon[1] (the bottom edge, length ~w)
  const wall0len = Math.hypot(polygon_mm[1][0] - polygon_mm[0][0],
                              polygon_mm[1][1] - polygon_mm[0][1]);
  const doorW = [760, 810, 900][Math.floor(rnd() * 3)];
  const doorOffset = round10(Math.max(150, Math.min(wall0len - doorW - 150,
                                                    300 + rnd() * (wall0len - doorW - 600))));
  // Window: pick the LONGEST wall that is not wall 0 (the door wall), then clamp
  // the opening so offset + width can never overflow that wall (SPEC §4.4).
  let wIdx = 1, wallLen = 0;
  for (let i = 1; i < polygon_mm.length; i++) {
    const a2 = polygon_mm[i], b2 = polygon_mm[(i + 1) % polygon_mm.length];
    const len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
    if (len > wallLen) { wallLen = len; wIdx = i; }
  }
  const winW = round10(Math.min(1800, Math.max(600,
    Math.min(wallLen - 400, wallLen * (0.3 + rnd() * 0.25)))));
  const maxOff = Math.max(0, wallLen - winW - 100);
  const winOffset = Math.min(round10(Math.max(100, (wallLen - winW) / 2 + (rnd() - 0.5) * 400)),
                             Math.floor(maxOff / 10) * 10);
  const openings = [
    {
      id: 'd1', type: 'door', wall_index: 0, offset_mm: doorOffset, width_mm: doorW,
      height_mm: 2040, sill_mm: 0,
      swing: ['in-left', 'in-right'][Math.floor(rnd() * 2)],
    },
    (() => {
      const sill = round10(750 + rnd() * 200);
      // head of the window must clear the ceiling by >= 100mm (SPEC §4.4)
      const head = round10(Math.min(1200 + rnd() * 400, height_mm - sill - 100));
      return {
        id: 'w1', type: 'window', wall_index: wIdx, offset_mm: winOffset, width_mm: winW,
        height_mm: head, sill_mm: sill, swing: null,
      };
    })(),
  ];

  const features = [];
  if (rnd() < 0.5) {
    features.push({
      id: 'f1', type: 'radiator', wall_index: wIdx,
      offset_mm: winOffset,
      width_mm: round10(Math.min(winW, 1400)), depth_mm: 120,
    });
  }

  return {
    id: `room_${(hashString(seed) % 0xffff).toString(16)}`,
    name: hints.name || 'Living room',
    polygon_mm,
    height_mm,
    openings,
    features,
    source: hints.source || 'photogrammetry',
    confidence: +(0.72 + rnd() * 0.24).toFixed(2),
  };
}

/** Proxy mesh + estimated dims for object jobs (SPEC §5.5). */
export function synthesizeObject(seed, name = 'My piece') {
  const rnd = rngFrom(hashString(seed));
  const w = round10(600 + rnd() * 1600), d = round10(500 + rnd() * 500),
        h = round10(400 + rnd() * 600);
  return {
    mesh_url: `mock://mesh/${hashString(seed).toString(16)}.glb`,
    dims_mm: { w, d, h },
    name,
    proxy: {
      parts: [
        { shape: 'box', pos: [0, 0, Math.round(h * 0.28)], size: [w, d, Math.round(h * 0.55)], color: 'body', radius: 40 },
        { shape: 'box', pos: [0, -Math.round(d * 0.42), Math.round(h * 0.72)], size: [w, Math.round(d * 0.14), Math.round(h * 0.45)], color: 'body', radius: 30 },
      ],
    },
    confidence: +(0.6 + rnd() * 0.3).toFixed(2),
  };
}

/* ------------------------------------------------------------- the provider */
export function createMockProvider(cfg = {}) {
  const durationMs = Number(cfg.durationMs ?? process.env.RECON_MOCK_DURATION_MS ?? DEFAULT_DURATION_MS);
  const failRate = Number(cfg.failRate ?? process.env.RECON_MOCK_FAIL_RATE ?? 0);
  const now = cfg.now || (() => Date.now());
  const jobs = new Map();
  let counter = 0;

  function start(kind, payload) {
    const job_id = `mock_${now().toString(36)}_${(++counter).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    jobs.set(job_id, {
      job_id, kind, payload, created: now(),
      duration: durationMs,
      seed: payload.seed ?? job_id,
      willFail: Math.random() < failRate,
      terminal: null,
    });
    return { job_id };
  }

  /** Advance a job purely from elapsed wall-clock time (no timers to leak). */
  function evaluate(job) {
    if (job.terminal) return job.terminal;
    const elapsed = now() - job.created;
    const t = job.duration <= 0 ? 1 : Math.min(1, elapsed / job.duration);
    if (t < 0.08) return { job_id: job.job_id, status: 'queued', progress: 0 };
    if (t < 1) {
      return { job_id: job.job_id, status: 'running', progress: +t.toFixed(3) };
    }
    if (job.willFail) {
      job.terminal = {
        job_id: job.job_id, status: 'failed', progress: 1,
        error: 'MOCK_RECON_FAILED: insufficient parallax between frames',
      };
      return job.terminal;
    }
    let result;
    if (job.kind === 'object') {
      result = synthesizeObject(job.seed, job.payload.name);
    } else {
      const room = synthesizeRoom(job.seed, {
        ...(job.payload.hints || {}),
        source: job.kind === 'blueprint' ? 'blueprint' : 'photogrammetry',
      });
      result = { room };
      if (job.kind === 'blueprint' && job.payload.scale_hint) {
        result.scale_hint = job.payload.scale_hint;
      }
    }
    job.terminal = { job_id: job.job_id, status: 'succeeded', progress: 1, result };
    return job.terminal;
  }

  return {
    kind: 'mock',
    createRoomFromImages({ images = [], hints = {} } = {}) {
      if (!Array.isArray(images)) throw new Error('images must be an array');
      return start('room', { images, hints, seed: hints.seed ?? (images[0]?.storage_path || images[0] || 'room') });
    },
    createRoomFromBlueprint({ file, scale_hint } = {}) {
      if (!file) throw new Error('file required');
      return start('blueprint', { file, scale_hint, hints: {}, seed: file.storage_path || file.name || String(file) });
    },
    createObjectFromImages({ images = [], name = 'My piece' } = {}) {
      return start('object', { images, name, seed: name + (images[0]?.storage_path || '') });
    },
    getJob(job_id) {
      const job = jobs.get(job_id);
      if (!job) return { job_id, status: 'failed', progress: 0, error: 'UNKNOWN_JOB' };
      return evaluate(job);
    },
    /** Test helper: finish a job immediately. Not part of the provider contract. */
    __advance(job_id, ms = 1e9) {
      const job = jobs.get(job_id);
      if (job) job.created -= ms;
      return this.getJob(job_id);
    },
    __size() { return jobs.size; },
  };
}

export default { createMockProvider, synthesizeRoom, synthesizeObject };

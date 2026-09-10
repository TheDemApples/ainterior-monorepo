// services/recon/index.js  -- SPEC §5.5
// Provider-agnostic 3D reconstruction adapter.
//
//   createReconProvider(kind /* "meshy" | "mock" | "huggingface" */, cfg) => {
//     createRoomFromImages({ images, hints })      => { job_id }
//     createRoomFromBlueprint({ file, scale_hint }) => { job_id }
//     createObjectFromImages({ images, name })     => { job_id }
//     getJob(job_id) => { status, progress, result?, error? }
//   }
//
// MOCK remains the DEFAULT so the demo keeps working offline (SPEC §5.5). Swapping to Meshy is a
// config change (RECON_PROVIDER=meshy + MESHY_API_KEY) — the interface is byte
// identical, so nothing upstream changes.

import { createMockProvider } from './mock.js';
import { createMeshyProvider } from './meshy.js';
import { createHuggingFaceProvider } from './huggingface.js';

export const PROVIDERS = ['mock', 'meshy', 'huggingface'];
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'];

/** Every provider must expose exactly these methods. Enforced at construction. */
const REQUIRED = ['createRoomFromImages', 'createRoomFromBlueprint',
                  'createObjectFromImages', 'getJob'];

export function createReconProvider(kind = process.env.RECON_PROVIDER || 'mock', cfg = {}) {
  const k = String(kind || 'mock').toLowerCase();
  let provider;
  switch (k) {
    case 'mock':
      provider = createMockProvider(cfg);
      break;
    case 'meshy':
      provider = createMeshyProvider(cfg);
      break;
    // FREE, no API key: public Hugging Face Space running Hunyuan3D-2.1.
    // Object scanning only -- it cannot do rooms (see services/recon/RECON.md).
    // Output is UNSCALED: the caller must apply one real user measurement via
    // packages/three-editor/mesh-import.js fitToDimension() (SPEC §8.8).
    case 'huggingface':
    case 'hf':
      provider = createHuggingFaceProvider(cfg);
      break;
    default:
      throw new Error(`unknown recon provider "${kind}" (expected one of ${PROVIDERS.join(', ')})`);
  }
  for (const m of REQUIRED) {
    if (typeof provider[m] !== 'function') {
      throw new Error(`recon provider "${k}" is missing ${m}()`);
    }
  }
  provider.kind = k;
  return provider;
}

/** Normalises anything a provider returns into the SPEC §5.5 job envelope. */
export function normalizeJob(j) {
  if (!j) return { status: 'failed', progress: 0, error: 'no job' };
  const status = JOB_STATUSES.includes(j.status) ? j.status : 'queued';
  return {
    job_id: j.job_id,
    status,
    progress: Math.max(0, Math.min(1, Number(j.progress) || 0)),
    ...(j.result ? { result: j.result } : {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

export default { createReconProvider, normalizeJob, PROVIDERS, JOB_STATUSES };

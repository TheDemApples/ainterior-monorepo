// supabase/functions/recon-webhook/index.ts
// Provider callback -> update the job -> materialise the Room (SPEC §4.4).
//
// Two entry modes:
//   POST { job_id, status, progress, result?, error?, secret }   <- push webhook
//   POST { job_id, poll: true }                                 <- pull/poll path,
//        used by the MOCK provider and by Meshy (which has no webhook for
//        image-to-3d): we ask the provider for the job and persist the answer.
//
// Auth: the request must present either the per-job `webhook_secret` (issued at
// job creation, never leaves the server) or the shared RECON_WEBHOOK_SECRET.
// This endpoint is intentionally verify_jwt = false so providers can reach it.
import { preflight, json, fail } from '../_shared/cors.ts';
import { adminClient } from '../_shared/supabase.ts';
import { createReconProvider, normalizeJob } from '../../../services/recon/index.js';

const SHARED = Deno.env.get('RECON_WEBHOOK_SECRET') ?? '';
const PROVIDER_KIND = Deno.env.get('RECON_PROVIDER') ?? 'mock';

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST only', 405);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_JSON', 'invalid JSON body'); }

  const job_id = body.job_id ?? body.jobId;
  if (!job_id) return fail('MISSING_JOB_ID', 'job_id required');

  const admin = adminClient();
  const { data: job } = await admin.from('recon_jobs')
    .select('*').eq('id', job_id).single();
  if (!job) return fail('UNKNOWN_JOB', 'no such job', 404);

  const presented = String(body.secret ?? req.headers.get('x-recon-secret') ?? '');
  const okSecret =
    (job.webhook_secret && timingSafeEqual(presented, job.webhook_secret)) ||
    (SHARED && timingSafeEqual(presented, SHARED)) ||
    body.poll === true;   // poll path is server-initiated from the app, JWT-gated upstream
  if (!okSecret) return fail('BAD_SECRET', 'invalid webhook secret', 401);

  let status = body.status as string | undefined;
  let progress = body.progress as number | undefined;
  let result = body.result ?? null;
  let error = body.error ?? null;

  // Poll path: ask the provider directly. This is how the MOCK provider drives
  // itself to completion with no external service (SPEC §5.5).
  if (body.poll === true || !status) {
    if (!job.provider_job_id) return fail('NOT_STARTED', 'job has no provider_job_id', 409);
    const provider = createReconProvider(job.provider ?? PROVIDER_KIND, {
      apiKey: Deno.env.get('MESHY_API_KEY'),
    });
    const j = normalizeJob(await provider.getJob(job.provider_job_id));
    status = j.status; progress = j.progress; result = j.result ?? null; error = j.error ?? null;
  }

  const { data: updated, error: rpcErr } = await admin.rpc('apply_recon_result', {
    p_job_id: job_id,
    p_status: status,
    p_progress: progress ?? job.progress,
    p_result: result,
    p_error: error,
  });
  if (rpcErr) return fail('APPLY_FAILED', rpcErr.message, 500);

  const row = Array.isArray(updated) ? updated[0] : updated;
  return json({
    ok: true,
    job: {
      id: row?.id ?? job_id,
      status: row?.status ?? status,
      progress: row?.progress ?? progress,
      room_id: row?.room_id ?? job.room_id,
      error: row?.error ?? error,
    },
    room_written: status === 'succeeded' && !!result?.room,
  });
});

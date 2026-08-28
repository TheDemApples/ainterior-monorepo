// Local-dev mirror of the Supabase Edge Function of the same name.
// Same request/response contract, so apps/web/lib/api.ts can point at either
// (NEXT_PUBLIC_API_MODE=local|edge) with no other change.
import { admin, failRes, jsonRes } from '../_lib/server';
import { createReconProvider, normalizeJob } from '../../../../../services/recon/index.js';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.job_id) return failRes('MISSING_JOB_ID', 'job_id required');
  const db = admin();
  const { data: job } = await db.from('recon_jobs').select('*').eq('id', body.job_id).single();
  if (!job) return failRes('UNKNOWN_JOB', 'no such job', 404);

  const presented = String(body.secret ?? req.headers.get('x-recon-secret') ?? '');
  const shared = process.env.RECON_WEBHOOK_SECRET ?? '';
  const ok = body.poll === true
    || (job.webhook_secret && presented === job.webhook_secret)
    || (shared && presented === shared);
  if (!ok) return failRes('BAD_SECRET', 'invalid webhook secret', 401);

  let { status, progress, result = null, error = null } = body;
  if (body.poll === true || !status) {
    if (!job.provider_job_id) return failRes('NOT_STARTED', 'job has no provider_job_id', 409);
    const provider = createReconProvider(job.provider, { apiKey: process.env.MESHY_API_KEY });
    const j = normalizeJob(await provider.getJob(job.provider_job_id));
    ({ status, progress } = j); result = j.result ?? null; error = j.error ?? null;
  }

  const { data, error: rpcErr } = await db.rpc('apply_recon_result', {
    p_job_id: body.job_id, p_status: status, p_progress: progress ?? job.progress,
    p_result: result, p_error: error,
  });
  if (rpcErr) return failRes('APPLY_FAILED', rpcErr.message, 500);
  const row = Array.isArray(data) ? data[0] : data;
  return jsonRes({
    ok: true,
    job: { id: row?.id ?? body.job_id, status: row?.status ?? status,
           progress: row?.progress ?? progress, room_id: row?.room_id ?? job.room_id,
           error: row?.error ?? error },
    room_written: status === 'succeeded' && !!result?.room,
  });
}

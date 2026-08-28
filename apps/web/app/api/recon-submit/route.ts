// Local-dev mirror of the Supabase Edge Function of the same name.
// Same request/response contract, so apps/web/lib/api.ts can point at either
// (NEXT_PUBLIC_API_MODE=local|edge) with no other change.
import { admin, failRes, jsonRes, profileFromRequest } from '../_lib/server';
import { createReconProvider } from '../../../../../services/recon/index.js';

const COST = Number(process.env.RECON_CREDIT_COST ?? '1');
const PROVIDER_KIND = process.env.RECON_PROVIDER ?? 'mock';

export async function POST(req: Request) {
  const profile = await profileFromRequest(req);
  if (!profile) return failRes('UNAUTHENTICATED', 'sign in required', 401);
  const body = await req.json().catch(() => null);
  if (!body) return failRes('BAD_JSON', 'invalid JSON body');
  if (!body.project_id) return failRes('MISSING_PROJECT', 'project_id required');

  const db = admin();
  const { data: project } = await db.from('projects')
    .select('id, owner').eq('id', body.project_id).single();
  if (!project || project.owner !== profile.id) return failRes('FORBIDDEN', 'not your project', 403);

  const kind = body.kind ?? 'room_from_images';
  let images: { storage_path: string }[] = [];
  if (body.session_id) {
    const { data } = await db.from('scan_assets').select('storage_path')
      .eq('session_id', body.session_id);
    images = (data ?? []) as { storage_path: string }[];
  } else if (Array.isArray(body.asset_ids) && body.asset_ids.length) {
    const { data } = await db.from('scan_assets').select('storage_path').in('id', body.asset_ids);
    images = (data ?? []) as { storage_path: string }[];
  }
  if (kind !== 'room_from_blueprint' && !images.length) {
    return failRes('NO_ASSETS', 'at least one uploaded asset is required');
  }

  const { data: jobRows, error: jobErr } = await db.rpc('create_recon_job', {
    p_owner: profile.id, p_room_id: body.room_id ?? null, p_project_id: body.project_id,
    p_provider: PROVIDER_KIND, p_kind: kind, p_cost: COST,
  });
  if (jobErr) {
    if (String(jobErr.message).includes('INSUFFICIENT_CREDITS')) {
      const { data: bal } = await db.rpc('credit_balance', { p_owner: profile.id });
      return failRes('INSUFFICIENT_CREDITS', 'not enough credits', 402,
                     { balance: bal ?? 0, required: COST });
    }
    return failRes('JOB_CREATE_FAILED', jobErr.message, 500);
  }
  const job = Array.isArray(jobRows) ? jobRows[0] : jobRows;

  try {
    const provider = createReconProvider(PROVIDER_KIND, { apiKey: process.env.MESHY_API_KEY });
    const started = kind === 'room_from_blueprint'
      ? await provider.createRoomFromBlueprint({
          file: { storage_path: body.blueprint_path }, scale_hint: body.scale_hint })
      : kind === 'object_from_images'
        ? await provider.createObjectFromImages({ images, name: body.name ?? 'My piece' })
        : await provider.createRoomFromImages({ images, hints: { ...(body.hints ?? {}), seed: job.id } });
    await db.from('recon_jobs')
      .update({ provider_job_id: started.job_id, status: 'running', progress: 0.05 })
      .eq('id', job.id);
    const { data: balance } = await db.rpc('credit_balance', { p_owner: profile.id });
    return jsonRes({
      ok: true,
      job: { ...job, provider_job_id: started.job_id, status: 'running', progress: 0.05 },
      balance: balance ?? 0,
      webhook_url: '/api/recon-webhook', poll_after_ms: 1500,
    });
  } catch (e) {
    await db.rpc('apply_recon_result', {
      p_job_id: job.id, p_status: 'failed', p_progress: 1, p_result: null,
      p_error: `provider_error: ${(e as Error).message}`,
    });
    return failRes('PROVIDER_ERROR', (e as Error).message, 502,
                   { job_id: job.id, refunded: COST });
  }
}

// supabase/functions/recon-submit/index.ts
// Start a reconstruction job and deduct exactly one credit, atomically.
//
// POST { project_id, room_id?, kind?: "room_from_images"|"room_from_blueprint"|"object_from_images",
//        asset_ids?: uuid[], session_id?: uuid, blueprint_path?: string, hints?: {} }
// ->   { ok, job: { id, status, progress, provider, provider_job_id }, balance }
//
// SPEC §6: credits are deducted HERE (on recon_jobs creation) and never on
// catalog use. create_recon_job() inserts the job and the ledger row in one
// transaction, so an INSUFFICIENT_CREDITS raise rolls the job back too.
import { preflight, json, fail } from '../_shared/cors.ts';
import { adminClient, currentProfile } from '../_shared/supabase.ts';
import { createReconProvider } from '../../../services/recon/index.js';

const COST = Number(Deno.env.get('RECON_CREDIT_COST') ?? '1');
const PROVIDER_KIND = Deno.env.get('RECON_PROVIDER') ?? 'mock';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST only', 405);

  const profile = await currentProfile(req);
  if (!profile) return fail('UNAUTHENTICATED', 'sign in required', 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('BAD_JSON', 'invalid JSON body'); }

  const project_id = body.project_id as string | undefined;
  const room_id = (body.room_id as string | undefined) ?? null;
  const kind = (body.kind as string) ?? 'room_from_images';
  if (!project_id) return fail('MISSING_PROJECT', 'project_id required');

  const admin = adminClient();

  // Ownership check performed explicitly because we are about to use service_role.
  const { data: project } = await admin.from('projects')
    .select('id, owner').eq('id', project_id).single();
  if (!project || project.owner !== profile.id) {
    return fail('FORBIDDEN', 'not your project', 403);
  }
  if (room_id) {
    const { data: room } = await admin.from('rooms')
      .select('id, project_id').eq('id', room_id).single();
    if (!room || room.project_id !== project_id) return fail('FORBIDDEN', 'room/project mismatch', 403);
  }

  // Gather the input assets (owner-scoped by construction: session -> project).
  let images: Array<{ storage_path: string }> = [];
  if (Array.isArray(body.asset_ids) && body.asset_ids.length) {
    const { data } = await admin.from('scan_assets')
      .select('id, storage_path, session_id, capture_sessions!inner(project_id)')
      .in('id', body.asset_ids as string[]);
    images = (data ?? [])
      .filter((a: Record<string, any>) => a.capture_sessions?.project_id === project_id)
      .map((a: Record<string, any>) => ({ storage_path: a.storage_path }));
  } else if (body.session_id) {
    const { data } = await admin.from('scan_assets')
      .select('storage_path').eq('session_id', body.session_id as string);
    images = (data ?? []) as Array<{ storage_path: string }>;
  }
  if (kind !== 'room_from_blueprint' && images.length === 0) {
    return fail('NO_ASSETS', 'at least one uploaded asset is required');
  }

  // 1) Create job + deduct credit in one transaction.
  const { data: jobRows, error: jobErr } = await admin.rpc('create_recon_job', {
    p_owner: profile.id,
    p_room_id: room_id,
    p_project_id: project_id,
    p_provider: PROVIDER_KIND,
    p_kind: kind,
    p_cost: COST,
  });
  if (jobErr) {
    if (String(jobErr.message).includes('INSUFFICIENT_CREDITS')) {
      const { data: bal } = await admin.rpc('credit_balance', { p_owner: profile.id });
      return fail('INSUFFICIENT_CREDITS', 'not enough credits for a reconstruction', 402,
                  { balance: bal ?? 0, required: COST });
    }
    return fail('JOB_CREATE_FAILED', jobErr.message, 500);
  }
  const job = Array.isArray(jobRows) ? jobRows[0] : jobRows;

  // 2) Hand off to the provider. Failure here refunds via apply_recon_result.
  try {
    const provider = createReconProvider(PROVIDER_KIND, {
      apiKey: Deno.env.get('MESHY_API_KEY'),
    });
    const hints = { ...(body.hints as object ?? {}), seed: job.id };
    let started: { job_id: string };
    if (kind === 'room_from_blueprint') {
      started = await provider.createRoomFromBlueprint({
        file: { storage_path: body.blueprint_path as string },
        scale_hint: body.scale_hint as number | undefined,
      });
    } else if (kind === 'object_from_images') {
      started = await provider.createObjectFromImages({
        images, name: (body.name as string) ?? 'My piece',
      });
    } else {
      started = await provider.createRoomFromImages({ images, hints });
    }

    await admin.from('recon_jobs')
      .update({ provider_job_id: started.job_id, status: 'running', progress: 0.05 })
      .eq('id', job.id);

    const { data: balance } = await admin.rpc('credit_balance', { p_owner: profile.id });
    return json({
      ok: true,
      job: { ...job, provider_job_id: started.job_id, status: 'running', progress: 0.05 },
      balance: balance ?? 0,
      webhook_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/recon-webhook`,
      poll_after_ms: 1500,
    });
  } catch (e) {
    await admin.rpc('apply_recon_result', {
      p_job_id: job.id, p_status: 'failed', p_progress: 1,
      p_result: null, p_error: `provider_error: ${(e as Error).message}`,
    });
    return fail('PROVIDER_ERROR', (e as Error).message, 502, { job_id: job.id, refunded: COST });
  }
});

// Local-dev mirror of the Supabase Edge Function of the same name.
// Same request/response contract, so apps/web/lib/api.ts can point at either
// (NEXT_PUBLIC_API_MODE=local|edge) with no other change.
import { admin, failRes, jsonRes, profileFromRequest } from '../_lib/server';
import { identifyUpload, evaluateDedupe, DEDUPE_THRESHOLD }
  from '../../../../../services/vision/index.js';

const BUCKET = process.env.USER_ITEMS_BUCKET ?? 'user-items';
const THRESHOLD = Number(process.env.DEDUPE_THRESHOLD ?? DEDUPE_THRESHOLD);
const FLOOR = Number(process.env.MATCH_RETURN_FLOOR ?? '0.45');

export async function POST(req: Request) {
  const profile = await profileFromRequest(req);
  if (!profile) return failRes('UNAUTHENTICATED', 'sign in required', 401);
  const body = await req.json().catch(() => null);
  if (!body) return failRes('BAD_JSON', 'invalid JSON body');
  if (!body.storage_path && !body.image_base64) {
    return failRes('MISSING_IMAGE', 'storage_path or image_base64 required');
  }
  if (body.storage_path && !String(body.storage_path).startsWith(`${profile.id}/`)) {
    return failRes('FORBIDDEN', 'storage_path must live under your own prefix', 403);
  }

  const db = admin();
  let bytes: Uint8Array;
  if (body.image_base64) {
    bytes = Buffer.from(body.image_base64, 'base64');
  } else {
    const { data, error } = await db.storage.from(BUCKET).download(body.storage_path);
    if (error || !data) return failRes('DOWNLOAD_FAILED', error?.message ?? 'no object', 404);
    bytes = new Uint8Array(await data.arrayBuffer());
  }

  let ident;
  try { ident = await identifyUpload({ imageBytes: bytes }); }
  catch (e) { return failRes('DECODE_FAILED', (e as Error).message, 415); }
  const embedding = Array.from(ident.embedding);

  const { data: item, error: insErr } = await db.from('user_items').insert({
    owner: profile.id,
    name: body.name ?? `My ${ident.archetype_guess.replaceAll('_', ' ')}`,
    archetype: body.archetype ?? ident.archetype_guess,
    dims_mm: body.dims_mm ?? ident.dims_estimate_mm ?? null,
    storage_path: body.storage_path ?? null,
    embedding, phash: ident.phash, status: 'pending',
  }).select().single();
  if (insErr) return failRes('INSERT_FAILED', insErr.message, 500);

  const { data: matches, error: mErr } = await db.rpc('match_catalog_items', {
    query_embedding: embedding, query_phash: ident.phash,
    match_threshold: FLOOR, match_count: 5, filter_archetype: null,
  });
  if (mErr) return failRes('MATCH_FAILED', mErr.message, 500);

  const decision = evaluateDedupe({ matches: matches ?? [], threshold: THRESHOLD });
  let ledger_id: string | null = null;
  if (decision.gated) {
    const { data: gate } = await db.rpc('dedupe_gate_user_item', {
      p_user_item_id: item.id, p_threshold: THRESHOLD, p_saved: 1,
    });
    ledger_id = (Array.isArray(gate) ? gate[0] : gate)?.ledger_id ?? null;
  } else {
    await db.rpc('promote_clusters_to_moderation', { p_cos: 0.9, p_min_users: 5 });
  }
  const { data: saved } = await db.rpc('credits_saved', { p_owner: profile.id });
  const { data: balance } = await db.rpc('credit_balance', { p_owner: profile.id });

  return jsonRes({
    ok: true,
    user_item: { id: item.id, name: item.name, archetype: item.archetype,
                 status: decision.gated ? 'matched' : 'pending', phash: ident.phash,
                 dims_estimate_mm: ident.dims_estimate_mm ?? null },
    labels: ident.labels, gated: decision.gated, matched_by: decision.matched_by,
    credit_cost: decision.credit_cost, threshold: THRESHOLD,
    match: decision.match, modal: decision.modal, matches: matches ?? [],
    ledger_id, credits_saved: saved ?? 0, balance: balance ?? 0,
  });
}

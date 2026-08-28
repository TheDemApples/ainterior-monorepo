// supabase/functions/identify-upload/index.ts
// pHash + embedding + catalog match, and THE CREDIT GATE (SPEC §5.4).
//
// POST { storage_path, name?, archetype?, image_base64? }
// ->   { ok, user_item, gated, credit_cost, match?, modal?, matches[], credits_saved }
//
// If the top catalog similarity >= DEDUPE_THRESHOLD (0.86) we:
//   * do NOT start 3D generation and do NOT spend a credit,
//   * mark the user_item 'matched' with matched_item_id,
//   * append credits_ledger { delta: 0, reason: 'dedupe_saved', saved: 1 },
//   * return the modal payload so the frontend can ask
//     "Is this the same as {{match.name}}?".
// Otherwise the item stays 'pending' and the client may call recon-submit
// (kind=object_from_images), which is where the credit is actually spent.
import { preflight, json, fail } from '../_shared/cors.ts';
import { adminClient, currentProfile } from '../_shared/supabase.ts';
import { identifyUpload, evaluateDedupe, DEDUPE_THRESHOLD }
  from '../../../services/vision/index.js';

const DOWNLOAD_BUCKET = Deno.env.get('USER_ITEMS_BUCKET') ?? 'user-items';
const THRESHOLD = Number(Deno.env.get('DEDUPE_THRESHOLD') ?? DEDUPE_THRESHOLD);
const MATCH_RETURN_FLOOR = Number(Deno.env.get('MATCH_RETURN_FLOOR') ?? '0.45');

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST only', 405);

  const profile = await currentProfile(req);
  if (!profile) return fail('UNAUTHENTICATED', 'sign in required', 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_JSON', 'invalid JSON body'); }

  const storage_path = body.storage_path as string | undefined;
  if (!storage_path && !body.image_base64) {
    return fail('MISSING_IMAGE', 'storage_path or image_base64 required');
  }
  // Path convention: user-items/{profile_id}/{uuid}.jpg — enforced so a caller
  // cannot point us at somebody else's object.
  if (storage_path && !storage_path.startsWith(`${profile.id}/`)) {
    return fail('FORBIDDEN', 'storage_path must live under your own prefix', 403);
  }

  const admin = adminClient();

  let bytes: Uint8Array;
  if (body.image_base64) {
    bytes = Uint8Array.from(atob(body.image_base64 as string), (c) => c.charCodeAt(0));
  } else {
    const { data, error } = await admin.storage.from(DOWNLOAD_BUCKET).download(storage_path!);
    if (error || !data) return fail('DOWNLOAD_FAILED', error?.message ?? 'no object', 404);
    bytes = new Uint8Array(await data.arrayBuffer());
  }

  // 1) Vision: pHash + 512-d embedding + archetype guess.
  let ident;
  try {
    ident = await identifyUpload({ imageBytes: bytes });
  } catch (e) {
    return fail('DECODE_FAILED', (e as Error).message, 415);
  }
  const embedding = Array.from(ident.embedding);

  // 2) Persist the user_item first so the ledger row can reference it.
  const { data: item, error: insErr } = await admin.from('user_items').insert({
    owner: profile.id,
    name: body.name ?? `My ${ident.archetype_guess.replaceAll('_', ' ')}`,
    archetype: body.archetype ?? ident.archetype_guess,
    dims_mm: body.dims_mm ?? ident.dims_estimate_mm ?? null,
    storage_path: storage_path ?? null,
    embedding,
    phash: ident.phash,
    status: 'pending',
  }).select().single();
  if (insErr) return fail('INSERT_FAILED', insErr.message, 500);

  // 3) pgvector nearest neighbour against the PUBLISHED catalog.
  const { data: matches, error: matchErr } = await admin.rpc('match_catalog_items', {
    query_embedding: embedding,
    query_phash: ident.phash,
    match_threshold: MATCH_RETURN_FLOOR,
    match_count: 5,
    filter_archetype: null,
  });
  if (matchErr) return fail('MATCH_FAILED', matchErr.message, 500);

  // 4) THE GATE. Same maths as services/vision so JS and SQL never disagree.
  const decision = evaluateDedupe({ matches: matches ?? [], threshold: THRESHOLD });

  let ledger_id: string | null = null;
  if (decision.gated) {
    const { data: gate, error: gateErr } = await admin.rpc('dedupe_gate_user_item', {
      p_user_item_id: item.id, p_threshold: THRESHOLD, p_saved: 1,
    });
    if (gateErr) return fail('GATE_FAILED', gateErr.message, 500);
    ledger_id = (Array.isArray(gate) ? gate[0] : gate)?.ledger_id ?? null;
  } else {
    // Not a dedupe hit -> it may become a community catalog candidate.
    await admin.rpc('promote_clusters_to_moderation', { p_cos: 0.9, p_min_users: 5 });
  }

  const { data: saved } = await admin.rpc('credits_saved', { p_owner: profile.id });
  const { data: balance } = await admin.rpc('credit_balance', { p_owner: profile.id });

  return json({
    ok: true,
    user_item: {
      id: item.id, name: item.name, archetype: item.archetype,
      status: decision.gated ? 'matched' : 'pending',
      phash: ident.phash, dims_estimate_mm: ident.dims_estimate_mm ?? null,
    },
    labels: ident.labels,
    gated: decision.gated,
    matched_by: decision.matched_by,
    credit_cost: decision.credit_cost,           // 0 when gated
    threshold: THRESHOLD,
    match: decision.match,
    modal: decision.modal,
    matches: matches ?? [],
    ledger_id,
    credits_saved: saved ?? 0,
    balance: balance ?? 0,
  });
});

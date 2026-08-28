// supabase/functions/capture-session/index.ts
// QR phone-capture session lifecycle (SPEC §6).
//
//   POST { action:"create", project_id, room_id? }   [desktop, JWT]
//        -> { session, capture_url, qr_payload }
//   POST { action:"claim",  code, fingerprint? }      [phone, NO JWT]
//        -> { session_id, project_id, expires_at, capture_token, upload_prefix }
//   POST { action:"close",  session_id }              [desktop, JWT]
//        -> { session }
//   POST { action:"status", session_id }              [desktop, JWT]
//        -> { session, assets }
//
// Threat model for the anon phone path:
//   * `claim` is the ONLY unauthenticated action. It accepts a 12-char code from
//     a 32-symbol alphabet (~10^18 keyspace) that lives at most 15 minutes.
//   * It returns a JWT with role=anon and app_metadata.capture_session.session_id.
//     RLS policy `scan_assets_insert_phone` allows INSERT for that one session,
//     and there is NO anon SELECT/UPDATE/DELETE policy on scan_assets, so the
//     token is write-only. The phone can read exactly one row anywhere in the
//     database: its own capture_sessions row.
//   * Token exp = session expiry, so it dies with the session.
//   * 40-asset cap + TTL are re-enforced in trg_scan_assets_guard, i.e. in the
//     database, not just in this function.
import { preflight, json, fail } from '../_shared/cors.ts';
import { adminClient, currentProfile, mintCaptureToken } from '../_shared/supabase.ts';

const TTL_MIN = Number(Deno.env.get('CAPTURE_SESSION_TTL_MINUTES') ?? '15');
const MAX_ASSETS = Number(Deno.env.get('CAPTURE_SESSION_MAX_ASSETS') ?? '40');
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'http://localhost:3000';
const SCANS_BUCKET = Deno.env.get('SCANS_BUCKET') ?? 'scans';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST only', 405);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_JSON', 'invalid JSON body'); }
  const action = String(body.action ?? '');
  const admin = adminClient();

  /* ------------------------------------------------------------- create */
  if (action === 'create') {
    const profile = await currentProfile(req);
    if (!profile) return fail('UNAUTHENTICATED', 'sign in required', 401);
    const project_id = body.project_id as string;
    if (!project_id) return fail('MISSING_PROJECT', 'project_id required');

    const { data: project } = await admin.from('projects')
      .select('id, owner').eq('id', project_id).single();
    if (!project || project.owner !== profile.id) return fail('FORBIDDEN', 'not your project', 403);

    const { data, error } = await admin.rpc('create_capture_session', {
      p_project_id: project_id,
      p_room_id: (body.room_id as string) ?? null,
      p_ttl_minutes: Math.min(TTL_MIN, 15),
    });
    if (error) return fail('CREATE_FAILED', error.message, 500);
    const session = Array.isArray(data) ? data[0] : data;
    const capture_url = `${APP_URL}/capture/${session.code}`;

    return json({
      ok: true,
      session: {
        id: session.id, code: session.code, status: session.status,
        expires_at: session.expires_at, asset_count: 0, max_assets: MAX_ASSETS,
      },
      capture_url,
      qr_payload: capture_url,
      realtime: { table: 'scan_assets', filter: `session_id=eq.${session.id}` },
    });
  }

  /* -------------------------------------------------------------- claim */
  // Unauthenticated on purpose: the phone has only the QR code.
  if (action === 'claim') {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!/^[0-9A-HJ-NP-TV-Z]{8,24}$/.test(code)) return fail('BAD_CODE', 'malformed code');

    const { data, error } = await admin.rpc('claim_capture_session', {
      p_code: code,
      p_fingerprint: String(body.fingerprint ?? 'unknown').slice(0, 128),
    });
    if (error) {
      const m = String(error.message);
      if (m.includes('EXPIRED')) return fail('SESSION_EXPIRED', 'this capture link has expired', 410);
      if (m.includes('CLOSED')) return fail('SESSION_CLOSED', 'this capture session is closed', 410);
      return fail('SESSION_NOT_FOUND', 'unknown capture code', 404);
    }
    const session = Array.isArray(data) ? data[0] : data;
    const expiresAt = new Date(session.expires_at);
    const capture_token = await mintCaptureToken(session.id, session.project_id, expiresAt);

    return json({
      ok: true,
      session_id: session.id,
      project_id: session.project_id,
      room_id: session.room_id,
      expires_at: session.expires_at,
      max_assets: session.max_assets,
      remaining: Math.max(0, session.max_assets - session.asset_count),
      capture_token,                                     // role=anon, INSERT-only
      // Storage path the phone must use; storage policy scans_insert_phone checks
      // that folder[2] equals the session id in the token.
      upload_prefix: `${session.project_id}/${session.id}/`,
      bucket: SCANS_BUCKET,
      ttl_seconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    }, 200);
  }

  /* -------------------------------------------------------- close/status */
  if (action === 'close' || action === 'status') {
    const profile = await currentProfile(req);
    if (!profile) return fail('UNAUTHENTICATED', 'sign in required', 401);
    const session_id = body.session_id as string;
    if (!session_id) return fail('MISSING_SESSION', 'session_id required');

    const { data: s } = await admin.from('capture_sessions')
      .select('*, projects!inner(owner)').eq('id', session_id).single();
    if (!s || (s as Record<string, any>).projects?.owner !== profile.id) {
      return fail('FORBIDDEN', 'not your session', 403);
    }

    if (action === 'close') {
      const { data, error } = await admin.rpc('close_capture_session', { p_id: session_id });
      if (error) return fail('CLOSE_FAILED', error.message, 500);
      return json({ ok: true, session: Array.isArray(data) ? data[0] : data });
    }

    const { data: assets } = await admin.from('scan_assets')
      .select('id, storage_path, kind, width, height, created_at')
      .eq('session_id', session_id).order('created_at', { ascending: true });
    return json({
      ok: true,
      session: {
        id: s.id, code: s.code, status: s.status, expires_at: s.expires_at,
        asset_count: s.asset_count, max_assets: s.max_assets,
        expired: new Date(s.expires_at).getTime() <= Date.now(),
      },
      assets: assets ?? [],
    });
  }

  return fail('BAD_ACTION', 'action must be create|claim|close|status');
});

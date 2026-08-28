// Local-dev mirror of the Supabase Edge Function of the same name.
// Same request/response contract, so apps/web/lib/api.ts can point at either
// (NEXT_PUBLIC_API_MODE=local|edge) with no other change.
import { admin, failRes, jsonRes, mintCaptureToken, profileFromRequest }
  from '../_lib/server';

const TTL = Math.min(Number(process.env.CAPTURE_SESSION_TTL_MINUTES ?? 15), 15);
const APP_URL = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return failRes('BAD_JSON', 'invalid JSON body');
  const db = admin();

  if (body.action === 'create') {
    const profile = await profileFromRequest(req);
    if (!profile) return failRes('UNAUTHENTICATED', 'sign in required', 401);
    const { data: project } = await db.from('projects')
      .select('id, owner').eq('id', body.project_id).single();
    if (!project || project.owner !== profile.id) return failRes('FORBIDDEN', 'not your project', 403);

    const { data, error } = await db.rpc('create_capture_session', {
      p_project_id: body.project_id, p_room_id: body.room_id ?? null, p_ttl_minutes: TTL,
    });
    if (error) return failRes('CREATE_FAILED', error.message, 500);
    const s = Array.isArray(data) ? data[0] : data;
    const capture_url = `${APP_URL}/capture/${s.code}`;
    return jsonRes({
      ok: true,
      session: { id: s.id, code: s.code, status: s.status, expires_at: s.expires_at,
                 asset_count: 0, max_assets: s.max_assets },
      capture_url, qr_payload: capture_url,
      realtime: { table: 'scan_assets', filter: `session_id=eq.${s.id}` },
    });
  }

  if (body.action === 'claim') {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!/^[0-9A-HJ-NP-TV-Z]{8,24}$/.test(code)) return failRes('BAD_CODE', 'malformed code');
    const { data, error } = await db.rpc('claim_capture_session', {
      p_code: code, p_fingerprint: String(body.fingerprint ?? 'unknown').slice(0, 128),
    });
    if (error) {
      const m = String(error.message);
      if (m.includes('EXPIRED')) return failRes('SESSION_EXPIRED', 'this capture link has expired', 410);
      if (m.includes('CLOSED')) return failRes('SESSION_CLOSED', 'session closed', 410);
      return failRes('SESSION_NOT_FOUND', 'unknown capture code', 404);
    }
    const s = Array.isArray(data) ? data[0] : data;
    const expiresAt = new Date(s.expires_at);
    return jsonRes({
      ok: true, session_id: s.id, project_id: s.project_id, room_id: s.room_id,
      expires_at: s.expires_at, max_assets: s.max_assets,
      remaining: Math.max(0, s.max_assets - s.asset_count),
      capture_token: await mintCaptureToken(s.id, s.project_id, expiresAt),
      upload_prefix: `${s.project_id}/${s.id}/`,
      bucket: process.env.SCANS_BUCKET ?? 'scans',
      ttl_seconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    });
  }

  if (body.action === 'close' || body.action === 'status') {
    const profile = await profileFromRequest(req);
    if (!profile) return failRes('UNAUTHENTICATED', 'sign in required', 401);
    const { data: s } = await db.from('capture_sessions')
      .select('*, projects!inner(owner)').eq('id', body.session_id).single();
    if (!s || (s as any).projects?.owner !== profile.id) return failRes('FORBIDDEN', 'not yours', 403);
    if (body.action === 'close') {
      const { data } = await db.rpc('close_capture_session', { p_id: body.session_id });
      return jsonRes({ ok: true, session: Array.isArray(data) ? data[0] : data });
    }
    const { data: assets } = await db.from('scan_assets')
      .select('id, storage_path, kind, width, height, created_at')
      .eq('session_id', body.session_id).order('created_at', { ascending: true });
    return jsonRes({
      ok: true,
      session: { id: s.id, code: s.code, status: s.status, expires_at: s.expires_at,
                 asset_count: s.asset_count, max_assets: s.max_assets,
                 expired: new Date(s.expires_at).getTime() <= Date.now() },
      assets: assets ?? [],
    });
  }
  return failRes('BAD_ACTION', 'action must be create|claim|close|status');
}

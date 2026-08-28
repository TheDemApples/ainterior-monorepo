// apps/web/app/api/_lib/server.ts
import { createClient } from '@supabase/supabase-js';

export const admin = () => createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
export const failRes = (code: string, message: string, status = 400, extra = {}) =>
  jsonRes({ ok: false, error: { code, message, ...extra } }, status);

/** Resolve the caller's profile from the Authorization bearer token. */
export async function profileFromRequest(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const sb = createClient(
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } },
  );
  const { data } = await sb.auth.getUser();
  if (!data?.user) return null;
  const { data: p } = await admin().from('profiles')
    .select('id, user_id, role, credits').eq('user_id', data.user.id).single();
  return p ?? null;
}

/** Dev-only capture token: same claims shape as the edge function mints. */
export async function mintCaptureToken(session_id: string, project_id: string, expiresAt: Date) {
  const { createHmac } = await import('node:crypto');
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const payload = b64(JSON.stringify({
    role: 'anon', aud: 'authenticated', iss: 'ainterior-capture',
    sub: `capture:${session_id}`, exp, iat: Math.floor(Date.now() / 1000),
    app_metadata: { capture_session: { session_id, project_id, exp } },
  }));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', process.env.SUPABASE_JWT_SECRET!).update(data).digest('base64url');
  return `${data}.${sig}`;
}

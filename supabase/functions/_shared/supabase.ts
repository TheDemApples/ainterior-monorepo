// supabase/functions/_shared/supabase.ts
// Two clients, deliberately separated:
//   userClient(req)   -> forwards the caller's JWT, so RLS applies. Use for reads
//                        and for anything the user is allowed to do themselves.
//   adminClient()     -> service_role, bypasses RLS. Use ONLY for the privileged
//                        writes RLS forbids: credit deduction, job status, cluster
//                        promotion, minting capture tokens.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export function userClient(req: Request): SupabaseClient {
  return createClient(URL, ANON, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(URL, SERVICE, { auth: { persistSession: false } });
}

/** Resolve the caller's profile row (id, role, credits) or null. */
export async function currentProfile(req: Request) {
  const sb = userClient(req);
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return null;
  const admin = adminClient();
  const { data } = await admin.from('profiles')
    .select('id, user_id, role, plan, credits').eq('user_id', auth.user.id).single();
  return data ?? null;
}

/* ------------------------------------------------------------- capture token */
// A short-lived JWT for the phone. Signed with the project JWT secret so
// PostgREST accepts it; role = anon so RLS treats it as the anon principal; the
// capture_session claim is what scan_assets_insert_phone keys off.
const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string) {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function mintCaptureToken(session_id: string, project_id: string, expiresAt: Date) {
  const secret = Deno.env.get('SUPABASE_JWT_SECRET')!;
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'anon',                        // <- Postgres role: anon, nothing more
    aud: 'authenticated',
    iss: 'ainterior-capture',
    sub: `capture:${session_id}`,
    exp,
    iat: Math.floor(Date.now() / 1000),
    app_metadata: { capture_session: { session_id, project_id, exp } },
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

// apps/web/lib/api.ts
// The typed API surface the frontend calls. One place that knows whether we are
// talking to Supabase Edge Functions (production) or the Next.js route handlers
// (local dev). Set NEXT_PUBLIC_API_MODE=edge|local.
import type { CaptureSession, CatalogItem, Layout, ReconJob, Room, ScanAsset, UserItem }
  from './supabase';

const MODE = process.env.NEXT_PUBLIC_API_MODE ?? 'local';
const EDGE = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/functions/v1`;
const LOCAL = process.env.NEXT_PUBLIC_API_BASE ?? '/api';

function endpoint(fn: string) {
  return MODE === 'edge' ? `${EDGE}/${fn}` : `${LOCAL}/${fn}`;
}

export interface ApiError { code: string; message: string; [k: string]: unknown }
export class ApiCallError extends Error {
  constructor(public code: string, message: string, public status: number,
              public detail: Record<string, unknown> = {}) {
    super(message);
  }
}

async function post<T>(fn: string, body: unknown, accessToken?: string): Promise<T> {
  const res = await fetch(endpoint(fn), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && MODE === 'edge'
        ? { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    const e = (json?.error ?? {}) as ApiError;
    throw new ApiCallError(e.code ?? 'UNKNOWN', e.message ?? res.statusText, res.status, e);
  }
  return json as T;
}

/* ------------------------------------------------------------ capture (QR) */
export interface CreateSessionResult {
  ok: true;
  session: Pick<CaptureSession, 'id' | 'code' | 'status' | 'expires_at' | 'asset_count' | 'max_assets'>;
  capture_url: string;
  qr_payload: string;
  realtime: { table: string; filter: string };
}
export interface ClaimSessionResult {
  ok: true; session_id: string; project_id: string; room_id: string | null;
  expires_at: string; max_assets: number; remaining: number;
  capture_token: string; upload_prefix: string; bucket: string; ttl_seconds: number;
}

export const capture = {
  /** Desktop: create a session and render `qr_payload` as a QR code. */
  create(project_id: string, opts: { room_id?: string; accessToken: string }) {
    return post<CreateSessionResult>('capture-session',
      { action: 'create', project_id, room_id: opts.room_id ?? null }, opts.accessToken);
  },
  /** Phone: exchange the QR code for a short-lived INSERT-only token. No auth. */
  claim(code: string, fingerprint?: string) {
    return post<ClaimSessionResult>('capture-session', { action: 'claim', code, fingerprint });
  },
  status(session_id: string, accessToken: string) {
    return post<{ ok: true; session: CaptureSession & { expired: boolean }; assets: ScanAsset[] }>(
      'capture-session', { action: 'status', session_id }, accessToken);
  },
  close(session_id: string, accessToken: string) {
    return post<{ ok: true; session: CaptureSession }>(
      'capture-session', { action: 'close', session_id }, accessToken);
  },
};

/* ------------------------------------------------------------------- recon */
export interface ReconSubmitResult {
  ok: true; job: ReconJob; balance: number; webhook_url: string; poll_after_ms: number;
}
export const recon = {
  /** Spends exactly one credit (SPEC §6) and starts the provider job. */
  submit(input: {
    project_id: string; room_id?: string | null;
    kind?: 'room_from_images' | 'room_from_blueprint' | 'object_from_images';
    asset_ids?: string[]; session_id?: string; blueprint_path?: string;
    scale_hint?: number; name?: string; hints?: Record<string, unknown>;
  }, accessToken: string) {
    return post<ReconSubmitResult>('recon-submit', input, accessToken);
  },
  /** Poll path — drives the MOCK provider to completion with no external service. */
  poll(job_id: string, accessToken?: string) {
    return post<{ ok: true; job: Pick<ReconJob, 'id' | 'status' | 'progress' | 'room_id' | 'error'>;
                  room_written: boolean }>(
      'recon-webhook', { job_id, poll: true }, accessToken);
  },
  /** Convenience: poll until terminal. Prefer subscribeToReconJob() in the UI. */
  async wait(job_id: string, accessToken?: string,
             { intervalMs = 1200, timeoutMs = 120_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await recon.poll(job_id, accessToken);
      if (r.job.status === 'succeeded' || r.job.status === 'failed') return r;
      if (Date.now() - t0 > timeoutMs) throw new ApiCallError('TIMEOUT', 'recon job timed out', 504);
      await new Promise((r2) => setTimeout(r2, intervalMs));
    }
  },
};

/* ------------------------------------------------------------------ vision */
export interface DedupeMatch {
  item_id: string; name: string; brand: string; archetype: string;
  dims_mm: { w: number; d: number; h: number };
  similarity: number; phash_distance: number | null; reason: string;
}
export interface IdentifyResult {
  ok: true;
  user_item: Pick<UserItem, 'id' | 'name' | 'archetype' | 'status' | 'phash'> &
             { dims_estimate_mm: { w: number; d: number; h: number } | null };
  labels: { name: string; confidence: number }[];
  /** true => DO NOT generate, DO NOT spend a credit, show `modal`. */
  gated: boolean;
  matched_by: 'phash' | 'embedding' | null;
  credit_cost: 0 | 1;
  threshold: number;
  match: DedupeMatch | null;
  modal: {
    title: string; body: string;
    actions: { id: 'use_catalog' | 'generate_mine' | 'browse'; label: string; item_id?: string }[];
  } | null;
  matches: DedupeMatch[];
  credits_saved: number;
  balance: number;
}

export const vision = {
  /** Upload a photo of a piece the user owns -> pHash + embedding + catalog match. */
  identify(input: { storage_path?: string; image_base64?: string; name?: string;
                    archetype?: string; dims_mm?: { w: number; d: number; h: number } },
           accessToken: string) {
    return post<IdentifyResult>('identify-upload', input, accessToken);
  },
};

/* ---------------------------------------------------------------- catalog */
export const catalog = {
  async list(db: { from: (t: string) => any }, opts: { archetype?: string; category?: string;
                                                      q?: string; limit?: number } = {}) {
    let q = db.from('catalog_items').select('*').eq('published', true)
      .limit(opts.limit ?? 200);
    if (opts.archetype) q = q.eq('archetype', opts.archetype);
    if (opts.category) q = q.eq('category', opts.category);
    if (opts.q) q = q.ilike('name', `%${opts.q}%`);
    const { data, error } = await q;
    if (error) throw new ApiCallError('CATALOG_FAILED', error.message, 500);
    return (data ?? []) as CatalogItem[];
  },
};

/* ----------------------------------------------------------- rooms/layouts */
export const rooms = {
  async create(db: any, room: Partial<Room>) {
    const { data, error } = await db.from('rooms').insert(room).select().single();
    if (error) throw new ApiCallError('ROOM_CREATE_FAILED', error.message, 500);
    return data as Room;
  },
  async update(db: any, id: string, patch: Partial<Room>) {
    const { data, error } = await db.from('rooms').update(patch).eq('id', id).select().single();
    if (error) throw new ApiCallError('ROOM_UPDATE_FAILED', error.message, 500);
    return data as Room;
  },
};

export const layouts = {
  async save(db: any, layout: Partial<Layout>) {
    const { data, error } = await db.from('layouts').insert(layout).select().single();
    if (error) throw new ApiCallError('LAYOUT_SAVE_FAILED', error.message, 500);
    return data as Layout;
  },
  async listForRoom(db: any, room_id: string) {
    const { data, error } = await db.from('layouts').select('*')
      .eq('room_id', room_id).order('score', { ascending: false });
    if (error) throw new ApiCallError('LAYOUT_LIST_FAILED', error.message, 500);
    return (data ?? []) as Layout[];
  },
};

/* ---------------------------------------------------------------- credits */
export const credits = {
  async summary(db: any, profile_id: string) {
    const { data } = await db.from('credit_balances').select('*').eq('owner', profile_id).single();
    return (data ?? { owner: profile_id, balance: 0, credits_saved: 0, dedupe_hits: 0 }) as
      { owner: string; balance: number; credits_saved: number; dedupe_hits: number };
  },
  async ledger(db: any, limit = 50) {
    const { data } = await db.from('credits_ledger').select('*')
      .order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  },
};

export default { capture, recon, vision, catalog, rooms, layouts, credits };

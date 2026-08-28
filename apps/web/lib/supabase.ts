// apps/web/lib/supabase.ts
// Typed Supabase clients + the exact Realtime subscription the desktop uses.
import { createClient, type SupabaseClient, type RealtimeChannel }
  from '@supabase/supabase-js';

/* ------------------------------------------------------------ row types */
export type Role = 'user' | 'pro' | 'admin';
export type ProjectKind = 'residential' | 'staging' | 'hospitality' | 'student';
export type RoomSource = 'photogrammetry' | 'blueprint' | 'manual';
export type SessionStatus = 'open' | 'claimed' | 'closed' | 'expired';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type UserItemStatus = 'pending' | 'matched' | 'approved' | 'rejected';
export type ModerationState = 'new' | 'reviewing' | 'promoted' | 'rejected';
export type RenderKind = 'blueprint_svg' | 'blueprint_pdf' | 'render_png';
export type LayoutMode = 'use-mine' | 'augment';
export type LayoutStyle = 'neutral' | 'cozy' | 'minimal' | 'family' | 'wfh' | 'entertain';

export interface DimsMM { w: number; d: number; h: number }
export interface Opening {
  id: string; type: 'door' | 'window'; wall_index: number; offset_mm: number;
  width_mm: number; height_mm: number; sill_mm: number;
  swing: 'in-left' | 'in-right' | 'out-left' | 'out-right' | null;
}
export interface RoomFeature {
  id: string;
  type: 'radiator' | 'column' | 'fireplace' | 'stair' | 'niche' | 'tv_outlet' | 'vent';
  wall_index: number; offset_mm: number; width_mm: number; depth_mm: number;
}

export interface Profile {
  id: string; user_id: string; display_name: string | null; role: Role;
  plan: string; credits: number; created_at: string;
}
export interface Project {
  id: string; owner: string; name: string; kind: ProjectKind;
  archived: boolean; created_at: string;
}
export interface Room {
  id: string; project_id: string; name: string;
  polygon_mm: [number, number][]; height_mm: number;
  openings: Opening[]; features: RoomFeature[];
  source: RoomSource; confidence: number; created_at: string;
}
export interface CaptureSession {
  id: string; project_id: string; room_id: string | null; code: string;
  status: SessionStatus; expires_at: string; claimed_by: string | null;
  asset_count: number; max_assets: number; created_at: string;
}
export interface ScanAsset {
  id: string; session_id: string; room_id: string | null; storage_path: string;
  kind: 'photo' | 'blueprint'; exif: Record<string, unknown>;
  width: number | null; height: number | null; created_at: string;
}
export interface ReconJob {
  id: string; room_id: string | null; owner: string; project_id: string | null;
  provider: string; provider_job_id: string | null; status: JobStatus;
  progress: number; result: { room?: Room; mesh_url?: string; dims_mm?: DimsMM } | null;
  error: string | null; credits_cost: number; created_at: string;
}
export interface CatalogItem {
  id: string; brand: string; name: string; product_type: string | null;
  sku: string | null; category: string; archetype: string; dims_mm: DimsMM;
  seat_h_mm: number | null; footprint: 'rect' | 'round' | 'L';
  l_shape_mm: { notch_w: number; notch_d: number } | null;
  clearance_mm: { front: number; back: number; left: number; right: number };
  placement: Record<string, unknown>;
  colorways: { name: string; hex: string }[];
  price_usd: number | null; url: string | null; tags: string[];
  proxy: { parts: unknown[] }; phash: string | null; published: boolean;
}
export interface UserItem {
  id: string; owner: string; name: string; archetype: string | null;
  dims_mm: DimsMM | null; storage_path: string | null; phash: string | null;
  status: UserItemStatus; matched_item_id: string | null;
  match_similarity: number | null; cluster_id: string | null; created_at: string;
}
export interface ModerationRow {
  id: string; user_item_id: string; cluster_id: string; cluster_size: number;
  distinct_users: number; state: ModerationState; reviewer: string | null;
  notes: string | null; created_at: string;
}
export interface Layout {
  id: string; room_id: string; seed: number; mode: LayoutMode; style: LayoutStyle;
  score: number; placements: unknown[]; rationale: string[];
  metrics: Record<string, number>; is_user_edited: boolean; created_at: string;
}
export interface Render {
  id: string; layout_id: string; kind: RenderKind; storage_path: string; created_at: string;
}
export interface CreditLedgerRow {
  id: string; owner: string; delta: number;
  reason: 'signup_grant' | 'purchase' | 'recon_job' | 'dedupe_saved' | 'refund'
        | 'admin_adjust' | 'job_failed_refund';
  ref_id: string | null; saved: number; created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      projects: { Row: Project; Insert: Partial<Project>; Update: Partial<Project> };
      rooms: { Row: Room; Insert: Partial<Room>; Update: Partial<Room> };
      capture_sessions: { Row: CaptureSession; Insert: Partial<CaptureSession>; Update: Partial<CaptureSession> };
      scan_assets: { Row: ScanAsset; Insert: Partial<ScanAsset>; Update: Partial<ScanAsset> };
      recon_jobs: { Row: ReconJob; Insert: Partial<ReconJob>; Update: Partial<ReconJob> };
      catalog_items: { Row: CatalogItem; Insert: Partial<CatalogItem>; Update: Partial<CatalogItem> };
      user_items: { Row: UserItem; Insert: Partial<UserItem>; Update: Partial<UserItem> };
      moderation_queue: { Row: ModerationRow; Insert: Partial<ModerationRow>; Update: Partial<ModerationRow> };
      layouts: { Row: Layout; Insert: Partial<Layout>; Update: Partial<Layout> };
      renders: { Row: Render; Insert: Partial<Render>; Update: Partial<Render> };
      credits_ledger: { Row: CreditLedgerRow; Insert: Partial<CreditLedgerRow>; Update: never };
    };
    Views: {
      credit_balances: {
        Row: { owner: string; balance: number; credits_saved: number; dedupe_hits: number };
      };
    };
  };
}

export type Db = SupabaseClient<Database>;

/* ---------------------------------------------------------------- clients */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Browser / logged-in user client. RLS applies. */
export function createBrowserClient(): Db {
  return createClient<Database>(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

/** Phone client built from the short-lived capture token. INSERT-only in practice. */
export function createCaptureClient(captureToken: string): Db {
  return createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${captureToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Server-only. Never import this into a client component. */
export function createAdminClient(): Db {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (typeof window !== 'undefined') throw new Error('admin client is server-only');
  return createClient<Database>(process.env.SUPABASE_URL ?? url, service, {
    auth: { persistSession: false },
  });
}

/* -------------------------------------------------- REALTIME (SPEC §6) --- */
/**
 * THE exact desktop subscription. New phone uploads appear live, filtered
 * server-side to one session_id so no other project's rows are ever delivered.
 *
 *   const channel = subscribeToCaptureSession(db, session.id, {
 *     onAsset: (a) => setThumbs((t) => [...t, a]),
 *     onSessionChange: (s) => { if (s.status !== 'open' && s.status !== 'claimed') channel.unsubscribe(); },
 *   });
 *   // later: channel.unsubscribe()
 */
export function subscribeToCaptureSession(
  db: Db,
  sessionId: string,
  handlers: {
    onAsset?: (asset: ScanAsset) => void;
    onSessionChange?: (session: CaptureSession) => void;
    onStatus?: (status: string) => void;
  },
): RealtimeChannel {
  return db
    .channel(`capture:${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'scan_assets',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => handlers.onAsset?.(payload.new as ScanAsset),
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'capture_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => handlers.onSessionChange?.(payload.new as CaptureSession),
    )
    .subscribe((status) => handlers.onStatus?.(status));
}

/** Live recon job progress for the reconstruction spinner. */
export function subscribeToReconJob(
  db: Db, jobId: string, onJob: (job: ReconJob) => void,
): RealtimeChannel {
  return db
    .channel(`recon:${jobId}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'recon_jobs', filter: `id=eq.${jobId}` },
      (p) => onJob(p.new as ReconJob))
    .subscribe();
}

/** Signed thumbnail URLs for the assets that arrive over Realtime. */
export async function signedThumb(db: Db, storage_path: string, seconds = 600) {
  const { data } = await db.storage.from('scans').createSignedUrl(storage_path, seconds);
  return data?.signedUrl ?? null;
}

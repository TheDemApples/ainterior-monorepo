-- ainterior :: 0001_init.sql
-- Extensions, enums, tables, indexes, triggers.
-- SPEC §6 data model. All linear dimensions are millimetres, integers (SPEC §1).
-- Run order: 0001_init.sql -> 0002_rls.sql -> 0003_functions.sql

begin;

-- ---------------------------------------------------------------- extensions
create extension if not exists pgcrypto;    -- gen_random_uuid()
create extension if not exists vector;      -- pgvector: embedding vector(512)
create extension if not exists pg_trgm;     -- fuzzy name search on catalog
create extension if not exists btree_gin;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type profile_role   as enum ('user','pro','admin');
  create type project_kind   as enum ('residential','staging','hospitality','student');
  create type room_source    as enum ('photogrammetry','blueprint','manual');
  create type session_status as enum ('open','claimed','closed','expired');
  create type asset_kind     as enum ('photo','blueprint');
  create type job_status      as enum ('queued','running','succeeded','failed');
  create type user_item_status as enum ('pending','matched','approved','rejected');
  create type moderation_state as enum ('new','reviewing','promoted','rejected');
  create type render_kind    as enum ('blueprint_svg','blueprint_pdf','render_png');
  create type layout_mode    as enum ('use-mine','augment');
  create type layout_style   as enum ('neutral','cozy','minimal','family','wfh','entertain');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- profiles
create table if not exists profiles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  role         profile_role not null default 'user',
  plan         text not null default 'free',
  -- Denormalised cache of sum(credits_ledger.delta). Source of truth is the
  -- ledger; this column is maintained by trg_credits_ledger_sync and is never
  -- writable by clients (RLS column guard in 0002 + trigger in 0003).
  credits      integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists profiles_user_id_idx on profiles(user_id);
create index if not exists profiles_role_idx    on profiles(role);

-- ---------------------------------------------------------------- projects
create table if not exists projects (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references profiles(id) on delete cascade,
  name       text not null,
  kind       project_kind not null default 'residential',
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_idx on projects(owner);
create index if not exists projects_owner_active_idx on projects(owner) where archived = false;

-- ---------------------------------------------------------------- rooms  (SPEC §4.4)
create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null default 'Room',
  polygon_mm  jsonb not null default '[]'::jsonb,   -- [[x_mm,y_mm], ...] CCW, closed implicitly
  height_mm   integer not null default 2600,
  openings    jsonb not null default '[]'::jsonb,   -- SPEC §4.4 openings[]
  features    jsonb not null default '[]'::jsonb,   -- SPEC §4.4 features[]
  source      room_source not null default 'manual',
  confidence  double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint rooms_height_positive check (height_mm > 0 and height_mm < 20000),
  constraint rooms_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint rooms_polygon_is_array check (jsonb_typeof(polygon_mm) = 'array'),
  constraint rooms_openings_is_array check (jsonb_typeof(openings) = 'array'),
  constraint rooms_features_is_array check (jsonb_typeof(features) = 'array')
);
create index if not exists rooms_project_idx on rooms(project_id);

-- ------------------------------------------------------- capture_sessions (SPEC §6 QR flow)
create table if not exists capture_sessions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  room_id     uuid references rooms(id) on delete set null,
  -- short, unguessable, human-typeable code embedded in the QR at /capture/{code}
  code        text not null unique,
  status      session_status not null default 'open',
  expires_at  timestamptz not null default (now() + interval '15 minutes'),
  claimed_by  text,                                  -- opaque device fingerprint from the phone
  claimed_at  timestamptz,
  asset_count integer not null default 0,            -- maintained by trg_scan_assets_count
  max_assets  integer not null default 40,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint capture_sessions_code_len  check (char_length(code) between 8 and 24),
  constraint capture_sessions_max_cap   check (max_assets > 0 and max_assets <= 40)
);
create index if not exists capture_sessions_code_idx    on capture_sessions(code);
create index if not exists capture_sessions_project_idx on capture_sessions(project_id);
create index if not exists capture_sessions_live_idx    on capture_sessions(expires_at)
  where status in ('open','claimed');

-- ---------------------------------------------------------------- scan_assets
create table if not exists scan_assets (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references capture_sessions(id) on delete cascade,
  room_id      uuid references rooms(id) on delete set null,
  storage_path text not null,
  kind         asset_kind not null default 'photo',
  exif         jsonb not null default '{}'::jsonb,
  width        integer,
  height       integer,
  created_at   timestamptz not null default now(),
  constraint scan_assets_dims check (
    (width is null or width  between 1 and 20000) and
    (height is null or height between 1 and 20000))
);
create index if not exists scan_assets_session_idx on scan_assets(session_id, created_at desc);
create index if not exists scan_assets_room_idx    on scan_assets(room_id);

-- ---------------------------------------------------------------- recon_jobs
create table if not exists recon_jobs (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid references rooms(id) on delete cascade,
  owner           uuid not null references profiles(id) on delete cascade,
  project_id      uuid references projects(id) on delete set null,
  provider        text not null default 'mock',       -- 'mock' | 'meshy'
  provider_job_id text,
  kind            text not null default 'room_from_images',
  status          job_status not null default 'queued',
  progress        double precision not null default 0,
  result          jsonb,                              -- { room? | mesh_url? | dims_mm? }
  error           text,
  credits_cost    integer not null default 1,
  webhook_secret  text,                               -- per-job nonce; provider echoes it back
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint recon_jobs_progress_range check (progress >= 0 and progress <= 1)
);
create index if not exists recon_jobs_room_idx     on recon_jobs(room_id);
create index if not exists recon_jobs_owner_idx    on recon_jobs(owner, created_at desc);
create unique index if not exists recon_jobs_provider_job_idx
  on recon_jobs(provider, provider_job_id) where provider_job_id is not null;

-- ---------------------------------------------------------------- catalog_items (SPEC §4.1)
create table if not exists catalog_items (
  id            text primary key,                   -- kebab, stable: 'ikea-ektorp-3s'
  brand         text not null,
  name          text not null,
  product_type  text,
  sku           text,
  category      text not null,                      -- SPEC §4.2
  archetype     text not null,                      -- SPEC §4.3
  dims_mm       jsonb not null,                     -- { w, d, h }
  seat_h_mm     integer,
  footprint     text not null default 'rect',       -- rect | round | L
  l_shape_mm    jsonb,
  clearance_mm  jsonb not null default '{"front":0,"back":0,"left":0,"right":0}'::jsonb,
  placement     jsonb not null default '{}'::jsonb,
  colorways     jsonb not null default '[]'::jsonb,
  price_usd     numeric(10,2),
  url           text,
  tags          text[] not null default '{}',
  proxy         jsonb not null default '{"parts":[]}'::jsonb,
  embedding     vector(512),
  phash         text,
  published     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint catalog_footprint_enum check (footprint in ('rect','round','L')),
  constraint catalog_category_enum check (category in
    ('seating','tables','beds','storage','desks','lighting','rugs','decor','appliance','outdoor','kids')),
  constraint catalog_dims_keys check (
    dims_mm ? 'w' and dims_mm ? 'd' and dims_mm ? 'h'),
  constraint catalog_dims_positive check (
    (dims_mm->>'w')::int > 0 and (dims_mm->>'d')::int > 0 and (dims_mm->>'h')::int > 0)
);
create index if not exists catalog_published_idx on catalog_items(published) where published = true;
create index if not exists catalog_archetype_idx on catalog_items(archetype);
create index if not exists catalog_category_idx  on catalog_items(category);
create index if not exists catalog_phash_idx     on catalog_items(phash);
create index if not exists catalog_name_trgm_idx on catalog_items using gin (name gin_trgm_ops);
-- Cosine ANN index for dedupe nearest-neighbour (SPEC §5.4).
-- lists = ~sqrt(rows); tune with `set ivfflat.probes = 10;` at query time.
create index if not exists catalog_embedding_cos_idx
  on catalog_items using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------- user_items
create table if not exists user_items (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null references profiles(id) on delete cascade,
  name            text not null default 'My piece',
  archetype       text,
  dims_mm         jsonb,
  storage_path    text,
  embedding       vector(512),
  phash           text,
  status          user_item_status not null default 'pending',
  matched_item_id text references catalog_items(id) on delete set null,
  match_similarity double precision,
  cluster_id      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint user_items_similarity_range check (
    match_similarity is null or (match_similarity >= -1 and match_similarity <= 1))
);
create index if not exists user_items_owner_idx   on user_items(owner, created_at desc);
create index if not exists user_items_status_idx  on user_items(status);
create index if not exists user_items_cluster_idx on user_items(cluster_id);
create index if not exists user_items_embedding_cos_idx
  on user_items using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------- moderation_queue
create table if not exists moderation_queue (
  id           uuid primary key default gen_random_uuid(),
  user_item_id uuid not null references user_items(id) on delete cascade,
  cluster_id   uuid not null,
  cluster_size integer not null default 1,
  distinct_users integer not null default 1,
  state        moderation_state not null default 'new',
  reviewer     uuid references profiles(id) on delete set null,
  notes        text,
  promoted_item_id text references catalog_items(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint moderation_cluster_size_positive check (cluster_size >= 1)
);
create unique index if not exists moderation_queue_item_uniq on moderation_queue(user_item_id);
create index if not exists moderation_queue_state_idx   on moderation_queue(state);
create index if not exists moderation_queue_cluster_idx on moderation_queue(cluster_id);

-- ---------------------------------------------------------------- layouts (SPEC §4.5)
create table if not exists layouts (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references rooms(id) on delete cascade,
  seed           bigint not null default 0,
  mode           layout_mode  not null default 'augment',
  style          layout_style not null default 'neutral',
  score          double precision not null default 0,
  placements     jsonb not null default '[]'::jsonb,
  rationale      jsonb not null default '[]'::jsonb,
  violations     jsonb not null default '[]'::jsonb,
  metrics        jsonb not null default '{}'::jsonb,
  is_user_edited boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint layouts_placements_is_array check (jsonb_typeof(placements) = 'array')
);
create index if not exists layouts_room_idx on layouts(room_id, score desc);

-- ---------------------------------------------------------------- renders
create table if not exists renders (
  id           uuid primary key default gen_random_uuid(),
  layout_id    uuid not null references layouts(id) on delete cascade,
  kind         render_kind not null,
  storage_path text not null,
  bytes        integer,
  created_at   timestamptz not null default now()
);
create index if not exists renders_layout_idx on renders(layout_id, created_at desc);

-- ---------------------------------------------------------------- credits_ledger (append-only)
create table if not exists credits_ledger (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references profiles(id) on delete cascade,
  delta      integer not null,            -- negative = spend, positive = grant, 0 = dedupe_saved
  reason     text not null,               -- 'signup_grant' | 'recon_job' | 'dedupe_saved' | 'refund' | 'purchase'
  ref_id     uuid,                        -- recon_jobs.id / user_items.id / stripe ref
  saved      integer not null default 0,  -- credits *avoided* (dedupe_saved rows carry this)
  created_at timestamptz not null default now(),
  constraint credits_reason_enum check (reason in
    ('signup_grant','purchase','recon_job','dedupe_saved','refund','admin_adjust','job_failed_refund'))
);
create index if not exists credits_ledger_owner_idx on credits_ledger(owner, created_at desc);
create index if not exists credits_ledger_ref_idx   on credits_ledger(ref_id);
create index if not exists credits_ledger_reason_idx on credits_ledger(reason);
-- One spend row per recon job, ever. Makes the deduction idempotent.
create unique index if not exists credits_ledger_recon_once
  on credits_ledger(ref_id) where reason = 'recon_job';

-- ---------------------------------------------------------------- balance view
create or replace view credit_balances as
  select owner,
         coalesce(sum(delta), 0)::int                                as balance,
         coalesce(sum(saved) filter (where reason = 'dedupe_saved'), 0)::int as credits_saved,
         count(*) filter (where reason = 'dedupe_saved')::int        as dedupe_hits
  from credits_ledger
  group by owner;

-- ---------------------------------------------------------------- triggers
create or replace function tg_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','projects','rooms','recon_jobs','catalog_items',
                           'user_items','moderation_queue','layouts']
  loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format('create trigger trg_touch_%1$s before update on %1$s
                    for each row execute function tg_touch_updated_at()', t);
  end loop;
end $$;

-- credits_ledger is APPEND-ONLY: block UPDATE and DELETE at the database level
-- so even a leaked service-role key cannot rewrite history.
create or replace function tg_credits_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'credits_ledger is append-only (attempted %)', tg_op
    using errcode = 'check_violation';
end $$;

drop trigger if exists trg_credits_ledger_no_update on credits_ledger;
create trigger trg_credits_ledger_no_update before update or delete on credits_ledger
  for each row execute function tg_credits_ledger_append_only();

-- Keep profiles.credits in sync with the ledger sum on every insert.
create or replace function tg_credits_ledger_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles p
     set credits = (select coalesce(sum(l.delta),0) from credits_ledger l where l.owner = p.id)
   where p.id = new.owner;
  return new;
end $$;

drop trigger if exists trg_credits_ledger_sync on credits_ledger;
create trigger trg_credits_ledger_sync after insert on credits_ledger
  for each row execute function tg_credits_ledger_sync();

-- capture_sessions: count assets, enforce the 40-asset cap and the 15-minute TTL
-- at write time. The phone token can only INSERT, so this is the only gate needed.
create or replace function tg_scan_assets_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare s capture_sessions;
begin
  select * into s from capture_sessions where id = new.session_id for update;
  if s.id is null then
    raise exception 'unknown capture session' using errcode = 'foreign_key_violation';
  end if;
  if s.status not in ('open','claimed') then
    raise exception 'capture session is %', s.status using errcode = 'check_violation';
  end if;
  if s.expires_at <= now() then
    update capture_sessions set status = 'expired', closed_at = now() where id = s.id;
    raise exception 'capture session expired' using errcode = 'check_violation';
  end if;
  if s.asset_count >= s.max_assets then
    update capture_sessions set status = 'closed', closed_at = now() where id = s.id;
    raise exception 'capture session full (max % assets)', s.max_assets
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_scan_assets_guard on scan_assets;
create trigger trg_scan_assets_guard before insert on scan_assets
  for each row execute function tg_scan_assets_guard();

create or replace function tg_scan_assets_count() returns trigger
language plpgsql security definer set search_path = public as $$
declare n integer; s capture_sessions;
begin
  update capture_sessions
     set asset_count = asset_count + 1,
         status = case when status = 'open' then 'claimed'::session_status else status end,
         claimed_at = coalesce(claimed_at, now())
   where id = new.session_id
   returning asset_count, * into n, s;
  if n >= s.max_assets then
    update capture_sessions set status = 'closed', closed_at = now() where id = new.session_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_scan_assets_count on scan_assets;
create trigger trg_scan_assets_count after insert on scan_assets
  for each row execute function tg_scan_assets_count();

-- New auth user -> profile + signup credit grant.
create or replace function tg_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  insert into profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (user_id) do nothing
  returning id into pid;
  if pid is not null then
    insert into credits_ledger (owner, delta, reason) values (pid, 10, 'signup_grant');
  end if;
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created after insert on auth.users
  for each row execute function tg_on_auth_user_created();

-- ---------------------------------------------------------------- realtime
-- Desktop subscribes to scan_assets filtered by session_id (SPEC §6).
do $$ begin
  alter publication supabase_realtime add table scan_assets;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table capture_sessions;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table recon_jobs;
exception when duplicate_object then null; when undefined_object then null; end $$;

commit;

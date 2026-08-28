-- ainterior :: 0002_rls.sql
-- Row Level Security. Every table gets `enable row level security` + explicit policies.
-- Default posture: DENY. Nothing is readable or writable unless a policy below allows it.
--
-- Principals
--   authenticated  : a logged-in user. Scoped to rows they own (via profiles.id).
--   admin          : authenticated AND profiles.role = 'admin'.
--   anon (phone)   : a short-lived JWT minted by the capture-session edge function.
--                    Carries app_metadata.capture_session = { session_id, exp }.
--                    It may INSERT into scan_assets for that one session and NOTHING else.
--   service_role   : edge functions. Bypasses RLS by design; all privileged mutations
--                    (credit deduction, job status, cluster promotion) live there.

begin;

-- ---------------------------------------------------------------- helpers
-- current profile id for the calling JWT (null for anon)
create or replace function auth_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from profiles p where p.user_id = auth.uid()
$$;

create or replace function auth_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p
                 where p.user_id = auth.uid() and p.role = 'admin')
$$;

-- the capture session this (anon) JWT is scoped to, if any
create or replace function auth_capture_session_id() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb
        -> 'app_metadata' -> 'capture_session' ->> 'session_id',
      current_setting('request.jwt.claims', true)::jsonb
        -> 'capture_session' ->> 'session_id'
    ), '')::uuid
$$;

-- does the caller own the project that owns this room?
create or replace function owns_room(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from rooms r join projects pr on pr.id = r.project_id
    where r.id = p_room and pr.owner = auth_profile_id())
$$;

create or replace function owns_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects pr
                 where pr.id = p_project and pr.owner = auth_profile_id())
$$;

grant execute on function auth_profile_id, auth_is_admin, auth_capture_session_id,
                          owns_room, owns_project to authenticated, anon;

-- =========================================================== profiles
alter table profiles enable row level security;
alter table profiles force row level security;

drop policy if exists profiles_select_self  on profiles;
drop policy if exists profiles_select_admin on profiles;
drop policy if exists profiles_insert_self  on profiles;
drop policy if exists profiles_update_self  on profiles;
drop policy if exists profiles_update_admin on profiles;

create policy profiles_select_self on profiles
  for select to authenticated using (user_id = auth.uid());
create policy profiles_select_admin on profiles
  for select to authenticated using (auth_is_admin());
create policy profiles_insert_self on profiles
  for insert to authenticated with check (user_id = auth.uid());
-- A user may rename themselves. role / plan / credits are NOT self-writable:
-- credits is ledger-derived, role escalation would be privilege escalation.
create policy profiles_update_self on profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and role    = (select role    from profiles o where o.id = profiles.id)
    and plan    = (select plan    from profiles o where o.id = profiles.id)
    and credits = (select credits from profiles o where o.id = profiles.id));
create policy profiles_update_admin on profiles
  for update to authenticated using (auth_is_admin()) with check (auth_is_admin());
-- no DELETE policy: profiles die with auth.users via cascade only.

-- =========================================================== projects
alter table projects enable row level security;
alter table projects force row level security;
drop policy if exists projects_rw_owner on projects;
drop policy if exists projects_select_admin on projects;
create policy projects_rw_owner on projects
  for all to authenticated
  using (owner = auth_profile_id())
  with check (owner = auth_profile_id());
create policy projects_select_admin on projects
  for select to authenticated using (auth_is_admin());

-- =========================================================== rooms
alter table rooms enable row level security;
alter table rooms force row level security;
drop policy if exists rooms_rw_owner on rooms;
create policy rooms_rw_owner on rooms
  for all to authenticated
  using (owns_project(project_id))
  with check (owns_project(project_id));

-- =========================================================== capture_sessions
alter table capture_sessions enable row level security;
alter table capture_sessions force row level security;
drop policy if exists capture_sessions_rw_owner  on capture_sessions;
drop policy if exists capture_sessions_select_phone on capture_sessions;

-- Desktop (owner) full control.
create policy capture_sessions_rw_owner on capture_sessions
  for all to authenticated
  using (owns_project(project_id))
  with check (owns_project(project_id));

-- The phone may read EXACTLY its own, still-live session row (it needs project_id
-- and expiry to render the upload UI). One row, no fan-out, no other table.
create policy capture_sessions_select_phone on capture_sessions
  for select to anon
  using (id = auth_capture_session_id()
         and status in ('open','claimed')
         and expires_at > now());

-- =========================================================== scan_assets
alter table scan_assets enable row level security;
alter table scan_assets force row level security;
drop policy if exists scan_assets_select_owner on scan_assets;
drop policy if exists scan_assets_write_owner  on scan_assets;
drop policy if exists scan_assets_delete_owner on scan_assets;
drop policy if exists scan_assets_insert_phone on scan_assets;

create policy scan_assets_select_owner on scan_assets
  for select to authenticated
  using (exists (select 1 from capture_sessions s
                 where s.id = scan_assets.session_id and owns_project(s.project_id)));
create policy scan_assets_write_owner on scan_assets
  for insert to authenticated
  with check (exists (select 1 from capture_sessions s
                      where s.id = scan_assets.session_id and owns_project(s.project_id)));
create policy scan_assets_delete_owner on scan_assets
  for delete to authenticated
  using (exists (select 1 from capture_sessions s
                 where s.id = scan_assets.session_id and owns_project(s.project_id)));

-- THE ANON PHONE PATH. Insert-only. Scoped to the one session in the JWT, which
-- must still be open/claimed and unexpired. There is deliberately NO anon SELECT,
-- UPDATE or DELETE policy on this table, so a leaked phone token is write-only:
-- it cannot enumerate storage paths, other sessions, or anybody else's uploads.
-- The 40-asset cap and TTL are re-checked in trg_scan_assets_guard so the limit
-- holds even if a policy is later loosened.
create policy scan_assets_insert_phone on scan_assets
  for insert to anon
  with check (
    session_id = auth_capture_session_id()
    and exists (select 1 from capture_sessions s
                where s.id = scan_assets.session_id
                  and s.status in ('open','claimed')
                  and s.expires_at > now()
                  and s.asset_count < s.max_assets));

-- =========================================================== recon_jobs
alter table recon_jobs enable row level security;
alter table recon_jobs force row level security;
drop policy if exists recon_jobs_select_owner on recon_jobs;
drop policy if exists recon_jobs_insert_owner on recon_jobs;
drop policy if exists recon_jobs_select_admin on recon_jobs;
-- Read your own jobs (used for progress polling / Realtime).
create policy recon_jobs_select_owner on recon_jobs
  for select to authenticated using (owner = auth_profile_id());
-- Clients may not create jobs directly: creation must deduct a credit atomically,
-- so it goes through the recon-submit edge function (service_role). This INSERT
-- policy exists only for the local-dev path where the user is trusted; it still
-- forbids setting status/result.
create policy recon_jobs_insert_owner on recon_jobs
  for insert to authenticated
  with check (owner = auth_profile_id()
              and status = 'queued' and progress = 0 and result is null);
create policy recon_jobs_select_admin on recon_jobs
  for select to authenticated using (auth_is_admin());
-- No authenticated UPDATE/DELETE: only service_role advances a job.

-- =========================================================== catalog_items
alter table catalog_items enable row level security;
alter table catalog_items force row level security;
drop policy if exists catalog_select_published     on catalog_items;
drop policy if exists catalog_select_published_anon on catalog_items;
drop policy if exists catalog_admin_all            on catalog_items;
-- World-readable ONLY where published = true (SPEC §6).
create policy catalog_select_published on catalog_items
  for select to authenticated using (published = true);
create policy catalog_select_published_anon on catalog_items
  for select to anon using (published = true);
create policy catalog_admin_all on catalog_items
  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());

-- =========================================================== user_items
alter table user_items enable row level security;
alter table user_items force row level security;
drop policy if exists user_items_rw_owner    on user_items;
drop policy if exists user_items_select_admin on user_items;
create policy user_items_rw_owner on user_items
  for all to authenticated
  using (owner = auth_profile_id())
  with check (owner = auth_profile_id());
create policy user_items_select_admin on user_items
  for select to authenticated using (auth_is_admin());

-- =========================================================== moderation_queue
alter table moderation_queue enable row level security;
alter table moderation_queue force row level security;
drop policy if exists moderation_admin_all on moderation_queue;
-- ADMIN ONLY (SPEC §6). Ordinary users never see the review pipeline, not even
-- rows derived from their own uploads, because cluster_size leaks other users.
create policy moderation_admin_all on moderation_queue
  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());

-- =========================================================== layouts
alter table layouts enable row level security;
alter table layouts force row level security;
drop policy if exists layouts_rw_owner on layouts;
create policy layouts_rw_owner on layouts
  for all to authenticated
  using (owns_room(room_id))
  with check (owns_room(room_id));

-- =========================================================== renders
alter table renders enable row level security;
alter table renders force row level security;
drop policy if exists renders_rw_owner on renders;
create policy renders_rw_owner on renders
  for all to authenticated
  using (exists (select 1 from layouts l where l.id = renders.layout_id and owns_room(l.room_id)))
  with check (exists (select 1 from layouts l where l.id = renders.layout_id and owns_room(l.room_id)));

-- =========================================================== credits_ledger
alter table credits_ledger enable row level security;
alter table credits_ledger force row level security;
drop policy if exists credits_ledger_select_owner on credits_ledger;
drop policy if exists credits_ledger_select_admin on credits_ledger;
-- Read-only to the owner. No INSERT policy for authenticated: only service_role
-- (edge functions / SQL security-definer fns) may append. UPDATE/DELETE are also
-- blocked by trg_credits_ledger_no_update, so the ledger is append-only for
-- every principal including service_role.
create policy credits_ledger_select_owner on credits_ledger
  for select to authenticated using (owner = auth_profile_id());
create policy credits_ledger_select_admin on credits_ledger
  for select to authenticated using (auth_is_admin());

-- =========================================================== grants
revoke all on all tables in schema public from anon, authenticated;

grant select on catalog_items, credit_balances to anon, authenticated;
grant select, insert, update, delete on
  projects, rooms, capture_sessions, scan_assets, layouts, renders, user_items to authenticated;
grant select, insert, update on profiles to authenticated;
grant select, insert on recon_jobs to authenticated;
grant select on credits_ledger to authenticated;
grant select, insert, update, delete on moderation_queue to authenticated; -- gated by RLS to admins
-- The phone: insert-only on scan_assets, select-only on its own session row.
grant insert on scan_assets to anon;
grant select on capture_sessions to anon;

-- ---------------------------------------------------------------- storage
-- Bucket policies (Supabase Storage is itself RLS-protected via storage.objects).
-- scans/{project_id}/{session_id}/{uuid}.jpg  <- phone writes here, owner reads
do $$ begin
  insert into storage.buckets (id, name, public) values ('scans','scans', false)
  on conflict (id) do nothing;
  insert into storage.buckets (id, name, public) values ('renders','renders', false)
  on conflict (id) do nothing;
  insert into storage.buckets (id, name, public) values ('user-items','user-items', false)
  on conflict (id) do nothing;
exception when undefined_table then null; end $$;

do $$ begin
  drop policy if exists scans_insert_phone on storage.objects;
  create policy scans_insert_phone on storage.objects
    for insert to anon
    with check (bucket_id = 'scans'
                and auth_capture_session_id() is not null
                and (storage.foldername(name))[2] = auth_capture_session_id()::text);

  drop policy if exists scans_select_owner on storage.objects;
  create policy scans_select_owner on storage.objects
    for select to authenticated
    using (bucket_id = 'scans' and owns_project(((storage.foldername(name))[1])::uuid));

  drop policy if exists user_items_rw_owner_obj on storage.objects;
  create policy user_items_rw_owner_obj on storage.objects
    for all to authenticated
    using (bucket_id = 'user-items'
           and (storage.foldername(name))[1] = auth_profile_id()::text)
    with check (bucket_id = 'user-items'
           and (storage.foldername(name))[1] = auth_profile_id()::text);
exception when undefined_table then null; when insufficient_privilege then null; end $$;

commit;

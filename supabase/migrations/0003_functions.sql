-- ainterior :: 0003_functions.sql
-- Business logic that must be atomic: credit deduction, dedupe matching,
-- cluster promotion, capture-session lifecycle, recon result -> Room.
-- All money/credit paths are SECURITY DEFINER + explicit search_path.

begin;

-- ============================================================================
-- CREDITS  (SPEC §6: ledger is the source of truth; deduct on recon_jobs
--           creation only; dedupe hits log delta = 0)
-- ============================================================================

create or replace function credit_balance(p_owner uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta), 0)::int from credits_ledger where owner = p_owner
$$;

create or replace function credits_saved(p_owner uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(saved), 0)::int
  from credits_ledger where owner = p_owner and reason = 'dedupe_saved'
$$;

-- Append a spend row. Raises if the derived balance would go negative.
-- Locks the owner's profile row so two concurrent submits cannot both pass.
create or replace function deduct_credits(
  p_owner  uuid,
  p_amount integer,                 -- positive number of credits to spend
  p_reason text,
  p_ref_id uuid default null
) returns table (ledger_id uuid, balance integer)
language plpgsql security definer set search_path = public as $$
declare bal integer; lid uuid;
begin
  if p_amount <= 0 then
    raise exception 'deduct_credits: amount must be positive, got %', p_amount
      using errcode = 'check_violation';
  end if;

  perform 1 from profiles where id = p_owner for update;   -- serialise per user
  bal := credit_balance(p_owner);

  if bal < p_amount then
    raise exception 'INSUFFICIENT_CREDITS: balance % < required %', bal, p_amount
      using errcode = 'check_violation';
  end if;

  insert into credits_ledger (owner, delta, reason, ref_id)
  values (p_owner, -p_amount, p_reason, p_ref_id)
  returning id into lid;

  return query select lid, credit_balance(p_owner);
end $$;

create or replace function grant_credits(
  p_owner uuid, p_amount integer, p_reason text default 'purchase',
  p_ref_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
begin
  insert into credits_ledger (owner, delta, reason, ref_id)
  values (p_owner, abs(p_amount), p_reason, p_ref_id);
  return credit_balance(p_owner);
end $$;

-- The credit-saving log line (SPEC §5.4). delta = 0, saved = what we avoided.
create or replace function log_dedupe_saved(
  p_owner uuid, p_user_item_id uuid, p_saved integer default 1
) returns uuid
language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  insert into credits_ledger (owner, delta, reason, ref_id, saved)
  values (p_owner, 0, 'dedupe_saved', p_user_item_id, greatest(p_saved, 0))
  returning id into lid;
  return lid;
end $$;

-- ============================================================================
-- RECON JOBS  (credit deducted here, atomically with job creation)
-- ============================================================================

create or replace function create_recon_job(
  p_owner    uuid,
  p_room_id  uuid,
  p_project_id uuid,
  p_provider text default 'mock',
  p_kind     text default 'room_from_images',
  p_cost     integer default 1
) returns recon_jobs
language plpgsql security definer set search_path = public as $$
declare j recon_jobs;
begin
  insert into recon_jobs (owner, room_id, project_id, provider, kind,
                          status, progress, credits_cost, webhook_secret)
  values (p_owner, p_room_id, p_project_id, p_provider, p_kind,
          'queued', 0, p_cost, encode(gen_random_bytes(24), 'hex'))
  returning * into j;

  if p_cost > 0 then
    -- Raises INSUFFICIENT_CREDITS and rolls back the job insert with it.
    perform deduct_credits(p_owner, p_cost, 'recon_job', j.id);
  end if;

  return j;
end $$;

-- Provider callback lands here. Idempotent: a repeated 'succeeded' webhook is a no-op.
create or replace function apply_recon_result(
  p_job_id   uuid,
  p_status   job_status,
  p_progress double precision,
  p_result   jsonb default null,
  p_error    text  default null
) returns recon_jobs
language plpgsql security definer set search_path = public as $$
declare j recon_jobs; r jsonb; new_room uuid;
begin
  select * into j from recon_jobs where id = p_job_id for update;
  if j.id is null then
    raise exception 'unknown recon job %', p_job_id using errcode = 'no_data_found';
  end if;
  if j.status in ('succeeded','failed') then
    return j;                                        -- terminal: idempotent no-op
  end if;

  update recon_jobs
     set status   = p_status,
         progress = greatest(j.progress, coalesce(p_progress, j.progress)),
         result   = coalesce(p_result, j.result),
         error    = coalesce(p_error, j.error)
   where id = p_job_id
   returning * into j;

  -- Materialise the reconstructed Room (SPEC §4.4) onto the rooms row.
  r := p_result -> 'room';
  if p_status = 'succeeded' and r is not null then
    if j.room_id is null then
      insert into rooms (project_id, name, polygon_mm, height_mm, openings, features,
                         source, confidence)
      values (j.project_id,
              coalesce(r->>'name','Room'),
              coalesce(r->'polygon_mm','[]'::jsonb),
              coalesce((r->>'height_mm')::int, 2600),
              coalesce(r->'openings','[]'::jsonb),
              coalesce(r->'features','[]'::jsonb),
              coalesce((r->>'source')::room_source, 'photogrammetry'),
              coalesce((r->>'confidence')::double precision, 0))
      returning id into new_room;
      update recon_jobs set room_id = new_room where id = p_job_id returning * into j;
    else
      update rooms
         set name       = coalesce(r->>'name', name),
             polygon_mm = coalesce(r->'polygon_mm', polygon_mm),
             height_mm  = coalesce((r->>'height_mm')::int, height_mm),
             openings   = coalesce(r->'openings', openings),
             features   = coalesce(r->'features', features),
             source     = coalesce((r->>'source')::room_source, source),
             confidence = coalesce((r->>'confidence')::double precision, confidence)
       where id = j.room_id;
    end if;
  end if;

  -- Failed job -> refund the credit. Ledger stays append-only (compensating row).
  if p_status = 'failed' and j.credits_cost > 0 then
    insert into credits_ledger (owner, delta, reason, ref_id)
    values (j.owner, j.credits_cost, 'job_failed_refund', j.id);
  end if;

  return j;
end $$;

-- ============================================================================
-- DEDUPE / MATCHING  (SPEC §5.4 — pgvector nearest neighbour, 0.86 gate)
-- ============================================================================

-- cosine similarity in [-1,1]; pgvector's <=> is cosine DISTANCE = 1 - similarity
create or replace function cosine_similarity(a vector, b vector) returns double precision
language sql immutable strict parallel safe as $$
  select 1 - (a <=> b)
$$;

create or replace function hamming_hex(a text, b text) returns integer
language plpgsql immutable as $$
declare i int; d int := 0; na int; nb int;
begin
  if a is null or b is null or char_length(a) <> char_length(b) then return null; end if;
  for i in 1 .. char_length(a) loop
    na := ('x' || substr(a, i, 1))::bit(4)::int;
    nb := ('x' || substr(b, i, 1))::bit(4)::int;
    d := d + length(replace((na # nb)::bit(4)::text, '0', ''));
  end loop;
  return d;
end $$;

-- THE matching function the edge fn calls. Returns catalog candidates ordered by
-- similarity desc, with a human 'reason' string for the modal copy.
create or replace function match_catalog_items(
  query_embedding vector(512),
  query_phash     text    default null,
  match_threshold double precision default 0.70,   -- return-to-UI floor
  match_count     integer default 5,
  filter_archetype text   default null
) returns table (
  item_id    text,
  name       text,
  brand      text,
  archetype  text,
  dims_mm    jsonb,
  similarity double precision,
  phash_distance integer,
  reason     text
)
language sql stable security definer set search_path = public as $$
  select c.id,
         c.name,
         c.brand,
         c.archetype,
         c.dims_mm,
         (1 - (c.embedding <=> query_embedding))::double precision as similarity,
         hamming_hex(c.phash, query_phash)                          as phash_distance,
         case
           when query_phash is not null
                and hamming_hex(c.phash, query_phash) is not null
                and hamming_hex(c.phash, query_phash) <= 10
             then 'near-identical image (phash distance '
                  || hamming_hex(c.phash, query_phash) || ')'
           when (1 - (c.embedding <=> query_embedding)) >= 0.86
             then 'visual embedding match ('
                  || round(((1 - (c.embedding <=> query_embedding)) * 100)::numeric, 1) || '%)'
           else 'similar ' || coalesce(c.archetype, 'piece')
         end as reason
  from catalog_items c
  where c.published = true
    and c.embedding is not null
    and (filter_archetype is null or c.archetype = filter_archetype)
    and (1 - (c.embedding <=> query_embedding)) >= match_threshold
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1)
$$;

-- One-shot gate used by identify-upload: match, and if the top hit clears
-- DEDUPE_THRESHOLD (0.86) log 'dedupe_saved' and mark the user_item 'matched'
-- WITHOUT spending a credit.
create or replace function dedupe_gate_user_item(
  p_user_item_id uuid,
  p_threshold    double precision default 0.86,
  p_saved        integer default 1
) returns table (
  gated       boolean,
  item_id     text,
  name        text,
  similarity  double precision,
  reason      text,
  ledger_id   uuid,
  credits_saved_total integer
)
language plpgsql security definer set search_path = public as $$
declare ui user_items; top record; lid uuid; g boolean := false;
begin
  select * into ui from user_items where id = p_user_item_id for update;
  if ui.id is null then
    raise exception 'unknown user_item %', p_user_item_id using errcode = 'no_data_found';
  end if;
  if ui.embedding is null then
    return query select false, null::text, null::text, null::double precision,
                        'no embedding'::text, null::uuid, credits_saved(ui.owner);
    return;
  end if;

  select * into top
  from match_catalog_items(ui.embedding, ui.phash, 0.0, 1, null) m
  limit 1;

  if top.item_id is not null
     and (top.similarity >= p_threshold
          or (top.phash_distance is not null and top.phash_distance <= 6)) then
    g := true;
    update user_items
       set status = 'matched', matched_item_id = top.item_id,
           match_similarity = top.similarity
     where id = p_user_item_id;
    lid := log_dedupe_saved(ui.owner, p_user_item_id, p_saved);
  end if;

  return query select g, top.item_id, top.name, top.similarity, top.reason, lid,
                      credits_saved(ui.owner);
end $$;

-- ============================================================================
-- CLUSTER PROMOTION  (SPEC §5.4 — >= 5 distinct users, cosine >= 0.9)
-- ============================================================================

-- Greedy single-pass clustering: every unmatched, embedded user_item is a seed;
-- its neighbourhood is everything within cosine >= p_cos. A neighbourhood with
-- >= p_min_users distinct owners is a promotion candidate.
create or replace function find_user_item_clusters(
  p_cos       double precision default 0.9,
  p_min_users integer default 5,
  p_limit     integer default 50
) returns table (
  seed_item_id   uuid,
  cluster_size   integer,
  distinct_users integer,
  member_ids     uuid[],
  archetype      text,
  avg_similarity double precision
)
language sql stable security definer set search_path = public as $$
  with seeds as (
    select id, owner, embedding, archetype
    from user_items
    where embedding is not null
      and status in ('pending','approved')
      and matched_item_id is null
  ),
  neigh as (
    select s.id  as seed_item_id,
           s.archetype,
           n.id  as member_id,
           n.owner as member_owner,
           1 - (s.embedding <=> n.embedding) as sim
    from seeds s
    join seeds n
      on n.id <> s.id or n.id = s.id            -- include the seed itself
    where 1 - (s.embedding <=> n.embedding) >= p_cos
  ),
  grouped as (
    select seed_item_id,
           max(archetype)                       as archetype,
           count(*)::int                        as cluster_size,
           count(distinct member_owner)::int    as distinct_users,
           array_agg(member_id order by member_id) as member_ids,
           avg(sim)                             as avg_similarity
    from neigh
    group by seed_item_id
  )
  select seed_item_id, cluster_size, distinct_users, member_ids, archetype, avg_similarity
  from grouped
  where distinct_users >= p_min_users
  order by distinct_users desc, cluster_size desc
  limit p_limit
$$;

-- Materialise qualifying clusters into moderation_queue for manual review.
-- Idempotent via the unique index on moderation_queue(user_item_id).
create or replace function promote_clusters_to_moderation(
  p_cos double precision default 0.9,
  p_min_users integer default 5
) returns table (cluster_id uuid, seed_item_id uuid, cluster_size integer, distinct_users integer)
language plpgsql security definer set search_path = public as $$
declare c record; cid uuid; m uuid;
begin
  for c in select * from find_user_item_clusters(p_cos, p_min_users) loop
    -- reuse an existing cluster id if any member is already queued
    select mq.cluster_id into cid
    from moderation_queue mq
    where mq.user_item_id = any(c.member_ids)
    limit 1;
    if cid is null then cid := gen_random_uuid(); end if;

    foreach m in array c.member_ids loop
      insert into moderation_queue (user_item_id, cluster_id, cluster_size,
                                    distinct_users, state)
      values (m, cid, c.cluster_size, c.distinct_users, 'new')
      on conflict (user_item_id) do update
        set cluster_id = excluded.cluster_id,
            cluster_size = excluded.cluster_size,
            distinct_users = excluded.distinct_users;
    end loop;

    update user_items set cluster_id = cid where id = any(c.member_ids);

    return query select cid, c.seed_item_id, c.cluster_size, c.distinct_users;
  end loop;
end $$;

-- Admin action: promote a reviewed cluster into the public catalog.
create or replace function promote_cluster_to_catalog(
  p_cluster_id uuid,
  p_catalog_id text,
  p_brand text default 'Community',
  p_category text default 'seating',
  p_reviewer uuid default null
) returns catalog_items
language plpgsql security definer set search_path = public as $$
declare src user_items; ci catalog_items;
begin
  select * into src from user_items
  where cluster_id = p_cluster_id and dims_mm is not null
  order by created_at limit 1;
  if src.id is null then
    raise exception 'cluster % has no dimensioned member', p_cluster_id
      using errcode = 'no_data_found';
  end if;

  insert into catalog_items (id, brand, name, category, archetype, dims_mm,
                             embedding, phash, published)
  values (p_catalog_id, p_brand, src.name, p_category,
          coalesce(src.archetype, 'armchair'), src.dims_mm,
          src.embedding, src.phash, false)   -- published only after human QA
  on conflict (id) do update set embedding = excluded.embedding
  returning * into ci;

  update moderation_queue
     set state = 'promoted', reviewer = p_reviewer, promoted_item_id = ci.id
   where cluster_id = p_cluster_id;
  update user_items
     set status = 'approved', matched_item_id = ci.id
   where cluster_id = p_cluster_id;

  return ci;
end $$;

-- ============================================================================
-- CAPTURE SESSIONS  (SPEC §6 QR flow: TTL 15 min, max 40 assets, auto-close)
-- ============================================================================

create or replace function gen_capture_code() returns text
language sql volatile as $$
  -- 12 chars, Crockford-ish alphabet (no I/L/O/U) => ~10^17 keyspace
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                           1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 12)
$$;

create or replace function create_capture_session(
  p_project_id uuid,
  p_room_id    uuid default null,
  p_ttl_minutes integer default 15
) returns capture_sessions
language plpgsql security definer set search_path = public as $$
declare s capture_sessions; tries int := 0;
begin
  loop
    tries := tries + 1;
    begin
      insert into capture_sessions (project_id, room_id, code, status, expires_at, max_assets)
      values (p_project_id, p_room_id, gen_capture_code(), 'open',
              now() + make_interval(mins => least(greatest(p_ttl_minutes,1), 15)), 40)
      returning * into s;
      return s;
    exception when unique_violation then
      if tries > 5 then raise; end if;
    end;
  end loop;
end $$;

create or replace function claim_capture_session(
  p_code text, p_fingerprint text
) returns capture_sessions
language plpgsql security definer set search_path = public as $$
declare s capture_sessions;
begin
  select * into s from capture_sessions where code = upper(p_code) for update;
  if s.id is null then
    raise exception 'CAPTURE_SESSION_NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if s.expires_at <= now() then
    update capture_sessions set status = 'expired', closed_at = now() where id = s.id;
    raise exception 'CAPTURE_SESSION_EXPIRED' using errcode = 'check_violation';
  end if;
  if s.status = 'closed' then
    raise exception 'CAPTURE_SESSION_CLOSED' using errcode = 'check_violation';
  end if;
  update capture_sessions
     set status = 'claimed',
         claimed_by = coalesce(claimed_by, p_fingerprint),
         claimed_at = coalesce(claimed_at, now())
   where id = s.id
   returning * into s;
  return s;
end $$;

create or replace function close_capture_session(p_id uuid) returns capture_sessions
language plpgsql security definer set search_path = public as $$
declare s capture_sessions;
begin
  update capture_sessions set status = 'closed', closed_at = now()
   where id = p_id and status <> 'closed'
   returning * into s;
  if s.id is null then select * into s from capture_sessions where id = p_id; end if;
  return s;
end $$;

-- Cron: select cron.schedule('ainterior-expire', '* * * * *',
--        'select expire_capture_sessions()');
create or replace function expire_capture_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with x as (
    update capture_sessions set status = 'expired', closed_at = now()
     where status in ('open','claimed') and expires_at <= now()
     returning 1)
  select count(*)::int into n from x;
  return n;
end $$;

-- ============================================================================
-- grants: callable by logged-in users; privileged paths stay service_role only
-- ============================================================================
grant execute on function credit_balance(uuid), credits_saved(uuid),
                          match_catalog_items(vector, text, double precision, integer, text),
                          cosine_similarity(vector, vector), hamming_hex(text, text)
  to authenticated;
grant execute on function match_catalog_items(vector, text, double precision, integer, text)
  to anon;

revoke execute on function deduct_credits(uuid, integer, text, uuid) from anon, authenticated;
revoke execute on function grant_credits(uuid, integer, text, uuid) from anon, authenticated;
revoke execute on function create_recon_job(uuid, uuid, uuid, text, text, integer)
  from anon, authenticated;
revoke execute on function apply_recon_result(uuid, job_status, double precision, jsonb, text)
  from anon, authenticated;
revoke execute on function promote_clusters_to_moderation(double precision, integer)
  from anon, authenticated;
revoke execute on function promote_cluster_to_catalog(uuid, text, text, text, uuid)
  from anon, authenticated;
revoke execute on function log_dedupe_saved(uuid, uuid, integer) from anon, authenticated;
revoke execute on function dedupe_gate_user_item(uuid, double precision, integer)
  from anon, authenticated;

commit;

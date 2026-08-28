# ainterior — Backend (Deliverable D)

Supabase Postgres + RLS + Edge Functions, plus two provider-agnostic Node services
(`services/recon`, `services/vision`) that run identically in Deno (edge), Node
(tests) and the browser demo.

Everything works **offline with no third-party API key**: `RECON_PROVIDER=mock` is
the default and the vision embedder is a local deterministic descriptor.

---

## 1. Setup

```bash
# 0. prerequisites: supabase CLI, node >= 20, python3 (validator only)
cp .env.example .env.local            # fill in SUPABASE_* values

# 1. local stack
supabase start                        # postgres + auth + storage + realtime

# 2. migrations, IN ORDER (they are not independent)
supabase db push                      # or: psql -f each file below, in sequence

# 3. seed the catalog (Deliverable E owns packages/catalog/catalog.json)
node tools/seed_catalog.mjs           # see "Catalog seeding" below

# 4. edge functions
supabase functions deploy capture-session
supabase functions deploy identify-upload
supabase functions deploy recon-submit
supabase functions deploy recon-webhook --no-verify-jwt   # providers call this

# 5. verify
python3 tools/validate_schema.py      # schema + RLS invariants
node tests/run_all.mjs                # everything
```

### Migration order — mandatory

| # | file | why it must be third/second/first |
|---|---|---|
| 1 | `supabase/migrations/0001_init.sql` | extensions (`pgcrypto`, `vector`, `pg_trgm`), enums, 12 tables, 32 indexes, triggers, the `credit_balances` view, Realtime publication |
| 2 | `supabase/migrations/0002_rls.sql` | `enable`/`force` RLS + every policy. Depends on the tables and on the enum types. Also creates the `auth_profile_id()` / `owns_project()` helpers the policies call, and the three Storage buckets |
| 3 | `supabase/migrations/0003_functions.sql` | business logic (credits, dedupe, clustering, session lifecycle). Depends on tables **and** on the helper functions from 0002 |

Re-running any file is safe: every object uses `if not exists` /
`create or replace` / `drop policy if exists`.

### Catalog seeding

`catalog_items.embedding` must be populated or dedupe cannot work. Compute it with
the same code the runtime uses so the vectors are comparable:

```js
import { identifyUpload } from './services/vision/index.js';
const { phash, embedding } = await identifyUpload({ imageBytes: fs.readFileSync(img) });
await db.from('catalog_items').upsert({ ...item, phash, embedding: Array.from(embedding),
                                        published: true });
```

After a bulk load, rebuild the ANN index so `lists` matches the row count:

```sql
reindex index catalog_embedding_cos_idx;      -- or drop/recreate with lists = sqrt(n)
set ivfflat.probes = 10;                      -- per-session recall/latency knob
```

---

## 2. Auth model

Four principals. Everything below is enforced by Postgres, not by application code.

| principal | how it authenticates | can do |
|---|---|---|
| **authenticated** | Supabase Auth JWT (`auth.uid()`) | read/write only rows it owns, resolved through `profiles.id` |
| **admin** | authenticated **and** `profiles.role = 'admin'` | additionally: all of `moderation_queue`, catalog writes, read any project |
| **anon (phone)** | 15-minute JWT minted by `capture-session` (`action:"claim"`), `role: anon`, `app_metadata.capture_session.session_id` | **INSERT into `scan_assets` only**, for that one session; SELECT exactly its own `capture_sessions` row; SELECT published catalog rows |
| **service_role** | edge functions only, never shipped to a browser | bypasses RLS — used for credit deduction, job status, cluster promotion, token minting |

Ownership always resolves through `profiles`, never through `auth.users` directly:

```
auth.users.id ──> profiles.user_id ; profiles.id ──> projects.owner
                                              ├──> rooms.project_id ──> layouts.room_id ──> renders.layout_id
                                              ├──> capture_sessions.project_id ──> scan_assets.session_id
                                              ├──> user_items.owner
                                              └──> credits_ledger.owner
```

Helpers used by the policies (all `security definer`, fixed `search_path`):
`auth_profile_id()`, `auth_is_admin()`, `auth_capture_session_id()`,
`owns_project(uuid)`, `owns_room(uuid)`.

A new `auth.users` row fires `trg_on_auth_user_created`, which creates the profile
and appends a `signup_grant` of 10 credits.

---

## 3. RLS reasoning, table by table

Default posture is **deny**: `enable row level security` + `force row level
security` on all 12 tables, and `revoke all on all tables in schema public from
anon, authenticated` before the narrow grants. A missing policy therefore fails
closed, not open.

| table | policies | reasoning |
|---|---|---|
| `profiles` | select self / select admin / insert self / **update self with column guard** / update admin | A user may rename themselves. The `with check` clause re-reads `role`, `plan` and `credits` from the existing row and requires them to be unchanged — so self-service privilege escalation and credit self-minting are impossible even though the row is writable. |
| `projects` | `for all` where `owner = auth_profile_id()`; admin select | The ownership root. |
| `rooms` | `for all` via `owns_project(project_id)` | Rooms inherit project ownership; no direct owner column to drift. |
| `capture_sessions` | owner `for all`; **anon select of exactly one live row** | The phone needs `project_id` + expiry to build its upload path. The anon predicate is `id = auth_capture_session_id() and status in ('open','claimed') and expires_at > now()` — one row, no enumeration. |
| `scan_assets` | owner select/insert/delete; **anon insert only** | See the threat model in §4. |
| `recon_jobs` | owner select; admin select; constrained owner insert (`status='queued' and progress=0 and result is null`) | No client UPDATE at all: only `service_role` advances a job, so a user cannot mark their own job succeeded and skip the provider, nor rewrite `result`. Direct insert is allowed but is *not* the real path — the edge function is, because that is where the credit is deducted atomically. |
| `catalog_items` | select for `authenticated` and `anon`, both `using (published = true)`; admin `for all` | World-readable *only* where `published = true`, per SPEC §6. Unpublished rows (community submissions awaiting QA, embargoed SKUs) are invisible — and `match_catalog_items()` also filters on `published`, so they cannot leak through similarity search either. |
| `user_items` | owner `for all`; admin select | Private furniture photos. Admin read is needed for moderation. |
| `moderation_queue` | **admin only** (`auth_is_admin()` in both `using` and `with check`) | Ordinary users cannot see it *even for rows derived from their own upload*, because `cluster_size` / `distinct_users` leak how many other people own the same piece. |
| `layouts`, `renders` | `for all` via `owns_room` / `layout → room` | Chained ownership. |
| `credits_ledger` | **select only** (owner or admin) | No INSERT/UPDATE/DELETE policy for any client role. Appends happen through `security definer` functions called by edge functions. `trg_credits_ledger_no_update` raises on UPDATE **and** DELETE for *every* role including `service_role`, so the ledger is immutable even with a leaked service key. |

Storage (`storage.objects`) is policed separately:
`scans` insert is anon-allowed only when `foldername(name)[2]` equals the session
id in the token; `scans` select requires project ownership; `user-items` is keyed
on `foldername(name)[1] = auth_profile_id()`.

---

## 4. Threat model — the anon phone-upload path

The phone is an **unauthenticated device holding only a QR code**. That is the one
place where an anonymous principal can write to the database, so it is scoped hard.

**What the phone gets.** `POST /capture-session {action:"claim", code}` returns a
JWT with `role: anon`, `exp = session.expires_at`, and
`app_metadata.capture_session = { session_id, project_id, exp }`. It is signed with
the project JWT secret so PostgREST accepts it as an ordinary anon request.

**What that token can do, and nothing else:**

| attack | why it fails |
|---|---|
| Read other people's photos | There is **no anon SELECT policy on `scan_assets`**. The token is write-only. Even its own uploads are unreadable to it. |
| Enumerate projects, rooms, layouts, users | No anon policy exists on those tables at all, and `revoke all … from anon` removes the table privilege too. |
| Post into a different session | `scan_assets_insert_phone` requires `session_id = auth_capture_session_id()`, which comes from the signed token, not the request body. |
| Guess a session code | 12 chars over a 32-symbol alphabet ≈ 1.2 × 10¹⁸ combinations, alive for ≤ 15 minutes, and `claim` is the only endpoint that accepts a code. |
| Reuse a token after the session ends | The policy re-checks `status in ('open','claimed') and expires_at > now()` on every INSERT, and the JWT `exp` equals the session expiry. |
| Flood the session with uploads | The policy checks `asset_count < max_assets`, and `trg_scan_assets_guard` re-checks the cap **and** the TTL inside the transaction with `select … for update`, auto-closing the session at 40 assets. Defence is in the database, not the function. |
| Escalate the token | The JWT carries `role: anon`. It cannot name a different Postgres role; the capture claim only *narrows* what anon may do. |
| Write outside its storage folder | `scans_insert_phone` compares `foldername(name)[2]` with the session id from the token. |
| Steal the token from the phone | Worst case is 15 minutes of writing photos into one session the attacker cannot read back. Blast radius is one room's scan queue. Desktop can revoke instantly with `action:"close"`. |

Residual risks we accept: (1) a shoulder-surfed QR within the TTL can inject
photos into that one session — mitigated by the visible live thumbnail strip, the
desktop can see and close it; (2) mildly abusive image content is possible, so
storage objects should get an upload-time size/MIME check at the CDN edge.

---

## 5. Flows

### 5.1 QR phone capture (SPEC §6)

```
DESKTOP                          EDGE                        DB                     PHONE
   |                              |                           |                       |
   |-- capture-session create --->|-- create_capture_session ->|                       |
   |<-- {code, capture_url, id} --|   (code, TTL 15m, max 40)  |                       |
   |                              |                           |                       |
   | render QR of /capture/{code} |                           |   scans QR ---------->|
   |                              |<---------- claim(code) -------------------------- |
   |                              |-- claim_capture_session -->|                       |
   |                              |   mint anon JWT (15m,      |                       |
   |                              |   INSERT scan_assets only) |                       |
   |                              |----------- {capture_token, upload_prefix} ------->|
   |                              |                           |                       |
   |   [Realtime: scan_assets, session_id=eq.<id>]            |<-- Storage PUT --------|
   |                              |                           |<-- INSERT scan_assets -|
   |<========= INSERT event: thumbnail appears live ===========|                       |
   |                              |                    trg_scan_assets_count:          |
   |                              |                    open->claimed, +1, close at 40  |
   |-- capture-session close ---->|-- close_capture_session -->|                       |
```

The desktop subscription, verbatim (`apps/web/lib/supabase.ts`):

```ts
const channel = db
  .channel(`capture:${sessionId}`)
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'scan_assets',
        filter: `session_id=eq.${sessionId}` },
      (payload) => addThumbnail(payload.new as ScanAsset))
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'capture_sessions',
        filter: `id=eq.${sessionId}` },
      (payload) => setSession(payload.new as CaptureSession))
  .subscribe((status) => console.log('realtime', status));

// or simply:
const channel = subscribeToCaptureSession(db, session.id, {
  onAsset: (a) => setThumbs((t) => [...t, a]),
  onSessionChange: (s) => { if (s.status === 'closed') channel.unsubscribe(); },
});
```

The `filter` is applied **server-side**, so rows from other sessions are never
delivered to this client — Realtime also honours RLS, so a client that could not
`select` the row cannot receive it either.

### 5.2 Reconstruction + credits (SPEC §6)

```
client --> recon-submit ----------------------------------------------.
              | verify project ownership                              |
              | create_recon_job()  ── single transaction ──┐          |
              |     insert recon_jobs (status=queued)       |          |
              |     deduct_credits(owner, 1, 'recon_job')   |          |
              |       -> lock profile row, sum ledger,      |          |
              |          raise INSUFFICIENT_CREDITS (402)   |          |
              |          => job insert rolls back too       |          |
              |                                            <┘          |
              | provider.createRoomFromImages() -> provider_job_id      |
              | provider throws? -> apply_recon_result(failed)          |
              |                     -> 'job_failed_refund' row          |
              '-->  { job, balance }                                    |
                                                                       |
provider / poll --> recon-webhook (per-job secret or shared secret)     |
              | apply_recon_result(job, status, progress, result)        |
              |   terminal states are idempotent (repeat = no-op)        |
              |   status=succeeded + result.room -> INSERT/UPDATE rooms  |
              |   status=failed -> append refund row                     |
              '-->  { job, room_written }                                |
```

* Credits are deducted **only** on `recon_jobs` creation. Using a catalog item is
  free, forever.
* `credits_ledger` is the source of truth; `profiles.credits` is a trigger-maintained
  cache and `credit_balances` is the view the UI reads
  (`balance`, `credits_saved`, `dedupe_hits`).
* `credits_ledger_recon_once` (unique index where `reason = 'recon_job'`) makes the
  deduction idempotent per job.

### 5.3 Credit-saving dedupe (SPEC §5.4)

```
upload photo --> identify-upload
   | identifyUpload(): pHash (DCT) + 512-d embedding + archetype guess
   | insert user_items (status=pending)
   | match_catalog_items(embedding, phash)  <- pgvector ivfflat, cosine, published only
   |
   |-- top similarity >= 0.86  (or phash distance <= 6)
   |     * NO credit spent, NO 3D generation
   |     * dedupe_gate_user_item(): user_items.status='matched', matched_item_id set
   |     * credits_ledger { delta: 0, reason: 'dedupe_saved', saved: 1 }
   |     * return modal:
   |         "Is this the same as {{match.name}}?"
   |         [Yes, use the catalog piece] [No, it's different — generate mine] [Browse]
   |
   '-- below threshold
         * status stays 'pending', credit_cost = 1
         * promote_clusters_to_moderation() runs: any neighbourhood at cosine >= 0.9
           with >= 5 DISTINCT owners is written into moderation_queue (state='new')
         * client may then call recon-submit(kind='object_from_images') — that is
           where the credit is actually spent
```

"Credits saved" is reportable straight from the ledger:

```sql
select credits_saved, dedupe_hits from credit_balances where owner = $1;
```

Admin promotion path: `moderation_queue` review →
`promote_cluster_to_catalog(cluster_id, new_catalog_id, …)` inserts a
`catalog_items` row with `published = false` (human QA gate), marks the cluster
`promoted` and repoints every member's `matched_item_id`.

---

## 6. Provider swap (SPEC §5.5)

```
RECON_PROVIDER=mock    # default: timer-driven, no key, plausible Room per §4.4
RECON_PROVIDER=meshy   # + MESHY_API_KEY
```

Both satisfy the same four-method interface, checked at construction time in
`services/recon/index.js`. Nothing above the adapter knows which one is live.
Meshy has no blueprint endpoint, so `createRoomFromBlueprint` delegates to
`cfg.blueprintProvider` (set `RECON_BLUEPRINT_PROVIDER=mock`) rather than
silently returning garbage. `RECON_ROOM_FIT=bbox` turns a Meshy mesh bounding box
into a rectangular Room shell; `raw` returns `mesh_url` + `dims_mm` only.

---

## 7. Files

```
supabase/migrations/0001_init.sql        12 tables, enums, 32 indexes, triggers, view
supabase/migrations/0002_rls.sql         RLS + 30 policies + storage policies
supabase/migrations/0003_functions.sql   credits, dedupe, clustering, sessions
supabase/functions/recon-submit/         start job + deduct credit
supabase/functions/recon-webhook/        provider callback / poll -> Room
supabase/functions/identify-upload/      pHash + embedding + match + credit gate
supabase/functions/capture-session/      create | claim | status | close
supabase/functions/_shared/              cors.ts, supabase.ts (clients + token mint)
services/recon/{index,mock,meshy}.js     provider-agnostic adapter
services/vision/{index,phash}.js         identifyUpload / findMatches / clustering
apps/web/lib/supabase.ts                 typed client + Realtime snippets
apps/web/lib/api.ts                      typed API surface for the frontend
apps/web/app/api/**                      Next.js mirrors of all four edge functions
tools/validate_schema.py                 schema/RLS validator (pglast)
tests/                                   harness + vision + recon suites
```

`NEXT_PUBLIC_API_MODE=local` routes `apps/web/lib/api.ts` at the Next.js handlers
(no Deno needed for development); `edge` routes it at the deployed functions. The
request/response contracts are identical.

---

## 8. What was verified, and how

```
python3 tools/validate_schema.py     # 0 errors, 0 warnings
node tests/run_all.mjs               # 25 vision + 15 recon assertions, 0 failures
```

* **SQL syntax** — all three migrations are parsed with `pglast` (libpg_query, the
  real PostgreSQL grammar): 72 + 97 + 31 = 200 top-level statements accepted.
* **Structure** — all 12 SPEC §6 tables exist with every specced column plus
  `id`/`created_at`; 139 columns; all 18 foreign keys resolve to a real
  table+column (`auth.*` / `storage.*` targets excluded); 32 indexes; 30 functions;
  5 triggers.
* **RLS** — every table has `enable` **and** `force` RLS and ≥ 1 policy;
  `catalog_items` anon read is gated on `published = true`; every
  `moderation_queue` policy contains `auth_is_admin()`; `credits_ledger` has no
  write policy and does have the append-only trigger; the `scan_assets` anon
  policy is INSERT-only and contains the session scope, the TTL check and the
  40-asset cap.
* **Dedupe maths** — synthetic embeddings constructed to land on exact cosine
  values prove the gate: 0.8599 → charge 1 credit, 0.8600/0.8601 → gated with
  `credit_cost = 0` and the modal payload. Real images: identical photo → phash
  distance 0; same sofa shifted + brightened → cosine 0.956 (gated); rescaled copy
  → 0.997; sofa vs floor lamp → 0.049 (charged). Unpublished catalog rows are
  never returned.
* **Clustering** — 4 distinct users → no moderation row; 5 → one cluster of size 5;
  5 uploads from one user → nothing; cohort at cosine 0.85 → nothing.
* **Mock provider** — job walks `queued → running → succeeded` with monotonic
  progress, terminal states are sticky, failure path emits `MOCK_RECON_FAILED`,
  blueprint jobs report `source='blueprint'`, object jobs return a proxy mesh +
  integer `dims_mm`, and **200 generated Rooms** were validated against SPEC §4.4
  (integer mm, origin at bbox min, CCW winding, exactly one door + one window,
  openings inside their wall, window head under the ceiling, valid feature types).
  Same seed ⇒ identical Room.

Known gaps, stated plainly:

1. **No live Postgres execution.** `apt-get` is unavailable and pgvector cannot be
   installed into `pgserver`, so the migrations were validated with the real
   PostgreSQL *parser* plus structural assertions, not by being applied to a
   running server. Run `supabase db push` once before trusting the runtime
   behaviour of the triggers.
2. **JPEG support is DC-only.** `decodeJpegDc()` decodes baseline JPEG DC
   coefficients (one luma sample per 8×8 block) — enough for a stable pHash, and
   it needs no dependencies, but a JPEG and a PNG of the same scene differ by
   ~10 bits of phash, so cross-format matching relies on the embedding. Progressive
   JPEGs are rejected with a clear error; transcode upstream.
3. **The embedding is a local descriptor, not CLIP.** It is deterministic,
   contrast-normalised and discriminative enough for the 0.86 gate on real photos,
   but a hosted encoder will do better on cluttered scenes. Swap it by passing
   `embedder` to `identifyUpload()` (`VISION_EMBEDDER=remote`); the contract and
   the 512-d width are unchanged, but the catalog must be re-embedded.
4. **`tools/seed_catalog.mjs` is not included** — the catalog JSON is Deliverable E's
   artifact; §1 above gives the exact five-line upsert.

# ainterior — Canonical Build Spec v1

> **This file is the single source of truth.** Every module must conform to the contracts below.
> If a contract is ambiguous, implement the literal reading here and note the assumption in a
> `// SPEC-ASSUMPTION:` comment. Do NOT invent alternate field names, units, or axes.

---

## 0. Product in one paragraph

ainterior turns a real room into an editable 3D space. Users capture photos (desktop or via QR →
phone) or upload a blueprint; we reconstruct a dimensionally-accurate 3D shell. They add furniture
they already own (photo upload) and/or pick from a real catalog with true dimensions. Then either
the AI arranges the room (multiple candidate layouts, re-rollable) or they arrange it themselves in
a 3D editor with real collision + clearance feedback. Output: an annotated blueprint (named
furniture + dimension chains + FF&E schedule) and rendered views.

**Differentiator:** a manipulable 3D space with real furniture at real dimensions and AI assistance
— not a hallucinated image of a room that doesn't exist and can't be edited.

**Segments:** real-estate stagers · new homeowners/renters · students · hospitality &
commercial (multi-room portfolios, FF&E schedules).

---

## 1. Units & coordinate systems — NON-NEGOTIABLE

| Concern | Rule |
|---|---|
| Storage & all data files | **millimetres, integers** (`dims_mm`, `x_mm`, `width_mm`) |
| Three.js scene | **metres, floats** (`mm / 1000`) |
| Plan coordinates | `x` → right, `y` → "up the page" (plan north). Origin = room bbox min corner |
| Three.js mapping | `three.x = plan.x/1000`, `three.z = -plan.y/1000`, `three.y` = elevation |
| Rotation | `rot_deg`, degrees, **CCW positive** about the vertical axis, `0` = item's depth axis faces plan +y |
| Item local frame | width along local x, depth along local y, height along elevation. Origin = **footprint centre** |
| Display | user-toggleable cm / mm / ft-in. Never store display units |

Conversion helpers live in `packages/core/units.js` — `mm2m`, `m2mm`, `fmtLen(mm, unit)`.

---

## 2. Design system (authoritative tokens)

Concept: **"blueprint meets plaster."** Warm architectural neutrals for the human/interior side,
technical blue for the AI/measurement side. The tension between those two IS the brand.

```
--ink:        #0B0B0C   /* near-black base            */
--surface:    #121215
--surface-2:  #1A1A1E
--surface-3:  #232329
--line:       rgba(255,255,255,.09)
--line-2:     rgba(255,255,255,.16)
--bone:       #F5F2ED   /* warm plaster off-white     */
--bone-dim:   #C9C4BB
--muted:      #8A8A93
--clay:       #DC6B47   /* warm accent: human, interior, CTA */
--clay-dim:   #A94E31
--blueprint:  #3B6EF6   /* technical accent: AI, dimensions, measurement */
--blueprint-dim: #2A4FB8
--ok:         #4FA97C
--warn:       #E0A33C
--err:        #E05B4A
```

**Type**
- Display: `"Instrument Serif", Georgia, serif` — **italic only**, for emphasis words inside headlines.
- UI/Body/Headline: `"Inter Tight", "Inter", system-ui, sans-serif`.
- Mono/technical (dimensions, SKUs, coordinates): `"JetBrains Mono", ui-monospace, monospace`.
- Headline style: tight tracking (`-0.03em`), `clamp()` sizing, mixed-weight — sans for the main
  words, *serif italic* for the emphasis word. e.g. `Design your room in *real* dimensions`.
- Eyebrow labels: mono, 11px, `letter-spacing:.14em`, uppercase, `--muted`.

**Motion vocabulary** (borrowed from the two references, do not skip these)
1. **Splash logo blur-reveal** — on first load: logo scales 1.06→1, `filter: blur(14px)→0`, opacity
   0→1, then the mask wipes up. ~1100ms, `cubic-bezier(.16,1,.3,1)`. Runs once per session
   (`sessionStorage`), and is skipped entirely under `prefers-reduced-motion`.
2. **Liquid-glass nav** — `backdrop-filter: blur(20px) saturate(180%)`, 1px top highlight
   (`inset 0 1px 0 rgba(255,255,255,.14)`), shrinks + gains border on scroll past 40px.
3. **Blur reveal on scroll** — `IntersectionObserver`; elements enter with
   `opacity 0→1, translateY(24px)→0, filter blur(10px)→0`, staggered 60ms by index.
4. **Numbered scroll chapters** — `01 / 02 / 03 / 04` big mono numerals, sticky left column,
   content scrolls beside it (SharpLink's "Pioneering Productivity" pattern).
5. **Live data tiles** — count-up numbers on reveal, mono, with an eyebrow label above.
6. **Accordion propositions** — one open at a time, smooth `grid-template-rows: 0fr→1fr`.
7. **Magnetic buttons** — translate ≤4px toward cursor; label swaps via clipped dual-span slide.
8. **Footer interaction** — dot-grid that lights up near the cursor + oversized wordmark that
   blur-reveals when the footer enters view.
9. **Marquee** — slow, seamless, pauses on hover.

Accessibility: every animation must no-op under `@media (prefers-reduced-motion: reduce)`.
All interactive elements keyboard-reachable with a visible `--blueprint` focus ring.

**Responsiveness:** artifact panel ranges 400px → desktop. No fixed pixel widths on containers.
Tailwind utilities for layout; bespoke CSS only for the motion/effects above.
Dark is the primary aesthetic — use `dark:` variants and ensure light mode is also correct.

---

## 3. Repo layout

```
ainterior/
  README.md  ARCHITECTURE.md  SPEC.md  .env.example
  packages/
    core/            units.js  geometry.js  types.d.ts
    catalog/         catalog.json  schema.json  archetypes.json  importer/  seed.sql
    layout-engine/   index.js  rules.js  solver.js  scoring.js  augment.js  tests/
    blueprint/       index.js  svg.js  schedule.js  dimensions.js
    three-editor/    editor.js  room.js  proxies.js  gizmo.js  controls.js  collision.js
  apps/web/          Next.js 15 app router (marketing + app + api)
  supabase/          migrations/*.sql  functions/*  policies.sql
  services/vision/   dedupe (pHash + embedding adapter)
  demo/              self-contained static demo (index.html, editor.html, ...)
```

---

## 4. Data contracts

### 4.1 CatalogItem (`packages/catalog/catalog.json` is `{version, items: CatalogItem[]}`)

```jsonc
{
  "id": "ikea-ektorp-3s",             // kebab, stable, unique
  "brand": "IKEA",
  "name": "EKTORP",
  "product_type": "3-seat sofa",
  "sku": "302.383.65",                 // null if unknown
  "category": "seating",               // see 4.2
  "archetype": "sofa_3seat",           // see 4.3 — drives 3D proxy + layout rules
  "dims_mm": { "w": 2180, "d": 880, "h": 880 },
  "seat_h_mm": 450,                    // seating/beds only, else null
  "footprint": "rect",                 // "rect" | "round" | "L"
  "l_shape_mm": null,                  // {notch_w, notch_d} when footprint==="L"
  "clearance_mm": { "front": 750, "back": 50, "left": 100, "right": 100 },
  "placement": {
    "against_wall": true,              // prefers a wall
    "wall_offset_mm": 40,              // gap when against a wall
    "corner_ok": false,
    "center_ok": false,
    "needs_wall_len_mm": 2280,         // usually w + small margin
    "stackable": false,
    "wall_mounted": false,             // hangs on wall; y offset from mount_h_mm
    "mount_h_mm": null,
    "ceiling_mounted": false
  },
  "colorways": [{ "name": "Totebo light beige", "hex": "#D8D2C4" }],
  "price_usd": 599,
  "url": "https://www.ikea.com/us/en/p/ektorp-...",
  "tags": ["living-room", "upholstered", "family"],
  "proxy": {                            // primitive parts, item-local mm, y-up from floor
    "parts": [
      { "shape": "box", "pos": [0,0,220], "size": [2180,880,440], "color": "body",  "radius": 40 },
      { "shape": "box", "pos": [0,-380,620], "size": [2180,120,400], "color": "body", "radius": 30 }
    ]
  }
}
```

`proxy.parts[].shape` ∈ `box | cyl | sphere | plane`.
`pos` is `[x, y, z]` in the item-local plan frame where `z` = elevation, origin at footprint
centre on the floor. `color` ∈ `"body" | "wood" | "metal" | "glass" | "fabric" | "dark" | "#RRGGBB"`.
`radius` = optional corner rounding in mm.

### 4.2 Categories
`seating · tables · beds · storage · desks · lighting · rugs · decor · appliance · outdoor · kids`

### 4.3 Archetypes (closed set — 3D proxies and layout rules both switch on these)
```
sofa_2seat sofa_3seat sofa_sectional_l loveseat armchair ottoman bench chaise
dining_chair office_chair stool bar_stool
bed_single bed_double bed_queen bed_king crib
nightstand dresser wardrobe bookcase shelf_unit sideboard cabinet tv_bench storage_box
coffee_table side_table dining_table_rect dining_table_round desk console_table kitchen_island
rug floor_lamp table_lamp pendant_lamp wall_lamp
tv art_frame mirror plant curtain wall_shelf
monitor appliance rack cushion bike curtain_rod string_lights
```

> The final line was added in v2 alongside the ainterior generic range (SPEC2 §I2): brand-agnostic
> monitors, small appliances, racks/stands, floor cushions, bicycles, curtain rods and string lights
> had no honest home in the original set. `packages/catalog/archetypes.json` and the catalog
> validator derive from the same source, so all three stay in step.

### 4.4 Room

```jsonc
{
  "id": "room_a1",
  "name": "Living room",
  "polygon_mm": [[0,0],[4200,0],[4200,3600],[0,3600]],  // CCW, closed implicitly
  "height_mm": 2600,
  "openings": [
    { "id":"d1", "type":"door",   "wall_index":0, "offset_mm":300, "width_mm":900,
      "height_mm":2040, "sill_mm":0,   "swing":"in-left" },
    { "id":"w1", "type":"window", "wall_index":2, "offset_mm":1200, "width_mm":1600,
      "height_mm":1400, "sill_mm":800, "swing":null }
  ],
  "features": [
    { "id":"f1", "type":"radiator", "wall_index":2, "offset_mm":1300, "width_mm":1400, "depth_mm":120 }
  ],
  "source": "photogrammetry" | "blueprint" | "manual",
  "confidence": 0.0
}
```
`wall_index` i = the edge from `polygon_mm[i]` to `polygon_mm[(i+1) % n]`.
`offset_mm` = distance from that wall's start vertex to the opening's **near edge**.
`feature.type` ∈ `radiator · column · fireplace · stair · niche · tv_outlet · vent`.

### 4.5 Placement / Layout

```jsonc
{
  "id": "layout_3",
  "seed": 84213,
  "mode": "use-mine" | "augment",
  "style": "neutral" | "cozy" | "minimal" | "family" | "wfh" | "entertain",
  "score": 0.87,
  "placements": [
    { "instance_id":"i1", "item_id":"ikea-ektorp-3s", "x_mm":2100, "y_mm":420,
      "rot_deg":0, "colorway":0, "against":{"wall_index":0}, "locked":false, "added_by_ai":false }
  ],
  "rationale": ["Sofa anchored to the long wall facing the window for the best sightline."],
  "violations": [ { "severity":"warn", "code":"WALKWAY_TIGHT", "message":"...", "instance_ids":["i1"] } ],
  "metrics": { "walkway_min_mm": 780, "coverage": 0.41, "balance": 0.72 }
}
```

### 4.6 Violation codes (closed set)
`OVERLAP · CLEARANCE · WALKWAY_TIGHT · BLOCKS_DOOR · BLOCKS_WINDOW · BLOCKS_RADIATOR ·
OUT_OF_BOUNDS · NO_WALL_SUPPORT · TV_TOO_CLOSE · TV_TOO_FAR · UNREACHABLE · FLOATING`
Severity ∈ `error | warn | info`.

---

## 5. Module interfaces

### 5.1 `packages/layout-engine`

```js
// Pure, deterministic given the same seed. No DOM, no network, no deps.
solveLayouts({
  room,               // Room (4.4)
  items,              // [{ item_id, qty, locked_placement? }]
  catalog,            // Map<item_id, CatalogItem>
  mode,               // "use-mine" | "augment"
  style,              // see 4.5
  seed,               // int — same seed ⇒ identical output
  count               // how many candidate layouts to return (default 3)
}) => Layout[]        // sorted by score desc

scoreLayout({ room, layout, catalog }) => { score, metrics, violations }
validatePlacement({ room, layout, catalog, instance_id }) => Violation[]   // live editor feedback
suggestAdditions({ room, layout, catalog, style, seed }) => [{ item_id, reason }]
```

**Rules the solver must actually enforce** (this is the product's credibility):
- Primary walkway ≥ **900mm**; secondary ≥ **760mm**; never below **600mm** (that's an `error`).
- Door swing arcs kept clear; a 900mm-deep entry apron in front of every door.
- Coffee table **350–450mm** from the sofa's front edge.
- TV viewing distance **1.6×–2.5×** the diagonal; TV centre **1000–1150mm** off the floor.
- Dining: **1100mm** of pull-out+circulation behind each occupied chair edge; **600mm** of table
  edge per seat.
- Bed: ≥ **700mm** on both access sides for doubles+; headboard against a wall; not centred under
  an openable window when avoidable.
- Rugs sit **under** the primary seating group and must overlap the sofa's front legs by
  **≥ 200mm**; never rendered as a collider.
- Nothing blocks a radiator, a window below **1100mm** sill, or a vent.
- Wall-hung and ceiling items are excluded from floor collision but must not intersect openings.
- Deterministic re-roll: `seed+1, seed+2, …` yields materially different, still-valid layouts.

### 5.2 `packages/blueprint`

```js
renderBlueprint({
  room, layout, catalog,
  opts: { unit:"mm"|"cm"|"ft", scale:"fit"|number, paper:"A3"|"A4"|"Letter",
          show:{ dimensions:true, names:true, schedule:true, northArrow:true,
                 scaleBar:true, titleBlock:true, clearances:false },
          title, project, author, date }
}) => string   // standalone SVG, no external refs, embedded fonts-as-system-stack

renderSchedule({ layout, catalog }) => { rows:[{tag,qty,brand,name,dims,sku,price}], total }
```
Requirements: every placed piece gets a **tag** (`A1, A2, B1…` grouped by category) drawn inside or
leader-lined outside its footprint, plus its name. Overall + per-wall dimension chains. Openings
drawn properly (door swing arc, window mullion). Hatched walls. Legend + FF&E schedule table +
title block. Must be print-clean in pure black/white and remain legible at A4.

### 5.3 `packages/three-editor`

```js
const editor = createEditor({ mount, room, catalog, layout, unit:"cm", onChange, onSelect, onViolations });
editor.setRoom(room); editor.setLayout(layout); editor.getLayout();
editor.add(item_id, {x_mm,y_mm,rot_deg});  editor.duplicate(instance_id);
editor.remove(instance_id); editor.select(instance_id);
editor.setMode("translate"|"rotate"|"scale-none");
editor.setView("3d"|"top"|"first-person"); editor.setUnit("mm"|"cm"|"ft");
editor.snapshot({ width, height }) => dataURL;   // for renders
editor.dispose();
```
Behaviour: drag on the floor plane to translate (grid snap 10mm, wall snap ≤120mm, edge-align to
neighbours), rotate ring with 15° snapping (Shift = free), `Ctrl/Cmd+D` duplicate, `Del` remove,
`Esc` deselect, undo/redo ≥30 steps. Live dimension HUD on the selected item (w×d×h + distances to
the two nearest walls). Colliding items tint `--err` at 35%; clearance envelopes render as
`--blueprint` dashed footprints when enabled. Orbit/pan/zoom, clamped so the camera can't go under
the floor. Walls fade out when the camera looks through them from outside.

### 5.4 Vision / dedupe (`services/vision`)

```js
identifyUpload({ imageBytes }) => {
  labels:[{name,confidence}], archetype_guess, dims_estimate_mm?,
  phash, embedding:Float32Array(512)
}
findMatches({ embedding, phash, catalog }) => [{ item_id, similarity, reason }]
```
**Credit-saving flow (explicit product requirement):** on user furniture upload, run
`identifyUpload` → `findMatches`. If top `similarity ≥ 0.86`, **block the expensive 3D generation**
and show the modal:

> **Is this the same as *{{match.name}}*?**
> It looks like a piece already in our catalog — using ours keeps your credits and gives you exact
> dimensions.
> `[ Yes, use the catalog piece ]  [ No, it's different — generate mine ]  [ Browse the catalog ]`

If the user proceeds, the upload enters `moderation_queue`. When ≥ `MATCH_PROMOTION_THRESHOLD` (5)
distinct users upload pieces that cluster together (cosine ≥ 0.9), the cluster is flagged for
manual review to be promoted into the public catalog.

### 5.5 3D reconstruction adapter (`services/recon`)

Provider-agnostic. `MOCK` is the default and must be fully functional with **no API key**.

```js
createReconProvider(kind /* "meshy" | "mock" */, cfg) => {
  createRoomFromImages({ images, hints }) => { job_id }
  createRoomFromBlueprint({ file, scale_hint }) => { job_id }
  createObjectFromImages({ images, name }) => { job_id }
  getJob(job_id) => { status:"queued"|"running"|"succeeded"|"failed",
                      progress:0..1, result?:{ room?|mesh_url?|dims_mm? }, error? }
}
```
The mock progresses jobs on a timer and returns a plausible `Room` (rectangular-ish with a door and
a window) or a proxy mesh + estimated dims, so the entire flow is demoable end-to-end offline.

---

## 6. Supabase data model

Tables (all with `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`):

| table | key columns |
|---|---|
| `profiles` | `user_id→auth.users`, `display_name`, `role` (`user\|pro\|admin`), `plan`, `credits` |
| `projects` | `owner→profiles`, `name`, `kind` (`residential\|staging\|hospitality\|student`), `archived` |
| `rooms` | `project_id`, `name`, `polygon_mm jsonb`, `height_mm`, `openings jsonb`, `features jsonb`, `source`, `confidence` |
| `capture_sessions` | `project_id`, `code` (short, unguessable), `status`, `expires_at`, `claimed_by` |
| `scan_assets` | `session_id`, `room_id`, `storage_path`, `kind` (`photo\|blueprint`), `exif jsonb`, `width`, `height` |
| `recon_jobs` | `room_id`, `provider`, `provider_job_id`, `status`, `progress`, `result jsonb`, `error` |
| `catalog_items` | mirrors §4.1, `embedding vector(512)`, `phash text`, `published bool` |
| `user_items` | `owner`, `name`, `archetype`, `dims_mm jsonb`, `storage_path`, `embedding vector(512)`, `phash`, `status` (`pending\|matched\|approved\|rejected`), `matched_item_id` |
| `moderation_queue` | `user_item_id`, `cluster_id`, `cluster_size`, `state` (`new\|reviewing\|promoted\|rejected`), `reviewer`, `notes` |
| `layouts` | `room_id`, `seed`, `mode`, `style`, `score`, `placements jsonb`, `rationale jsonb`, `metrics jsonb`, `is_user_edited` |
| `renders` | `layout_id`, `kind` (`blueprint_svg\|blueprint_pdf\|render_png`), `storage_path` |
| `credits_ledger` | `owner`, `delta`, `reason`, `ref_id` — append-only, `credits` is a view/trigger sum |

**RLS on every table.** Owner-scoped read/write; `catalog_items` is world-readable where
`published = true`; `moderation_queue` is admin-only. `capture_sessions` are readable by
short-lived anon token so a phone can post into one without logging in — the phone may **INSERT
into `scan_assets` only**, scoped to a non-expired session, and can never read other rows.

**QR phone-capture flow:** desktop creates a `capture_session` → renders QR of
`/capture/{code}` → phone opens it, uploads straight to Storage → row lands in `scan_assets` →
desktop is subscribed via Supabase Realtime on `session_id` and the thumbnails appear live.
Session TTL 15 min, max 40 assets, then auto-closes.

**Credits:** deduct on `recon_jobs` creation, never on catalog use. `credits_ledger` is the source
of truth. Dedupe hits are logged with `reason='dedupe_saved'` and `delta=0` so we can report
"credits saved" back to the user.

---

## 7. Deliverable definitions

**A — Marketing site** (`demo/` root): dark editorial one-pager, all 9 motion patterns, sections:
splash → hero → live stat tiles → 4 numbered chapters (the customer journey) → differentiator
comparison (us vs. image-generators) → segments (4) → accordion propositions → catalog marquee →
pricing (Free / Pro / Studio) → FAQ → footer interaction. CTA routes into the demo app.

**B — 3D editor demo** (`demo/editor.html`): the real editor over the real catalog, with the
catalog browser, AI-layout panel (re-roll, style, augment toggle), violation list, unit toggle,
blueprint export preview, and snapshot render.

**C — Layout engine + blueprint** as specced in 5.1 / 5.2, with tests.

**D — Backend**: migrations, RLS, edge functions, recon adapter, dedupe, QR pairing, typed client.

**E — Catalog**: ≥ 100 real IKEA items, verified dimensions, full `proxy` geometry, importer + seed.

---

## 8. Hard constraints for every agent

1. **No build step in `demo/`.** Plain ES modules + CDN. It must open from `file://` or a static host.
2. Three.js pinned: `https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js`
   (plus `examples/jsm/controls/OrbitControls.js` from the same version).
3. Tailwind pinned exactly as the scaffold emits it. Do not swap to `@latest`.
4. Separate files: `index.html` / `styles.css` / `app.js`. No inlined CSS or JS blobs.
5. No purple/rainbow gradients. Use the §2 tokens only.
6. Every animation respects `prefers-reduced-motion`.
7. Layout engine and blueprint packages must be **dependency-free and DOM-free** so they run in
   both the browser demo and Node tests.
8. Real dimensions only. Never invent a measurement to make a layout work — if it doesn't fit, emit
   a violation.
9. Ship working code over placeholders. No `TODO` stubs on the critical path.

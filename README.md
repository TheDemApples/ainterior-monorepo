# ainterior

**A manipulable 3D space with real furniture at real dimensions, and AI that respects the tape measure.**

ainterior turns a real room into an editable 3D space. Capture photos (desktop, or scan a QR code and
shoot with your phone) or upload a blueprint; we rebuild a dimensionally-accurate 3D shell. Add
furniture you already own by photographing it, and/or pick from a catalog of real products with true
dimensions. Then either let the AI arrange the room — several candidate layouts, re-rollable — or
arrange it yourself in a 3D editor with live collision and clearance feedback. Ship an annotated
blueprint (named furniture, dimension chains, FF&E schedule) and rendered views.

### The differentiator

Other AI interior tools generate a *picture* of a room that does not exist: no real products, no real
dimensions, not editable, not buyable. ainterior gives you a real 3D space containing real furniture
at its real size, and the AI's suggestions obey actual clearance and walkway standards. If something
does not fit, we say so — we never shrink a sofa or overlap two pieces to make a layout look good.

---

## What's in here

| Path | What it is |
|---|---|
| `demo/` | **Runnable, no build step.** `index.html` = marketing, `design.html` = floorplan designer, `editor.html` = the 3D studio. |
| `packages/floorplan/` | Multi-room floorplan model, validation, presets, and `floorplanToShell` |
| `packages/catalog/` | 201 real IKEA products, mm-accurate, with procedural 3D proxy geometry |
| `packages/layout-engine/` | The AI layout solver — constraint-based, deterministic, dependency-free |
| `packages/blueprint/` | Annotated floor-plan SVG + FF&E schedule generator |
| `packages/three-editor/` | The 3D editor core (Three.js), collision, gizmos, plan/3D/walk views |
| `supabase/` | Migrations, RLS policies, SQL functions, Edge Functions |
| `services/recon/` | Provider-agnostic photo/blueprint → 3D adapter (**mock works with no API key**) |
| `services/vision/` | Perceptual hash + embedding dedupe — the credit-saving path |
| `apps/web/` | Next.js typed client + API route mirrors for local dev |
| `tests/` | Cross-package integration, vision, recon suites |
| `tools/` | Schema validator, demo browser verification, catalog module generator |
| `SPEC.md` | The canonical contract every module conforms to |
| `SPEC2.md` | Addendum v2: input model, gizmo, picking, camera, bounds, realism, designer |

## Run the demo

```bash
# any static server; or just open demo/index.html from the filesystem
python3 -m http.server 8000
# → http://localhost:8000/demo/index.html   (marketing)
# → http://localhost:8000/demo/design.html  (floorplan designer — presets or build your own)
# → http://localhost:8000/demo/editor.html  (the 3D studio)
```

The intended path is **marketing → designer → studio**. The designer hands off through
`localStorage['ainterior.floorplan.handoff']` plus `editor.html?plan=handoff`; the contract is in
`packages/floorplan/README.md`.

No install, no bundler. Three.js and Tailwind come from pinned CDN URLs. The catalog ships as an ES
module (`demo/catalog-data.js`) rather than fetched JSON specifically so `file://` works too.

## Run the tests

```bash
node packages/layout-engine/tests/run.js      # 49 — solver rules & invariants
node tests/integration.mjs                    # 20 — catalog x engine x blueprint
node tests/run_all.mjs                        # 40 — vision dedupe + recon lifecycle
node packages/catalog/importer/validate.js    # catalog schema + semantic checks
python3 tools/validate_schema.py              # SQL: tables, FKs, RLS coverage
python3 tools/verify_demo.py                  # 29 — real browser E2E (Playwright)
```

All green as of this commit. `tools/verify_demo.py` drives a real Chromium: it asserts zero console
errors, exercises the editor API, runs an AI layout over the full catalog, generates a blueprint, and
screenshots at 400 / 900 / 1440px.

## Backend setup

```bash
cp .env.example .env          # documented; the recon mock needs no keys
supabase db push              # applies migrations 0001 → 0003 in order
node packages/catalog/importer/validate.js && psql < packages/catalog/seed.sql
```

See `BACKEND.md` for the auth model, the RLS threat model for anonymous phone uploads, and flow
diagrams.

## Studio controls

| Input | 3D | Plan | Walk |
|---|---|---|---|
| Left click | select only | select only | — |
| Left drag on a gizmo handle | move / rotate | move / rotate | — |
| Right drag | orbit (never selects) | pan | look |
| Middle drag | pan — **drag down moves forward** | pan | — |
| Wheel | zoom to cursor | zoom to cursor | — |
| `Ctrl` + drag | free transform (no snapping) | same | — |
| `Shift` / `Ctrl` or `C` | — | — | sprint / crouch |

Selection gets an explicit gizmo: three axis arrows, a planar floor handle for everyday 2D moves,
and three rotation rings. It stays a constant ~110px on screen at any zoom, and drags are computed
projectively from a fixed anchor, so the piece tracks the pointer instead of shaking. Snapping is
10mm / 15°; hold `Ctrl` to bypass. Furniture cannot leave the floor polygon — it slides along walls
and snaps flush within 120mm.

**Graphics tiers.** The realism layer (PBR maps, IBL environment, soft shadows) costs roughly 5x the
frame time of flat materials — irrelevant on a GPU, decisive on a software rasteriser. The studio
measures actual frame pacing on load (time-bounded, so a slow machine reports slow immediately) and
steps down to `medium` (no shadows) or `low` (no shadows or environment, pixel ratio 1). Override it
with the **graphics** control in the toolbar; the choice persists.

## How the AI layout actually works

Not a language model, and not random jitter — a seeded constraint solver, so it is reproducible and
explainable:

1. **Analyse the room** — find the focal wall (longest uninterrupted run, or the wall opposite the
   main window), locate door aprons, windows, radiators.
2. **Anchor** — place the primary piece (sofa / bed / desk, depending on what you gave it).
3. **Attach dependents** — coffee table 350–450mm off the sofa, rug overlapping the sofa's front legs
   by ≥200mm, TV at 1.6–2.5× diagonal viewing distance, nightstands flanking the bed.
4. **Fill, then repair** — place secondary pieces, then measure walkways with a distance-field
   widest-path search and relocate whatever pinches the route.
5. **Score and rank** — walkway quality, visual balance, focal coherence, wall utilisation,
   conversation tightness, coverage. Error-severity violations apply a multiplicative penalty so a
   layout that fails to fit your furniture can never out-rank one that fits it all.
6. **Explain** — every candidate returns human `rationale` derived from the decisions actually made,
   plus honest `violations`.

Four strategies (wall-anchored, window-facing, corner-asymmetric, floating-group) each get up to 3
re-seeded attempts, and the best per strategy is returned — so "re-roll" gives genuinely different
*approaches*, not the same approach nudged. Same seed always reproduces the same layout.

## Credit-saving dedupe

Generating 3D from photos costs money, so we avoid it when we already have the piece:

1. User uploads a photo of their furniture.
2. We compute a DCT perceptual hash + an embedding, and search the catalog with pgvector.
3. If the best match is ≥ 0.86 cosine, **we do not spend a credit.** We show:
   *"Is this the same as EKTORP? Using ours keeps your credits and gives you exact dimensions."*
4. If they proceed anyway, the upload enters `moderation_queue`. Once ≥5 distinct users upload pieces
   that cluster at ≥0.9, the cluster is flagged for review and possible promotion into the public
   catalog.

Savings are logged (`reason='dedupe_saved'`, `delta=0`) so we can show users what they didn't spend.

## Known gaps

Honest list; see `CATALOG.md` and `BACKEND.md` for detail.

- **Catalog dimensions are reconstructed from spec-sheet knowledge, not scraped live.** Every item
  carries `dims_confidence` — 57 high / 119 medium / 25 low. The 25 low-confidence rows are the top
  data debt. SKUs are all `null`.
- **No live Postgres run.** Migrations are validated with `pglast` (real PostgreSQL grammar) for
  structure, FK integrity and RLS coverage, but triggers and policies have not been executed.
- **Embeddings are a local deterministic descriptor**, swappable for CLIP via the `embedder` hook.
  JPEG decoding is DC-only.
- **Recon is the mock provider by default.** The Meshy implementation sits behind the same interface;
  add a key and flip the config.
- Extendable/adjustable furniture stores a single state (needs `dims_variants[]`). Modular systems
  (PAX, BESTÅ, KALLAX) ship as fixed sizes, not configurators.
- TV mount height is validated against the 1000–1150mm comfort band but not enforced — it derives
  from catalog `mount_h_mm`, which the solver won't overwrite.

## License / provenance

IKEA product names and dimensions are referenced for interoperability; ainterior is not affiliated
with or endorsed by Inter IKEA Systems B.V.

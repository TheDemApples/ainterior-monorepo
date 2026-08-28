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
| `demo/` | **Runnable, no build step.** `index.html` = marketing site, `editor.html` = the 3D studio. |
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

## Run the demo

```bash
# any static server; or just open demo/index.html from the filesystem
python3 -m http.server 8000
# → http://localhost:8000/demo/index.html   (marketing)
# → http://localhost:8000/demo/editor.html  (the studio)
```

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

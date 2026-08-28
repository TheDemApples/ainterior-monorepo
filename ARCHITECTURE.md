# Architecture

## Shape

```
                    ┌──────────────────────────────────────────┐
   photos / QR ────▶│ services/recon   (mock | meshy)          │
   blueprint    ────│  adapter, identical interface either way │
                    └───────────────┬──────────────────────────┘
                                    │ Room { polygon_mm, openings, features }
                                    ▼
  own furniture ──▶ services/vision ──▶ dedupe gate ──▶ credits_ledger
   (photo)          pHash + embedding    ≥0.86 ⇒ free      (append-only)
                                    │
   catalog ─────────────────────────┤
   201 real items, mm-accurate      ▼
                    ┌──────────────────────────────────────────┐
                    │ packages/layout-engine                   │
                    │  4 strategies × best-of-3 seeded tries   │
                    │  → ranked Layout[] + rationale + violations│
                    └───────┬──────────────────────┬───────────┘
                            │                      │
                            ▼                      ▼
              packages/three-editor        packages/blueprint
              user edits, live validation   annotated SVG + FF&E schedule
```

## Layering rules

- `packages/layout-engine` and `packages/blueprint` are **dependency-free and DOM-free.** They run
  unchanged in the browser demo and in Node tests. Nothing in them imports Three.js or touches
  `document`.
- `packages/three-editor` owns all Three.js. It treats the layout engine as an **optional** injected
  validator (`editor.setValidator`), so the editor still works standalone.
- `packages/catalog` is pure data + validation. Every consumer reads it through the shapes in
  `SPEC.md` §4.1.
- All storage is **millimetres, integers.** Only the Three.js scene works in metres, converted at the
  boundary. See `SPEC.md` §1 — this is the single most important invariant in the codebase.

## Who is authoritative for what

This mattered more than expected during integration:

| Question | Authority | Why |
|---|---|---|
| Is this layout any good? | `layout-engine.scoreLayout` | Multi-factor (walkway, balance, focal, wall use, conversation, coverage). The editor has a crude fallback used only when no engine is wired — it is *not* a design-quality score. |
| What's wrong with this layout? | `layout-engine.validatePlacement` | The editor's collision pass covers the same ground and words it differently; showing both double-reported every conflict. The engine wins, and the editor's pass only drives the red collision tint. |
| How big is this thing? | `packages/catalog` | Never inferred, never rounded to make a layout work. |

## Coordinate system

Plan space: `x` right, `y` up-the-page, origin at room bbox min corner, millimetres.
Three.js: `three.x = plan.x/1000`, `three.z = -plan.y/1000`, `three.y` = elevation.
Rotation: `rot_deg`, CCW positive, `0` = the item's depth axis faces plan `+y`.
Item local frame: width along local x, depth along local y, **origin at the footprint centre.**

## Determinism

`solveLayouts` is pure and seeded. The same `seed` always yields byte-identical output; `seed+1`
re-rolls the *approach*, because the strategy shuffle is itself seeded. This is what makes the user's
"give me another layout" button reproducible and debuggable — a reported bad layout can be replayed
exactly from its seed.

## Failure philosophy

If a piece does not fit, the solver emits an `OUT_OF_BOUNDS` violation and reports it. It never
shrinks a real product, never overlaps two colliders, and never silently drops a user's furniture.
Scoring enforces this: error-severity violations apply a multiplicative penalty
(`RULES.ERROR_SCORE_FACTOR`) outside the soft-penalty cap, so an incomplete layout can never
out-rank a complete valid one. Before that penalty existed, dropping an awkward piece *improved* the
score — it removed that piece's clearance conflicts and freed floor area — so the solver was
literally rewarded for giving up.

## Security posture (detail in BACKEND.md)

RLS is forced on every table. The interesting case is the QR phone-capture path: the phone holds a
short-lived anon-scoped token that can **INSERT into `scan_assets` only**, constrained to a
non-expired session with a 40-asset cap, and can never read any other row. The desktop watches the
session over Realtime. `credits_ledger` has no write policies at all — it's append-only via trigger,
and balances derive from it.

# ainterior — furniture catalog (Deliverable E)

`packages/catalog` is the dimensional foundation of the product. Everything downstream — the
3D editor, the layout solver, the blueprint, the FF&E schedule — reads its truth from here.
The product's core claim is *real furniture at real dimensions*, so this package is written to
be honest about what it knows and explicit about what it doesn't.

```
catalog.json            { version: 1, items: CatalogItem[] }   — 284 items
thumbs/{id}.png         192×192 transparent isometric thumbnail, one per item (SPEC2 §I1)
thumbs.js               ES module: THUMBS[id] = data:image/png;base64,…  (file://-safe)
thumbs_grid_48.png      every thumbnail at 48×48 — the list-row legibility check
schema.json             strict JSON Schema (draft-07) for CatalogItem
archetypes.json         archetype → clearances, placement defaults, layout hints, sanity envelopes
seed.sql                idempotent upsert into public.catalog_items (SPEC §6)
contact_sheet.png       isometric render of every item's proxy — the visual QA artifact
importer/import.js      CLI: external product feed → CatalogItem[], validate, report
importer/validate.js    schema + semantic validation, histograms, confidence breakdown
tools/items_data.py     the source-of-truth item table (dimensions live here)
tools/archetypes_data.py per-archetype defaults + dims sanity envelopes
tools/proxy_builders.py  primitive-proxy geometry, one builder per archetype
tools/gen_catalog.py     emits catalog.json / schema.json / archetypes.json / seed.sql
tools/contact_sheet.py   hand-rolled isometric rasteriser (PIL, no browser)
tools/ai_items_data.py   ainterior generic defaults table (SPEC2 §I2), dict records
tools/ai_proxy_builders.py geometry for the generics, incl. image_slot apertures (§G3)
tools/gen_thumbs.py      renders thumbs/*.png + thumbs.js (same camera as contact_sheet)
```

## Regenerate & verify

```bash
python3 tools/gen_catalog.py        # rebuild the four data artifacts
node importer/validate.js           # must exit 0 with 0 errors
python3 tools/contact_sheet.py      # rebuild contact_sheet.png, then LOOK at it
python3 tools/gen_thumbs.py --grid 48   # rebuild thumbs/, thumbs.js and the 48px grid
```

`catalog.json`, `schema.json`, `archetypes.json` and `seed.sql` are **generated**. Edit the
Python tables in `tools/`, never the JSON.

---

## Contents

| | |
|---|---|
| Items | **284** (198 IKEA + 3 generic TV envelopes + 83 ainterior generics) |
| Archetypes covered | **44 / 44** of the SPEC §4.3 closed set |
| Categories | seating 43 · storage 48 · tables 29 · lighting 18 · decor 18 · beds 13 · desks 12 · rugs 10 · kids 8 · outdoor 2 |
| Proxy primitives | 1,703 (avg **8.5** per item, max 25) |
| Units | millimetres, integers, everywhere (SPEC §1) |

Lines represented: EKTORP · KIVIK · SÖDERHAMN · LANDSKRONA · FRIHETEN · VIMLE · GRÖNLID ·
KLIPPAN · POÄNG · PELLO · STRANDMON · TULLSTA · VEDBO · EKEDALEN · INGOLF · STEFAN · TEODORES ·
ADDE · JANINGE · ODGER · NORRÅKER · MARKUS · MILLBERGET · LÅNGFJÄLL · FLINTAN · MARIUS · FROSTA ·
FRANKLIN · SKOGSTA · MACKAPÄR · LACK · VITTSJÖ · LISABO · KRAGSTA · HEMNES · STOCKHOLM · GLADOM ·
BURVIK · LUNNARP · INGATORP · NORDEN · MÖRBYLÅNGA · INGO · MELLTORP · VANGSTA · LANEBERG ·
STRANDTORP · DOCKSTA · HAVSTA · IDANÄS · STENSTORP · TORNVIKEN · VADHOLMA · ÄPPLARÖ · TÄRNÖ ·
MICKE · LINNMON/ADILS · LAGKAPTEN · MALM · BEKANT · TROTTEN · ALEX · UTESPELARE · BRIMNES ·
SLATTUM · TARVA · SONGESAND · HAUGA · NEIDEN · KURA · SNIGLAR · SUNDVIK · KNARREVIK · VIKHAMMER ·
KOPPANG · KULLEN · NORDLI · PAX · KLEPPSTAD · NORDKISA · BILLY · GERSBY · LAIVA · FJÄLKINGE ·
IVAR · KALLAX · BESTÅ · TROFAST · SKUBB · DRÖNA · SAMLA · NYMÅNE · HEKTAR · RANARP · HOLMÖ · NOT ·
LAMPAN · ÅRSTID · TERTIAL · FADO · FOTO · SKURUP · STOENSE · VINDUM · HAMPEN · ÅDUM · MORUM ·
LOHALS · TIPHEDE · MOSSLANDA · BERGSHULT · RIBBA · BJÖRKSTA · HOVSTA · NISSEDAL · HOVET ·
LINDBYN · FEJKA · LENDA · MAJGULL · SANELA · FLISAT · MAMMUT · KRITTER.

---

## Provenance: how dimensions were sourced, and what that means

**These dimensions were reconstructed from working product knowledge of IKEA's published
spec sheets — they were not scraped live from ikea.com during this build.** That is the single
most important caveat in this package, and it is why every item carries a
`dims_confidence` field rather than an implied guarantee.

`dims_confidence` values:

| value | meaning | count | share |
|---|---|---|---|
| `high` | Dimension is a well-known, frequently-cited published figure that I can state with confidence (e.g. EKTORP 3-seat 218cm, BILLY 80×28×202, KALLAX 147×39×147, LACK coffee table 90×55×45, MARKUS 62×60). Treat as trustworthy to ±10mm. | **57** | 28.4% |
| `medium` | Dimension is consistent with the product line's known module pitch and my recollection of the spec sheet, but I have not verified the exact figure. Treat as ±30mm. | **119** | 59.2% |
| `low` | Dimension is an estimate derived from product photography proportions, family module grids, or a line whose sizes change between editions. **Do not quote to a client.** Treat as ±80mm or worse. | **25** | 12.4% |

Every `medium` and `low` item that has a specific uncertainty also carries a free-text
`dims_note` explaining exactly what is uncertain. Examples actually in the data:

- `ikea-vedbo-armchair` — *"Dimensions estimated from product photography ratios — verify before commercial use."*
- `ikea-havsta-console-table` — *"Console dimensions estimated; IKEA console line-up changes frequently."*
- `ikea-markus-office-chair` — *"Total height is adjustable 1290–1400; stored value is max."*
- `ikea-ekedalen-ext-table` — *"Extends 1200→1800."*
- `ikea-norden-gateleg-table` — *"Folds 260 / 890 / 1520; stored value is the single-leaf state."*
- `ikea-kivik-chaise-sectional` — *"Chaise depth (1630) confident; overall width varies by module order."*

### Known systematic uncertainties

1. **Adjustable and extendable pieces store one state.** Extendable dining tables
   (EKEDALEN, VANGSTA, LANEBERG, STRANDTORP, INGATORP) store the **closed** footprint; the
   extended size lives only in `dims_note`. Height-adjustable chairs (MARKUS, MILLBERGET) and
   desks (BEKANT) store a single representative height. The layout engine therefore plans the
   closed/nominal case. A future `dims_variants[]` field should carry the full set.
2. **Pendant and wall lamps have no fixed envelope.** `h` for a pendant is a *typical hang*
   (1200mm drop) because the cord is user-cut. The shade diameter is the real number; the drop
   is a placement default. `wall_lamp` bounding boxes are the weakest data in the package —
   all three are `low`.
3. **US vs. EU sizing.** Bed widths use the **US** naming (queen ≈ 1580–1680mm frame). The same
   model sold in Europe as 160cm will differ. Mattress sizes are not modelled separately.
4. **SKUs are `null` everywhere.** IKEA article numbers are colourway-specific and I could not
   establish real ones; inventing them would be worse than omitting them. The field exists and
   the importer will populate it from a real feed.
5. **URLs are IKEA search links**, not product-page permalinks
   (`https://www.ikea.com/us/en/search/?q=EKTORP+3-seat+sofa`). Product-page URLs contain
   colourway-specific article slugs I cannot verify, so a guessed permalink would 404. The
   search route is canonical, stable, and always resolves to the right product.
6. **Sofa family widths interpolate.** Where I know the 3-seat width confidently but not the
   2-seat, the 2-seat is derived from the family's module pitch and marked `medium`.
7. **The 3 `Generic` TVs are not IKEA.** They exist because the `tv` archetype needs a real
   16:9 panel envelope for the SPEC §5.1 viewing-distance rules. Their dimensions are the
   industry-standard active-area + bezel figures for 43″/55″/65″ and are `high` confidence.

### Before this ships commercially

Point `importer/import.js` at IKEA's real product feed. Every field it can verify overwrites
the reconstructed value and the item is re-stamped. The importer **never** writes
`dims_confidence: "high"` — only a human review pass may promote an item to `high`.

---

## Proxy geometry

Each item's `proxy.parts` is a list of primitives (`box` · `cyl` · `sphere` · `plane`) in the
item-local frame: **x = width, y = depth, z = elevation, origin = footprint centre on the
floor, `pos` = the primitive's centre.**

**Front/back convention:** `-y` is the *back* of the piece (wall side), `+y` is the *front*
(room side). This matches the SPEC §4.1 EKTORP example, whose back cushion sits at `y = -380`.

Colours use the named roles from SPEC §4.1 — `body` · `wood` · `metal` · `glass` · `fabric` ·
`dark` — or a literal `#RRGGBB`. The renderer resolves `body` and `fabric` to the item's
selected colourway, so one geometry serves every colourway.

Geometry is authored per **archetype**, not per item, so it is consistent and reviewable:

| archetype family | composition |
|---|---|
| sofas / loveseat / chaise | plinth + back frame + per-seat seat cushions + per-seat back cushions + 2 arms + 4 legs |
| sectional (L) | main run + chaise block + shared arm + legs; `l_shape_mm` notch matches the geometry |
| armchair | single-seat sofa build |
| dining chair | seat + 2 back posts + back panel + lower back rail + 4 legs + stretcher |
| office chair | castor disc + 5 radial spokes + 5 castors + gas cylinder + seat + back + lumbar plate + headrest + 2 armrests (20 parts) |
| stool / bar stool | round or square seat + 3–4 legs + footrest ring/stretchers |
| beds | headboard + 2 side rails + foot rail + slat base + mattress + 1–2 pillows + 4 legs (+ storage drawer fronts) |
| crib | 4 corner posts + top/bottom rails + 7 turned slats per long side + head/foot panels + mattress (25 parts) |
| dressers / nightstands | carcass + top + plinth or legs + N drawer fronts + N handles |
| wardrobe | carcass + plinth + 2–3 door fronts + handles (mirror door where real) |
| bookcase | 2 side panels + top + bottom + **dark** back cavity + N shelves |
| shelf_unit (KALLAX) | outer frame + vertical dividers + horizontal dividers → real cube grid |
| shelf_unit (IVAR/FJÄLKINGE/TROFAST) | 2 uprights + N open shelves + rear braces |
| sideboard / cabinet / tv_bench | carcass + top + doors and/or drawer fronts + handles + legs or plinth |
| tables | top (box or cyl) + apron + 4 legs, or pedestal + base disc for DOCKSTA/KRAGSTA; optional lower shelf |
| desks | top + modesty panel + 4 legs, or top + integrated drawer unit (MICKE/ALEX/MALM/HEMNES) |
| kitchen island | carcass + overhanging top + plinth + drawer fronts + open shelves + towel rail |
| lamps | base + collar + stem + shade + a light-pool `plane` under the shade |
| pendant | ceiling canopy + cord + drum shade + light pool |
| rug | thin slab + inset pattern plane (never a collider) |
| plant | tapered pot + soil + stem + 6 foliage spheres |
| curtain | rod + 5 pleat panels with alternating shading |
| tv | panel + screen inset + neck + foot |
| art_frame / mirror | 4 frame members + canvas/glass plate; round mirrors use a 16-element bezel ring |
| wall_shelf | board + back rail + 2 brackets |

### Primitive limitation worth knowing

The SPEC primitive set has **no per-part rotation**. Round forms whose disc lies in the *wall*
plane (LINDBYN round mirror) therefore cannot use a `cyl` — a `cyl`'s axis is always vertical.
LINDBYN approximates its circle with a 16-element ring of small boxes, and its `footprint` is
`rect` (the plan bounding box), which is correct: the roundness is in elevation, not in plan.

---

## Visual QA — the contact sheet

`tools/contact_sheet.py` rasterises every item's proxy with a hand-rolled isometric
orthographic projector (painter's-algorithm depth sort, per-face Lambert shading, cylinders
as 16-segment prisms) and assembles `contact_sheet.png`. No three.js, no browser, no
Playwright — PIL only, ~3.5s for all 201 tiles. Each tile is labelled with name, archetype,
`w×d×h`, and a confidence swatch (green/amber/red).

```bash
python3 tools/contact_sheet.py                                    # full sheet
python3 tools/contact_sheet.py --only sofa_3seat,bookcase --tile 420 --cols 4   # zoom in
```

**Proxies changed after looking at the render (23 items across 5 builder families):**

| what the render showed | fix | items |
|---|---|---|
| BILLY/HEMNES/GERSBY/LAIVA bookcases read as solid slabs — the light back panel filled the openings | back panel recoloured to `dark` so the bays read as voids | 6 |
| KALLAX cube grids had the same problem; the grid disappeared | grid back panel recoloured to `dark` | 5 |
| MARKUS/MILLBERGET/LÅNGFJÄLL/FLINTAN 5-star bases merged into the dark shell — the chair read as a blob on a stick | base disc, spokes and castors recoloured `dark → metal` | 4 |
| FOTO/HEKTAR/RANARP/SKURUP pendant cords were sub-pixel; the shade looked like it floated | cord Ø 14mm → 24mm | 5 |
| LENDA/MAJGULL/SANELA curtains merged into one flat slab — no pleats | alternating pleat shading across the 5 panels | 3 |

Two further issues were found and fixed *before* the render, driven by the validator:
`plant` was used as a colour role (not legal — now `#4C7A45`), and vertical wall plates
(art frames, mirror glass, TV screens) were authored as horizontal `plane` primitives, whose
zero axis is `z`; they are now thin boxes.

One **renderer-only** concession: very dark colourways (FRIHETEN dark brown, black TVs,
MARKUS anthracite) collapsed into the dark tile background. `contact_sheet.py` lifts luminance
below a threshold **for the review render only** — `catalog.json` is untouched.

---

## Clearances and placement

Both come from `archetypes.json` and are applied uniformly; `validate.js` warns on any drift
between an item and its archetype default, so per-item overrides are always visible.

Representative values (mm, `front/back/left/right`):

| archetype | clearance | placement |
|---|---|---|
| `sofa_3seat` | 750 / 50 / 100 / 100 | `against_wall`, wall offset 40 |
| `coffee_table` | 400 all round | `center_ok`, and `offset_from_mm.sofa_3seat = 400` (SPEC §5.1 wants 350–450) |
| `dining_chair` | 300 / **1100** / 150 / 150 | back clearance is the SPEC §5.1 pull-out + circulation figure |
| `dining_table_rect` | 1100 all round | `center_ok`, `seat_pitch_mm: 600` |
| `bed_queen` | 750 / 0 / 700 / 700 | `against_wall` — SPEC §5.1 wants ≥700 on both access sides |
| `wardrobe` | 900 / 20 / 20 / 20 | `against_wall`, `corner_ok` |
| `pendant_lamp` | 0 | `ceiling_mounted`, `drop_below_ceiling_mm: 1200`, `centre_over` dining/island |
| `wall_shelf` | 400 front | `wall_mounted`, `mount_h_mm: 1400` |
| `wall_lamp` | 0 | `wall_mounted`, `mount_h_mm: 1500` |
| `tv` | 1600 front | `wall_mounted`, `mount_h_mm: 1000`, `view_dist_mult: [1.6, 2.5]` |
| `rug` | 0 | `no_collider: true`, `under_group_overlap_mm: 200` |
| `curtain` | 0 | `wall_mounted`, `mount_h_mm: 2400`, `aligns_to: "window"` |

`needs_wall_len_mm` is `w + 100` for every wall-dependent item (`w + 200` for curtains, whose
pair spreads wider than a single panel).

`layout_hints` additionally carries `zone`, `anchor`, `faces`, `pairs_with[]` and
`min_room_area_m2` so the layout engine can seed a room without hard-coding per-item rules.

---

## Validation

`node importer/validate.js [file] [--partial]` — exit 0 clean, exit 1 on any error.
Dependency-free; it embeds a draft-07 subset validator covering exactly the keywords
`schema.json` uses.

Checks performed:

1. **Schema conformance** — every field, `additionalProperties: false`, enums, patterns, ranges.
2. **Unique ids**, kebab-case.
3. **Archetype membership** in the SPEC §4.3 closed set; **category** in §4.2.
4. **Integer millimetres** on every dimension and every proxy coordinate (SPEC §1).
5. **Dims sanity per archetype** from `archetypes.json.dims_sanity_mm` — a queen bed must be
   1500–1720mm wide, a dining chair 280–600mm, a coffee table 350–500mm tall, a dining table
   500–780mm tall, a floor lamp 1100–2000mm, etc. Outliers are **errors**, not warnings.
6. **seat_h sanity** — present iff the archetype seats a body, inside the archetype envelope,
   and never greater than overall height.
7. **Footprint coherence** — `round` requires `w == d`; `L` requires `l_shape_mm` with both
   notches strictly smaller than the bbox, and vice versa.
8. **Placement coherence** — `wall_mounted` ⇒ `mount_h_mm`; not both wall- and ceiling-mounted;
   wall-dependent ⇒ `needs_wall_len_mm ≥ w`; no item may have every placement flag false.
9. **Proxy integrity** — non-empty; every primitive inside the `dims_mm` box (2mm rounding
   tolerance); nothing below the floor; legal colour roles; `cyl` size is `[dia, dia, h]`;
   `sphere` size cubic; `plane` size `[sx, sy, 0]`.
10. **Proxy plausibility (warnings)** — fewer than 3 primitives, bbox fill under 5%, or nothing
    reaching 80% of the declared height all warn, because those are the shapes that read as a
    single box rather than as furniture.
11. **Drift warnings** — any clearance or placement flag differing from the archetype default.

It then prints category / archetype / footprint / brand histograms, the confidence breakdown,
and archetype coverage. Current state: **201 items, 0 errors, 0 warnings, 44/44 archetypes.**

---

## Importing an external feed

```bash
node importer/import.js feed.json                  # dry run + report
node importer/import.js feed.csv --out items.json  # write normalised items
node importer/import.js feed.json --merge          # upsert into catalog.json
node importer/import.js feed.json --map map.json   # custom column mapping
```

Accepts a JSON array, `{items:[…]}`, `{products:[…]}`, or CSV with a header row. It maps loose
column names (`width`, `width_cm`, `dim_w`, …), converts **mm / cm / m / inches** to integer
millimetres, infers the archetype from ~45 keyword rules, derives the category from the
archetype, applies archetype clearance/placement defaults, and checks every dimension against
the sanity envelope.

Its honesty rules:

- **Never emits `dims_confidence: "high"`.** Clean rows land at `medium`, anything with an
  issue at `low`. Only a human review pass may promote to `high`.
- **Never invents a missing w/d/h** — the row is skipped and listed under SKIPPED.
- **Flags inferred units.** A bare `80` in a `width` column is read as cm but recorded as
  *"unit inferred as cm"* in `dims_note` and surfaced under NEEDS REVIEW.
- **Cannot author real geometry.** It emits an archetype-shaped block fallback and says so, in
  the report and in `dims_note`. Those items must get real geometry in `proxy_builders.py`
  before they are published.
- **Pipes its own output through `validate.js --partial`** and exits non-zero if it fails.

A worked example against a deliberately messy 6-row feed (mixed units, an unmappable
"Widget", a row with no dimensions) yields 4 items, 2 skipped with reasons, 3 flagged for
review, and a clean validation pass.

---

## Adding an item by hand

1. Append a tuple to `ITEMS` in `tools/items_data.py`:
   `(id, name, product_type, category, archetype, w, d, h, seat_h, price_usd, confidence, footprint, palette_key, tags, dims_note)`
   — `archetype` must be in the §4.3 closed set; `id` is kebab-case and stable forever
   (placements reference it). Add a colourway list to `P` if no existing palette fits.
2. Be honest with `confidence`. If you are working from a photo, it is `low`, and say why in
   `dims_note`.
3. If the archetype's existing builder does not read as the piece, extend
   `tools/proxy_builders.py` — add a keyword branch in `gen_catalog.build_proxy`, don't
   special-case in the data.
4. `python3 tools/gen_catalog.py && node importer/validate.js` — must be 0 errors.
5. `python3 tools/contact_sheet.py --only <your-id> --tile 480 --cols 1` and **look at it.**
   If it doesn't read as the furniture, it isn't done.

New archetypes require a SPEC amendment plus entries in `archetypes_data.A` and
`archetypes_data.SANITY`; `validate.js` rejects anything outside the closed set.

---

## Database

`seed.sql` is a single idempotent statement: `insert … on conflict (slug) do update`, so it can
be re-run after every regeneration. It targets `public.catalog_items` (SPEC §6) with
`published = true`. `embedding vector(512)` and `phash` are deliberately left `NULL` — they are
populated out-of-band by the dedupe pipeline in Deliverable D.

The `id` from `catalog.json` maps to the `slug` column; the table's own `id` is the
`uuid default gen_random_uuid()` required by SPEC §6.

---

## Known gaps

1. **No live verification pass.** Nothing here was fetched from ikea.com during this build.
   The 25 `low` items and, to a lesser degree, the 119 `medium` items need a feed reconciliation
   run before any commercial promise is made on them. This is the top item of technical debt.
2. **No SKUs.** All `null`. Blocks real purchase links and the FF&E schedule's article column.
3. **Extendable / adjustable states are lossy.** A single stored state per item; needs a
   `dims_variants[]` field so the solver can try the extended table.
4. **`appliance` category is empty.** IKEA sells LAGAN/TILLREDA etc.; none are modelled, so
   kitchen layouts have an island and stools but no appliances.
5. **`outdoor` is thin** (2 items: ÄPPLARÖ, TÄRNÖ) and both are `medium`/`low`.
6. **Modular systems are frozen configurations.** PAX, BESTÅ, KALLAX, IVAR and SÖDERHAMN are
   real systems; we ship 3–5 fixed sizes each rather than a configurator. A future
   `modular: {module_w_mm, min_w, max_w, step}` field would let the solver resize a PAX run to
   the wall it found.
7. **No soft-goods beyond curtains and rugs.** No bedding, cushions, throws, or window blinds.
8. **`wall_lamp` bounding boxes are the weakest data** — all 3 are `low` confidence estimates.
9. **No mass, assembly footprint, or packaging dimensions** — irrelevant to layout today, but a
   staging customer moving real furniture will eventually ask.
10. **Colourway hexes are plausible, not measured.** They are visually representative of the
    named IKEA fabric/finish, not colorimetric samples. Fine for a proxy render; not fine for
    a client-facing colour match.
11. **Rotation-free primitives** mean angled forms (POÄNG's cantilever, a wing chair's splayed
    back, TÄRNÖ's folding geometry) are approximated as orthogonal masses. Silhouettes read
    correctly at editor scale; they are not accurate at close range.
12. **Single locale.** US sizing and USD pricing only; no EU/UK size or currency variants.


---

## Thumbnails (SPEC2 §I1)

`tools/gen_thumbs.py` rasterises every item's `proxy` through the *same* projector, camera and
light as `contact_sheet.py` — 30° isometric, light from +x/+y/+z — so the whole set reads as one
family. Each tile is 192×192, transparent, the item scaled to span 86% of the tile, with a soft
blurred ground-shadow ellipse computed from the footprint (`w × d`), not from the primitives, so
tall thin items still sit on the floor rather than float.

Two outputs, deliberately:

| Output | Consumer |
|---|---|
| `thumbs/{id}.png` | the repo, code review, the docs |
| `thumbs.js` (`export const THUMBS`) | the browser list — the demo runs from `file://`, where `fetch()` of local files is blocked, so the data URIs must be inlined in a module |

PNGs are octree-quantised to 47 colours + a dedicated transparent index. That keeps every tile
**under 4 KB** (avg ≈2.3 KB, max 3.9 KB), well inside the 8 KB hard cap; the whole module is
**≈894 KB** for 284 items. Anything that only reads at 192px is a failure — the list row is
48×48, which is what `thumbs_grid_48.png` exists to check.

## ainterior generic defaults (SPEC2 §I2)

83 items, `brand: "ainterior"`, ids prefixed `ai-`, all `dims_confidence: "high"` — these are
published standard sizes (ISO 216 A-series, US frame sizes, standard appliance envelopes), not
scraped guesses, so "high" is honest here in a way it isn't for a scraped product page.

- **Posters & frames (25 items, 27 `image_slot` parts).** A4/A3/A2/A1/A0 and US 8×10, 11×14,
  16×20, 18×24, 24×36 plus 12×12 square, each framed *and* unframed; two gallery-wrapped canvases;
  one three-panel triptych (three independent slots). The framed variants carry the frame profile
  and mount inset in their outside dimensions, and the `image_slot` part is sized to the **visible
  aperture** — inside the profile *and* inside the matting — so a photo textured onto it lands
  exactly where the mount opening is.
- **Generic furniture (20):** floor/wall mirror, wall clock, floor cushion, bean bag, laundry
  hamper, drying rack, ironing board, moving boxes S/M/L, fabric bin + 60L tote, shoe rack, coat
  stand, umbrella stand, pedal bin, radiator cover, curtain rod, roller blind, door mat.
- **Tech & appliance envelopes (18):** 24/27/32″ monitors, monitor arm, tower PC, printer, router,
  desk lamp, space heater, pedestal + tower fan, air purifier, humidifier, mini fridge, microwave,
  kettle, robot vacuum + dock.
- **Life stuff (20):** houseplants S/M/L/hanging, yoga mat, dumbbell rack, bike (floor + wall),
  guitar stand, keyboard stand, pet bed, hooded litter box, cat tree, whiteboard, corkboard,
  string lights, standing-desk converter, folding chair, folding table.

`price_usd` is `null` where a price is genuinely meaningless (the two bikes; the vacuum dock that
ships with the vacuum).

### Archetypes added to the SPEC §4.3 closed set

Seven, each because the existing set had no home with the right layout semantics:

| New archetype | Covers | Why not an existing one |
|---|---|---|
| `monitor` | 24/27/32″ screens, monitor arm | `tv` is a wall/bench object 700mm+ wide with TV clearances; a monitor lives on a desk |
| `appliance` | tower PC, printer, router, heater, fans, purifier, humidifier, mini fridge, microwave, kettle, robot vac + dock | nothing in §4.3 describes a powered box that sits on a counter or against a wall |
| `rack` | drying rack, ironing board, dumbbell rack, coat stand, guitar/keyboard stand, cat tree, desk riser | open floor frames, not `shelf_unit` cabinetry |
| `cushion` | floor cushion, bean bag, pet bed | `ottoman` mandates a 300–520mm seat height |
| `bike` | bike floor + wall mount | long, thin, wall-hugging, sometimes wall-*mounted* |
| `curtain_rod` | curtain rod | `curtain` is a 1200mm+ fabric drop; a rod is 70–120mm tall |
| `string_lights` | festoon lights | ceiling-hung catenary, not a `pendant_lamp` |

Two existing sanity envelopes were widened (loosened only, no existing item moved):
`storage_box` w/d 700→800, h 450→**700** (hampers, pedal bins, umbrella stands) and
`rug` w-min 500→450, d-min 700→**400** (door mats).

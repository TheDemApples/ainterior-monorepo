# ainterior — Spec Addendum v2 (studio usability + realism)

> Read `SPEC.md` first — §1 (units/axes), §4 (data shapes) and §8 (hard constraints) still bind.
> This addendum overrides §5.3 where they disagree. Same rules: millimetres in storage, metres in
> the scene, `three.x = plan.x/1000`, `three.z = -plan.y/1000`, rotation CCW degrees.

Twelve reported defects drive this document. Each section names the defect it closes.

---

## A. Input model — the single source of truth (fixes #4)

The current mapping overloads left-drag and inverts nothing. Replace it wholesale with this table.
**No other bindings.** If a binding is not listed here it must not exist.

| Input | 3D view | Plan (ortho) view | Walk view |
|---|---|---|---|
| **Left click** | **Select furniture ONLY.** Never pans, never orbits. | Select furniture only | — |
| **Left drag on a gizmo handle** | Manipulate that handle | Manipulate that handle | — |
| **Left drag on empty space** | Nothing (no marquee, no pan) | Nothing | — |
| **Right drag** | **Orbit.** Must NOT select anything, ever. | **Pan** (no orbit in ortho) | Look |
| **Middle drag** | **Pan, vertically inverted** — see below | Pan | — |
| **Wheel** | Zoom (toward cursor) | **Zoom at cursor** | — |
| **Ctrl + drag** | **Free transform** — bypasses all snapping (was Alt; Alt must no longer do this) | same | — |
| `Shift` (hold) | — | — | **Sprint** |
| `Ctrl` (hold) or `C` | — | — | **Crouch** |
| `W/A/S/D` | — | — | Move |
| `Del` / `Esc` / `Ctrl+D` / `Ctrl+Z` / `Ctrl+Shift+Z` | unchanged | unchanged | — |

**Middle-drag vertical inversion (explicit, #4b):** dragging the mouse **down** moves the camera
**forward** (into the scene); dragging **up** moves it **backward**. Horizontal is unchanged
(drag right → pan right). Implement as: `forward += dyPixels * k`, i.e. a positive screen-space
`dy` (downward) advances along the camera's forward vector projected onto the floor plane.

**Right-click must never select.** Suppress the context menu on the canvas, and do not run a pick on
button 2. Also suppress the click-after-orbit from landing as a selection.

---

## B. Manipulation gizmo (fixes #2)

Delete freeform "drag the mesh around the floor". Selection gets an explicit gizmo, in a new module
`packages/three-editor/gizmo.js`.

### Handles
1. **Three axis arrows** — shafts + cone heads, constrained translation:
   - `X` → `--clay` `#DC6B47`
   - `Y` (elevation) → `--blueprint` `#3B6EF6`, clamped so the item never goes below the floor;
     enabled only for `wall_mounted` / `ceiling_mounted` items, and hidden (not just disabled) for
     floor-standing pieces so it can't be grabbed by accident
   - `Z` → `#7E9B6B`
2. **One planar handle** — a small square at the origin in the floor (XZ) plane for free **2D**
   movement across the floor. This is the everyday interaction and must be the easiest to hit.
3. **Three rotation circles** — flat 2D rings, one per axis, colour-matched to the axes. The
   floor-plane (yaw) ring is the primary one and must be the largest / most reachable.

### Behaviour — stability is the whole point
- **Screen-constant size.** Scale the gizmo by camera distance (perspective) or ortho zoom so it is
  always ~110 CSS px across regardless of zoom or item size. A gizmo sized in world units is
  unusable on a 250mm lamp and on a 2400mm wardrobe at the same time.
- **Drag math must be projective, not incremental.** On pointer-down, record the ray/handle
  intersection as an anchor. On every move, re-intersect the *same* plane or axis line and apply
  `current - anchor`. Never accumulate frame deltas, and never re-derive from the object's current
  position — that is what causes the reported shake and drift.
- **Axis drag:** intersect the pointer ray with the plane through the item that contains the axis and
  most faces the camera; project that point onto the axis line; translate by the scalar delta.
- **Rotation drag:** intersect the ray with the ring's plane, take `atan2` about the item origin,
  and apply the signed angle difference from the anchor angle. Unwrap across ±π so a drag through the
  seam doesn't jump 360°.
- **Pointer capture** (`setPointerCapture`) for the whole drag, so leaving the canvas doesn't
  desync. Release on `pointerup` / `pointercancel` / `lostpointercapture`.
- **Degenerate-ray guard:** if the ray is within ~4° of parallel to the drag plane, hold the last
  valid value instead of flinging the item to infinity.
- **Snapping:** translate 10mm, rotate 15°. **Ctrl held ⇒ free** (no snap).
- **Hover feedback:** the handle under the cursor brightens; the active handle stays highlighted for
  the whole drag; all other handles dim.
- One `history` entry per completed drag — not per frame.

---

## C. Picking (fixes #9)

**Root cause, already diagnosed — do not re-litigate it:** `pick()` calls
`raycaster.intersectObjects(furniture.children, true)`. That recursive walk hits every helper mesh
parented to each item: the collision `overlay` (a box spanning the item's whole bounding volume),
the `clearance` footprint (which extends up to **1000mm past** the item — a sofa's is 750mm at the
front), and the `outline` `LineSegments`. **Three.js raycasting does not skip `visible === false`
objects**, so those invisible helpers are live targets. Clicking near one item hits a *neighbour's*
invisible clearance plane first and selects the wrong thing.

Required fix:
1. Give every non-pickable helper a no-op raycast: `overlay.raycast = () => {};` and the same for
   `outline`, `clearance`, the guide lines, and every gizmo part that isn't a handle. Belt and
   braces: also put pickable proxy meshes on a dedicated `PICK_LAYER` and set
   `raycaster.layers.set(PICK_LAYER)`.
2. Raycast **only** the item proxy meshes.
3. Skip any candidate whose `visible` is false, or any ancestor of which is invisible.
4. Nearest hit wins, except: **gizmo handles always take priority** over furniture, and a
   selected item's own handles take priority over other items.
5. **Rugs and other flat, floor-level items must not shadow the things standing on them.** When the
   nearest hit is a `rug` (or `archetype === 'rug' || category === 'rugs'`) and another item was hit
   within 150mm of the same depth, prefer the non-rug.
6. Verify with a real test: place two items 200mm apart, click the centroid of each in screen space,
   and assert the correct `instance_id` comes back — including when their clearance envelopes
   overlap heavily. This is the regression that must never come back.

---

## D. Camera (fixes #3, #8)

Rewrite orbit/pan/zoom for stability in `controls.js`.

- **Spherical orbit** around a target with damping (`lerp` ~0.12/frame). Clamp polar to
  `[0.05, Math.PI/2 - 0.02]` so it can never flip or go under the floor. Azimuth wraps continuously.
- **No delta accumulation across frames.** Track pointer position, derive angles from the delta
  since the last event, then damp toward the target — never integrate stale velocity.
- **Pointer capture** on every camera drag; end cleanly on `pointercancel` / `lostpointercapture` /
  `blur`. A dropped pointerup must not leave the camera spinning (a current bug).
- **Zoom to cursor** in both 3D and plan views: the world point under the cursor stays under the
  cursor. Clamp distance to `[0.6m, 60m]`. Exponential steps so it feels the same at every scale.
- **Plan view (#8): must support zoom and pan.** Wheel zooms at the cursor by adjusting the ortho
  frustum; middle-drag and right-drag both pan. Keep an explicit "fit" action to re-frame the plan.
- Re-`fitOrtho()` only on explicit fit or on resize — never every frame, or the user's zoom gets
  stomped.
- `requestAnimationFrame`-driven; no work in the pointer handlers beyond recording state.

---

## E. Walk mode (fixes #7)

- Default walk **1.35 m/s** (currently far too fast).
- **Sprint** (hold `Shift`) **3.2 m/s**; **crouch** (hold `Ctrl` or `C`) **0.7 m/s**.
- Eye height: standing **1.62m**, crouched **0.95m**.
- **Smooth transitions:** ease speed and eye height with a time-based lerp (~180ms, ease-out).
  No instant snapping between states. Sprint should also widen FOV slightly (68° → 74°) and ease
  back — subtle, not a fisheye.
- Collide with walls and floor colliders so you can't walk through the sofa; keep a 250mm body
  radius.
- Hold `Space` = no jumping. Ignore it.

---

## F. Bounds & wall snapping (fixes #12)

Furniture must not leave the floor.

- Clamp on **the item's rotated footprint (OBB)**, not its centre: every corner stays inside the
  floor polygon. Handles concave/L-shaped plans, so test against the polygon, not a bbox.
- If a clamp is hit, the item **slides along** the boundary rather than sticking — a drag pushing
  into a wall should still track sideways.
- **Snap flush to a wall** when the footprint edge comes within **120mm** of it: zero the gap
  (respecting `placement.wall_offset_mm`) and, if the item is `against_wall`, rotate to face into the
  room. Snapping must be visibly indicated (highlight that wall segment).
- `wall_mounted` items snap onto the nearest wall plane at `mount_h_mm` and may not float in mid-air.
- Never silently resize an item to make it fit (SPEC §8.8).

---

## G. Visual realism (fixes #11)

Target: "photographed interior", not "untextured 3D viewport". Everything procedural — **no external
texture downloads**, no new dependencies. New modules `packages/three-editor/lighting.js` and
`packages/three-editor/textures.js`.

1. **Renderer:** `ACESFilmicToneMapping`, `toneMappingExposure ≈ 1.05`,
   `outputColorSpace = SRGBColorSpace`, `shadowMap.type = PCFSoftShadowMap`, `antialias: true`,
   pixel ratio capped at 2.
2. **Lighting:** a warm key directional light casting soft shadows, sized to the room bounds with a
   tight shadow camera (sharp contact shadows, not mush); a cool sky/bounce fill; a subtle warm
   bounce from the floor. Windows should read as light sources — put a soft area-ish light just
   inside each window opening so daylight falls into the room.
3. **Materials:** `MeshStandardMaterial` throughout with believable roughness/metalness per role.
   `fabric` slightly sheened and rough; `wood` with anisotropic-ish grain; `metal` low-roughness;
   `glass` transmissive-looking but cheap.
4. **Procedural textures** (canvas-generated, cached, mipmapped, tiled by world size so scale reads
   correctly): oak floor planks with seams; fine fabric weave; wall plaster with very subtle
   mottling; a rug pile noise. Generate at ≤512px, reuse across items — do not build a texture per
   instance.
5. **Contact grounding:** every floor-standing item needs a soft contact shadow so it doesn't look
   pasted on. A cheap radial-gradient decal under the footprint is acceptable and preferred over
   expensive AO.
6. **Geometry polish:** bevel/round exposed edges slightly; baseboards; a thin reveal where wall
   meets floor. Cheap, high payoff.
7. **Environment:** a vertical gradient environment so reflections aren't flat black.
8. **Performance is a hard requirement:** ≥40fps at 1600×1000 with ~25 items on the sandbox's
   software renderer (SwiftShader). Measure it and report the number. If a feature costs more than
   it returns visually, drop it and say so.
9. Respect `prefers-reduced-motion` for camera easing.

## G2. Multi-room shells (supports #1)

`room.js` must render a floorplan with **interior walls**, not just one polygon.
Accept an optional `interior_walls` array on the room/floorplan object:

```jsonc
{ "interior_walls": [
    { "id":"iw1", "a":[3200,0], "b":[3200,4200], "thickness_mm":110,
      "openings":[ { "id":"d2", "type":"door", "offset_mm":800, "width_mm":800,
                     "height_mm":2040, "sill_mm":0, "swing":"in-left" } ] }
  ] }
```

`offset_mm` runs from vertex `a`. Interior walls get the same treatment as exterior ones: openings
cut properly, door swing arcs, baseboards both sides, and inclusion in the camera-facing fade so you
can always see into the room you're working in. Also honour per-room `floor_material`
(`oak | ash | concrete | tile | carpet`) so rooms read as distinct spaces.

## G3. Image slots (supports #10)

`proxies.js` must support a part flagged `"image_slot": true`. Such a part renders with a
user-supplied image texture when one is set, and a neutral placeholder otherwise. Expose
`editor.setInstanceImage(instance_id, imageBitmapOrURL)` and `editor.clearInstanceImage(id)`.
The image must be aspect-fit inside the part (letterboxed, never stretched) — a 3:2 photo in a
square frame keeps its proportions.

---

## H. Floorplan designer (fixes #1)

New package `packages/floorplan/` plus a page `demo/design.html`.

Entry choice, presented up front:
- **(a) Try a preset** — at least 4: Studio 6.0×4.2m · 1-bed apartment · 2-bed apartment ·
  Single room 4.6×3.8m. Loading a preset goes straight to the studio.
- **(b) Design my own** — the builder below.

### Data model

```jsonc
{
  "id": "fp_1", "name": "My apartment", "unit": "cm",
  "rooms": [
    { "id":"r1", "name":"Living room", "polygon_mm":[[0,0],[4600,0],[4600,3800],[0,3800]],
      "height_mm":2600, "floor_material":"oak",
      "openings":[ /* SPEC §4.4, wall_index relative to THIS room's polygon */ ],
      "features":[] }
  ],
  "interior_walls": [ /* G2 */ ]
}
```

Room polygons live in **shared absolute floorplan coordinates**, so rooms tile into a plan. Provide:
- `createFloorplan()`, `addRoom(fp, {name, w_mm, d_mm, at:[x,y]})`, `removeRoom`, `moveRoom`,
  `resizeRoom`, `addDoor`, `addWindow`, `connectRooms(fp, aId, bId, {width_mm})`
- `validateFloorplan(fp)` → `[{severity, code, message, room_id?}]` — must catch overlapping rooms,
  disconnected rooms (no door path from the entrance), rooms below a usable minimum, and walls
  thinner than 60mm.
- `floorplanToShell(fp)` → the object the 3D editor consumes: outer `polygon_mm`, merged `openings`,
  `interior_walls`, `rooms[]` metadata. **Derive the interior walls from shared room edges** — where
  two rooms abut, that shared edge becomes one interior wall, not two coincident ones.
- `PRESETS` — the four above, as complete valid floorplans.

### Builder UX — the animation requirement is explicit
- A 2D plan canvas: click-drag to place a room, then drag edges/corners to resize, drag the body to
  move. Rooms snap to each other's edges and to a 100mm grid.
- **Numeric dimension fields with smooth visual feedback (#1).** As the user types a width or depth,
  the room must **animate** to the new size — tween the geometry (~180ms ease-out), animate the
  dimension witness lines, and count the number up/down rather than snapping. Typing `4600` should
  feel like the wall gliding out to 4.6m. This is called out specifically in the request, so make it
  genuinely smooth: rAF-driven tweens, `prefers-reduced-motion` respected.
- Live readouts per room: area (m² and ft²), perimeter, and plan total.
- Door/window placement by clicking a wall; drag along the wall to reposition; numeric offset+width.
- Room naming and floor-material choice.
- **Furniture brief step:** after geometry, let the user pick which pieces to include per room
  (searchable catalog with thumbnails and quantities), then hand off to the studio.
- Undo/redo. Persist to `localStorage` so a refresh doesn't lose the plan.
- Validation surfaced inline and non-blockingly (warn, don't prevent).
- Styling strictly from `SPEC.md` §2 tokens; dark by default; responsive 400px → desktop.

---

## I. Catalog additions

### I1. Product thumbnails (fixes #6)
Every catalog item needs a picture in the browser list.

- Render each item's `proxy` geometry to a small isometric thumbnail — the same approach as the
  existing `packages/catalog/tools/contact_sheet.py`, which already proves the pipeline.
- Output **both**:
  1. `packages/catalog/thumbs/{id}.png` — 192×192, transparent background, for the repo; and
  2. `packages/catalog/thumbs.js` — an ES module `export const THUMBS = { "<id>": "data:image/png;base64,..." }`.
     The demo must work from `file://`, where `fetch()` of local files is blocked, so the demo
     consumes the module. Keep each data URI small (indexed/quantised PNG, aim ≤4KB, hard cap 8KB)
     and report the total module size.
- Thumbnails must be recognisable at 48×48 in a list row: consistent camera, consistent lighting,
  item framed to fill the tile, subtle ground shadow.
- Provide `packages/catalog/tools/gen_thumbs.py` so they can be regenerated.

### I2. Generic / ainterior-default items (fixes #10)
Add ≥45 new items where brand genuinely doesn't matter. `brand: "ainterior"`, ids prefixed
`ai-`, `dims_confidence: "high"` (these are standard sizes, so they're actually certain).

- **Posters and frames with photo slots** — standard sizes, each with an `image_slot` part (G3):
  A4, A3, A2, A1, A0, plus US 8×10", 11×14", 16×20", 18×24", 24×36" and a 12×12" square. Both
  framed and unframed variants. Also a canvas print and a triptych.
- **Generic furniture nobody shops by brand:** floor mirror, wall clock, floor cushion, beanbag,
  laundry hamper, drying rack, ironing board, moving boxes (S/M/L), storage bins, shoe rack, coat
  stand, umbrella stand, waste bin, radiator cover, curtain rod, roller blind, door mat.
- **Tech/appliance envelopes:** monitor (24"/27"/32"), monitor arm, desktop tower, printer, router,
  desk lamp, space heater, pedestal fan, tower fan, air purifier, humidifier, mini fridge,
  microwave, kettle, robot vacuum + dock.
- **Life stuff:** houseplants (small/medium/large/hanging), yoga mat, dumbbell rack, bike (floor +
  wall mount), guitar stand, keyboard stand, pet bed, litter box, cat tree, whiteboard, corkboard,
  string lights, floor fan, standing desk converter, folding chair, folding table.

Every item needs: correct `archetype` from SPEC §4.3 (extend the closed set **only** if genuinely
unavoidable, and list any additions loudly in your summary), real standard dimensions, proper
`clearance_mm` and `placement` flags (`wall_mounted` + `mount_h_mm` for posters/mirrors/clocks/
blinds; `ceiling_mounted` where apt), a complete recognisable `proxy`, colourways, and a
`price_usd` (use `null` where a price is meaningless).

`node importer/validate.js` must pass clean afterwards, and the contact sheet must be regenerated so
the new items are visually checked.

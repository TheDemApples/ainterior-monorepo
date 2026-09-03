# packages/floorplan — floorplan designer (fixes #1)

Dependency-free, DOM-free model + operations + validation + shell derivation for the
`demo/design.html` builder. Runs in the browser demo and in Node tests (SPEC §8.7).
Units: **integer millimetres**, plan frame `x → right`, `y → up the page` (SPEC §1).

## Modules
- `geometry.js` — rectilinear polygon ops: area/perimeter, CCW, bbox, rect overlap,
  shared-edge detection, rectilinear union (outer envelope + holes), wall/opening math.
- `validate.js` — `validateFloorplan(fp) → [{severity, code, message, room_id?}]`.
- `presets.js` — the 4 starter plans (Studio 6.0×4.2m, 1-bed, 2-bed, Single room 4.6×3.8m).
- `index.js` — model + operations + `floorplanToShell` + history + handoff. Re-exports the rest.
- `tests/run.js` — `node packages/floorplan/tests/run.js` (zero deps).

## Operations
`createFloorplan, addRoom, removeRoom, moveRoom, translateRoom, resizeRoom, setRoomEdge,
renameRoom, setFloorMaterial, addDoor, addWindow, updateOpening, removeOpening,
connectRooms, disconnectRooms, rebuildInteriorWalls, roomMetrics, planMetrics,
floorplanToShell, setBriefItem, briefCount, createHistory, snapRect, snapScalar`.

## `floorplanToShell(fp)` → the object `packages/three-editor` consumes
```jsonc
{
  "id": "fp_1", "name": "My apartment",
  "polygon_mm": [[0,0],[9200,0],[9200,4200],[0,4200]],  // CCW outer envelope, integer mm
  "holes_mm": [],                                        // courtyard rings (CW), if any
  "height_mm": 2600,
  "wall_thickness_mm": 200,
  "openings": [ /* SPEC §4.4, wall_index relative to polygon_mm, exterior only */ ],
  "dropped_openings": [],                                // room openings not on the envelope
  "interior_walls": [                                    // SPEC2 §G2 — ONE per shared edge
    { "id":"iw1", "a":[4800,0], "b":[4800,4200], "thickness_mm":110,
      "between":["r_living","r_hall"],
      "openings":[ {"id":"c1","type":"door","offset_mm":1600,"width_mm":1100,
                    "height_mm":2040,"sill_mm":0,"swing":"in-left"} ] }
  ],
  "rooms": [ { "id","name","polygon_mm","height_mm","floor_material",
               "area_mm2","area_m2","openings","features" } ],
  "source": "manual", "confidence": 1.0
}
```

## Handoff contract (design.html → editor.html)
The builder writes one JSON payload and navigates to the studio with a URL flag.

- **localStorage key** `ainterior.floorplan.handoff` →
  ```jsonc
  { "v": 2, "created_at": "<iso>", "source": "design",
    "floorplan": { /* full authoring model */ },
    "shell":     { /* floorplanToShell output above — render this */ },
    "brief":     [ { "room_id": "r_living", "items": [ {"item_id":"ikea-ektorp-3seat","qty":1} ] } ],
    "issues":    [ /* validateFloorplan output, non-blocking */ ] }
  ```
- **URL** `editor.html?plan=handoff` — when `plan=handoff`, the studio should read
  `localStorage["ainterior.floorplan.handoff"]`, render `payload.shell` (outer polygon +
  `interior_walls` + per-room `floor_material`), and seed the furniture from `payload.brief`.
- **Draft key** `ainterior.floorplan.draft` → the in-progress authoring model (for resume).

Constants exported: `HANDOFF_KEY`, `DRAFT_KEY`, `HANDOFF_PARAM` (`"plan"`),
`HANDOFF_VALUE` (`"handoff"`), `saveHandoff(fp, storage, editorPath)`, `readHandoff(storage)`.

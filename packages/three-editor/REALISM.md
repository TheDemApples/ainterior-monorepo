# REALISM.md — integrating the §G realism layer

Everything in this document is **additive**. `editor.js`, `controls.js`, `collision.js`,
`gizmo.js`, `demo/`, `packages/catalog/` and `packages/floorplan/` were not modified.

Two of the four pieces need **no integration at all**:

| Piece | How it lands |
|---|---|
| `textures.js` | pulled in by `materials.js` — already live |
| `materials.js` (PBR roles, plaster walls, oak floor) | `editor.js` already calls `createMaterialLibrary()` — already live |
| `lighting.js` | **needs the 4-line hook below** |
| `proxies.js` image slots | needs `setInstanceImage` wiring (below) |

---

## 1. The lighting hook (required — this is the whole P1 payoff)

`editor.js` builds its own three lights at lines **121–129** and never enables
`renderer.shadowMap`. Replace that block, or simply let the rig override it from outside.
`createEditor()` already exposes `.scene`, `.renderer` and `.camera`, so **no edit to
`editor.js` is strictly necessary** — the integrator can call this right after
`createEditor(...)` returns:

```js
import { applyRenderer, createEnvironment, createLighting, enableShadows }
  from '../packages/three-editor/lighting.js';

const editor = createEditor({ mount, ... });          // unchanged

applyRenderer(editor.renderer);                        // ACESFilmic + SRGB + PCFSoft
const env = createEnvironment(editor.renderer);
editor.scene.environment = env.texture;                // §G.7 gradient env
const rig = createLighting({ scene: editor.scene, renderer: editor.renderer });
rig.fit(shell);                                        // shell = the object buildRoom() returned
enableShadows(editor.scene.getObjectByName('furniture'));
```

### If you *do* want to edit `editor.js` (cleanest result)

1. **Delete lines 121–129** (the `hemi` / `dir` / `fill` / `AmbientLight` block).
2. After `const mats = createMaterialLibrary();` (line 118) add:
   ```js
   applyRenderer(renderer);
   scene.environment = createEnvironment(renderer).texture;
   const rig = createLighting({ scene, renderer });
   ```
3. Inside `rebuildRoom()` (line 193), after `scene.add(shell.group);` add:
   ```js
   rig.fit(shell);
   ```
   This is what keeps the shadow camera tight to the room bounds — **the single most
   important line for shadow crispness**. Without it the shadow camera never resizes and
   contact shadows go soft/blocky.
4. In the proxy builder (line ~258, after `buildProxy(...)`) add `enableShadows(proxy);`
   so new items cast.

`rig.fit(shell)` reads `shell.bounds`, `shell.height_mm`, `shell.frames` and
`shell.openings`. **`room.js` does not currently return `openings`** — the rig falls back to
`shell.room.openings` and, failing that, simply skips the window lights (no crash). To get the
daylight spill, either add `openings` to the object `buildRoom` returns, or pass it yourself:
`rig.fit({ ...shell, openings: room.openings })`.

### Exports

- `applyRenderer(renderer, {exposure=1.05, maxPixelRatio=2})`
- `createEnvironment(renderer, {sky, horizon, ground}) -> { texture, dispose }`
- `createLighting({scene, room, renderer, quality}) -> { group, key, hemi, fill, bounce,
   windowLights, fit(shell), setQuality('low'|'high'|'ultra'), dispose() }`
- `enableShadows(root)` — casts on solids, receive-only on thin planes (rugs/art).

**Quality knob:** default shadow map is **1024²**. `rig.setQuality('ultra')` gives 2048² —
on SwiftShader that roughly halves the frame rate, so it is *not* the default. On real GPU
hardware `'ultra'` is the right choice.

---

## 2. Image slots (§G3) — `editor.setInstanceImage`

`proxies.js` renders any part with `"image_slot": true` through a dedicated, per-instance
material and exposes helpers on the returned group:

```js
group.userData.imageSlots   // array of { mesh, material, aspect } for this instance
```

`editor.js` cannot be edited, so add these two methods to its returned `api` object
(after `get three()`, line ~1446):

```js
setInstanceImage(instance_id, imageOrURL) {
  const rec = /* the editor's internal instance record for instance_id */;
  return setProxyImage(rec.group, imageOrURL);     // import from proxies.js
},
clearInstanceImage(instance_id) {
  const rec = /* ... */;
  return clearProxyImage(rec.group);
},
```

Both accept an `HTMLImageElement`, `ImageBitmap`, `HTMLCanvasElement`, or a URL string, and
both are safe to call on an item that has no image slot (they no-op and return `false`).

**Aspect-fit is done in the texture matrix, not the geometry** — the image is letterboxed
inside the part with `texture.repeat`/`texture.offset`, so a 3:2 photo in a square frame keeps
its proportions and is padded, never stretched. A neutral placeholder renders when unset.

---

## 3. Textures

All procedural, all canvas-generated, all ≤512px, all cached in a **module-level `Map`** in
`textures.js` and shared across every instance — a hundred fabric materials reference one
weave texture. `tiled(tex, rx, ry)` returns cached clones keyed by repeat pair, so tiling by
world size never allocates per-item.

Call `setRendererCaps(renderer)` (done automatically by `applyRenderer`) to pick up
anisotropy. `disposeTextures()` frees the whole cache on teardown — note that
`materialLibrary.dispose()` deliberately does **not** free them, since they outlive any single
material library.

---

## 4. What is NOT done

- **§G2 interior walls (P3) is NOT implemented.** `room.js` is unchanged and still renders a
  single polygon envelope, so multi-room plans from `floorplanToShell` show only the outer
  shell. Per-room `floor_material` is *supported at the material layer*
  (`mats.floorMaterial('oak'|'ash'|'concrete'|'tile'|'carpet')` returns a cached, correctly
  tiled PBR floor material) but nothing calls it per-room yet.
- Shadow-casting window lights were dropped: `PointLight.castShadow` on a software renderer
  costs a full cube-shadow pass per light. The window lights are unshadowed.
- `MeshPhysicalMaterial.transmission` for glass was dropped — it forces an extra scene render
  pass. Glass is low-roughness + low-opacity + high `envMapIntensity` instead.

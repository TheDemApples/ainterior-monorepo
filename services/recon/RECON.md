# `services/recon` — photo → 3D furniture scanning

Provider-agnostic reconstruction adapter (SPEC §5.5). `mock` is still the
default so the demo runs offline with no key. `huggingface` is a **free,
no-API-key** object scanner backed by a public Hugging Face Space running
`tencent/Hunyuan3D-2.1`.

```bash
RECON_PROVIDER=mock         # default — offline, no network, no key
RECON_PROVIDER=huggingface  # free image→3D, no key required
RECON_PROVIDER=meshy        # paid, needs MESHY_API_KEY
```

---

## 1. Provider comparison — measured, not marketing

All numbers below were measured from this sandbox on **2026-09-10** with
`test_chair.jpeg` (529 KB JPEG), anonymously, no HF token.

| Provider | Cost | Status | Result |
|---|---|---|---|
| **`tencent/Hunyuan3D-2.1`** (this adapter) | **Free, anonymous** | ✅ Working | Watertight `white_mesh.glb`, **148,838 verts / 297,684 faces, 5.11 MB** |
| `TencentARC/Pixal3D` | Free w/ ZeroGPU quota | ⚠️ Unusable anonymously | Anonymous quota too small (`120s requested vs 155s left`, resets daily). Needs the user's own HF token |
| `stabilityai/TripoSR` | Free | ❌ Down | Space throws an upstream `AppError` |
| `JeffreyXiang/TRELLIS` | Free | ❌ Down | Space in `CONFIG_ERROR` |
| Meshy | Paid | ✅ Working | Out of scope — the whole point here is *free* |

### Reliability — three end-to-end runs through *this* adapter

Wall time = upload + queue + GPU + download of the `.glb` to disk.

| Run | Wall time | Bytes | Result |
|---|---|---|---|
| 1 | **24.2 s** | 5,359,532 | ✅ |
| 2 | **22.2 s** | 5,359,528 | ✅ |
| 3 | **26.1 s** | 5,359,528 | ✅ |
| 4 (via `tools/recon-server.mjs` HTTP) | **22.6 s** | 5,359,528 | ✅ |

**4 / 4 succeeded, spread over ~20 minutes, mean ≈ 23.8 s.** The Space itself
self-reports `shape generation 17.6 s`, `remove background 1.03 s`,
`total 18.7 s` — the rest is upload, queue wait and the 5 MB download.

Byte counts differ by 4 bytes between runs: the geometry is deterministic at
`seed=1234, randomize_seed=false`, but glTF padding is not bit-identical.

> A control run through the Python `gradio_client` took **58.8 s** for the same
> job. The direct REST path in this adapter is faster because it skips the
> library's config/handshake round-trips.

---

## 2. Two protocol gotchas (both cost real debugging time)

**a) This Space is Gradio 4.44.0, and its `/call/<endpoint>` REST route is broken.**
Posting to `/gradio_api/upload` returns `404` (that prefix is Gradio 5 only),
and posting to `/call/shape_generation` returns an immediate
`event: error / data: null`. The adapter therefore:

* probes `/gradio_api/info` once and falls back to the bare root (`resolveApiRoot`),
* drives the job through the **queue protocol** — `POST /queue/join`, then
  `GET /queue/data?session_hash=…` as an SSE stream — which works on both
  Gradio 4 and 5.

**b) `/shape_generation` needs 13 inputs, but `view_api()` advertises 12.**
Sending the 12 documented parameters fails with:

```
An event handler (shape_generation) didn't receive enough input values
(needed: 13, got: 12).
```

Component 0 is a hidden `state`. `buildArgs()` reads `/config`, walks the real
input component list and injects `null` for every non-user slot, so the adapter
does not hard-code the arity and will survive the Space adding another field.

Endpoints available: `/shape_generation` (geometry, ~19 s GPU),
`/generation_all` (adds texture, slower), `/on_export_click` (glb/obj/ply/stl).

---

## 3. Setup

Zero npm dependencies. Node ≥ 18 (tested on **v20.19.5**) for global
`fetch`/`FormData`/`File`.

```bash
# scan one photo, straight through the provider
cd ainterior
node tools/scan-once.mjs test_chair.jpeg out.glb

# run the dev HTTP server for the static demo
RECON_PROVIDER=huggingface node tools/recon-server.mjs
#   POST /api/scan        multipart field "image", or JSON {image_base64|image_url}
#   GET  /api/scan/:id    job envelope
#   GET  /api/mesh?url=…  CORS-safe proxy (the Space sends no CORS headers)
#   GET  /api/health

curl -s -F image=@test_chair.jpeg http://127.0.0.1:8787/api/scan
curl -s http://127.0.0.1:8787/api/scan/<job_id>
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `RECON_PROVIDER` | `mock` | `mock` \| `huggingface` \| `meshy` |
| `HF_SPACE` | `tencent/Hunyuan3D-2.1` | any compatible Space, or a full URL |
| `HF_TOKEN` | *(unset)* | optional; raises ZeroGPU quota |
| `PORT` | `8787` | dev server port |

---

## 4. Cost & quota reality

* **Free and genuinely anonymous.** No token, no account, no credit card. All
  three benchmark runs above were anonymous.
* It is a **shared community GPU**. You are queueing behind strangers. Our
  `estimation` events reported `rank 0, queue_size 1, eta ≈ 24.7 s`, but at busy
  times the queue is the dominant cost, not inference.
* **ZeroGPU quota is per-IP when anonymous** and small. Sibling Spaces
  (`Pixal3D`) already refuse anonymous work with
  `120s requested vs 155s left`. Setting `HF_TOKEN` moves you to a per-account
  quota, which is what you want in production.
* **No SLA whatsoever.** Two of the four Spaces we benchmarked are hard-down
  right now (`TripoSR` AppError, `TRELLIS` CONFIG_ERROR). Assume this one can
  vanish mid-sprint and keep `mock` as the fallback.
* Rooms are **not supported**: Hunyuan3D-2.1 is single-object image→3D.
  `createRoomFromImages` / `createRoomFromBlueprint` fail fast with an explicit
  message rather than returning a fabricated room.

---

## 5. The two defects in raw output, and what we do about them

### 5.1 A ground plane is baked into the mesh

Even with `check_box_rembg=true`, the floor and contact shadow under the
subject are reconstructed as a large flat slab. Measured on the test chair:

| | bbox (x, y, z) in scene units | height ÷ max(width, depth) |
|---|---|---|
| Raw output | `[1.9868, 0.5387, 1.9861]` | **0.271** — a pancake |
| After `stripGroundPlane()` | `[0.4218, 0.5257, 0.5419]` | **0.970** — chair-like |

**259,835 of 297,684 triangles (87.3 %) were floor.**

`packages/three-editor/mesh-import.js` removes it in three stages:

* **Stage A — component slab.** Split into connected components, drop any that
  is *planar* **and** *at the bottom* **and** *broad in footprint*. All three
  must hold, so a seat cushion (flat and broad but high) and a chair back (flat
  and tall but narrow) both survive.
* **Stage B — fused slab.** Hunyuan3D emits a **watertight** mesh, so on the
  test chair the floor is welded to the chair and stage A finds exactly
  **one** component — component splitting alone provably cannot work here.
  Stage B bins triangles into an XZ grid and measures each column's vertical
  extent. A floor slab is a paper-thin sheet (near-zero column height); any
  real object has tall columns. We flood-fill the tall-column cluster
  containing the tallest column and discard everything outside it.
* **Stage C — floor-band shave.** Stage B necessarily keeps the floor that lies
  *inside* the object's own columns, i.e. the patch directly under the legs. It
  renders as a small fringed mat and is very visible. Stage C drops surviving
  triangles that sit within `floorBandFrac` (3 %) of the mesh height above the
  detected floor plane **and** face up/down (`|normal.y| ≥ 0.7`), so vertical
  leg walls survive. Measured effect: horizontal triangles in the bottom 3 %
  band fell from **12,277 → 123**, and their maximum horizontal spread from
  **0.283 → 0.213** (i.e. only the leg-bottom caps remain, nothing wider than
  the legs). It costs the lowest few mm of the legs, which is invisible once
  the piece is recentred onto `y = 0`.

Then the survivor is recentred to the SPEC §4.1 proxy origin: footprint centre
at the origin, lowest point at `y = 0` (verified: `min_y = 0`,
`footprint centre = [0, 0]`).

**Degenerate guard.** If removal would leave fewer than
`max(minSurvivingTris, minSurvivingTriFrac × total)` triangles — by default
`max(200, 2 %)` — the original mesh is kept and the report says
`ground_plane_removed: false`. It never returns an empty scene.

> The fractional part of that guard is deliberately **low**, and this is not
> sloppiness. On real output the floor is *genuinely* 87 % of the mesh, so an
> intuitive-looking 15 % threshold rejects every legitimate removal — we hit
> exactly that during development: the carve worked, then the guard silently
> reverted it and reported `removed_triangles: 0`. The **absolute** floor
> (200 triangles) is what actually protects against wiping the mesh.
> Stage C has its own guard, `minShaveSurvivalFrac` (40 %), measured against
> what survived stage B rather than the raw triangle count, for the same reason.

### 5.2 There is no real-world scale — so we never claim one

The mesh is normalised to roughly unit size. It carries **no** dimensional
information. Per SPEC §8.8 (*never invent a measurement*):

* The provider always returns `dims_mm: null` and
  `scale_confidence: 'unscaled'`.
* `fitToDimension(group, axis, mm)` takes **one** real measurement the user
  physically took and scales **uniformly**. A single measurement cannot justify
  per-axis correction, and faking that would be inventing data.
* Only then does the result carry `scale_confidence: 'user-measured'` and real
  `dims_mm`.
* `toUserItem()` **refuses** to emit a SPEC §4.1 item from an unscaled mesh,
  returning `{ ok: false, error: 'NO_SCALE' }`.

Verified: scaling the cleaned chair to width **780 mm** yields
`measure() → { w_mm: 780, d_mm: 1002, h_mm: 972 }` — **exact** on the measured
axis, plausible on the others (scale factor 1.849, `min_y = 0`, footprint
centre `[0, 0]`).

### 5.3 Browser importmap requirement

`GLTFLoader` imports the bare specifier `three`. Any page loading
`mesh-import.js` **must** declare an importmap first, using the pinned 0.169.0
build (SPEC §8.2), or you get
`Failed to resolve module specifier "three"`:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
  }
}
</script>
<script type="module" src="./app.js"></script>
```

---

## 6. Limitations a user must be told

1. **No size without a measurement.** A scan alone cannot tell you how big
   something is. The UI must ask for one real dimension before the piece can be
   placed. This is a product requirement, not a bug.
2. **Uniform scale only.** One measurement ⇒ one scale factor. If the model's
   proportions are slightly off, the unmeasured axes inherit that error.
   `d_mm 1003 / h_mm 955` on our chair are *model proportions*, not measurements.
3. **Single-view guesswork.** From one photo the unseen back and underside are
   *invented* by the model. Treat rear geometry as decorative. Pass
   front/back/left/right photos (the adapter supports all four slots) to reduce
   this materially.
4. **Queue latency is unpredictable.** ~24 s when idle; minutes when busy.
   Show a progress state, never block a UI thread.
5. **Anonymous quota is small and per-IP.** Set `HF_TOKEN` for production.
6. **No uptime guarantee** on a community Space (see §4).
7. **Heavy meshes.** ~298 k triangles / 5.1 MB per object. Decimate before
   putting many in one room. Ground-plane removal alone drops ~87 % of them
   (298 k → ~38 k).
8. **Objects only, never rooms.**
9. **Aggressive floor removal on flat objects.** A genuinely slab-like piece
   (a rug, a low platform) looks exactly like a floor. Stage B could eat it.
   The degenerate guard prevents total loss; set `carveFusedSlab: false` and/or
   `shaveFloorBand: false` for known-flat categories (rugs, mats, platforms).

---

## 7. Self-hosting when the public Space is down or rate-limited

The adapter only speaks the Gradio HTTP API, so **any** host that exposes the
same endpoints works — just point `HF_SPACE` at it.

**a) Duplicate the Space (easiest).** On the Space page choose *⋮ → Duplicate
this Space*, pick a GPU tier, then:

```bash
HF_SPACE=your-username/Hunyuan3D-2.1 HF_TOKEN=hf_xxx \
  RECON_PROVIDER=huggingface node tools/recon-server.mjs
```

A private duplicate gives you a dedicated queue and your own quota.

**b) Run the model locally on your own GPU** (needs CUDA, ~16 GB VRAM):

```bash
git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
cd Hunyuan3D-2.1
pip install -r requirements.txt
python gradio_app.py --port 7860        # serves the same Gradio API
```

```bash
HF_SPACE=http://127.0.0.1:7860 RECON_PROVIDER=huggingface \
  node tools/recon-server.mjs
```

`spaceOrigin()` accepts a full URL, so a bare host works with no code change.

**c) Fall back to `mock`.** `RECON_PROVIDER=mock` keeps the entire flow
demoable with no network at all — that is exactly why it is still the default.

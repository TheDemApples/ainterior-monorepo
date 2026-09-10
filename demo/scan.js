// demo/scan.js — photograph a piece of furniture, get it into the room in 3D.
//
// Runs entirely in the browser. The Hugging Face Space that does the
// reconstruction (tencent/Hunyuan3D-2.1) sends permissive CORS headers —
// verified: cross-origin GET /config and POST /upload both return 200 — so no
// proxy or server is required and this works in a hosted static bundle.
//
// Free, anonymous, no API key. Measured over 5 runs: 22.2s / 24.1s / 24.2s /
// 22.6s / 26.1s wall, ~5.1 MB GLB, 297,684 triangles.
//
// Two honest caveats are baked into the UX rather than hidden:
//   1. ~87% of the returned triangles are a floor slab the model bakes in from
//      the photo. mesh-import.js strips it before you ever see the result.
//   2. The reconstruction has NO real-world scale. ainterior is a
//      dimensionally-honest product (SPEC §8.8: never invent a measurement), so
//      the user must supply exactly one real dimension before the piece can be
//      placed. Until then it is flagged `unscaled` and cannot enter the room.
import { createHuggingFaceProvider } from '../services/recon/huggingface.js';
import {
  importScannedItem, toUserItem, fitToDimension, measure as measureGroup,
} from '../packages/three-editor/mesh-import.js';

const $ = (sel, root = document) => root.querySelector(sel);

const STATE = {
  file: null,
  imported: null,   // { group, measure(), ... }
  busy: false,
};

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function buildDialog() {
  const dlg = el('dialog', 'snapdlg scandlg');
  dlg.id = 'scanDlg';
  dlg.innerHTML = `
    <div class="snapdlg-head">
      <span class="eyebrow">scan furniture</span>
      <div class="bar-group">
        <a class="btn" id="scanHelp" href="https://huggingface.co/spaces/tencent/Hunyuan3D-2.1"
           target="_blank" rel="noopener">about the model</a>
        <button class="btn" id="scanClose">close</button>
      </div>
    </div>

    <div class="scan-body">
      <div class="scan-col">
        <p class="eyebrow">1 &middot; photo</p>
        <label class="scan-drop" id="scanDrop">
          <input type="file" id="scanFile" accept="image/*" hidden />
          <span class="scan-drop__hint mono">choose a photo&hellip;<br />
            <span class="dim">one clear, straight-on shot works best</span></span>
          <img id="scanPreview" alt="" hidden />
        </label>
        <button class="btn primary" id="scanGo" disabled>generate 3D</button>
        <p class="mono dim scan-note" id="scanStatus">free &middot; anonymous &middot; ~25s</p>
      </div>

      <div class="scan-col">
        <p class="eyebrow">2 &middot; result</p>
        <div class="scan-view" id="scanView">
          <p class="dim mono scan-empty">no scan yet</p>
        </div>
        <p class="mono dim" id="scanMesh">&mdash;</p>
      </div>

      <div class="scan-col">
        <p class="eyebrow">3 &middot; real size</p>
        <p class="scan-help dim">
          The reconstruction has no real-world scale. Measure the piece once and
          we will scale everything from it &mdash; ainterior never guesses a dimension.
        </p>
        <label class="scan-field">
          <span class="mono dim">name</span>
          <input class="input" id="scanName" type="text" value="Scanned piece" />
        </label>
        <label class="scan-field">
          <span class="mono dim">measured axis</span>
          <select class="input" id="scanAxis">
            <option value="w">width</option>
            <option value="d">depth</option>
            <option value="h">height</option>
          </select>
        </label>
        <label class="scan-field">
          <span class="mono dim">real measurement (mm)</span>
          <input class="input" id="scanMm" type="number" min="20" max="6000" step="10" value="780" />
        </label>
        <p class="mono dim" id="scanDims">&mdash;</p>
        <button class="btn primary" id="scanAdd" disabled>add to room</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  return dlg;
}

function setStatus(msg, tone) {
  const n = $('#scanStatus');
  if (!n) return;
  n.textContent = msg;
  n.style.color = tone === 'err' ? 'var(--err)' : (tone === 'ok' ? 'var(--ok)' : '');
}

/** Small three.js preview of the cleaned mesh. */
async function previewMesh(group) {
  const THREE = window.aiEditor && window.aiEditor.three;
  const host = $('#scanView');
  if (!THREE || !host) return;
  host.innerHTML = '';
  const w = host.clientWidth || 300;
  const h = host.clientHeight || 220;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  r.setSize(w, h, false);
  host.appendChild(r.domElement);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x30303a, 1.5));
  const d = new THREE.DirectionalLight(0xffffff, 1.7);
  d.position.set(2, 4, 3);
  sc.add(d);
  const obj = group.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  obj.position.sub(ctr);
  sc.add(obj);
  const cam = new THREE.PerspectiveCamera(36, w / h, 0.01, 100);
  const rad = Math.max(size.x, size.y, size.z) * 2.0;
  let a = 0.7;
  const tick = () => {
    if (!host.isConnected || !host.contains(r.domElement)) { r.dispose(); return; }
    a += 0.006;
    cam.position.set(rad * Math.sin(a), rad * 0.42, rad * Math.cos(a));
    cam.lookAt(0, 0, 0);
    r.render(sc, cam);
    requestAnimationFrame(tick);
  };
  tick();
}

function refreshDims() {
  if (!STATE.imported) return;
  const mm = parseFloat($('#scanMm').value);
  const axis = $('#scanAxis').value;
  if (!Number.isFinite(mm) || mm <= 0) { $('#scanAdd').disabled = true; return; }
  try {
    // fitToDimension scales the group and reports the resulting dims; mirror
    // them onto the import so toUserItem() sees a 'user-measured' scan.
    const fit = fitToDimension(STATE.imported.group, axis, mm);
    STATE.imported.scale_confidence = fit.scale_confidence;
    STATE.imported.dims_mm = fit.dims_mm;
    STATE.imported.scale = fit.scale;
    const m = measureGroup(STATE.imported.group);
    $('#scanDims').textContent =
      `${Math.round(m.w_mm)} \u00d7 ${Math.round(m.d_mm)} \u00d7 ${Math.round(m.h_mm)} mm  `
      + `(w\u00d7d\u00d7h) \u2014 scaled from your ${axis} measurement`;
    $('#scanAdd').disabled = false;
  } catch (e) {
    $('#scanDims').textContent = `could not scale: ${e.message}`;
    $('#scanAdd').disabled = true;
  }
}

export function initScan({ onAdded } = {}) {
  const dlg = buildDialog();

  const open = () => (dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', ''));
  const close = () => (dlg.close ? dlg.close() : dlg.removeAttribute('open'));
  $('#scanClose').onclick = close;

  $('#scanFile').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    STATE.file = f;
    const img = $('#scanPreview');
    img.src = URL.createObjectURL(f);
    img.hidden = false;
    $('#scanDrop').querySelector('.scan-drop__hint').style.display = 'none';
    $('#scanGo').disabled = false;
    setStatus(`${f.name} \u00b7 ready`);
  };

  $('#scanGo').onclick = async () => {
    if (!STATE.file || STATE.busy) return;
    STATE.busy = true;
    $('#scanGo').disabled = true;
    setStatus('uploading\u2026');
    const t0 = performance.now();
    try {
      const provider = createHuggingFaceProvider({});
      const bytes = new Uint8Array(await STATE.file.arrayBuffer());
      const { job_id } = await provider.createObjectFromImages({
        images: [{ bytes, name: STATE.file.name, type: STATE.file.type || 'image/jpeg' }],
        name: $('#scanName').value || 'Scanned piece',
      });
      setStatus('queued on the free GPU\u2026 (~25s)');
      let job = null;
      for (let i = 0; i < 180; i++) {
        job = await provider.getJob(job_id);
        if (job.status === 'succeeded' || job.status === 'failed') break;
        setStatus(`reconstructing\u2026 ${Math.round((performance.now() - t0) / 1000)}s`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!job || job.status !== 'succeeded') {
        throw new Error((job && job.error) || 'reconstruction failed');
      }
      setStatus('cleaning up the mesh\u2026');
      const url = job.result && (job.result.mesh_url || job.result.url);
      STATE.imported = await importScannedItem(url, {
        name: $('#scanName').value || 'Scanned piece',
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const gp = STATE.imported.ground_plane_removed;
      let tris = 0;
      STATE.imported.group.traverse((o) => {
        const g = o.geometry;
        if (!g) return;
        tris += g.index ? g.index.count / 3 : (g.attributes.position
          ? g.attributes.position.count / 3 : 0);
      });
      const removed = (STATE.imported.report || {}).removed_triangles || 0;
      $('#scanMesh').textContent =
        `${Math.round(tris).toLocaleString()} triangles kept \u00b7 `
        + (gp ? `${removed.toLocaleString()} floor triangles removed` : 'no slab detected');
      setStatus(`done in ${secs}s \u2014 now give it a real measurement`, 'ok');
      await previewMesh(STATE.imported.group);
      refreshDims();
    } catch (e) {
      console.error('[scan]', e);
      setStatus(`failed: ${e.message}`.slice(0, 140), 'err');
    } finally {
      STATE.busy = false;
      $('#scanGo').disabled = false;
    }
  };

  $('#scanMm').oninput = refreshDims;
  $('#scanAxis').onchange = refreshDims;

  $('#scanAdd').onclick = () => {
    if (!STATE.imported || !window.aiEditor) return;
    const res = toUserItem(STATE.imported, {
      name: $('#scanName').value || 'Scanned piece',
      brand: 'scanned',
      category: 'decor',
    });
    if (!res.ok) {                     // guards the unscaled case (SPEC §8.8)
      setStatus(res.message || 'needs a real measurement first', 'err');
      return;
    }
    const item = res.item;
    item.__mesh = STATE.imported.group;
    window.aiEditor.registerItem(item);
    const id = window.aiEditor.add(item.id);
    if (onAdded) onAdded(item, id);
    close();
  };

  const btn = document.getElementById('scanBtn');
  if (btn) btn.onclick = open;
  return { open, close };
}

export default initScan;

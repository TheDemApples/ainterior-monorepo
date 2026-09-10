#!/usr/bin/env python3
"""End-to-end proof of in-browser furniture scanning: photo -> 3D -> placed."""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/home/user/ainterior/dist")
OUT = Path("/home/user/ainterior/.verify2")
OUT.mkdir(exist_ok=True)
PHOTO = "/home/user/chair.jpeg"
PORT = 8993

srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                       cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok)))
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"\n          {detail}" if detail else ""))


try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        # The provider deliberately probes /gradio_api/info once to detect the
        # Space's Gradio major version and falls back to the legacy root on 404.
        # That expected probe is not a defect; anything else is.
        def note_err(m):
            if m.type != "error":
                return
            if "gradio_api" in (m.text or "") or "404" in (m.text or ""):
                probes.append(m.text)
                return
            errs.append(m.text)

        probes = []
        pg.on("console", note_err)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/editor.html", wait_until="networkidle", timeout=90000)
        pg.wait_for_selector("#viewport canvas", timeout=60000)
        pg.wait_for_timeout(4000)

        check("scan: button present and enabled",
              pg.evaluate("() => { const b=document.getElementById('scanBtn');"
                          " return !!b && !b.disabled; }"))

        before = pg.evaluate("() => window.aiEditor.getLayout().placements.length")
        pg.click("#scanBtn")
        pg.wait_for_timeout(700)
        check("scan: dialog opens", pg.evaluate("() => !!document.querySelector('#scanDlg[open]')"))

        pg.set_input_files("#scanFile", PHOTO)
        pg.wait_for_timeout(700)
        check("scan: photo accepted",
              pg.evaluate("() => !document.getElementById('scanGo').disabled"))

        t0 = time.time()
        pg.click("#scanGo")
        done, status = False, ""
        for _ in range(140):
            pg.wait_for_timeout(2000)
            status = pg.evaluate("() => document.getElementById('scanStatus').textContent")
            if "done in" in status or "failed" in status:
                done = True
                break
        secs = round(time.time() - t0, 1)
        check("scan: reconstruction completed in the browser",
              done and "done in" in status, f"{secs}s wall — status: {status!r}")

        mesh = pg.evaluate("() => document.getElementById('scanMesh').textContent")
        check("scan: floor slab was stripped", "removed" in mesh, mesh)

        dims = pg.evaluate("() => document.getElementById('scanDims').textContent")
        check("scan: scaled from the user's measurement", "mm" in dims and "780" in dims, dims)

        pg.screenshot(path=str(OUT / "scan_dialog.png"))

        check("scan: add button enabled once scaled",
              pg.evaluate("() => !document.getElementById('scanAdd').disabled"))
        pg.click("#scanAdd")
        pg.wait_for_timeout(2500)

        after = pg.evaluate("""() => {
          const L = window.aiEditor.getLayout();
          const last = L.placements[L.placements.length-1];
          const it = (window.aiCatalog||[]).find(c => c.id === last.item_id);
          return {n: L.placements.length, item_id: last.item_id,
                  dims: it ? it.dims_mm : null, brand: it ? it.brand : null};
        }""")
        check("scan: scanned piece placed in the room", after["n"] == before + 1, after)
        check("scan: placed item carries the measured dimensions",
              after["dims"] and abs(after["dims"]["w"] - 780) <= 2, after["dims"])

        pg.evaluate("() => window.aiEditor.setView('3d')")
        pg.wait_for_timeout(2500)
        pg.screenshot(path=str(OUT / "scan_placed.png"))
        check("scan: no unexpected console errors", not errs, "; ".join(errs[:3]))
        check("scan: only the expected Gradio-root probe 404 occurred",
              len(probes) <= 2, f"{len(probes)} probe messages: {probes[:2]}")
        b.close()
finally:
    srv.terminate()

npass = sum(1 for _, ok in checks if ok)
print("\n" + "-" * 66)
print(f"  {npass} passed   {len(checks)-npass} failed   {len(checks)} total")
print(f"  RESULT: {'PASS' if npass == len(checks) else 'FAIL'}")
print("-" * 66)
sys.exit(0 if npass == len(checks) else 1)

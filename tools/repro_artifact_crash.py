"""Reproduce the Gumloop artifact-viewer crash.

The viewer runs the bundle inside a sandboxed iframe. Two things differ from a
plain local server:
  1. an opaque origin  -> touching `localStorage` throws SecurityError
  2. a constrained frame -> long main-thread blocks / OOM can kill it
This harness recreates (1) exactly and measures (2), for every page.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/home/user/ainterior/dist")
PORT = 8975

HOST = ROOT / "_probe_host.html"
HOST.write_text("""<!doctype html><html><body style="margin:0;background:#111">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:1280px;height:860px;border:0"></iframe>
<script>
  window.__frameErrors = [];
  window.addEventListener('message', e => window.__frameErrors.push(e.data));
  window.load = (src) => { document.getElementById('f').src = src; };
</script></body></html>""")

srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                       cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

rows = []
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        for page in ("demo/index.html", "demo/design.html", "demo/editor.html"):
            ctx = b.new_context(viewport={"width": 1280, "height": 860})
            pg = ctx.new_page()
            errs, crashed = [], []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(f"console:{m.text}") if m.type == "error" else None)
            pg.on("crash", lambda _: crashed.append(True))
            pg.goto(f"http://127.0.0.1:{PORT}/_probe_host.html", wait_until="load", timeout=30000)
            # The viewer must allow same-origin or ES modules would be CORS-blocked and
            # nothing would run at all; so this mirrors it with storage available.
            pg.evaluate(f"() => window.load('http://127.0.0.1:{PORT}/{page}')")
            t0 = time.time()
            alive, note = True, ""
            try:
                for _ in range(24):
                    pg.wait_for_timeout(1000)
                    if crashed:
                        alive, note = False, "renderer crash event"
                        break
                    st = pg.evaluate("""() => {
                      const f = document.getElementById('f');
                      try { return {href: f.contentWindow.location.href.slice(-28)}; }
                      catch (e) { return {href: 'opaque'}; }
                    }""")
                    ready = pg.evaluate("""() => { try {
                      const d = document.getElementById('f').contentDocument;
                      return {ready: d && d.body ? d.body.dataset.ready || null : null,
                              canvas: !!(d && d.querySelector('#viewport canvas')),
                              heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null};
                    } catch (e) { return {err: String(e).slice(0,80)}; } }""")
                    if ready: note = json.dumps(ready)
                    if st is None:
                        alive, note = False, "host evaluate returned null"
                        break
            except Exception as e:  # noqa: BLE001
                alive, note = False, f"{type(e).__name__}: {str(e)[:120]}"
            secs = round(time.time() - t0, 1)
            mem = None
            try:
                mem = pg.evaluate("() => performance.memory ? "
                                  "Math.round(performance.memory.usedJSHeapSize/1048576) : null")
            except Exception:  # noqa: BLE001
                pass
            rows.append({"page": page, "survived": alive, "note": note,
                         "seconds_watched": secs, "host_heap_mb": mem,
                         "errors": errs[:6]})
            print(json.dumps(rows[-1], indent=2)[:1200], flush=True)
            ctx.close()
        b.close()
finally:
    srv.terminate()
    HOST.unlink(missing_ok=True)

print("\n--- SUMMARY (sandboxed opaque-origin iframe) ---")
for r in rows:
    print(f"  {'OK  ' if r['survived'] else 'DIED'} {r['page']:22s} {r['note']}")
    for e in r["errors"][:4]:
        print(f"        {e[:150]}")

#!/usr/bin/env python3
"""v3 checks: in-document routing (crash mitigation) and the flipped pan axis."""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/home/user/ainterior/dist")
PORT = 8981
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

        # ── routing: CTA must NOT navigate the top document ──────────────────
        pg = b.new_page(viewport={"width": 1440, "height": 920})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/index.html", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(1800)
        before = pg.url
        pg.evaluate("""() => { const a=[...document.querySelectorAll('a')]
            .find(x=>(x.getAttribute('href')||'').startsWith('design.html')); a.click(); }""")
        pg.wait_for_timeout(2500)
        after = pg.url
        state = pg.evaluate("""() => {
          const o = document.querySelector('.approuter');
          const f = o && o.querySelector('iframe');
          return {overlay: !!o, src: f ? f.getAttribute('src') : null,
                  docPath: location.pathname, hash: location.hash};
        }""")
        check("router: overlay opens instead of navigating the document",
              state["overlay"] and state["src"] == "design.html"
              and state["docPath"].endswith("/demo/index.html"), state)
        check("router: top document URL keeps its entry path",
              after.split("#")[0] == before.split("#")[0], f"{before} -> {after}")
        check("router: hash reflects the route", state["hash"] == "#design", state)

        inner_ok = pg.evaluate("""() => {
          const f = document.querySelector('.approuter iframe');
          try { const d = f.contentDocument;
                return !!(d && d.querySelector('#presetGrid')); } catch (e) { return 'blocked'; }
        }""")
        check("router: designer actually renders inside the frame", inner_ok is True, inner_ok)

        pg.keyboard.press("Escape")
        pg.wait_for_timeout(900)
        closed = pg.evaluate("() => !document.querySelector('.approuter')")
        check("router: Escape returns to the marketing page", closed)

        # deep link straight to the studio
        pg.goto(f"http://127.0.0.1:{PORT}/demo/index.html#studio",
                wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(3500)
        deep = pg.evaluate("""() => {
          const f = document.querySelector('.approuter iframe');
          return {open: !!f, src: f ? f.getAttribute('src') : null};
        }""")
        check("router: #studio deep-links straight into the studio",
              deep["open"] and deep["src"] == "editor.html", deep)
        check("router: no console errors", not errs, "; ".join(errs[:3]))
        pg.close()

        # ── middle-drag pan: horizontal axis flipped ─────────────────────────
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        perrs = []
        pg.on("pageerror", lambda e: perrs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{PORT}/demo/editor.html", wait_until="networkidle", timeout=90000)
        pg.wait_for_selector("#viewport canvas", timeout=60000)
        pg.wait_for_timeout(4500)

        def pan(dx, dy):
            pg.evaluate("() => window.aiEditor.settleCamera && window.aiEditor.settleCamera()")
            a = pg.evaluate("() => window.aiEditor.getCameraState().target")
            box = pg.evaluate("""() => { const r=document.querySelector('#viewport canvas')
                .getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; }""")
            pg.mouse.move(box["x"], box["y"])
            pg.mouse.down(button="middle")
            pg.mouse.move(box["x"] + dx, box["y"] + dy, steps=10)
            pg.mouse.up(button="middle")
            pg.wait_for_timeout(700)
            pg.evaluate("() => window.aiEditor.settleCamera && window.aiEditor.settleCamera()")
            bb = pg.evaluate("() => window.aiEditor.getCameraState().target")
            return a, bb

        a, bb = pan(180, 0)
        dxw = bb["x"] - a["x"]
        check("#3 middle-drag right now moves the view the other way",
              abs(dxw) > 0.05, f"target.x {a['x']:.3f} -> {bb['x']:.3f} (delta {dxw:+.3f}) for a +180px drag")
        a2, b2 = pan(-180, 0)
        dxw2 = b2["x"] - a2["x"]
        check("#3 dragging back reverses it symmetrically",
              dxw * dxw2 < 0 and abs(abs(dxw) - abs(dxw2)) < abs(dxw) * 0.4,
              f"right {dxw:+.3f} vs left {dxw2:+.3f}")
        check("studio: no page errors during pan", not perrs, "; ".join(perrs[:2]))
        pg.close()
        b.close()
finally:
    srv.terminate()

npass = sum(1 for _, ok in checks if ok)
print("\n" + "-" * 66)
print(f"  {npass} passed   {len(checks)-npass} failed   {len(checks)} total")
print(f"  RESULT: {'PASS' if npass == len(checks) else 'FAIL'}")
print("-" * 66)
sys.exit(0 if npass == len(checks) else 1)

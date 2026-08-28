#!/usr/bin/env python3
"""End-to-end browser verification of the ainterior demo.

Drives demo/index.html (marketing) and demo/editor.html (3D studio) in a real
browser: asserts zero console errors, exercises the editor API, the AI layout
path against the real 201-item catalog, and the blueprint export, then captures
screenshots for visual inspection.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".verify"
OUT.mkdir(exist_ok=True)
PORT = 8842

srv = subprocess.Popen(
    [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
    cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
time.sleep(1.5)

results = {"errors": [], "checks": []}


def check(name, ok, detail=""):
    results["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"\n          {detail}" if detail else ""))
    return ok


try:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])

        # ─────────────────────────── marketing page ───────────────────────────
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        msgs, pageerrs, failed = [], [], []
        page.on("console", lambda m: msgs.append((m.type, m.text)))
        page.on("pageerror", lambda e: pageerrs.append(str(e)))
        page.on("requestfailed", lambda r: failed.append(f"{r.url} {r.failure}"))
        page.goto(f"http://127.0.0.1:{PORT}/demo/index.html", wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(2500)

        cerr = [t for (k, t) in msgs if k == "error"]
        check("marketing: zero console errors", not cerr and not pageerrs,
              "; ".join(cerr[:3] + pageerrs[:3]))
        check("marketing: zero failed requests", not failed, "; ".join(failed[:3]))

        # does the CTA actually point at the editor?
        href = page.evaluate(
            "() => { const a=[...document.querySelectorAll('a')]"
            ".find(x=>/editor\\.html/.test(x.getAttribute('href')||'')); return a?a.getAttribute('href'):null; }")
        check("marketing: a CTA links to editor.html", href is not None, f"href={href}")

        revealed = page.evaluate("() => document.querySelectorAll('.is-in').length")
        check("marketing: scroll reveals fired", revealed > 0, f"{revealed} revealed")

        # brand default is dark regardless of OS preference, with an explicit opt-out
        dark0 = page.evaluate("() => document.documentElement.classList.contains('dark')")
        bg0 = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
        check("marketing: defaults to dark (brand parity with the studio)",
              dark0 and "11, 11, 12" in bg0, f"dark={dark0} bg={bg0}")
        page.click("#themeToggle")
        page.wait_for_timeout(500)
        light1 = page.evaluate(
            "() => ({dark: document.documentElement.classList.contains('dark'),"
            " bg: getComputedStyle(document.body).backgroundColor,"
            " saved: localStorage.getItem('ainterior-theme')})")
        check("marketing: theme toggle switches to light and persists",
              (not light1["dark"]) and "245, 242, 237" in light1["bg"] and light1["saved"] == "light",
              light1)
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)
        kept = page.evaluate("() => document.documentElement.classList.contains('dark')")
        check("marketing: explicit light choice survives reload", not kept, f"dark={kept}")
        page.evaluate("() => { localStorage.removeItem('ainterior-theme'); }")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)
        back = page.evaluate("() => document.documentElement.classList.contains('dark')")
        check("marketing: clearing the choice returns to dark", back, f"dark={back}")

        for w in (400, 900, 1440):
            page.set_viewport_size({"width": w, "height": 900})
            page.wait_for_timeout(700)
            ox = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(f"marketing: no horizontal overflow @{w}px", ox <= 1, f"overflow {ox}px")
            page.screenshot(path=str(OUT / f"marketing_{w}.png"))
        page.close()

        # ──────────────────────────── editor page ─────────────────────────────
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        msgs, pageerrs, failed = [], [], []
        page.on("console", lambda m: msgs.append((m.type, m.text)))
        page.on("pageerror", lambda e: pageerrs.append(str(e)))
        page.on("requestfailed", lambda r: failed.append(f"{r.url} {r.failure}"))
        page.goto(f"http://127.0.0.1:{PORT}/demo/editor.html", wait_until="networkidle", timeout=90000)
        page.wait_for_selector("#viewport canvas", timeout=60000)
        page.wait_for_timeout(3000)

        cerr = [t for (k, t) in msgs if k == "error"]
        check("editor: zero console errors", not cerr and not pageerrs,
              "; ".join(cerr[:4] + pageerrs[:4]))
        check("editor: zero failed requests", not failed, "; ".join(failed[:4]))

        # real catalog wired in?
        ncat = page.evaluate("() => (window.aiCatalog||[]).length")
        check("editor: real 201-item catalog loaded", ncat >= 200, f"{ncat} items")

        engine = page.evaluate("() => (document.querySelector('#engineInfo')||{}).textContent")
        check("editor: layout-engine detected (not fallback)",
              engine and "layout-engine" in engine, f"engineInfo={engine!r}")

        # catalog browser actually rendered rows
        rows = page.evaluate("() => document.querySelectorAll('#catList [role=listitem], #catList .cat-row').length")
        check("editor: catalog browser rendered rows", rows > 20, f"{rows} rows")

        n0 = page.evaluate("() => window.aiEditor.getLayout().placements.length")
        check("editor: seeded layout has furniture", n0 > 0, f"{n0} placements")

        # exercise the §5.3 API
        api = page.evaluate("""() => {
          const e = window.aiEditor, out = {};
          const before = e.getLayout().placements.length;
          const id = e.add(window.aiCatalog[0].id, {x_mm: 1200, y_mm: 1200, rot_deg: 0});
          out.added = e.getLayout().placements.length - before;
          const dup = e.duplicate(id);
          out.duplicated = !!dup;
          e.select(dup);
          out.dims = !!e.getDimensions;
          e.remove(dup); e.remove(id);
          out.after = e.getLayout().placements.length;
          out.before = before;
          e.setView('top'); out.top = true;
          e.setView('3d');
          e.setUnit('ft'); e.setUnit('cm');
          const snap = e.snapshot({width: 900, height: 560});
          out.snapLen = (snap||'').length;
          out.snapPng = (snap||'').startsWith('data:image/png');
          return out;
        }""")
        check("editor: add() inserts one placement", api["added"] == 1, api)
        check("editor: duplicate() returns a new instance", api["duplicated"], api)
        check("editor: remove() restores original count", api["after"] == api["before"], api)
        check("editor: snapshot() returns a real PNG",
              api["snapPng"] and api["snapLen"] > 20000, f"{api['snapLen']} chars")

        # AI arrange over the real catalog
        page.click("#aiBtn")
        page.wait_for_timeout(2500)
        ai = page.evaluate("""() => {
          const L = window.aiEditor.getLayout();
          return {n: L.placements.length, rationale: (L.rationale||[]).length};
        }""")
        check("editor: AI arrange produced a layout", ai["n"] > 0, ai)
        cerr = [t for (k, t) in msgs if k == "error"]
        check("editor: no console errors after AI arrange", not cerr, "; ".join(cerr[:3]))

        page.screenshot(path=str(OUT / "editor_3d.png"))
        page.evaluate("() => window.aiEditor.setView('top')")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / "editor_top.png"))
        page.evaluate("() => window.aiEditor.setView('3d')")
        page.wait_for_timeout(800)

        # ─────────────────────────── blueprint export ─────────────────────────
        page.click("#bpBtn")
        page.wait_for_timeout(3000)
        bp = page.evaluate("""() => {
          const host = document.querySelector('#bpHost');
          const svg = host && host.querySelector('svg');
          if (!svg) return {ok: false, html: (host && host.textContent || '').slice(0,200)};
          const texts = [...svg.querySelectorAll('text')].map(t => t.textContent);
          return {
            ok: true,
            texts: texts.length,
            markup: svg.outerHTML.length,
            meta: (document.querySelector('#bpMeta')||{}).textContent,
            dl: (document.querySelector('#bpDl')||{}).href ? true : false,
            sample: texts.slice(0, 6),
          };
        }""")
        check("blueprint: SVG rendered into the dialog", bp.get("ok"), bp.get("html", ""))
        if bp.get("ok"):
            check("blueprint: sheet carries text labels", bp["texts"] > 30, f"{bp['texts']} <text> nodes")
            check("blueprint: markup is substantial", bp["markup"] > 20000, f"{bp['markup']} chars")
            check("blueprint: download href present", bp["dl"], bp.get("meta"))
            print(f"          meta: {bp.get('meta')}")
            print(f"          sample labels: {bp.get('sample')}")
        page.screenshot(path=str(OUT / "editor_blueprint.png"))

        # A4 re-render path
        page.click("#bpPaperSeg button[data-paper='A4']")
        page.wait_for_timeout(2000)
        a4 = page.evaluate("() => { const s=document.querySelector('#bpHost svg'); return s? s.outerHTML.length:0; }")
        check("blueprint: A4 re-render works", a4 > 15000, f"{a4} chars")

        cerr = [t for (k, t) in msgs if k == "error"]
        check("editor: zero console errors overall", not cerr and not pageerrs,
              "; ".join(cerr[:4] + pageerrs[:4]))

        # narrow viewport sanity for the studio
        page.set_viewport_size({"width": 900, "height": 800})
        page.wait_for_timeout(1000)
        page.screenshot(path=str(OUT / "editor_900.png"))

        browser.close()
finally:
    srv.terminate()

npass = sum(1 for c in results["checks"] if c["ok"])
nfail = len(results["checks"]) - npass
print("\n" + "-" * 66)
print(f"  {npass} passed   {nfail} failed   {len(results['checks'])} total")
print(f"  RESULT: {'PASS' if nfail == 0 else 'FAIL'}")
print("-" * 66)
(OUT / "results.json").write_text(json.dumps(results, indent=2))
sys.exit(1 if nfail else 0)

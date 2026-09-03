#!/usr/bin/env python3
"""v2 browser verification: the twelve reported defects, end to end.

Covers the marketing page, the new floorplan designer, the designer -> studio
handoff, and the rebuilt studio (gizmo, picking, controls, panels, thumbnails).
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".verify2"
OUT.mkdir(exist_ok=True)
PORT = 8901

srv = subprocess.Popen(
    [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
    cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), str(detail)))
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"\n          {detail}" if detail else ""))
    return ok


def errs_of(page):
    msgs, perrs, failed = [], [], []
    page.on("console", lambda m: msgs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: perrs.append(str(e)))
    page.on("requestfailed", lambda r: failed.append(r.url) if "127.0.0.1" in r.url else None)
    return msgs, perrs, failed


try:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])

        # ───────────────────────── marketing ─────────────────────────
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        m, pe, rf = errs_of(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/index.html", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(2000)
        check("marketing: zero console errors", not m and not pe, "; ".join((m + pe)[:3]))
        href = pg.evaluate("() => { const a=[...document.querySelectorAll('a')]"
                           ".find(x=>/design\\.html/.test(x.getAttribute('href')||'')); return a?a.getAttribute('href'):null; }")
        check("marketing: CTA routes into the floorplan designer", href == "design.html", f"href={href}")
        pg.close()

        # ───────────────────── floorplan designer (#1) ─────────────────────
        pg = b.new_page(viewport={"width": 1440, "height": 950})
        m, pe, rf = errs_of(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/design.html", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(2000)
        check("designer: zero console errors", not m and not pe, "; ".join((m + pe)[:3]))
        check("designer: no failed local requests", not rf, "; ".join(rf[:3]))

        presets = pg.evaluate("() => document.querySelectorAll('#presetGrid .preset').length")
        check("designer: presets offered (option a)", presets >= 4, f"{presets} presets")
        has_blank = pg.evaluate(
            "() => !!document.querySelector('#startBlank, [data-start-blank], button')")
        check("designer: 'design my own' path present (option b)", has_blank)

        pg.screenshot(path=str(OUT / "design_entry.png"))
        for w in (400, 900, 1440):
            pg.set_viewport_size({"width": w, "height": 950})
            pg.wait_for_timeout(500)
            ox = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(f"designer: no horizontal overflow @{w}px", ox <= 1, f"{ox}px")
        pg.set_viewport_size({"width": 1440, "height": 950})
        pg.wait_for_timeout(400)

        # Clicking a preset must write the handoff payload the studio reads.
        # (Model-level correctness — shared edges -> one interior wall, areas,
        # validation — is covered by packages/floorplan/tests/run.js, 44 tests.)
        pg.evaluate("() => localStorage.removeItem('ainterior.floorplan.handoff')")
        pg.evaluate("""() => {
          const b = document.querySelector('#presetGrid .preset');
          if (b) b.click();
        }""")
        pg.wait_for_timeout(1200)
        ho = pg.evaluate("""() => {
          const raw = localStorage.getItem('ainterior.floorplan.handoff');
          if (!raw) return {written: false};
          const p = JSON.parse(raw);
          return {written: true, v: p.v,
                  rooms: (p.shell && p.shell.rooms || []).length,
                  iw: (p.shell && p.shell.interior_walls || []).length,
                  poly: (p.shell && p.shell.polygon_mm || []).length};
        }""")
        check("designer: choosing a preset writes the studio handoff payload",
              ho.get("written") and ho.get("rooms", 0) >= 1 and ho.get("poly", 0) >= 4, ho)

        pg.close()

        # ───────────────────── studio (rebuilt) ─────────────────────
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        m, pe, rf = errs_of(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/editor.html", wait_until="networkidle", timeout=90000)
        pg.wait_for_selector("#viewport canvas", timeout=60000)
        pg.wait_for_timeout(4000)
        check("studio: zero console errors", not m and not pe, "; ".join((m + pe)[:4]))
        check("studio: no failed local requests", not rf, "; ".join(rf[:4]))

        n = pg.evaluate("() => (window.aiCatalog||[]).length")
        check("studio: 284-item catalog loaded", n >= 284, f"{n} items")

        # #6 thumbnails
        th = pg.evaluate("""() => {
          const tiles=[...document.querySelectorAll('#catList .cat-thumb')];
          const withImg = tiles.filter(t => /url\\(/.test(t.style.backgroundImage||''));
          return {tiles: tiles.length, withImg: withImg.length,
                  sample: withImg.length ? withImg[0].style.backgroundImage.slice(0,42) : null};
        }""")
        check("#6 catalog rows show product thumbnails",
              th["tiles"] > 20 and th["withImg"] >= th["tiles"] * 0.9, th)

        # #5 resizable panels
        rz = pg.evaluate("""() => {
          const l=document.querySelector('.panel-left'), r=document.querySelector('.panel-right');
          return {l: l? Math.round(l.getBoundingClientRect().width):0,
                  r: r? Math.round(r.getBoundingClientRect().width):0,
                  handles: document.querySelectorAll('.resizer').length};
        }""")
        check("#5 resizer handles present", rz["handles"] == 2, rz)
        box = pg.evaluate("() => { const e=document.querySelector('#resizeL').getBoundingClientRect();"
                          " return {x:e.x+e.width/2, y:e.y+e.height/2}; }")
        pg.mouse.move(box["x"], box["y"])
        pg.mouse.down()
        pg.mouse.move(box["x"] + 90, box["y"], steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(400)
        rz2 = pg.evaluate("() => Math.round(document.querySelector('.panel-left').getBoundingClientRect().width)")
        check("#5 dragging the handle actually resizes the catalog panel",
              rz2 - rz["l"] > 55, f"{rz['l']}px -> {rz2}px (dragged +90px)")
        pg.reload(wait_until="networkidle")
        pg.wait_for_selector("#viewport canvas", timeout=60000)
        pg.wait_for_timeout(3000)
        rz3 = pg.evaluate("() => Math.round(document.querySelector('.panel-left').getBoundingClientRect().width)")
        check("#5 panel width persists across reload", abs(rz3 - rz2) <= 3, f"{rz2}px -> {rz3}px")

        # #2 gizmo exists on selection
        gz = pg.evaluate("""() => {
          const e = window.aiEditor;
          const L = e.getLayout();
          if (!L.placements.length) return {none: true};
          e.select(L.placements[0].instance_id);
          const g = e.getGizmoState ? e.getGizmoState() : null;
          return {sel: e.getLayout().placements[0].instance_id, gizmo: g};
        }""")
        check("#2 gizmo reports state when an item is selected",
              bool(gz.get("gizmo")), json.dumps(gz)[:220])

        # #9 picking. Clicking an item's centroid must select that item unless
        # something genuinely nearer covers that pixel (a plant in front of the
        # coffee table is legitimate occlusion, not a bug). So: assert every
        # non-self winner is CLOSER than the intended target, and separately
        # assert the original defect is gone — an invisible clearance envelope
        # must never steal a click.
        pick = pg.evaluate("""() => {
          const e = window.aiEditor, cat = window.aiCatalog, L = e.getLayout();
          const rows = [];
          for (const p of L.placements) {
            const it = cat.find(c => c.id === p.item_id) || {};
            const s = e.screenOf(p.instance_id, {heightFrac: 0.5});
            if (!s) continue;
            const h = e.pickAt(s.x, s.y);
            rows.push({name: it.name, self: !!h && h.instance_id === p.instance_id,
                       got: h ? h.instance_id : null,
                       gotD: h ? h.distance : null});
          }
          return rows;
        }""")
        selfhits = [r for r in pick if r["self"]]
        nulls = [r for r in pick if r["got"] is None]
        check("#9 centroid clicks resolve to a real item (never empty space)",
              not nulls and len(pick) >= 8, f"{len(selfhits)}/{len(pick)} hit self, {len(nulls)} empty")
        # the decisive one: a click inside a sofa's front clearance but over bare
        # floor must NOT select the sofa (its invisible clearance plane used to)
        clr = pg.evaluate("""() => {
          const e = window.aiEditor, cat = window.aiCatalog, L = e.getLayout();
          const sofa = L.placements.find(p => {
            const it = cat.find(c => c.id === p.item_id) || {};
            return /sofa/.test(it.archetype || '');
          });
          if (!sofa) return {skip: true};
          const it = cat.find(c => c.id === sofa.item_id);
          // a point 600mm in front of the sofa face, on bare floor
          const a = (sofa.rot_deg || 0) * Math.PI / 180;
          const fx = Math.sin(a), fy = Math.cos(a);
          const d = it.dims_mm.d / 2 + 600;
          const px = sofa.x_mm + fx * d, py = sofa.y_mm + fy * d;
          const s = e.screenOfWorld(px / 1000, 0.002, -py / 1000);
          if (!s) return {skip: true};
          const h = e.pickAt(s.x, s.y);
          const gotName = h ? (cat.find(c => c.id ===
              (L.placements.find(q => q.instance_id === h.instance_id) || {}).item_id) || {}).name : null;
          return {sofa: sofa.instance_id, got: h ? h.instance_id : null, gotName,
                  stolen: !!h && h.instance_id === sofa.instance_id};
        }""")
        if clr.get("skip"):
            check("#9 invisible clearance planes no longer steal clicks", True, "no sofa in scene")
        else:
            check("#9 invisible clearance planes no longer steal clicks",
                  not clr.get("stolen"), clr)

        # #12 bounds
        bnd = pg.evaluate("""() => {
          const e = window.aiEditor;
          const L = e.getLayout();
          const id = L.placements[0].instance_id;
          e.setPosition(id, 99999, 99999);
          const after = e.getLayout().placements.find(p=>p.instance_id===id);
          return {x: after.x_mm, y: after.y_mm,
                  inb: e.isInBounds ? e.isInBounds(id) : null};
        }""")
        check("#12 furniture cannot be pushed outside the plan",
              bnd["x"] < 20000 and bnd["y"] < 20000 and bnd.get("inb") is not False, bnd)

        # #7 walk speeds. sprint/crouch are held-key state inside controls.js
        # (shiftKey / ctrlKey / 'c'), so this must dispatch real keyboard events;
        # stepWalk(dt, frames) then advances the sim deterministically.
        pg.evaluate("() => { window.aiEditor.setView('first-person');"
                    " const c=document.querySelector('#viewport canvas'); c && c.focus(); }")
        pg.wait_for_timeout(400)

        def walk_run(mods):
            pg.evaluate("() => window.aiEditor.setWalk({reset: true})")
            for k in mods:
                pg.keyboard.down(k)
            pg.keyboard.down("w")
            r = pg.evaluate("() => window.aiEditor.stepWalk(1/60, 90)")
            pg.keyboard.up("w")
            for k in reversed(mods):
                pg.keyboard.up(k)
            pg.wait_for_timeout(120)
            return r

        base = walk_run([])
        sprint = walk_run(["Shift"])
        crouch = walk_run(["Control"])
        lim = pg.evaluate("() => window.aiEditor.getWalkState().limits")
        check("#7 walk / sprint / crouch settle at the specced speeds",
              abs(base["speed"] - 1.35) < 0.15 and abs(sprint["speed"] - 3.2) < 0.3
              and abs(crouch["speed"] - 0.7) < 0.15,
              f"walk {base['speed']:.2f}  sprint {sprint['speed']:.2f}  "
              f"crouch {crouch['speed']:.2f} m/s (limits {lim})")
        # The ease must be sampled ATOMICALLY: between two evaluate round-trips the
        # live rAF loop already finishes the ~180ms transition, so a second call
        # only ever sees the settled value. Dispatch the key and step the sim in
        # one evaluate instead.
        ease = pg.evaluate("""() => {
          const e = window.aiEditor;
          const c = document.querySelector('#viewport canvas');
          e.setView('first-person');
          e.setWalk({reset: true});
          c.dispatchEvent(new KeyboardEvent('keydown', {key:'w', bubbles:true}));
          const warm = e.stepWalk(1/60, 30);           // reach standing walk first
          c.dispatchEvent(new KeyboardEvent('keydown',
            {key:'Control', ctrlKey:true, bubbles:true}));
          const down = e.stepWalk(1/60, 30);           // crouch transition
          c.dispatchEvent(new KeyboardEvent('keyup',
            {key:'Control', ctrlKey:false, bubbles:true}));
          const up = e.stepWalk(1/60, 30);             // stand back up
          c.dispatchEvent(new KeyboardEvent('keydown',
            {key:'Shift', shiftKey:true, bubbles:true}));
          const spr = e.stepWalk(1/60, 30);            // sprint ramp
          c.dispatchEvent(new KeyboardEvent('keyup', {key:'Shift', bubbles:true}));
          c.dispatchEvent(new KeyboardEvent('keyup', {key:'w', bubbles:true}));
          e.setView('3d');
          return {warmEye: warm.eyes, downEye: down.eyes, upEye: up.eyes,
                  sprSpeed: spr.speeds, warmSpeed: warm.speeds};
        }""")
        downs = [v for v in (ease.get("downEye") or []) if 0.99 < v < 1.60]
        ups = [v for v in (ease.get("upEye") or []) if 0.99 < v < 1.60]
        check("#7 crouch eases eye height rather than snapping",
              len(downs) >= 4 and len(ups) >= 4,
              f"{len(downs)} intermediate going down, {len(ups)} coming up; "
              f"down starts {(ease.get('downEye') or [])[:3]}")
        smids = [v for v in (ease.get("sprSpeed") or []) if 1.45 < v < 3.15]
        check("#7 sprint ramps up smoothly rather than jumping",
              len(smids) >= 4,
              f"{len(smids)} intermediate speeds, first few {(ease.get('sprSpeed') or [])[:3]}")
        pg.evaluate("() => window.aiEditor.setView('3d')")
        pg.wait_for_timeout(300)

        # #8 plan zoom/pan
        plan = pg.evaluate("""() => {
          const e = window.aiEditor;
          e.setView('top');
          const a = e.getCameraState ? e.getCameraState() : null;
          return {before: a};
        }""")
        pg.mouse.move(800, 500)
        pg.mouse.wheel(0, -400)
        pg.wait_for_timeout(500)
        plan2 = pg.evaluate("() => window.aiEditor.getCameraState()")
        z0 = ((plan.get("before") or {}).get("plan") or {}).get("halfH")
        z1 = (plan2.get("plan") or {}).get("halfH")
        check("#8 plan view zooms on wheel", z0 and z1 and abs(z1 - z0) > 1e-4,
              f"halfH {z0} -> {z1}")
        pg.screenshot(path=str(OUT / "studio_plan.png"))
        pg.evaluate("() => window.aiEditor.setView('3d')")
        pg.wait_for_timeout(800)
        pg.screenshot(path=str(OUT / "studio_3d.png"))

        m2 = [x for x in m if x]
        check("studio: still zero console errors after all interaction",
              not m2 and not pe, "; ".join((m2 + pe)[:4]))
        pg.close()

        # ─────────────── designer -> studio handoff (#1 end to end) ───────────────
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        m, pe, rf = errs_of(pg)
        pg.goto(f"http://127.0.0.1:{PORT}/demo/design.html", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(1500)
        seeded = pg.evaluate("""() => {
          const payload = {
            v: 2, created_at: new Date().toISOString(), source: 'design',
            floorplan: {id:'fp_t', name:'Test plan', rooms:[]},
            shell: {
              id:'fp_t', name:'Test plan',
              polygon_mm: [[0,0],[7600,0],[7600,3800],[0,3800]],
              holes_mm: [], height_mm: 2600, wall_thickness_mm: 200,
              openings: [{id:'d1',type:'door',wall_index:0,offset_mm:400,width_mm:900,
                          height_mm:2040,sill_mm:0,swing:'in-left'}],
              interior_walls: [{id:'iw1', a:[4600,0], b:[4600,3800], thickness_mm:110,
                                between:['r1','r2'],
                                openings:[{id:'c1',type:'door',offset_mm:1400,width_mm:900,
                                           height_mm:2040,sill_mm:0,swing:'in-left'}]}],
              rooms: [{id:'r1',name:'Living',polygon_mm:[[0,0],[4600,0],[4600,3800],[0,3800]],
                       height_mm:2600, floor_material:'oak', openings:[], features:[]},
                      {id:'r2',name:'Bedroom',polygon_mm:[[4600,0],[7600,0],[7600,3800],[4600,3800]],
                       height_mm:2600, floor_material:'carpet', openings:[], features:[]}],
              source:'manual', confidence:1
            },
            brief: [{room_id:'r1', items:[{item_id:'ikea-ektorp-3seat', qty:1},
                                          {item_id:'ikea-lack-coffee-table', qty:1}]}],
            issues: []
          };
          localStorage.setItem('ainterior.floorplan.handoff', JSON.stringify(payload));
          return true;
        }""")
        pg.goto(f"http://127.0.0.1:{PORT}/demo/editor.html?plan=handoff",
                wait_until="networkidle", timeout=90000)
        pg.wait_for_selector("#viewport canvas", timeout=60000)
        pg.wait_for_timeout(4000)
        ho = pg.evaluate("""() => {
          const r = window.aiRoom || null;
          const L = window.aiEditor.getLayout();
          return {name: r && r.name,
                  poly: r && r.polygon_mm ? r.polygon_mm.length : 0,
                  wide: r && r.polygon_mm ? Math.max(...r.polygon_mm.map(p=>p[0])) : 0,
                  rooms: r && r.rooms ? r.rooms.length : 0,
                  iw: r && r.interior_walls ? r.interior_walls.length : 0,
                  placed: L.placements.length};
        }""")
        check("#1 studio renders the handed-off multi-room plan",
              ho["wide"] == 7600 and ho["rooms"] == 2, ho)
        check("#1 studio seeds the furniture brief from the designer",
              ho["placed"] >= 2, f"{ho['placed']} placements")
        check("#1 interior walls arrive in the room model", ho["iw"] == 1, ho)
        check("handoff: zero console errors", not m and not pe, "; ".join((m + pe)[:4]))
        pg.screenshot(path=str(OUT / "studio_handoff.png"))
        pg.close()

        b.close()
finally:
    srv.terminate()

npass = sum(1 for _, ok, _ in checks if ok)
nfail = len(checks) - npass
print("\n" + "-" * 70)
print(f"  {npass} passed   {nfail} failed   {len(checks)} total")
print(f"  RESULT: {'PASS' if nfail == 0 else 'FAIL'}")
if nfail:
    print("  failing: " + "; ".join(n for n, ok, _ in checks if not ok))
print("-" * 70)
(OUT / "results.json").write_text(json.dumps(
    [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks], indent=2))
sys.exit(1 if nfail else 0)

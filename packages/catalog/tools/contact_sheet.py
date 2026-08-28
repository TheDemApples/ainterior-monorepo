# -*- coding: utf-8 -*-
"""Rasterises every catalog item's primitive proxy to an isometric tile and assembles a
contact sheet, so the geometry can be eyeballed instead of trusted.

    python3 tools/contact_sheet.py [--out contact_sheet.png] [--cols 12] [--tile 210]
    python3 tools/contact_sheet.py --only sofa_3seat,armchair --tile 420 --cols 4

Hand-rolled orthographic/isometric projector with a painter's-algorithm depth sort.
No three.js, no browser -- PIL only.
"""
import json, math, os, sys, argparse
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SS = 2  # supersample factor

BG = (18, 18, 21)
TILE_BG = (26, 26, 30)
GRID = (44, 44, 50)
INK = (245, 242, 237)
MUTED = (138, 138, 147)
BLUEPRINT = (59, 110, 246)
CLAY = (220, 107, 71)

ROLE = {"wood": "#C8A87C", "metal": "#9AA0A6", "glass": "#B8CEDA", "dark": "#34353B"}

FACE_SHADE = {"top": 1.16, "+y": 0.98, "-y": 0.70, "+x": 0.82, "-x": 0.58, "bot": 0.46}


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def shade(rgb, f):
    return tuple(max(0, min(255, int(c * f))) for c in rgb)


def lift(rgb, floor=64):
    """Contact-sheet legibility only: very dark colorways (FRIHETEN, black TVs, MARKUS)
    collapse into the dark tile background. This lifts luminance for the review render
    and never touches catalog.json."""
    lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
    if lum >= floor:
        return rgb
    k = (floor + 26) / max(1.0, lum)
    return tuple(min(255, int(c * k + 18)) for c in rgb)


def resolve_color(role, cw_hex):
    if role.startswith("#"):
        return lift(hex2rgb(role))
    if role in ("body", "fabric"):
        return lift(hex2rgb(cw_hex))
    return lift(hex2rgb(ROLE.get(role, "#8A8A93")))


# ------------------------------------------------------------------ projection
COS30, SIN30 = math.cos(math.radians(30)), math.sin(math.radians(30))

def proj(x, y, z):
    return ((x - y) * COS30, (x + y) * SIN30 - z)

def depth(x, y, z):
    return x + y + z


def box_faces(x, y, z, sx, sy, sz):
    hx, hy, hz = sx / 2.0, sy / 2.0, sz / 2.0
    X0, X1 = x - hx, x + hx
    Y0, Y1 = y - hy, y + hy
    Z0, Z1 = z - hz, z + hz
    return [
        ("bot", [(X0, Y0, Z0), (X1, Y0, Z0), (X1, Y1, Z0), (X0, Y1, Z0)]),
        ("-x", [(X0, Y0, Z0), (X0, Y1, Z0), (X0, Y1, Z1), (X0, Y0, Z1)]),
        ("-y", [(X0, Y0, Z0), (X1, Y0, Z0), (X1, Y0, Z1), (X0, Y0, Z1)]),
        ("+x", [(X1, Y0, Z0), (X1, Y1, Z0), (X1, Y1, Z1), (X1, Y0, Z1)]),
        ("+y", [(X0, Y1, Z0), (X1, Y1, Z0), (X1, Y1, Z1), (X0, Y1, Z1)]),
        ("top", [(X0, Y0, Z1), (X1, Y0, Z1), (X1, Y1, Z1), (X0, Y1, Z1)]),
    ]


def cyl_faces(x, y, z, dia, hh, seg=16):
    r = dia / 2.0
    z0, z1 = z - hh / 2.0, z + hh / 2.0
    out = []
    ring = [(x + r * math.cos(2 * math.pi * k / seg), y + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
    for k in range(seg):
        ax, ay = ring[k]
        bx, by = ring[(k + 1) % seg]
        nx, ny = (ax + bx) / 2 - x, (ay + by) / 2 - y
        # simple lambert against the iso light direction (+x, +y, +z)
        n = math.hypot(nx, ny) or 1
        lam = 0.55 + 0.45 * max(0.0, (nx / n * 0.62 + ny / n * 0.62))
        out.append((lam, [(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)]))
    out.append((FACE_SHADE["top"], [(px, py, z1) for (px, py) in ring]))
    return out


def collect(item, tile_px):
    """Returns (draw_ops, screen bbox) where each op is (depth, polygon_pts, rgb)."""
    cw = item["colorways"][0]["hex"]
    ops = []
    for p in item["proxy"]["parts"]:
        x, y, z = p["pos"]
        sx, sy, sz = p["size"]
        base = resolve_color(p["color"], cw)
        if p["shape"] == "box":
            for name, quad in box_faces(x, y, z, sx, sy, sz):
                c = shade(base, FACE_SHADE[name])
                dep = sum(depth(*v) for v in quad) / 4.0
                ops.append((dep, [proj(*v) for v in quad], c))
        elif p["shape"] == "cyl":
            for lam, quad in cyl_faces(x, y, z, sx, sz):
                c = shade(base, lam)
                dep = sum(depth(*v) for v in quad) / len(quad)
                ops.append((dep, [proj(*v) for v in quad], c))
        elif p["shape"] == "sphere":
            r = sx / 2.0
            for lam, quad in cyl_faces(x, y, z, sx * 0.94, sz * 0.94, seg=12):
                c = shade(base, lam)
                dep = sum(depth(*v) for v in quad) / len(quad)
                ops.append((dep, [proj(*v) for v in quad], c))
        elif p["shape"] == "plane":  # horizontal sheet, normal = +z
            hx, hy = sx / 2.0, sy / 2.0
            quad = [(x - hx, y - hy, z), (x + hx, y - hy, z), (x + hx, y + hy, z), (x - hx, y + hy, z)]
            ops.append((sum(depth(*v) for v in quad) / 4.0 - 1, [proj(*v) for v in quad],
                        shade(base, 1.05)))
    ops.sort(key=lambda o: o[0])
    xs = [pt[0] for o in ops for pt in o[1]]
    ys = [pt[1] for o in ops for pt in o[1]]
    return ops, (min(xs), min(ys), max(xs), max(ys))


def render_tile(item, tile_px, label=True):
    T = tile_px * SS
    lab_h = int(T * 0.16) if label else 0
    img = Image.new("RGB", (T, T + lab_h), TILE_BG)
    dr = ImageDraw.Draw(img)
    ops, (x0, y0, x1, y1) = collect(item, T)
    pad = T * 0.10
    span = max(x1 - x0, y1 - y0, 1)
    s = (T - 2 * pad) / span
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ox, oy = T / 2, (T - 2 * pad) / 2 + pad

    # ground shadow ellipse
    w, d = item["dims_mm"]["w"], item["dims_mm"]["d"]
    gp = [proj(sx * w / 2, sy * d / 2, 0) for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    dr.polygon([((px - cx) * s + ox, (py - cy) * s + oy) for (px, py) in gp], fill=(21, 21, 25))

    for dep, pts, col in ops:
        poly = [((px - cx) * s + ox, (py - cy) * s + oy) for (px, py) in pts]
        dr.polygon(poly, fill=col, outline=shade(col, 0.72))

    if label:
        try:
            f1 = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(lab_h * 0.34))
            f2 = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", int(lab_h * 0.27))
        except Exception:
            f1 = f2 = ImageFont.load_default()
        dr.rectangle([0, T, T, T + lab_h], fill=(20, 20, 24))
        nm = ("%s %s" % (item["name"], item["product_type"]))[:34]
        dr.text((int(T * 0.05), T + int(lab_h * 0.10)), nm, font=f1, fill=INK)
        dm = item["dims_mm"]
        dr.text((int(T * 0.05), T + int(lab_h * 0.50)),
                "%s  %d\u00d7%d\u00d7%d" % (item["archetype"], dm["w"], dm["d"], dm["h"]),
                font=f2, fill=MUTED)
        cconf = {"high": (79, 169, 124), "medium": (224, 163, 60), "low": (224, 91, 74)}[item["dims_confidence"]]
        dr.rectangle([T - int(T * 0.05) - int(T * 0.035), T + int(lab_h * 0.32),
                      T - int(T * 0.05), T + int(lab_h * 0.32) + int(T * 0.035)], fill=cconf)
    return img.resize((tile_px, tile_px + (lab_h // SS)), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "contact_sheet.png"))
    ap.add_argument("--cols", type=int, default=12)
    ap.add_argument("--tile", type=int, default=210)
    ap.add_argument("--only", default=None, help="comma list of archetypes or ids")
    args = ap.parse_args()

    cat = json.load(open(os.path.join(ROOT, "catalog.json"), encoding="utf-8"))
    items = cat["items"]
    if args.only:
        keys = set(args.only.split(","))
        items = [i for i in items if i["archetype"] in keys or i["id"] in keys]
    items = sorted(items, key=lambda i: (i["category"], i["archetype"], i["id"]))

    tiles = [render_tile(i, args.tile) for i in items]
    tw, th = tiles[0].size
    cols = args.cols
    rows = (len(tiles) + cols - 1) // cols
    head = 78
    sheet = Image.new("RGB", (cols * tw + 2, rows * th + head + 2), BG)
    dr = ImageDraw.Draw(sheet)
    try:
        fh = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
        fs = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
    except Exception:
        fh = fs = ImageFont.load_default()
    dr.text((14, 14), "ainterior \u2014 catalog proxy contact sheet", font=fh, fill=INK)
    dr.text((16, 50), "%d items \u00b7 %d primitives \u00b7 isometric orthographic \u00b7 confidence swatch: green=high amber=medium red=low"
            % (len(items), sum(len(i["proxy"]["parts"]) for i in items)), font=fs, fill=MUTED)
    for n, t in enumerate(tiles):
        r, c = divmod(n, cols)
        sheet.paste(t, (c * tw + 1, head + r * th + 1))
    for c in range(cols + 1):
        dr.line([(c * tw, head), (c * tw, head + rows * th)], fill=GRID)
    for r in range(rows + 1):
        dr.line([(0, head + r * th), (cols * tw, head + r * th)], fill=GRID)
    sheet.save(args.out)
    print("wrote %s  (%dx%d, %d tiles)" % (args.out, sheet.size[0], sheet.size[1], len(tiles)))


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""Primitive-proxy geometry builders, one per archetype (SPEC v1 §4.1).

Local frame: x = width, y = depth, z = elevation. Origin = footprint centre on the floor.
Convention (matches the SPEC EKTORP example, whose back cushion sits at y = -380):
    -y = the BACK of the piece (wall side)     +y = the FRONT (room side)
`pos` is the CENTRE of each primitive.
Colours use the named roles: body | wood | metal | glass | fabric | dark (or #RRGGBB).
Every builder must keep all parts inside the [w, d, h] bounding box.
"""
import math

def _i(v):
    return int(round(v))

def box(x, y, z, sx, sy, sz, color, radius=None):
    p = {"shape": "box", "pos": [_i(x), _i(y), _i(z)],
         "size": [max(1, _i(sx)), max(1, _i(sy)), max(1, _i(sz))], "color": color}
    if radius:
        p["radius"] = _i(radius)
    return p

def cyl(x, y, z, dia, hh, color):
    return {"shape": "cyl", "pos": [_i(x), _i(y), _i(z)],
            "size": [max(1, _i(dia)), max(1, _i(dia)), max(1, _i(hh))], "color": color}

def sph(x, y, z, dia, color):
    d = max(1, _i(dia))
    return {"shape": "sphere", "pos": [_i(x), _i(y), _i(z)], "size": [d, d, d], "color": color}

def plane(x, y, z, sx, sy, color):
    return {"shape": "plane", "pos": [_i(x), _i(y), _i(z)],
            "size": [max(1, _i(sx)), max(1, _i(sy)), 0], "color": color}

def legs4(w, d, h, dia=50, inset=70, color="wood", kind="cyl"):
    out = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            x = sx * (w / 2 - inset)
            y = sy * (d / 2 - inset)
            out.append(cyl(x, y, h / 2, dia, h, color) if kind == "cyl"
                       else box(x, y, h / 2, dia, dia, h, color))
    return out


# ------------------------------------------------------------------ seating
def build_sofa(w, d, h, seat_h, n_seats, arms=True):
    seat_h = seat_h or 450
    leg_h = min(90, max(50, _i(h * 0.09)))
    back_t = max(120, _i(d * 0.20))
    arm_w = min(230, max(90, _i(w * 0.10))) if arms else 30
    cush_t = 140
    plat_top = max(leg_h + 60, seat_h - cush_t)
    arm_top = min(h - 60, seat_h + 240)
    seat_d = d - back_t - 40
    inner_w = w - 2 * arm_w
    parts = []
    # base platform
    parts.append(box(0, 0, (leg_h + plat_top) / 2, w, d, plat_top - leg_h, "body", 20))
    # back frame
    back_y = -(d / 2 - back_t / 2)
    parts.append(box(0, back_y, (leg_h + (h - 40)) / 2, w, back_t, (h - 40) - leg_h, "body", 30))
    # seat cushions
    gap = 24
    cw = (inner_w - gap * (n_seats - 1)) / n_seats
    cy = -(d / 2) + back_t + seat_d / 2
    for i in range(n_seats):
        cx = -inner_w / 2 + cw / 2 + i * (cw + gap)
        parts.append(box(cx, cy, plat_top + cush_t / 2, cw - 10, seat_d, cush_t, "fabric", 40))
        # back cushion
        bh = max(180, (h - 70) - (seat_h + 10))
        parts.append(box(cx, back_y + back_t / 2 - back_t * 0.30, seat_h + 10 + bh / 2,
                         cw - 10, max(90, back_t * 0.60), bh, "fabric", 35))
    # arms
    if arms:
        for s in (-1, 1):
            parts.append(box(s * (w / 2 - arm_w / 2), 0, (leg_h + arm_top) / 2,
                             arm_w, d, arm_top - leg_h, "body", 40))
    parts += legs4(w, d, leg_h, dia=55, inset=80, color="wood")
    return parts


def build_sectional(w, d, h, seat_h, notch_w, notch_d):
    """L-shaped sofa: main run across the back, chaise block on the right."""
    seat_h = seat_h or 450
    d_main = d - notch_d
    chaise_w = w - notch_w
    parts = []
    # main run sits in the back band (y from -d/2 to -d/2 + d_main)
    main_cy = -d / 2 + d_main / 2
    for p in build_sofa(w, d_main, h, seat_h, max(2, _i((w - chaise_w) / 620)), arms=True):
        p["pos"][1] += _i(main_cy)
        parts.append(p)
    # chaise extension on the right, forward of the main run
    ch_cx = w / 2 - chaise_w / 2
    ch_cy = -d / 2 + d_main + notch_d / 2
    leg_h = min(90, max(50, _i(h * 0.09)))
    parts.append(box(ch_cx, ch_cy, (leg_h + seat_h - 140) / 2, chaise_w, notch_d, seat_h - 140 - leg_h, "body", 20))
    parts.append(box(ch_cx, ch_cy, seat_h - 70, chaise_w - 60, notch_d - 40, 140, "fabric", 40))
    arm_w = min(230, max(90, _i(w * 0.10)))
    parts.append(box(w / 2 - arm_w / 2, ch_cy, (leg_h + seat_h + 240) / 2,
                     arm_w, notch_d, seat_h + 240 - leg_h, "body", 40))
    for sx in (-1, 1):
        parts.append(cyl(ch_cx + sx * (chaise_w / 2 - 80), ch_cy + notch_d / 2 - 80, leg_h / 2, 55, leg_h, "wood"))
    return parts


def build_armchair(w, d, h, seat_h):
    return build_sofa(w, d, h, seat_h or 430, 1, arms=True)


def build_ottoman(w, d, h, seat_h):
    leg_h = min(110, max(40, _i(h * 0.22)))
    parts = [box(0, 0, (leg_h + h) / 2, w, d, h - leg_h, "fabric", 30)]
    parts += legs4(w, d, leg_h, dia=50, inset=70, color="wood")
    return parts


def build_bench(w, d, h, seat_h, storage=False):
    top_t = 40
    if storage:
        parts = [box(0, 0, (60 + h - top_t) / 2, w, d, h - top_t - 60, "body", 10),
                 box(0, 0, h - top_t / 2, w, d, top_t, "wood", 8)]
        for s in (-1, 1):
            parts.append(box(s * w * 0.25, d / 2 - 30, (h - top_t) / 2 + 20, w * 0.42, 26, (h - top_t) * 0.5, "#DCD7CE"))
        parts += legs4(w, d, 60, dia=45, inset=60, color="wood")
        return parts
    parts = [box(0, 0, h - top_t / 2, w, d, top_t, "wood", 8)]
    # trestle legs
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - 60), 0, (h - top_t) / 2, 45, d - 60, h - top_t, "wood", 6))
    parts.append(box(0, 0, (h - top_t) * 0.35, w - 200, 35, 35, "wood"))
    return parts


def build_dining_chair(w, d, h, seat_h, upholstered=False):
    seat_h = seat_h or 450
    seat_t = 45
    leg_dia = 40
    parts = []
    parts.append(box(0, 20, seat_h - seat_t / 2, w - 20, d - 90, seat_t, "fabric" if upholstered else "wood", 10))
    # back posts
    back_y = -(d / 2 - 35)
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - 30), back_y, (seat_h + h) / 2 - seat_t / 2, 38, 38, h - seat_h + seat_t, "wood"))
    # back panel
    bh = (h - seat_h) * 0.55
    parts.append(box(0, back_y, h - bh / 2 - 45, w - 80, 26, bh, "fabric" if upholstered else "wood", 12))
    parts.append(box(0, back_y, seat_h + (h - seat_h) * 0.22, w - 80, 24, 70, "wood", 10))
    # 4 legs
    for sx in (-1, 1):
        for sy in (-1, 1):
            y = back_y if sy < 0 else (d / 2 - 45)
            parts.append(cyl(sx * (w / 2 - 30), y, (seat_h - seat_t) / 2, leg_dia, seat_h - seat_t, "wood"))
    # stretcher
    parts.append(box(0, 20, seat_h * 0.35, w - 70, 26, 26, "wood"))
    return parts


def build_office_chair(w, d, h, seat_h, headrest=False):
    seat_h = seat_h or 460
    parts = []
    # 5-star base rendered as a low disc + 5 radial spokes + castors
    parts.append(cyl(0, 0, 20, w * 0.34, 40, "metal"))
    for k in range(5):
        a = math.radians(90 + k * 72)
        r = (w / 2 - 45) * 0.62
        parts.append(box(r * math.cos(a), r * math.sin(a), 35, w * 0.30, 46, 34, "metal"))
        rr = w / 2 - 40
        parts.append(cyl(rr * math.cos(a), rr * math.sin(a), 30, 58, 60, "dark"))
    # gas cylinder
    parts.append(cyl(0, 0, (70 + seat_h - 70) / 2, 78, seat_h - 140, "metal"))
    # seat
    parts.append(box(0, 20, seat_h - 40, w * 0.78, d * 0.74, 80, "fabric", 25))
    # back
    back_top = h - (140 if headrest else 0)
    parts.append(box(0, -(d * 0.30), (seat_h + 40 + back_top) / 2, w * 0.70, 70,
                     back_top - seat_h - 40, "fabric", 30))
    parts.append(box(0, -(d * 0.30) - 40, (seat_h + 60 + back_top) / 2, w * 0.60, 34,
                     back_top - seat_h - 90, "metal", 20))
    if headrest:
        parts.append(box(0, -(d * 0.30), h - 70, w * 0.46, 70, 130, "fabric", 25))
    # armrests
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - 40), 20, seat_h + 130, 60, d * 0.42, 34, "dark", 12))
        parts.append(box(s * (w / 2 - 45), -20, seat_h + 60, 34, 34, 150, "dark"))
    return parts


def build_stool(w, d, h, seat_h):
    seat_t = 40
    parts = [cyl(0, 0, h - seat_t / 2, w, seat_t, "wood")]
    for k in range(3):
        a = math.radians(90 + k * 120)
        r = w / 2 - 45
        parts.append(cyl(r * math.cos(a), r * math.sin(a), (h - seat_t) / 2, 38, h - seat_t, "metal"))
    parts.append(cyl(0, 0, h * 0.30, w * 0.62, 22, "metal"))
    return parts


def build_bar_stool(w, d, h, seat_h):
    seat_h = seat_h or _i(h * 0.8)
    seat_t = 45
    parts = [box(0, 20, seat_h - seat_t / 2, w - 20, d - 80, seat_t, "wood", 12)]
    back_y = -(d / 2 - 35)
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - 28), back_y, (seat_h + h) / 2, 34, 34, h - seat_h, "wood"))
    parts.append(box(0, back_y, h - (h - seat_h) * 0.35, w - 80, 24, (h - seat_h) * 0.5, "wood", 10))
    for sx in (-1, 1):
        for sy in (-1, 1):
            y = back_y if sy < 0 else (d / 2 - 40)
            parts.append(cyl(sx * (w / 2 - 28), y, (seat_h - seat_t) / 2, 36, seat_h - seat_t, "wood"))
    for yy in (back_y, d / 2 - 40):
        parts.append(box(0, yy, seat_h * 0.42, w - 66, 24, 24, "wood"))
    return parts


# ------------------------------------------------------------------ beds
def build_bed(w, d, h, plat_h, headboard=True, storage=False):
    plat_h = plat_h or 380
    leg_h = 70
    rail_t = 45
    mat_t = 200
    parts = []
    hb_y = -(d / 2 - rail_t / 2)
    if headboard:
        parts.append(box(0, hb_y, (leg_h + h) / 2, w, rail_t + 15, h - leg_h, "wood", 12))
    # side rails
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - rail_t / 2), 0, (leg_h + plat_h) / 2, rail_t, d, plat_h - leg_h, "wood", 8))
    # foot rail
    parts.append(box(0, d / 2 - rail_t / 2, (leg_h + plat_h * 0.82) / 2, w, rail_t, plat_h * 0.82 - leg_h, "wood", 8))
    # slat base
    parts.append(box(0, 0, plat_h - 30, w - 2 * rail_t, d - 2 * rail_t, 40, "dark"))
    # mattress
    parts.append(box(0, 15, plat_h + mat_t / 2, w - 2 * rail_t - 20, d - 2 * rail_t - 20, mat_t, "#EDE9E2", 30))
    # pillows
    for s in (-1, 1) if w > 1200 else (0,):
        px = s * (w * 0.22) if w > 1200 else 0
        parts.append(box(px, hb_y + 300, plat_h + mat_t + 55, w * 0.40 if w > 1200 else w * 0.6, 380, 110, "#F5F2ED", 45))
    if storage:
        for s in (-1, 1):
            parts.append(box(s * (w * 0.26), d / 2 - rail_t - 40, plat_h * 0.5, w * 0.44, 30, plat_h * 0.5, "#DCD7CE"))
    parts += legs4(w, d, leg_h, dia=60, inset=60, color="wood", kind="box")
    return parts


def build_crib(w, d, h):
    base_h = _i(h * 0.42)
    post = 55
    parts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box(sx * (w / 2 - post / 2), sy * (d / 2 - post / 2), h / 2, post, post, h, "wood", 6))
    # long-side slats
    for sx in (-1, 1):
        x = sx * (w / 2 - 26)
        parts.append(box(x, 0, h - 30, 45, d - post, 55, "wood", 6))         # top rail
        parts.append(box(x, 0, base_h - 30, 45, d - post, 45, "wood"))        # bottom rail
        n = 7
        for i in range(n):
            y = -(d / 2 - post) + (d - 2 * post) * i / (n - 1)
            parts.append(cyl(x, y, (base_h + h) / 2 - 20, 26, h - base_h - 60, "wood"))
    # head / foot panels
    for sy in (-1, 1):
        parts.append(box(0, sy * (d / 2 - 26), (base_h + h) / 2 - 10, w - post, 40, h - base_h - 40, "wood", 8))
    # mattress
    parts.append(box(0, 0, base_h + 60, w - 2 * post - 10, d - 2 * post - 10, 120, "#EDE9E2", 20))
    return parts


# ------------------------------------------------------------------ case goods
def _carcass(w, d, h, plinth=60, top_t=25, color="wood"):
    parts = [box(0, 0, (plinth + h - top_t) / 2, w, d, h - top_t - plinth, color, 6),
             box(0, 0, h - top_t / 2, w, d, top_t, color, 6)]
    if plinth > 0:
        parts.append(box(0, 0, plinth / 2, w - 60, d - 40, plinth, "dark"))
    return parts


def build_drawer_chest(w, d, h, n_drawers, legs=False, handles=True):
    plinth = 0 if legs else 55
    leg_h = 90 if legs else 0
    base = plinth + leg_h
    top_t = 25
    parts = []
    parts.append(box(0, 0, (base + h - top_t) / 2, w, d, h - top_t - base, "wood", 6))
    parts.append(box(0, 0, h - top_t / 2, w, d, top_t, "wood", 6))
    if plinth:
        parts.append(box(0, 0, plinth / 2, w - 60, d - 40, plinth, "dark"))
    if legs:
        parts += legs4(w, d, leg_h, dia=48, inset=60, color="wood")
    inner_h = h - top_t - base - 30
    per = inner_h / n_drawers
    for i in range(n_drawers):
        z = base + 15 + per * (i + 0.5)
        parts.append(box(0, d / 2 - 8, z, w - 44, 18, per - 14, "#E6E1D8", 6))
        if handles:
            parts.append(cyl(0, d / 2 + 4, z, 22, min(160, w * 0.30), "metal"))
    return parts


def build_wardrobe(w, d, h, n_doors=None, mirror=False):
    n_doors = n_doors or max(2, min(3, _i(round(w / 550.0))))
    plinth = 40
    parts = [box(0, 0, (plinth + h) / 2, w, d, h - plinth, "wood", 4),
             box(0, 0, plinth / 2, w - 40, d - 30, plinth, "dark")]
    dw = (w - 30) / n_doors
    for i in range(n_doors):
        x = -w / 2 + 15 + dw * (i + 0.5)
        col = "glass" if (mirror and i == n_doors // 2) else "#E9E4DB"
        parts.append(box(x, d / 2 - 10, (plinth + h) / 2, dw - 12, 22, h - plinth - 24, col, 4))
        parts.append(cyl(x + dw * 0.34, d / 2 + 6, h * 0.52, 20, 220, "metal"))
    return parts


def build_bookcase(w, d, h, back=True):
    side_t = 22
    parts = [box(-(w / 2 - side_t / 2), 0, h / 2, side_t, d, h, "wood"),
             box(w / 2 - side_t / 2, 0, h / 2, side_t, d, h, "wood"),
             box(0, 0, h - 12, w, d, 24, "wood"),
             box(0, 0, 40, w - 2 * side_t, d, 26, "wood")]
    if back:
        parts.append(box(0, -(d / 2 - 6), h / 2, w - 2 * side_t, 10, h - 20, "dark"))
    n = max(2, _i((h - 120) / 340.0))
    for i in range(1, n + 1):
        z = 60 + (h - 130) * i / (n + 1)
        parts.append(box(0, 6, z, w - 2 * side_t, d - 12, 22, "wood"))
    return parts


def build_shelf_grid(w, d, h):
    """KALLAX-style square cube grid."""
    t = 32
    cols = max(1, _i(round((w - t) / 385.0)))
    rows = max(1, _i(round((h - t) / 385.0)))
    parts = [box(-(w / 2 - t / 2), 0, h / 2, t, d, h, "wood"),
             box(w / 2 - t / 2, 0, h / 2, t, d, h, "wood"),
             box(0, 0, h - t / 2, w, d, t, "wood"),
             box(0, 0, t / 2, w, d, t, "wood"),
             box(0, -(d / 2 - 5), h / 2, w - 2 * t, 8, h - 2 * t, "dark")]
    inner_w = w - 2 * t
    inner_h = h - 2 * t
    for c in range(1, cols):
        parts.append(box(-inner_w / 2 + inner_w * c / cols, 0, h / 2, t, d, inner_h, "wood"))
    for r in range(1, rows):
        parts.append(box(0, 0, t + inner_h * r / rows, inner_w, d, t, "wood"))
    return parts


def build_open_shelf(w, d, h):
    t = 26
    parts = [box(-(w / 2 - t / 2), 0, h / 2, t, d, h, "wood"),
             box(w / 2 - t / 2, 0, h / 2, t, d, h, "wood")]
    n = max(3, _i((h - 80) / 380.0) + 1)
    for i in range(n + 1):
        z = 60 + (h - 80) * i / n
        parts.append(box(0, 0, min(z, h - t / 2), w - 2 * t, d, t, "wood"))
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - t / 2), -(d / 2 - 20), h * 0.55, t + 4, 30, h * 0.8, "wood"))
    return parts


def build_sideboard(w, d, h, n_doors=None, drawers=0, legs=True):
    n_doors = n_doors or max(2, min(4, _i(round(w / 500.0))))
    leg_h = 90 if legs else 45
    top_t = 26
    parts = [box(0, 0, (leg_h + h - top_t) / 2, w, d, h - top_t - leg_h, "wood", 4),
             box(0, 0, h - top_t / 2, w, d, top_t, "wood", 4)]
    body_h = h - top_t - leg_h
    dz0 = leg_h
    if drawers:
        dh = body_h * 0.30 / max(1, drawers)
        for i in range(drawers):
            z = leg_h + dh * (i + 0.5)
            parts.append(box(0, d / 2 - 8, z, w - 40, 18, dh - 12, "#E6E1D8", 4))
            parts.append(cyl(0, d / 2 + 4, z, 20, min(150, w * 0.25), "metal"))
        dz0 = leg_h + body_h * 0.30
    dw = (w - 24) / n_doors
    for i in range(n_doors):
        x = -w / 2 + 12 + dw * (i + 0.5)
        parts.append(box(x, d / 2 - 8, (dz0 + h - top_t) / 2, dw - 12, 18, (h - top_t) - dz0 - 16, "#E9E4DB", 4))
        parts.append(cyl(x + dw * 0.32, d / 2 + 4, (dz0 + h - top_t) / 2, 18, 140, "metal"))
    if legs:
        parts += legs4(w, d, leg_h, dia=44, inset=70, color="wood")
    else:
        parts.append(box(0, 0, leg_h / 2, w - 50, d - 30, leg_h, "dark"))
    return parts


def build_tv_bench(w, d, h):
    leg_h = min(90, max(40, _i(h * 0.20)))
    top_t = 24
    parts = [box(0, 0, (leg_h + h - top_t) / 2, w, d, h - top_t - leg_h, "wood", 4),
             box(0, 0, h - top_t / 2, w, d, top_t, "wood", 4)]
    n = max(2, _i(round(w / 620.0)))
    dw = (w - 24) / n
    for i in range(n):
        x = -w / 2 + 12 + dw * (i + 0.5)
        parts.append(box(x, d / 2 - 8, (leg_h + h - top_t) / 2, dw - 14, 18, (h - top_t - leg_h) - 16, "#E6E1D8", 4))
        parts.append(cyl(x, d / 2 + 4, (leg_h + h - top_t) / 2, 18, min(180, dw * 0.4), "metal"))
    parts += legs4(w, d, leg_h, dia=42, inset=60, color="dark")
    return parts


def build_cabinet(w, d, h, drawers=0):
    if drawers:
        return build_drawer_chest(w, d, h, drawers, legs=False)
    return build_sideboard(w, d, h, n_doors=max(1, _i(round(w / 500.0))), legs=False)


def build_nightstand(w, d, h, n_drawers=2):
    return build_drawer_chest(w, d, h, n_drawers, legs=(h >= 600))


def build_storage_box(w, d, h):
    lid = max(14, _i(h * 0.12))
    return [box(0, 0, (h - lid) / 2, w, d, h - lid, "body", 12),
            box(0, 0, h - lid / 2, w, d, lid, "body", 12),
            box(0, d / 2 - 4, (h - lid) * 0.60, w * 0.34, 10, h * 0.20, "metal", 6)]


# ------------------------------------------------------------------ tables
def build_low_table(w, d, h, round_top=False, shelf=False, pedestal=False):
    top_t = min(60, max(28, _i(h * 0.10)))
    parts = []
    if round_top:
        parts.append(cyl(0, 0, h - top_t / 2, w, top_t, "wood"))
    else:
        parts.append(box(0, 0, h - top_t / 2, w, d, top_t, "wood", 8))
    if pedestal:
        parts.append(cyl(0, 0, (30 + h - top_t) / 2, max(90, w * 0.16), h - top_t - 30, "metal"))
        parts.append(cyl(0, 0, 18, w * 0.46, 36, "metal"))
    else:
        parts += legs4(w, d, h - top_t, dia=46, inset=70, color="wood")
    if shelf:
        if round_top:
            parts.append(cyl(0, 0, h * 0.28, w - 130, 20, "wood"))
        else:
            parts.append(box(0, 0, h * 0.28, w - 130, d - 110, 20, "wood", 6))
    return parts


def build_dining_table_rect(w, d, h, apron=True):
    top_t = 40
    parts = [box(0, 0, h - top_t / 2, w, d, top_t, "wood", 10)]
    if apron:
        parts.append(box(0, 0, h - top_t - 45, w - 150, d - 130, 60, "wood"))
    parts += legs4(w, d, h - top_t, dia=70, inset=90, color="wood", kind="box")
    return parts


def build_dining_table_round(w, d, h, pedestal=True):
    top_t = 40
    parts = [cyl(0, 0, h - top_t / 2, w, top_t, "wood")]
    if pedestal:
        parts.append(cyl(0, 0, (40 + h - top_t) / 2, max(150, w * 0.20), h - top_t - 40, "wood"))
        parts.append(cyl(0, 0, 22, w * 0.44, 44, "wood"))
    else:
        for k in range(4):
            a = math.radians(45 + k * 90)
            r = w / 2 - 130
            parts.append(box(r * math.cos(a), r * math.sin(a), (h - top_t) / 2, 65, 65, h - top_t, "wood"))
        parts.append(cyl(0, 0, h * 0.32, w - 300, 40, "wood"))
    return parts


def build_desk(w, d, h, drawer_unit=False, modesty=True):
    top_t = 30
    parts = [box(0, 0, h - top_t / 2, w, d, top_t, "wood", 8)]
    if modesty:
        parts.append(box(0, -(d / 2 - 40), (h - top_t) * 0.62, w - 200, 24, (h - top_t) * 0.40, "wood"))
    if drawer_unit:
        uw = min(400, w * 0.32)
        ux = w / 2 - uw / 2 - 30
        parts.append(box(ux, 0, (h - top_t) / 2, uw, d - 40, h - top_t, "wood", 4))
        for i in range(2):
            z = (h - top_t) * (0.30 + 0.40 * i)
            parts.append(box(ux, d / 2 - 26, z, uw - 30, 16, (h - top_t) * 0.28, "#E6E1D8", 4))
            parts.append(cyl(ux, d / 2 - 14, z, 16, uw * 0.4, "metal"))
        for sy in (-1, 1):
            parts.append(cyl(-(w / 2 - 60), sy * (d / 2 - 60), (h - top_t) / 2, 50, h - top_t, "metal"))
    else:
        parts += legs4(w, d, h - top_t, dia=52, inset=60, color="metal")
    return parts


def build_console(w, d, h):
    top_t = 32
    parts = [box(0, 0, h - top_t / 2, w, d, top_t, "wood", 6)]
    parts += legs4(w, d, h - top_t, dia=48, inset=55, color="wood")
    parts.append(box(0, 0, h * 0.22, w - 110, d - 60, 22, "wood", 4))
    parts.append(box(0, 0, h * 0.62, w - 110, d - 70, 20, "wood", 4))
    return parts


def build_kitchen_island(w, d, h):
    top_t = 45
    body_w, body_d = w - 60, d - 90
    parts = [box(0, 0, h - top_t / 2, w, d, top_t, "wood", 6),
             box(0, -20, (80 + h - top_t) / 2, body_w, body_d, h - top_t - 80, "#E9E4DB", 4),
             box(0, -20, 40, body_w - 60, body_d - 30, 80, "dark")]
    # drawers on the back face, open shelves on the front
    for i in range(2):
        z = 120 + (h - top_t - 140) * (0.28 + 0.42 * i)
        parts.append(box(-body_w * 0.24, -(body_d / 2 - 30) - 20, z, body_w * 0.42, 18, (h - top_t) * 0.26, "#DCD7CE", 4))
        parts.append(cyl(-body_w * 0.24, -(body_d / 2 - 20) - 20, z, 18, 160, "metal"))
    for i in range(2):
        parts.append(box(body_w * 0.24, -20, 180 + i * 300, body_w * 0.42, body_d - 60, 22, "wood"))
    parts.append(box(0, d / 2 - 22, h - 210, w - 300, 28, 28, "metal", 14))   # towel rail (horizontal -> box)
    return parts


# ------------------------------------------------------------------ soft goods & lighting
def build_rug(w, d, h):
    return [box(0, 0, h / 2, w, d, h, "fabric", 20),
            plane(0, 0, h + 1, w - 220, d - 220, "fabric")]


def build_floor_lamp(w, d, h, uplighter=False):
    shade_h = min(320, max(160, _i(h * 0.17)))
    base_dia = min(320, max(180, _i(w * 0.62)))
    parts = [cyl(0, 0, 12, base_dia, 24, "metal"),
             cyl(0, 0, 45, base_dia * 0.34, 60, "metal"),
             cyl(0, 0, (60 + h - shade_h) / 2, 34, h - shade_h - 60, "metal"),
             cyl(0, 0, h - shade_h / 2, w, shade_h, "#F1EDE4" if not uplighter else "metal")]
    parts.append(plane(0, 0, h - shade_h - 4, w * 0.86, w * 0.86, "#FFF6E2"))
    return parts


def build_table_lamp(w, d, h):
    shade_h = max(90, _i(h * 0.42))
    base_dia = max(70, _i(w * 0.48))
    return [cyl(0, 0, 14, base_dia, 28, "metal"),
            cyl(0, 0, (28 + h - shade_h) / 2, max(22, w * 0.12), h - shade_h - 28, "metal"),
            cyl(0, 0, h - shade_h / 2, w, shade_h, "#F1EDE4"),
            plane(0, 0, h - shade_h - 3, w * 0.8, w * 0.8, "#FFF6E2")]


def build_pendant_lamp(w, d, h):
    shade_h = max(150, min(_i(w * 0.62), _i(h * 0.30)))
    cord_h = h - shade_h
    return [cyl(0, 0, h - 18, 90, 36, "metal"),                 # ceiling canopy
            cyl(0, 0, shade_h + cord_h / 2, 24, cord_h, "dark"),
            cyl(0, 0, shade_h / 2, w, shade_h, "metal"),
            plane(0, 0, 6, w * 0.82, w * 0.82, "#FFF6E2")]


def build_wall_lamp(w, d, h):
    """Wall plate at -y, arm reaching forward, shade at +y. The plate has to read as a
    separate mass or the tile looks like a table lamp."""
    plate_t = 26
    plate_w = max(70, _i(w * 0.9))
    plate_h = max(90, _i(h * 0.94))
    shade_dia = max(60, _i(min(w, d * 0.52)))
    shade_h = max(70, _i(min(h * 0.52, shade_dia * 1.15)))
    shade_y = d / 2 - shade_dia / 2 - 8
    arm_len = max(40, shade_y - (-(d / 2 - plate_t)))
    return [box(0, -(d / 2 - plate_t / 2), plate_h / 2, plate_w, plate_t, plate_h, "metal", 8),
            box(0, -(d / 2 - plate_t) + arm_len / 2, h * 0.68, 32, arm_len, 32, "metal"),
            box(0, -(d / 2 - plate_t) + 30, h * 0.68, 46, 46, 46, "metal", 12),
            cyl(0, shade_y, shade_h / 2 + h * 0.06, shade_dia, shade_h, "#F1EDE4"),
            plane(0, shade_y, max(3, h * 0.05), shade_dia * 0.82, shade_dia * 0.82, "#FFF6E2")]


# ------------------------------------------------------------------ decor
def build_tv(w, d, h):
    panel_t = max(18, _i(d * 0.35))
    screen_h = h * 0.90
    parts = [box(0, -(d / 2 - panel_t / 2), h - screen_h / 2, w, panel_t, screen_h, "dark", 6),
             box(0, -(d / 2 - panel_t) + 6, h - screen_h / 2, w - 24, 8, screen_h - 24, "#1B2530"),
             box(0, 0, h - screen_h - 30, w * 0.14, d * 0.6, 60, "dark"),
             box(0, 0, 12, w * 0.42, d, 24, "dark", 6)]
    return parts


def build_art_frame(w, d, h):
    f = max(28, min(60, _i(min(w, h) * 0.07)))
    parts = [box(0, 0, h / 2, w, d * 0.5, h, "wood", 4),
             box(0, d * 0.22, h / 2, w - 2 * f, 8, h - 2 * f, "#D9D3C8")]
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - f / 2), d * 0.10, h / 2, f, d, h, "wood", 4))
        parts.append(box(0, d * 0.10, h / 2 + s * (h / 2 - f / 2), w, d, f, "wood", 4))
    return parts


def build_mirror(w, d, h, round_shape=False):
    f = max(24, min(50, _i(min(w, h) * 0.06)))
    if round_shape:
        # No rotated primitives in the SPEC set, so a circular bezel is approximated by a
        # ring of small spheres in the wall plane + a glass plane inset behind it.
        parts = [box(0, 0, h / 2, w - 2.2 * f, max(8, d * 0.45), h - 2.2 * f, "glass")]
        n = 28
        r = (min(w, h) - f) / 2
        seg = 2 * math.pi * r / n * 1.35
        for k in range(n):
            a = 2 * math.pi * k / n
            parts.append(box(r * math.cos(a), 0, h / 2 + r * math.sin(a),
                             seg, d, seg, "metal", seg * 0.5))
        return parts
    parts = [box(0, 0, h / 2, w, d * 0.6, h, "wood", 4),
             box(0, d * 0.20, h / 2, w - 2 * f, 8, h - 2 * f, "glass")]
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - f / 2), 0, h / 2, f, d, h, "wood", 4))
        parts.append(box(0, 0, h / 2 + s * (h / 2 - f / 2), w, d, f, "wood", 4))
    return parts


def build_plant(w, d, h):
    pot_h = max(120, _i(h * 0.22))
    parts = [cyl(0, 0, pot_h / 2, w * 0.62, pot_h, "#B0724F"),
             cyl(0, 0, pot_h - 12, w * 0.58, 30, "dark"),
             cyl(0, 0, (pot_h + h * 0.62) / 2, max(24, w * 0.07), h * 0.62 - pot_h, "#4A6B3A")]
    leaf = w * 0.44
    spots = [(0.34, 0.0, 0.72), (-0.30, 0.16, 0.86), (0.16, -0.30, 0.90),
             (-0.14, -0.22, 0.66), (0.0, 0.26, 0.97), (0.28, 0.24, 0.80)]
    for (fx, fy, fz) in spots:
        parts.append(sph(fx * w, fy * d, min(h - leaf / 2, fz * h), leaf, "#4C7A45"))
    return parts


def build_curtain(w, d, h):
    # SPEC-ASSUMPTION: `cyl` has a vertical axis only, so a horizontal curtain rod must be a
    # box. (This was a real bug caught on the contact sheet -- the rod rendered as a mast.)
    parts = [box(0, -(d / 2 - 18), h - 20, w, 34, 34, "metal", 16)]
    n = 7
    pw = (w - 20) / n
    for i in range(n):
        x = -w / 2 + 10 + pw * (i + 0.5)
        # alternate the pleat forward/back as well as light/dark so the folds read
        fwd = (i % 2 == 0)
        parts.append(box(x, (d * 0.16 if fwd else -d * 0.10), (h - 44) / 2,
                         pw - 6, d * 0.55, h - 44,
                         "fabric" if fwd else "#B4AFA6", 18))
    return parts


def build_wall_shelf(w, d, h):
    parts = [box(0, 0, h - min(h, 26) / 2, w, d, min(h, 26), "wood", 4)]
    if h > 40:
        parts.append(box(0, -(d / 2 - 12), (h - 26) / 2, w, 22, h - 26, "wood"))
    for s in (-1, 1):
        parts.append(box(s * (w / 2 - 90), -(d / 2 - 20), max(6, (h - 26) / 2), 22, d * 0.7, max(10, h - 26), "metal"))
    return parts

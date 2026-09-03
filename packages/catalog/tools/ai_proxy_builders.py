# -*- coding: utf-8 -*-
"""Primitive proxy builders for the ainterior generic ("ai-") catalog items.

Same conventions as `proxy_builders.py`:
  pos = [x, y, z] millimetres, item-local, origin = footprint centre on the floor,
  z = elevation. shape in box | cyl | sphere | plane. cyl size = [dia, dia, height].
  colour roles: body | wood | metal | glass | fabric | dark | #RRGGBB.

Extra: parts may carry `"image_slot": True` (SPEC2 G3) -- the surface a user photo is
textured onto. Exactly one image_slot part per frame/poster/canvas panel, sized to the
*visible aperture* (inside the frame profile and the mount/matting).
"""
import math

MAT = "#EDE9E2"      # mount / matting board
PAPER = "#E7E3DA"
SLOT = "#9FB4C4"     # neutral placeholder tone for an empty image slot
GLASSY = "#B8CEDA"
GREEN = "#4C7A45"
SOIL = "#4A3B31"


# ------------------------------------------------------------------ primitive helpers
def bx(x, y, z, sx, sy, sz, c, r=0):
    p = {"shape": "box", "pos": [int(x), int(y), int(z)],
         "size": [int(max(1, sx)), int(max(1, sy)), int(max(1, sz))], "color": c}
    if r:
        p["radius"] = int(r)
    return p


def cy(x, y, z, dia, hh, c):
    return {"shape": "cyl", "pos": [int(x), int(y), int(z)],
            "size": [int(max(1, dia)), int(max(1, dia)), int(max(1, hh))], "color": c}


def sp(x, y, z, dia, c):
    d = int(max(1, dia))
    return {"shape": "sphere", "pos": [int(x), int(y), int(z)], "size": [d, d, d], "color": c}


def slot(part):
    part["image_slot"] = True
    return part


# ================================================================== posters & frames
def build_frame(w, d, h, framed=True, mat=0, profile=None, tone="wood"):
    """Wall-hung picture. Local depth axis d is the wall-normal thickness;
    the visible face looks out along -y."""
    fw = profile if profile is not None else (max(16, min(46, int(min(w, h) * 0.045))) if framed else 0)
    yf = -d / 2.0                      # front face plane
    parts = []
    # backing board / stretcher
    parts.append(bx(0, yf + d * 0.78, h / 2, w, max(6, d * 0.42), h, "dark"))
    ap_w, ap_h = w - 2 * (fw + mat), h - 2 * (fw + mat)
    if framed:
        # glazing sits just behind the frame profile
        parts.append(bx(0, yf + d * 0.42, h / 2, w - 2 * fw, max(3, d * 0.16), h - 2 * fw, GLASSY))
        if mat > 0:   # mount board, aperture cut out -> four bands
            my = yf + d * 0.30
            mt = max(3, d * 0.12)
            parts.append(bx(0, my, h - fw - mat / 2.0, w - 2 * fw, mt, mat, MAT))
            parts.append(bx(0, my, fw + mat / 2.0, w - 2 * fw, mt, mat, MAT))
            parts.append(bx(-(w / 2.0 - fw - mat / 2.0), my, h / 2, mat, mt, h - 2 * fw, MAT))
            parts.append(bx((w / 2.0 - fw - mat / 2.0), my, h / 2, mat, mt, h - 2 * fw, MAT))
        # frame profile: four rails, proud of the glass
        fy = yf + d * 0.16
        ft = max(6, d * 0.34)
        parts.append(bx(0, fy, h - fw / 2.0, w, ft, fw, tone))
        parts.append(bx(0, fy, fw / 2.0, w, ft, fw, tone))
        parts.append(bx(-(w - fw) / 2.0, fy, h / 2, fw, ft, h, tone))
        parts.append(bx((w - fw) / 2.0, fy, h / 2, fw, ft, h, tone))
    else:
        # bare sheet + hanger rails top and bottom
        rail = max(14, int(h * 0.022))
        parts.append(bx(0, yf + d * 0.34, h - rail / 2.0, w, max(5, d * 0.3), rail, "wood"))
        parts.append(bx(0, yf + d * 0.34, rail / 2.0, w, max(5, d * 0.3), rail, "wood"))
        ap_h = h - 2 * rail
    # the photo itself
    parts.append(slot(bx(0, yf + d * 0.22, h / 2, ap_w, max(2, d * 0.1), ap_h, SLOT)))
    return parts


def build_canvas(w, d, h):
    """Gallery-wrapped canvas print: no frame, image wraps the edges."""
    yf = -d / 2.0
    parts = [
        bx(0, yf + d * 0.66, h / 2, w - 40, max(6, d * 0.5), h - 40, "wood"),          # stretcher bars
        bx(0, yf + d * 0.66, h - 30, w - 40, max(6, d * 0.5), 40, "wood"),
        bx(0, yf + d * 0.30, h / 2, w, max(4, d * 0.3), h, PAPER),                     # wrapped edge
        slot(bx(0, yf + d * 0.12, h / 2, w - 24, max(2, d * 0.16), h - 24, SLOT)),
    ]
    return parts


def build_triptych(w, d, h, gap=60):
    """Three panels hung as one piece: each panel carries its own image slot."""
    pw = (w - 2 * gap) / 3.0
    yf = -d / 2.0
    parts = []
    for k in (-1, 0, 1):
        cx = k * (pw + gap)
        parts.append(bx(cx, yf + d * 0.70, h / 2, pw, max(6, d * 0.5), h, "dark"))
        parts.append(bx(cx, yf + d * 0.34, h / 2, pw, max(4, d * 0.3), h, "wood"))
        parts.append(slot(bx(cx, yf + d * 0.14, h / 2, pw - 28, max(2, d * 0.16), h - 28, SLOT)))
    return parts


def build_wall_clock(w, d, h):
    """The dial stands in the WALL plane, so it cannot be a `cyl` (whose axis is vertical).
    A plus-of-slabs gives an octagonal dial silhouette without stacking outlines."""
    dia = min(w, h)
    yf = -d / 2.0
    cz = h / 2.0
    rim = max(14, dia * 0.07)
    parts = [bx(0, yf + d * 0.74, cz, dia, max(10, d * 0.5), dia, "dark", r=int(dia * 0.3))]  # case
    for (fx, fz) in ((1.00, 0.62), (0.62, 1.00)):                                             # dial
        parts.append(bx(0, yf + d * 0.34, cz, (dia - 2 * rim) * fx, max(6, d * 0.3),
                        (dia - 2 * rim) * fz, "#F4F1EA"))
    parts.append(bx(0, yf + d * 0.14, cz + dia * 0.16, max(10, dia * 0.04), max(4, d * 0.14), dia * 0.30, "dark"))
    parts.append(bx(dia * 0.12, yf + d * 0.14, cz, dia * 0.24, max(4, d * 0.14), max(10, dia * 0.04), "#B4342B"))
    parts.append(bx(0, yf + d * 0.10, cz, max(16, dia * 0.07), max(4, d * 0.12), max(16, dia * 0.07), "metal"))
    return parts


def build_board(w, d, h, cork=False):
    """Whiteboard / corkboard: frame + writing surface + tray."""
    yf = -d / 2.0
    face = "#C8A87C" if cork else "#F6F5F2"
    fw = 30
    parts = [
        bx(0, yf + d * 0.72, h / 2, w, max(8, d * 0.5), h, "dark"),
        bx(0, yf + d * 0.34, h / 2, w - 2 * fw, max(5, d * 0.28), h - 2 * fw, face),
        bx(0, yf + d * 0.24, h - fw / 2.0, w, max(6, d * 0.3), fw, "metal"),
        bx(0, yf + d * 0.24, fw / 2.0, w, max(6, d * 0.3), fw, "metal"),
        bx(-(w - fw) / 2.0, yf + d * 0.24, h / 2, fw, max(6, d * 0.3), h, "metal"),
        bx((w - fw) / 2.0, yf + d * 0.24, h / 2, fw, max(6, d * 0.3), h, "metal"),
        bx(0, yf + d * 0.05, fw + 22, w * 0.5, max(8, d * 0.5), 22, "metal"),   # pen tray
    ]
    if cork:
        for k in (-1, 1):
            parts.append(sp(k * w * 0.22, yf + d * 0.18, h * 0.62, 26, "#B4342B"))
    return parts


# ================================================================== mirrors
def build_floor_mirror(w, d, h):
    yf = -d / 2.0
    fw = 46
    return [
        bx(0, yf + d * 0.62, h / 2, w, max(10, d * 0.45), h, "wood"),
        bx(0, yf + d * 0.28, h / 2, w - 2 * fw, max(6, d * 0.3), h - 2 * fw, GLASSY),
        bx(0, yf + d * 0.16, h - fw / 2.0, w, max(8, d * 0.34), fw, "wood"),
        bx(0, yf + d * 0.16, fw / 2.0, w, max(8, d * 0.34), fw, "wood"),
        bx(-(w - fw) / 2.0, yf + d * 0.16, h / 2, fw, max(8, d * 0.34), h, "wood"),
        bx((w - fw) / 2.0, yf + d * 0.16, h / 2, fw, max(8, d * 0.34), h, "wood"),
        bx(0, d * 0.30, 30, w * 0.5, d * 0.34, 60, "metal"),   # leaning foot
    ]


# ================================================================== soft floor things
def build_floor_cushion(w, d, h):
    return [
        cy(0, 0, h * 0.46, min(w, d), h * 0.9, "body"),
        cy(0, 0, h * 0.9, min(w, d) * 0.72, h * 0.22, "body"),
        cy(0, 0, h * 0.96, 70, h * 0.1, "dark"),                     # button tuft
        bx(0, -d * 0.42, h * 0.5, w * 0.22, d * 0.1, h * 0.34, "fabric"),  # carry handle
    ]


def build_beanbag(w, d, h):
    """`sphere` rasterises as a drum in the iso renderer, so the pear silhouette is built
    from a stack of shrinking discs instead."""
    dia = min(w, d)
    return [
        cy(0, 0, h * 0.09, dia, h * 0.18, "body"),               # squashed base
        cy(0, 0, h * 0.28, dia * 0.97, h * 0.24, "body"),
        cy(0, -d * 0.04, h * 0.50, dia * 0.84, h * 0.22, "body"),
        cy(0, -d * 0.08, h * 0.68, dia * 0.64, h * 0.18, "body"),  # slumped back-rest
        cy(0, -d * 0.11, h * 0.83, dia * 0.44, h * 0.16, "body"),
        cy(0, -d * 0.13, h * 0.94, dia * 0.26, h * 0.12, "body"),
        bx(0, d * 0.36, h * 0.30, w * 0.16, d * 0.1, h * 0.16, "fabric"),   # carry handle
    ]


def build_pet_bed(w, d, h):
    return [
        cy(0, 0, h * 0.22, min(w, d), h * 0.44, "body"),
        cy(0, 0, h * 0.62, min(w, d), h * 0.42, "body"),
        cy(0, 0, h * 0.66, min(w, d) * 0.62, h * 0.4, "fabric"),   # inner nest
        cy(0, 0, h * 0.46, min(w, d) * 0.6, h * 0.1, "fabric"),
    ]


# ================================================================== boxes, bins, baskets
def build_hamper(w, d, h, lid=True, tapered=True):
    body_h = h * (0.86 if lid else 1.0)
    tw = w * (0.86 if tapered else 1.0)
    parts = [
        bx(0, 0, body_h * 0.5, w, d, body_h, "body", r=40),
        bx(0, 0, body_h * 0.5, tw, d * 0.9, body_h * 0.7, "fabric"),
        bx(0, 0, body_h * 0.06, w * 0.98, d * 0.98, body_h * 0.12, "dark"),
    ]
    if lid:
        parts.append(bx(0, 0, h - (h - body_h) / 2.0, w * 1.0, d * 1.0, h - body_h, "body", r=30))
        parts.append(bx(0, 0, h - 12, w * 0.22, d * 0.16, 24, "wood"))
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 30), 0, body_h * 0.78, 40, d * 0.3, body_h * 0.14, "dark"))
    return parts


def build_moving_box(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "body"),
        bx(0, 0, h - 6, w * 0.98, d * 0.44, 12, "#B99B6E"),      # open flap seam
        bx(0, 0, h - 4, w * 0.2, d * 1.0, 8, "#D9D5CC"),         # packing tape
        bx(0, -d / 2.0 + 8, h * 0.52, w * 0.5, 16, h * 0.18, "#D9D5CC"),   # label
        bx(0, 0, h * 0.03, w * 0.99, d * 0.99, h * 0.06, "#A9865A"),
    ]


def build_storage_bin(w, d, h, fabric=False):
    body = "fabric" if fabric else "body"
    return [
        bx(0, 0, h * 0.5, w, d, h, body, r=30),
        bx(0, 0, h * 0.5, w * 0.9, d * 0.9, h * 0.78, "dark" if fabric else body),
        bx(0, 0, h - h * 0.06, w, d, h * 0.12, "dark"),          # rim
        bx(0, -d / 2.0 + 10, h * 0.6, w * 0.3, 20, h * 0.2, "metal"),   # label holder
        bx(0, 0, h * 0.04, w * 0.92, d * 0.92, h * 0.08, "dark"),
    ]


def build_waste_bin(w, d, h, pedal=True):
    dia = min(w, d)
    parts = [
        cy(0, 0, h * 0.46, dia, h * 0.86, "metal"),
        cy(0, 0, h * 0.9, dia * 1.02, h * 0.1, "dark"),          # rim
        cy(0, 0, h * 0.96, dia * 0.96, h * 0.08, "metal"),       # lid
        cy(0, 0, h * 0.04, dia * 0.94, h * 0.06, "dark"),
    ]
    if pedal:
        parts.append(bx(0, -d * 0.42, h * 0.05, dia * 0.34, d * 0.12, h * 0.05, "dark"))
    return parts


def build_umbrella_stand(w, d, h):
    dia = min(w, d)
    body_h = h * 0.60
    parts = [
        cy(0, 0, body_h * 0.5, dia, body_h, "metal"),
        cy(0, 0, body_h - 20, dia * 1.06, 44, "dark"),          # rim
        cy(0, 0, 24, dia * 1.02, 48, "dark"),                    # foot
    ]
    for k in (-1, 1):                                            # umbrellas poking out the top
        parts.append(cy(k * dia * 0.18, k * dia * 0.10, h * 0.62, 62, h * 0.76, "body"))
        parts.append(bx(k * dia * 0.30, k * dia * 0.10, h - 40, 150, 60, 70, "dark"))   # crook handle
    return parts


def build_litter_box(w, d, h):
    return [
        bx(0, 0, h * 0.22, w, d, h * 0.44, "body", r=40),
        bx(0, d * 0.06, h * 0.7, w * 0.80, d * 0.84, h * 0.56, "body", r=60),   # tapered hood
        bx(0, -d * 0.30, h * 0.52, w * 0.40, 40, h * 0.34, GLASSY),      # flap door
        bx(0, d * 0.06, h - 16, w * 0.34, d * 0.24, 34, "dark"),          # carry handle
        bx(0, 0, h * 0.05, w * 0.96, d * 0.96, h * 0.1, "dark"),
    ]


def build_door_mat(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "body"),
        bx(0, 0, h * 0.85, w - 90, d - 90, max(2, h * 0.4), "dark"),
        bx(0, 0, h * 0.95, w - 220, d - 200, max(2, h * 0.25), "body"),
    ]


def build_yoga_mat(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "body"),
        bx(0, 0, h * 0.9, w - 40, d - 60, max(2, h * 0.3), "dark"),
        bx(0, d * 0.34, h * 0.9, w - 60, 20, max(2, h * 0.3), "body"),
        bx(0, -d * 0.34, h * 0.9, w - 60, 20, max(2, h * 0.3), "body"),
    ]


# ================================================================== racks & stands
def build_shoe_rack(w, d, h, tiers=3):
    parts = []
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 20), 0, h / 2, 40, d, h, "metal"))
    for t in range(tiers):
        z = 60 + t * (h - 120) / max(1, tiers - 1)
        parts.append(bx(0, 0, z, w - 80, d * 0.92, 26, "wood"))
        parts.append(bx(0, d * 0.36, z + 40, w - 80, 18, 60, "metal"))
    return parts


def build_coat_stand(w, d, h):
    dia = min(w, d)
    parts = [
        cy(0, 0, h * 0.5, 90, h, "wood"),
        cy(0, 0, 34, dia, 68, "dark"),
        sp(0, 0, h - 45, 120, "wood"),
    ]
    for k, (ax, ay) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
        z = h - 120 - (k % 2) * 130
        parts.append(bx(ax * dia * 0.30, ay * dia * 0.30, z, 240 if ax else 70, 70 if ax else 240, 56, "wood"))
        parts.append(sp(ax * dia * 0.46, ay * dia * 0.46, z + 40, 80, "metal"))
    # tripod feet
    for (ax, ay) in ((1, 0.6), (-1, 0.6), (0, -1)):
        parts.append(bx(ax * dia * 0.28, ay * dia * 0.28, 34, 190, 190, 66, "wood"))
    return parts


def build_drying_rack(w, d, h):
    """A-frame concertina airer."""
    parts = []
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 24), k * (d / 2.0 - 24), h / 2, 44, 44, h, "metal"))
        parts.append(bx(k * (w / 2.0 - 24), -k * (d / 2.0 - 24), h * 0.44, 40, 40, h * 0.88, "metal"))
    for t in range(5):
        z = h * 0.28 + t * h * 0.17
        yy = (d / 2.0 - 40) * (1 - t / 6.0)
        parts.append(bx(0, yy, z, w - 60, 22, 22, "metal"))
        parts.append(bx(0, -yy, z, w - 60, 22, 22, "metal"))
    parts.append(bx(0, 0, 22, w - 40, d - 40, 30, "metal"))
    return parts


def build_ironing_board(w, d, h):
    parts = [
        bx(-w * 0.06, 0, h - 30, w * 0.88, d * 0.88, 60, "body", r=80),   # padded top
        bx(w * 0.40, 0, h - 30, w * 0.2, d * 0.5, 56, "body", r=60),      # tapered nose
        bx(0, 0, h - 74, w * 0.5, d * 0.4, 30, "metal"),                   # under-frame
    ]
    for k in (-1, 1):
        parts.append(bx(-w * 0.1 + k * w * 0.16, k * (d / 2.0 - 40), h * 0.46, 40, 60, h * 0.92, "metal"))
        parts.append(bx(-w * 0.1 + k * w * 0.16, -k * (d / 2.0 - 40), h * 0.46, 40, 60, h * 0.92, "metal"))
    parts.append(bx(-w * 0.1, 0, 24, w * 0.42, d - 60, 40, "metal"))
    return parts


def build_dumbbell_rack(w, d, h):
    parts = []
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 40), 0, h * 0.48, 70, d, h * 0.96, "dark"))
    for t in range(2):
        z = h * 0.30 + t * h * 0.40
        parts.append(bx(0, 0, z, w - 120, d * 0.8, 40, "metal"))
        for j in (-1, 0, 1):
            x = j * (w * 0.26)
            parts.append(cy(x, 0, z + 90, 130, 150, "dark"))
            parts.append(bx(x, 0, z + 90, w * 0.14, 60, 60, "metal"))
    parts.append(bx(0, 0, 30, w, d, 60, "dark"))
    return parts


def build_guitar_stand(w, d, h):
    parts = [
        bx(0, 0, 30, w, d * 0.9, 60, "metal"),
        bx(0, d * 0.2, h * 0.5, 44, 44, h, "metal"),
        bx(0, d * 0.05, h * 0.30, w * 0.7, 40, 40, "metal"),          # lower yoke
        bx(0, 0, h - 60, w * 0.42, 40, 120, "metal"),                  # neck cradle
        bx(0, -d * 0.12, h * 0.36, w * 0.86, d * 0.42, h * 0.30, "body", r=110),  # lower bout
        bx(0, -d * 0.12, h * 0.56, w * 0.62, d * 0.36, h * 0.16, "body", r=80),   # upper bout
        cy(0, -d * 0.30, h * 0.40, w * 0.22, max(8, d * 0.06), "dark"),           # sound hole
        bx(0, -d * 0.12, h * 0.78, w * 0.16, d * 0.24, h * 0.4, "wood"),         # neck
        bx(0, -d * 0.12, h - 40, w * 0.22, d * 0.26, 90, "dark"),                # headstock
    ]
    return parts


def build_keyboard_stand(w, d, h):
    parts = [
        bx(0, 0, h - 40, w, d * 0.62, 80, "dark", r=20),                # keyboard slab
        bx(0, -d * 0.16, h - 20, w * 0.94, d * 0.4, 30, "#EDE9E2"),     # keys
    ]
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 90), 0, h * 0.46, 50, d * 0.8, h * 0.9, "metal"))
        parts.append(bx(k * (w / 2.0 - 90), 0, 30, 60, d, 60, "metal"))
    parts.append(bx(0, 0, h * 0.4, w - 200, 40, 40, "metal"))
    return parts


def build_cat_tree(w, d, h):
    parts = [
        bx(0, 0, 50, w, d, 100, "body"),
        cy(-w * 0.22, 0, h * 0.26, 130, h * 0.42, "wood"),
        bx(-w * 0.22, 0, h * 0.5, w * 0.62, d * 0.62, 70, "body"),      # mid platform
        cy(w * 0.2, d * 0.1, h * 0.62, 130, h * 0.4, "wood"),
        cy(w * 0.2, d * 0.1, h - 90, min(w, d) * 0.62, 180, "body"),    # top perch
        bx(w * 0.2, d * 0.1, h - 20, min(w, d) * 0.58, min(w, d) * 0.58, 40, "fabric"),
        cy(-w * 0.3, -d * 0.2, h * 0.20, 220, h * 0.3, "body"),          # cubby
    ]
    return parts


def build_desk_riser(w, d, h):
    """Standing-desk converter sitting on a desktop."""
    return [
        bx(0, -d * 0.18, h - 30, w, d * 0.62, 60, "body"),              # upper deck
        bx(0, d * 0.30, 40, w * 0.9, d * 0.36, 80, "body"),             # keyboard tray
        bx(-w * 0.3, 0, h * 0.5, 60, d * 0.5, h * 0.86, "metal"),
        bx(w * 0.3, 0, h * 0.5, 60, d * 0.5, h * 0.86, "metal"),
        bx(0, 0, h * 0.44, w * 0.5, 50, 50, "metal"),
        bx(0, d * 0.34, 12, w * 0.96, d * 0.3, 24, "dark"),
    ]


# ================================================================== tech & appliances
def build_monitor(w, d, h):
    panel_h = h * 0.60
    return [
        bx(0, d * 0.22, h - panel_h / 2.0, w, max(22, d * 0.16), panel_h, "dark"),        # panel body
        bx(0, -d * 0.14, h - panel_h / 2.0, w - 26, max(10, d * 0.08), panel_h - 26, "#2B3138"),  # screen
        bx(0, -d * 0.16, h - panel_h + 34, w * 0.2, max(6, d * 0.06), 24, "#1A1D21"),     # chin logo
        bx(0, d * 0.16, h * 0.34, w * 0.10, d * 0.2, h * 0.34, "metal"),                  # neck
        bx(0, d * 0.1, 16, w * 0.42, d * 0.82, 32, "metal"),                              # foot
    ]


def build_monitor_arm(w, d, h):
    return [
        bx(0, d * 0.36, h * 0.14, w * 0.5, d * 0.26, h * 0.28, "dark"),      # desk clamp
        cy(0, d * 0.30, h * 0.52, 60, h * 0.9, "metal"),                     # post
        bx(0, 0, h - 60, w * 0.4, d * 0.5, 50, "metal"),                     # upper arm
        bx(0, -d * 0.28, h - 130, w * 0.3, d * 0.3, 46, "metal"),            # forearm
        bx(0, -d * 0.44, h - 210, w * 0.5, 40, 220, "dark"),                 # VESA plate
    ]


def build_tower_pc(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "dark", r=14),
        bx(0, -d / 2.0 + 12, h * 0.5, w * 0.9, 24, h * 0.9, "#2A2D33"),       # front panel
        bx(-w * 0.18, -d / 2.0 + 6, h * 0.86, w * 0.5, 14, h * 0.06, "#3B6EF6"),  # power LED strip
        bx(0, d * 0.42, h * 0.72, w * 0.6, 20, h * 0.28, "metal"),            # rear IO
        bx(0, 0, 18, w * 0.9, d * 0.9, 36, "metal"),
    ]


def build_printer(w, d, h):
    return [
        bx(0, 0, h * 0.36, w, d, h * 0.72, "body", r=20),
        bx(0, 0, h * 0.86, w * 0.98, d * 0.9, h * 0.28, "dark", r=20),        # scanner lid
        bx(0, -d / 2.0 + 20, h * 0.5, w * 0.8, 40, h * 0.08, "#2B3138"),      # output slot
        bx(0, -d * 0.36, h * 0.22, w * 0.86, d * 0.3, h * 0.1, "dark"),       # paper tray
        bx(w * 0.28, -d / 2.0 + 12, h * 0.66, w * 0.3, 24, h * 0.12, "#3B6EF6"),  # control panel
    ]


def build_router(w, d, h):
    parts = [
        bx(0, 0, h * 0.16, w, d, h * 0.32, "dark", r=20),
        bx(0, 0, h * 0.34, w * 0.8, d * 0.8, h * 0.06, "#2A2D33"),
        bx(-w * 0.2, -d * 0.3, h * 0.36, w * 0.34, d * 0.12, h * 0.04, "#3B6EF6"),   # LEDs
    ]
    for k in (-1, 1):
        parts.append(bx(k * (w / 2.0 - 30), d * 0.30, h * 0.68, 26, 26, h * 0.7, "dark"))
    parts.append(bx(0, d * 0.30, h * 0.68, 26, 26, h * 0.7, "dark"))
    return parts


def build_desk_lamp(w, d, h):
    return [
        cy(0, d * 0.34, 18, min(w, d) * 0.9, 36, "dark"),                     # weighted base
        bx(0, d * 0.30, h * 0.5, 40, 40, h * 0.94, "metal"),                  # riser
        bx(0, 0, h - 40, 44, d * 0.62, 44, "metal"),                          # arm
        bx(0, -d * 0.26, h - 90, min(w, 190), min(w, 190), 110, "body", r=30),  # shade head
        bx(0, -d * 0.26, h - 148, min(w, 150), min(w, 150), 20, "#F3E7C8"),   # bulb glow
    ]


def build_space_heater(w, d, h):
    parts = [
        bx(0, 0, h * 0.5, w, d, h, "body", r=24),
        bx(0, -d / 2.0 + 16, h * 0.52, w * 0.82, 30, h * 0.6, "dark"),        # grille recess
    ]
    for t in range(5):
        parts.append(bx(0, -d / 2.0 + 8, h * 0.28 + t * h * 0.11, w * 0.76, 16, h * 0.045, "metal"))
    parts.append(bx(0, 0, h - 26, w * 0.5, d * 0.5, 40, "dark"))              # handle / controls
    parts.append(bx(0, 0, 20, w * 0.92, d * 0.92, 40, "dark"))
    return parts


def build_pedestal_fan(w, d, h):
    dia = min(w, min(d, h * 0.36))
    return [
        cy(0, 0, 30, min(w, d) * 0.94, 60, "dark"),
        cy(0, 0, h * 0.44, 60, h * 0.8, "metal"),
        cy(0, d * 0.12, h - dia * 0.55, dia, min(120, d * 0.5), "metal"),     # cage
        cy(0, d * 0.02, h - dia * 0.55, dia * 0.94, min(90, d * 0.4), "body"),
        cy(0, d * 0.3, h - dia * 0.55, dia * 0.32, min(140, d * 0.6), "dark"),  # motor
        bx(0, 0, h * 0.14, 120, 120, h * 0.16, "dark"),                        # control knob block
    ]


def build_tower_fan(w, d, h):
    parts = [
        cy(0, 0, 40, min(w, d) * 1.0, 80, "dark"),                            # base
        bx(0, 0, h * 0.54, w * 0.86, d * 0.86, h * 0.92, "body", r=60),       # column
        bx(0, -d * 0.36, h * 0.56, w * 0.5, d * 0.2, h * 0.7, "dark"),        # front grille
    ]
    for t in range(6):
        parts.append(bx(0, -d * 0.44, h * 0.26 + t * h * 0.11, w * 0.42, 18, h * 0.04, "metal"))
    parts.append(bx(0, 0, h - 40, w * 0.6, d * 0.6, 60, "dark"))              # top control panel
    return parts


def build_air_purifier(w, d, h):
    dia = min(w, d)
    return [
        cy(0, 0, h * 0.46, dia, h * 0.9, "body"),
        cy(0, 0, h * 0.46, dia * 0.9, h * 0.66, "dark"),                      # intake mesh band
        cy(0, 0, h * 0.9, dia * 0.98, h * 0.16, "body"),
        cy(0, 0, h - 20, dia * 0.6, 40, "metal"),                             # top outlet
        cy(0, 0, 24, dia * 0.96, 48, "dark"),
    ]


def build_humidifier(w, d, h):
    dia = min(w, d)
    return [
        cy(0, 0, h * 0.34, dia, h * 0.68, "body"),
        cy(0, 0, h * 0.34, dia * 0.72, h * 0.5, GLASSY),                      # water tank window
        cy(0, 0, h * 0.78, dia * 0.9, h * 0.2, "body"),
        cy(0, 0, h - 30, dia * 0.34, 60, "metal"),                            # mist spout
        cy(0, 0, 20, dia * 0.98, 40, "dark"),
    ]


def build_mini_fridge(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "body", r=16),
        bx(0, -d / 2.0 + 22, h * 0.54, w * 0.94, 44, h * 0.86, "#E4E1DA"),    # door face
        bx(w * 0.36, -d / 2.0 + 6, h * 0.56, 34, 26, h * 0.4, "metal"),       # handle
        bx(0, -d / 2.0 + 10, h * 0.14, w * 0.94, 24, h * 0.06, "dark"),       # door seam / freezer line
        bx(0, 0, 28, w * 0.94, d * 0.94, 56, "dark"),                          # plinth
    ]


def build_microwave(w, d, h):
    return [
        bx(0, 0, h * 0.5, w, d, h, "body", r=14),
        bx(-w * 0.1, -d / 2.0 + 18, h * 0.52, w * 0.68, 36, h * 0.72, "dark"),   # door
        bx(-w * 0.1, -d / 2.0 + 8, h * 0.52, w * 0.56, 20, h * 0.56, "#2B3138"), # window
        bx(w * 0.36, -d / 2.0 + 14, h * 0.52, w * 0.2, 30, h * 0.8, "#E4E1DA"),  # control panel
        bx(w * 0.36, -d / 2.0 + 4, h * 0.72, w * 0.14, 16, h * 0.18, "#3B6EF6"), # display
        bx(0, 0, 20, w * 0.9, d * 0.9, 40, "dark"),
    ]


def build_kettle(w, d, h):
    dia = min(w, d) * 0.82
    return [
        cy(0, 0, 22, min(w, d), 44, "dark"),                                   # power base
        cy(0, 0, h * 0.5, dia, h * 0.8, "body"),
        cy(0, 0, h * 0.9, dia * 0.86, h * 0.14, "dark"),                        # lid
        bx(dia * 0.02, -d * 0.42, h * 0.72, dia * 0.3, d * 0.2, h * 0.18, "body"),   # spout
        bx(0, d * 0.42, h * 0.6, 40, d * 0.16, h * 0.5, "dark"),                # handle
        cy(0, -d * 0.3, h * 0.5, dia * 0.2, h * 0.5, GLASSY),                   # water window
    ]


def build_robot_vacuum(w, d, h):
    dia = min(w, d)
    return [
        cy(0, 0, h * 0.44, dia, h * 0.88, "body"),
        cy(0, 0, h * 0.9, dia * 0.9, h * 0.2, "dark"),                          # top cover
        cy(0, 0, h - 8, dia * 0.24, 16, "#3B6EF6"),                             # button
        bx(0, -d * 0.4, h * 0.4, dia * 0.7, d * 0.14, h * 0.5, "dark"),         # bumper
        bx(-dia * 0.36, -d * 0.3, h * 0.18, dia * 0.3, dia * 0.1, h * 0.2, "metal"),  # side brush
    ]


def build_vacuum_dock(w, d, h):
    return [
        bx(0, d * 0.28, h * 0.5, w, d * 0.44, h, "body", r=20),                 # tower
        bx(0, -d * 0.26, 24, w * 0.9, d * 0.5, 48, "body"),                     # ramp
        bx(0, -d * 0.26, 46, w * 0.5, d * 0.4, 20, "metal"),                    # charge pads
        bx(0, d * 0.06, h * 0.72, w * 0.6, 30, h * 0.3, "dark"),
        bx(0, d * 0.28, h - 30, w * 0.9, d * 0.4, 60, "dark"),
    ]


# ================================================================== window & wall fittings
def build_curtain_rod(w, d, h):
    # the rod is horizontal, so it cannot be a `cyl` (whose axis is vertical here)
    dia = max(34, min(h * 0.55, d * 0.55))
    parts = [bx(0, 0, h - dia * 0.62, w * 0.92, dia, dia, "metal")]
    for k in (-1, 1):
        parts.append(sp(k * (w / 2.0 - dia * 0.85), 0, h - dia * 0.62, dia * 1.9, "dark"))      # finials
        parts.append(bx(k * (w * 0.34), d * 0.22, h * 0.34, dia * 0.8, d * 0.55, h * 0.68, "metal"))  # brackets
    for j in range(5):                                                                        # ring glides
        parts.append(bx(-w * 0.30 + j * w * 0.15, 0, h - dia * 0.62, dia * 0.5, dia * 1.5, dia * 1.5, "dark"))
    return parts


def build_roller_blind(w, d, h):
    return [
        cy(0, 0, h - 45, min(90, d), min(90, d), "dark"),                     # (visual cap)
        bx(0, 0, h - 45, w, min(90, d), 90, "dark"),                          # roller tube
        bx(0, -d * 0.1, h * 0.48, w * 0.98, max(6, d * 0.16), h * 0.86, "body"),   # fabric
        bx(0, -d * 0.1, h * 0.07, w * 0.98, max(10, d * 0.3), 60, "wood"),    # bottom bar
        bx(w / 2.0 - 20, d * 0.16, h * 0.6, 16, 16, h * 0.7, "metal"),        # chain
    ]


def build_radiator_cover(w, d, h):
    parts = [
        bx(0, 0, h - 25, w, d, 50, "body"),                                    # top shelf
        bx(-(w / 2.0 - 40), 0, h * 0.5, 80, d, h, "body"),
        bx((w / 2.0 - 40), 0, h * 0.5, 80, d, h, "body"),
        bx(0, d * 0.36, h * 0.5, w - 160, d * 0.24, h * 0.9, "dark"),          # recessed back
        bx(0, -d * 0.36, 40, w - 160, d * 0.24, 80, "body"),
    ]
    for t in range(7):                                                          # grille slats
        parts.append(bx(-w * 0.36 + t * (w * 0.72 / 6.0), -d * 0.3, h * 0.55, w * 0.035, d * 0.2, h * 0.68, "wood"))
    return parts


def build_string_lights(w, d, h):
    """Draped festoon: catenary of bulbs on a cable."""
    parts = []
    n = 9
    for i in range(n):
        t = i / (n - 1.0)
        x = -w / 2.0 + t * w
        sag = math.sin(math.pi * t)
        z = h - 60 - sag * (h * 0.58)
        parts.append(bx(x, 0, z + 70, w / (n * 1.25), 34, 40, "dark"))         # cable segment
        parts.append(sp(x, 0, z - 30, min(150, d * 2.2), "#F3E7C8"))           # bulb
    parts.append(bx(-w / 2.0 + 45, 0, h - 45, 90, 50, 90, "dark"))
    parts.append(bx(w / 2.0 - 45, 0, h - 45, 90, 50, 90, "dark"))
    return parts


# ================================================================== plants
def build_hanging_plant(w, d, h):
    dia = min(w, d)
    parts = []
    for k in (-1, 1):                                                           # hanger cords
        parts.append(bx(k * dia * 0.3, 0, h * 0.78, 16, 16, h * 0.44, "dark"))
        parts.append(bx(0, k * dia * 0.3, h * 0.78, 16, 16, h * 0.44, "dark"))
    parts.append(bx(0, 0, h - 20, 40, 40, 40, "metal"))                         # ceiling hook
    parts.append(cy(0, 0, h * 0.5, dia * 0.72, h * 0.2, "body"))                # pot
    parts.append(cy(0, 0, h * 0.58, dia * 0.6, h * 0.06, SOIL))
    for (ax, ay, ln) in ((1, 0, 0.36), (-1, 0.4, 0.28), (0.3, -1, 0.32), (-0.6, -0.7, 0.24)):
        parts.append(bx(ax * dia * 0.28, ay * dia * 0.28, h * (0.42 - ln / 2 + 0.02),
                        dia * 0.2, dia * 0.2, h * ln, GREEN))
    parts.append(sp(0, 0, h * 0.44, dia * 0.6, GREEN))
    return parts


# ================================================================== bikes
def _wheel(cx, dia, y, color="dark", seg=12, tyre=None):
    """Axis-aligned block ring standing in the x-z plane -- reads as a wheel. Segments are
    kept thin with visible gaps so it doesn't collapse into a disc."""
    out = []
    r = dia / 2.0
    t = max(44, dia * 0.11)
    for k in range(seg):
        a = 2 * math.pi * k / seg
        x = cx + r * math.cos(a) * 0.93
        z = r + r * math.sin(a) * 0.93
        out.append({"shape": "box", "pos": [int(x), int(y), int(z)],
                    "size": [int(t * 1.25), int(t * 0.75), int(t * 1.25)], "color": color})
    out.append({"shape": "cyl", "pos": [int(cx), int(y), int(r)],
                "size": [int(dia * 0.22), int(dia * 0.22), int(t * 0.6)], "color": "metal"})
    return out


def build_bike(w, d, h):
    wd = min(h * 0.62, w * 0.38)
    rear, front = -w * 0.30, w * 0.30
    parts = []
    parts += _wheel(rear, wd, 0)
    parts += _wheel(front, wd, 0)
    parts += [
        bx(0, 0, h * 0.60, w * 0.44, 60, 60, "body"),                    # top tube
        bx(-w * 0.02, 0, h * 0.42, w * 0.40, 55, 55, "body"),            # down tube
        bx(rear + wd * 0.32, 0, h * 0.48, 60, 55, h * 0.42, "body"),     # seat tube
        bx(front - wd * 0.1, 0, h * 0.56, 60, 55, h * 0.44, "body"),     # fork / head tube
        bx(rear + wd * 0.30, 0, h - 40, w * 0.14, 90, 70, "dark"),       # saddle
        bx(front - wd * 0.06, 0, h - 60, 60, d * 0.9, 60, "dark"),       # handlebar
        bx(rear + wd * 0.36, 0, wd * 0.5, w * 0.30, 40, 40, "metal"),    # chainstay
    ]
    return parts


def build_bike_wall(w, d, h):
    wd = min(h * 0.66, w * 0.40)
    rear, front = -w * 0.28, w * 0.28
    parts = [
        bx(0, d * 0.40, h * 0.86, w * 0.5, d * 0.2, 90, "metal"),        # wall rail
        bx(-w * 0.2, d * 0.24, h * 0.86, 70, d * 0.4, 70, "dark"),       # hooks
        bx(w * 0.2, d * 0.24, h * 0.86, 70, d * 0.4, 70, "dark"),
    ]
    parts += _wheel(rear, wd, -d * 0.1)
    parts += _wheel(front, wd, -d * 0.1)
    parts += [
        bx(0, -d * 0.1, h * 0.52, w * 0.42, 60, 60, "body"),
        bx(-w * 0.02, -d * 0.1, h * 0.36, w * 0.38, 55, 55, "body"),
        bx(rear + wd * 0.3, -d * 0.1, h * 0.44, 60, 55, h * 0.36, "body"),
        bx(front - wd * 0.1, -d * 0.1, h * 0.50, 60, 55, h * 0.38, "body"),
        bx(rear + wd * 0.3, -d * 0.1, h * 0.66, w * 0.13, 85, 65, "dark"),
    ]
    return parts


# ================================================================== folding pieces
def build_folding_chair(w, d, h, seat_h):
    return [
        bx(0, 0, seat_h - 20, w * 0.94, d * 0.7, 40, "body"),                        # seat
        bx(0, d * 0.34, (seat_h + h) / 2.0, w * 0.94, 40, h - seat_h, "body"),       # back
        bx(0, d * 0.34, h - 40, w * 0.94, 46, 60, "metal"),
        bx(-(w / 2.0 - 30), d * 0.28, seat_h * 0.5, 46, 46, seat_h, "metal"),
        bx((w / 2.0 - 30), d * 0.28, seat_h * 0.5, 46, 46, seat_h, "metal"),
        bx(-(w / 2.0 - 30), -d * 0.3, seat_h * 0.5, 46, 46, seat_h, "metal"),
        bx((w / 2.0 - 30), -d * 0.3, seat_h * 0.5, 46, 46, seat_h, "metal"),
        bx(0, 0, seat_h * 0.34, w * 0.9, d * 0.6, 34, "metal"),                      # cross brace
    ]


def build_folding_table(w, d, h):
    parts = [
        bx(0, 0, h - 25, w, d, 50, "body", r=20),
        bx(0, 0, h - 70, w * 0.94, d * 0.9, 44, "metal"),
    ]
    for kx in (-1, 1):
        parts.append(bx(kx * (w / 2.0 - 90), 0, h * 0.46, 55, d * 0.86, h * 0.9, "metal"))
        parts.append(bx(kx * (w / 2.0 - 90), 0, 24, 70, d * 0.9, 48, "metal"))
    parts.append(bx(0, 0, h * 0.3, w * 0.5, 40, 40, "metal"))
    return parts

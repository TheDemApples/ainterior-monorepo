# -*- coding: utf-8 -*-
"""Builds catalog.json / schema.json / archetypes.json / seed.sql from the source tables."""
import json, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from items_data import ITEMS, P
from archetypes_data import A, CATEGORIES, SANITY
import proxy_builders as B

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

# ----------------------------------------------------------------- proxy dispatch
def build_proxy(it):
    iid, name, ptype, cat, arch, w, d, h, sh, price, conf, fp, pal, tags, note = it
    low = iid.lower()
    if arch in ("sofa_3seat", "sofa_2seat", "loveseat"):
        n = 3 if arch == "sofa_3seat" else 2
        return B.build_sofa(w, d, h, sh, n)
    if arch == "sofa_sectional_l":
        return B.build_sectional(w, d, h, sh, notch_w=int(w * 0.42), notch_d=d - 950 if d > 1250 else int(d * 0.42))
    if arch == "chaise":
        return B.build_sofa(w, d, h, sh, 2, arms=True)
    if arch == "armchair":
        return B.build_armchair(w, d, h, sh)
    if arch == "ottoman":
        return B.build_ottoman(w, d, h, sh)
    if arch == "bench":
        return B.build_bench(w, d, h, sh, storage=("mackapar" in low))
    if arch == "dining_chair":
        return B.build_dining_chair(w, d, h, sh, upholstered=any(k in low for k in ("ekedalen", "tullsta", "mammut")))
    if arch == "office_chair":
        return B.build_office_chair(w, d, h, sh, headrest=(h >= 1200))
    if arch == "stool":
        return B.build_stool(w, d, h, sh)
    if arch == "bar_stool":
        return B.build_bar_stool(w, d, h, sh)
    if arch.startswith("bed_"):
        return B.build_bed(w, d, h, sh, headboard=(h >= 600),
                           storage=any(k in low for k in ("brimnes", "hauga", "malm-bed")))
    if arch == "crib":
        return B.build_crib(w, d, h)
    if arch == "nightstand":
        return B.build_nightstand(w, d, h, n_drawers=1 if "knarrevik" in low else 2)
    if arch == "dresser":
        m = re.search(r"(\d)drawer", low)
        return B.build_drawer_chest(w, d, h, int(m.group(1)) if m else 3,
                                   legs=any(k in low for k in ("hemnes", "koppang", "tarva")))
    if arch == "wardrobe":
        return B.build_wardrobe(w, d, h, mirror=("brimnes" in low))
    if arch == "bookcase":
        return B.build_bookcase(w, d, h)
    if arch == "shelf_unit":
        if "kallax" in low:
            return B.build_shelf_grid(w, d, h)
        return B.build_open_shelf(w, d, h)
    if arch == "sideboard":
        return B.build_sideboard(w, d, h, drawers=2 if "havsta" in low else 0)
    if arch == "cabinet":
        return B.build_cabinet(w, d, h, drawers=5 if "alex" in low else 0)
    if arch == "tv_bench":
        return B.build_tv_bench(w, d, h)
    if arch == "storage_box":
        return B.build_storage_box(w, d, h)
    if arch == "coffee_table":
        return B.build_low_table(w, d, h, round_top=(fp == "round"),
                                 shelf=any(k in low for k in ("lack", "vittsjo", "hemnes", "stockholm")),
                                 pedestal=("kragsta" in low))
    if arch == "side_table":
        return B.build_low_table(w, d, h, round_top=(fp == "round"),
                                 shelf=any(k in low for k in ("lack", "lunnarp")),
                                 pedestal=any(k in low for k in ("gladom", "burvik")))
    if arch == "dining_table_rect":
        return B.build_dining_table_rect(w, d, h)
    if arch == "dining_table_round":
        return B.build_dining_table_round(w, d, h, pedestal=("docksta" in low))
    if arch == "desk":
        return B.build_desk(w, d, h, drawer_unit=any(k in low for k in ("micke", "alex", "hemnes-desk", "malm-desk")))
    if arch == "console_table":
        return B.build_console(w, d, h)
    if arch == "kitchen_island":
        return B.build_kitchen_island(w, d, h)
    if arch == "rug":
        return B.build_rug(w, d, h)
    if arch == "floor_lamp":
        return B.build_floor_lamp(w, d, h, uplighter=("not-floor" in low))
    if arch == "table_lamp":
        return B.build_table_lamp(w, d, h)
    if arch == "pendant_lamp":
        return B.build_pendant_lamp(w, d, h)
    if arch == "wall_lamp":
        return B.build_wall_lamp(w, d, h)
    if arch == "tv":
        return B.build_tv(w, d, h)
    if arch == "art_frame":
        return B.build_art_frame(w, d, h)
    if arch == "mirror":
        return B.build_mirror(w, d, h, round_shape=("round-mirror" in tags))
    if arch == "plant":
        return B.build_plant(w, d, h)
    if arch == "curtain":
        return B.build_curtain(w, d, h)
    if arch == "wall_shelf":
        return B.build_wall_shelf(w, d, h)
    raise SystemExit("no proxy builder for archetype " + arch)


# ----------------------------------------------------------------- clamp parts into bounds
def clamp_parts(parts, w, d, h):
    """Guarantees every primitive sits inside the [w,d,h] box (validator invariant)."""
    out = []
    for p in parts:
        sx, sy, sz = p["size"]
        x, y, z = p["pos"]
        if p["shape"] == "sphere":
            dd = min(sx, sy, sz, w, d, h)
            sx = sy = sz = dd
        else:
            sx, sy = min(sx, w), min(sy, d)
            sz = min(sz, h)
        x = max(-(w / 2 - sx / 2), min(w / 2 - sx / 2, x))
        y = max(-(d / 2 - sy / 2), min(d / 2 - sy / 2, y))
        z = max(sz / 2, min(h - sz / 2, z))
        p["pos"] = [int(round(x)), int(round(y)), int(round(z))]
        p["size"] = [int(round(sx)), int(round(sy)), int(round(sz))] if p["shape"] != "plane" \
            else [int(round(sx)), int(round(sy)), 0]
        out.append(p)
    return out


# ----------------------------------------------------------------- item assembly
SEAT_ARCH = {"sofa_2seat", "sofa_3seat", "sofa_sectional_l", "loveseat", "chaise", "armchair",
             "ottoman", "bench", "dining_chair", "office_chair", "stool", "bar_stool",
             "bed_single", "bed_double", "bed_queen", "bed_king"}

def make_item(it):
    iid, name, ptype, cat, arch, w, d, h, sh, price, conf, fp, pal, tags, note = it
    if arch not in A:
        raise SystemExit("archetype not in closed set: " + arch)
    if cat not in CATEGORIES:
        raise SystemExit("bad category: " + cat)
    a = A[arch]
    cf, cb, cl, cr = a["c"]
    place = {"against_wall": False, "wall_offset_mm": 0, "corner_ok": False, "center_ok": False,
             "needs_wall_len_mm": None, "stackable": False, "wall_mounted": False,
             "mount_h_mm": None, "ceiling_mounted": False}
    place.update(a["p"])
    if place["against_wall"] or place["wall_mounted"]:
        margin = 200 if arch == "curtain" else 100
        place["needs_wall_len_mm"] = int(w + margin)
    l_shape = None
    if fp == "L":
        nw = int(w * 0.42)
        nd = d - 950 if d > 1250 else int(d * 0.42)
        l_shape = {"notch_w": nw, "notch_d": int(nd)}
    parts = clamp_parts(build_proxy(it), w, d, h)
    return {
        "id": iid, "brand": "IKEA" if iid.startswith("ikea-") else "Generic",
        "name": name, "product_type": ptype, "sku": None,
        "category": cat, "archetype": arch,
        "dims_mm": {"w": int(w), "d": int(d), "h": int(h)},
        "seat_h_mm": int(sh) if (sh and arch in SEAT_ARCH) else None,
        "footprint": fp, "l_shape_mm": l_shape,
        "clearance_mm": {"front": cf, "back": cb, "left": cl, "right": cr},
        "placement": place,
        "colorways": [{"name": n, "hex": hx} for (n, hx) in P[pal]],
        "price_usd": int(price),
        "url": ("https://www.ikea.com/us/en/search/?q=" +
                (name + " " + ptype).replace(" ", "+")) if iid.startswith("ikea-") else None,
        "tags": list(tags),
        "dims_confidence": conf,
        "dims_note": note or None,
        "proxy": {"parts": parts},
    }


def main():
    items = [make_item(it) for it in ITEMS]
    ids = [i["id"] for i in items]
    assert len(ids) == len(set(ids)), "duplicate ids: " + str([x for x in ids if ids.count(x) > 1])
    catalog = {"version": 1, "generated_by": "packages/catalog/tools/gen_catalog.py",
               "units": "mm (integers)", "items": items}
    with open(os.path.join(OUT, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)

    # ---------- archetypes.json
    arch_out = {}
    for k, v in A.items():
        cf, cb, cl, cr = v["c"]
        place = {"against_wall": False, "wall_offset_mm": 0, "corner_ok": False, "center_ok": False,
                 "stackable": False, "wall_mounted": False, "mount_h_mm": None, "ceiling_mounted": False}
        place.update(v["p"])
        arch_out[k] = {"clearance_mm": {"front": cf, "back": cb, "left": cl, "right": cr},
                       "placement_defaults": place, "layout_hints": v["hints"],
                       "dims_sanity_mm": SANITY[k]}
    with open(os.path.join(OUT, "archetypes.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "categories": CATEGORIES, "archetypes": arch_out}, f,
                  ensure_ascii=False, indent=1)

    # ---------- schema.json
    part = {
        "type": "object", "additionalProperties": False,
        "required": ["shape", "pos", "size", "color"],
        "properties": {
            "shape": {"enum": ["box", "cyl", "sphere", "plane"]},
            "pos": {"type": "array", "items": {"type": "integer"}, "minItems": 3, "maxItems": 3},
            "size": {"type": "array", "items": {"type": "integer", "minimum": 0}, "minItems": 3, "maxItems": 3},
            "color": {"oneOf": [{"enum": ["body", "wood", "metal", "glass", "fabric", "dark"]},
                                {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}]},
            "radius": {"type": "integer", "minimum": 0},
        },
    }
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "https://ainterior.app/schema/catalog-item.json",
        "title": "ainterior CatalogItem v1",
        "definitions": {"proxy_part": part},
        "type": "object", "additionalProperties": False,
        "required": ["id", "brand", "name", "product_type", "sku", "category", "archetype",
                     "dims_mm", "seat_h_mm", "footprint", "l_shape_mm", "clearance_mm",
                     "placement", "colorways", "price_usd", "url", "tags", "proxy",
                     "dims_confidence"],
        "properties": {
            "id": {"type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$"},
            "brand": {"type": "string", "minLength": 1},
            "name": {"type": "string", "minLength": 1},
            "product_type": {"type": "string", "minLength": 1},
            "sku": {"type": ["string", "null"]},
            "category": {"enum": CATEGORIES},
            "archetype": {"enum": sorted(A.keys())},
            "dims_mm": {"type": "object", "additionalProperties": False,
                        "required": ["w", "d", "h"],
                        "properties": {k: {"type": "integer", "minimum": 1, "maximum": 6000} for k in "wdh"}},
            "seat_h_mm": {"type": ["integer", "null"], "minimum": 100, "maximum": 1200},
            "footprint": {"enum": ["rect", "round", "L"]},
            "l_shape_mm": {"oneOf": [{"type": "null"},
                                     {"type": "object", "additionalProperties": False,
                                      "required": ["notch_w", "notch_d"],
                                      "properties": {"notch_w": {"type": "integer", "minimum": 1},
                                                     "notch_d": {"type": "integer", "minimum": 1}}}]},
            "clearance_mm": {"type": "object", "additionalProperties": False,
                             "required": ["front", "back", "left", "right"],
                             "properties": {k: {"type": "integer", "minimum": 0, "maximum": 2000}
                                            for k in ["front", "back", "left", "right"]}},
            "placement": {"type": "object", "additionalProperties": False,
                          "required": ["against_wall", "wall_offset_mm", "corner_ok", "center_ok",
                                       "needs_wall_len_mm", "stackable", "wall_mounted",
                                       "mount_h_mm", "ceiling_mounted"],
                          "properties": {
                              "against_wall": {"type": "boolean"},
                              "wall_offset_mm": {"type": "integer", "minimum": 0, "maximum": 500},
                              "corner_ok": {"type": "boolean"},
                              "center_ok": {"type": "boolean"},
                              "needs_wall_len_mm": {"type": ["integer", "null"], "minimum": 0},
                              "stackable": {"type": "boolean"},
                              "wall_mounted": {"type": "boolean"},
                              "mount_h_mm": {"type": ["integer", "null"], "minimum": 0, "maximum": 3000},
                              "ceiling_mounted": {"type": "boolean"}}},
            "colorways": {"type": "array", "minItems": 1, "items": {
                "type": "object", "additionalProperties": False, "required": ["name", "hex"],
                "properties": {"name": {"type": "string", "minLength": 1},
                               "hex": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}}}},
            "price_usd": {"type": "integer", "minimum": 0, "maximum": 100000},
            "url": {"type": ["string", "null"]},
            "tags": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}},
            "dims_confidence": {"enum": ["high", "medium", "low"]},
            "dims_note": {"type": ["string", "null"]},
            "proxy": {"type": "object", "additionalProperties": False, "required": ["parts"],
                      "properties": {"parts": {"type": "array", "minItems": 1,
                                               "items": {"$ref": "#/definitions/proxy_part"}}}},
        },
    }
    with open(os.path.join(OUT, "schema.json"), "w", encoding="utf-8") as f:
        json.dump(schema, f, ensure_ascii=False, indent=1)

    # ---------- seed.sql
    def q(v):
        if v is None:
            return "NULL"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    def jq(v):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"

    lines = [
        "-- ainterior :: packages/catalog/seed.sql",
        "-- Generated by tools/gen_catalog.py -- DO NOT EDIT BY HAND.",
        "-- Target: public.catalog_items (SPEC v1 §6). Idempotent: re-running upserts on id.",
        "-- Units: millimetres, integers (SPEC v1 §1).",
        "begin;",
        "",
        "insert into public.catalog_items",
        "  (slug, brand, name, product_type, sku, category, archetype, dims_mm, seat_h_mm,",
        "   footprint, l_shape_mm, clearance_mm, placement, colorways, price_usd, url, tags,",
        "   dims_confidence, dims_note, proxy, published)",
        "values",
    ]
    rows = []
    for i in items:
        rows.append("  (" + ", ".join([
            q(i["id"]), q(i["brand"]), q(i["name"]), q(i["product_type"]), q(i["sku"]),
            q(i["category"]), q(i["archetype"]), jq(i["dims_mm"]),
            q(i["seat_h_mm"]), q(i["footprint"]),
            jq(i["l_shape_mm"]) if i["l_shape_mm"] else "NULL",
            jq(i["clearance_mm"]), jq(i["placement"]), jq(i["colorways"]),
            q(i["price_usd"]), q(i["url"]), jq(i["tags"]),
            q(i["dims_confidence"]), q(i["dims_note"]), jq(i["proxy"]), "true",
        ]) + ")")
    lines.append(",\n".join(rows) + "")
    lines += [
        "on conflict (slug) do update set",
        "  brand = excluded.brand,",
        "  name = excluded.name,",
        "  product_type = excluded.product_type,",
        "  sku = excluded.sku,",
        "  category = excluded.category,",
        "  archetype = excluded.archetype,",
        "  dims_mm = excluded.dims_mm,",
        "  seat_h_mm = excluded.seat_h_mm,",
        "  footprint = excluded.footprint,",
        "  l_shape_mm = excluded.l_shape_mm,",
        "  clearance_mm = excluded.clearance_mm,",
        "  placement = excluded.placement,",
        "  colorways = excluded.colorways,",
        "  price_usd = excluded.price_usd,",
        "  url = excluded.url,",
        "  tags = excluded.tags,",
        "  dims_confidence = excluded.dims_confidence,",
        "  dims_note = excluded.dims_note,",
        "  proxy = excluded.proxy,",
        "  published = excluded.published;",
        "",
        "commit;",
        "",
        "-- embedding vector(512) and phash are populated out-of-band by the dedupe pipeline",
        "-- (Deliverable D); they are intentionally left NULL here.",
    ]
    with open(os.path.join(OUT, "seed.sql"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("items: %d   proxy parts: %d   avg %.1f" % (
        len(items), sum(len(i["proxy"]["parts"]) for i in items),
        sum(len(i["proxy"]["parts"]) for i in items) / len(items)))
    from collections import Counter
    print("categories:", dict(Counter(i["category"] for i in items)))
    print("confidence:", dict(Counter(i["dims_confidence"] for i in items)))
    print("archetypes used:", len(set(i["archetype"] for i in items)), "of", len(A))
    print("unused archetypes:", sorted(set(A) - set(i["archetype"] for i in items)))


if __name__ == "__main__":
    main()

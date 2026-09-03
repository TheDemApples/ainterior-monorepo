# -*- coding: utf-8 -*-
"""ainterior generic defaults (SPEC2 §I2) -- the everyday things where brand doesn't matter,
plus the poster / frame family that carries a user photo (`image_slot`, SPEC2 §G3).

All ids are prefixed `ai-`, brand is "ainterior", dims_confidence is "high": these are
published standard sizes (ISO A-series, US frame sizes, ISO 216 paper, standard appliance
envelopes), not scraped guesses.

Record shape (dict, so new keys can be added without touching the 200-row IKEA table):
  id name ptype cat arch w d h  [seat_h] price(None = meaningless) fp pal tags builder
  [place]  -> placement overrides merged over the archetype defaults
  [note]   -> dims_note
"""

# ---------------------------------------------------------------- colour palettes
AIP = {
    "frame_wood":  [("Oak", "#C7A87A"), ("Black", "#26262A"), ("White", "#F2F1EE"), ("Walnut", "#6B4A32")],
    "frame_black": [("Black", "#26262A"), ("White", "#F2F1EE"), ("Oak", "#C7A87A")],
    "paper":       [("Matte paper", "#E7E3DA"), ("Bright white", "#F5F3EF")],
    "canvas":      [("Natural canvas", "#E4DCCB"), ("Bright white", "#F5F3EF")],
    "white":       [("White", "#F2F1EE")],
    "white_black": [("White", "#F2F1EE"), ("Black", "#26262A")],
    "black":       [("Black", "#26262A"), ("Graphite", "#3B3D40")],
    "gray":        [("Light gray", "#C9C6C0"), ("Dark gray", "#5C5F63")],
    "beige":       [("Beige", "#D8D2C4"), ("Off-white", "#EDE9E2"), ("Charcoal", "#3A3A3C")],
    "natural":     [("Natural rattan", "#C8A87C"), ("Bleached", "#E0D3BC")],
    "kraft":       [("Kraft cardboard", "#C39A66")],
    "steel":       [("Brushed steel", "#9AA0A6"), ("Matte black", "#26262A")],
    "tech_black":  [("Matte black", "#1E1E20"), ("Silver", "#B9BDC2")],
    "tech_white":  [("White", "#F2F1EE"), ("Graphite", "#3B3D40")],
    "green":       [("Green", "#4C7A45")],
    "denim":       [("Denim blue", "#42607F"), ("Charcoal", "#3A3A3C"), ("Mustard", "#C6912F")],
    "teal":        [("Teal", "#2F6E6B"), ("Black", "#26262A"), ("Red", "#B4342B")],
    "warm_white":  [("Warm white", "#F3E7C8")],
    "cork":        [("Cork", "#C8A87C")],
    "mat_white":   [("White mount", "#EDE9E2"), ("Black mount", "#26262A")],
}

_A = "appliance"       # category shorthand
_D = "decor"
_S = "storage"

# ---------------------------------------------------------------- poster / frame family
# Frame profile ~30-45mm per side, mount (matting) inset where a mount is conventional.
# `w`/`h` are the OUTSIDE dimensions; the image_slot part is the visible aperture.
_POSTERS = [
    # (key, sheet_w, sheet_h, label)
    ("a4",    210,  297, "A4"),
    ("a3",    297,  420, "A3"),
    ("a2",    420,  594, "A2"),
    ("a1",    594,  841, "A1"),
    ("a0",    841, 1189, "A0"),
    ("8x10",  203,  254, '8×10"'),
    ("11x14", 279,  356, '11×14"'),
    ("16x20", 406,  508, '16×20"'),
    ("18x24", 457,  610, '18×24"'),
    ("24x36", 610,  914, '24×36"'),
    ("12x12", 305,  305, '12×12"'),
]

# frame profile + mount inset + depth, by sheet size band
def _frame_geom(sw, sh):
    m = max(sw, sh)
    if m <= 320:
        return 32, 40, 26
    if m <= 460:
        return 34, 45, 28
    if m <= 640:
        return 38, 50, 30
    if m <= 900:
        return 42, 55, 34
    return 46, 60, 40


def _poster_items():
    out = []
    for key, sw, sh, label in _POSTERS:
        fw, mat, dep = _frame_geom(sw, sh)
        ow, oh = sw + 2 * fw, sh + 2 * fw
        mnt = max(300, int(1500 - oh / 2))
        out.append(dict(
            id="ai-frame-%s-framed" % key, name="Photo frame %s" % label,
            ptype="Framed print with mount, %s" % label, cat=_D, arch="art_frame",
            w=ow, d=dep, h=oh, price=max(9, int(round((ow * oh) / 40000.0)) * 5), fp="rect",
            pal="frame_wood", tags=["wall-art", "photo", "image-slot", "frame", key],
            builder=("frame", {"framed": True, "mat": mat, "profile": fw}),
            place={"mount_h_mm": mnt},
            note="ISO/US standard %s aperture; outside size includes a %dmm frame profile and %dmm mount." % (label, fw, mat)))
        out.append(dict(
            id="ai-poster-%s-unframed" % key, name="Poster %s" % label,
            ptype="Unframed poster print, %s" % label, cat=_D, arch="art_frame",
            w=sw, d=16, h=sh, price=max(6, int(round((sw * sh) / 60000.0)) * 4), fp="rect",
            pal="paper", tags=["wall-art", "photo", "image-slot", "poster", key],
            builder=("frame", {"framed": False, "mat": 0}),
            place={"mount_h_mm": max(300, int(1500 - sh / 2))},
            note="Sheet is exactly %s (%d×%dmm); depth is the poster hanger rail." % (label, sw, sh)))
    return out


AI_ITEMS = _poster_items() + [

    # ---------------------------------------------------------- canvas + triptych
    dict(id="ai-canvas-16x20", name="Canvas print 16×20\"", ptype="Gallery-wrapped canvas print",
         cat=_D, arch="art_frame", w=406, d=38, h=508, price=45, fp="rect", pal="canvas",
         tags=["wall-art", "photo", "image-slot", "canvas"], builder=("canvas", {}),
         place={"mount_h_mm": 1250},
         note="Standard 16×20\" stretcher bar depth 38mm."),
    dict(id="ai-canvas-24x36", name="Canvas print 24×36\"", ptype="Gallery-wrapped canvas print",
         cat=_D, arch="art_frame", w=610, d=40, h=914, price=89, fp="rect", pal="canvas",
         tags=["wall-art", "photo", "image-slot", "canvas", "large"], builder=("canvas", {}),
         place={"mount_h_mm": 1050}),
    dict(id="ai-triptych-3x300x400", name="Triptych 3×300×400", ptype="Three-panel photo triptych",
         cat=_D, arch="art_frame", w=1020, d=30, h=400, price=99, fp="rect", pal="frame_black",
         tags=["wall-art", "photo", "image-slot", "triptych", "set"], builder=("triptych", {"gap": 60}),
         place={"mount_h_mm": 1300},
         note="Three 300×400mm panels with 60mm reveals; each panel carries its own image slot."),

    # ---------------------------------------------------------- generic furniture
    dict(id="ai-wall-clock-300", name="Wall clock 300", ptype="Round wall clock",
         cat=_D, arch="art_frame", w=300, d=45, h=300, price=29, fp="rect", pal="black",
         tags=["clock", "wall-mounted", "round"], builder=("wall_clock", {}),
         place={"mount_h_mm": 1900}, note="300mm dial is the common domestic size."),
    dict(id="ai-floor-mirror-500x1600", name="Floor mirror 500×1600", ptype="Leaning full-length mirror",
         cat=_D, arch="mirror", w=500, d=120, h=1600, price=129, fp="rect", pal="frame_wood",
         tags=["mirror", "full-length", "bedroom", "leaning"], builder=("floor_mirror", {}),
         place={"wall_mounted": False, "mount_h_mm": None, "against_wall": True, "wall_offset_mm": 60},
         note="Leans against the wall; depth is the foot, not the glass."),
    dict(id="ai-wall-mirror-600x900", name="Wall mirror 600×900", ptype="Rectangular wall mirror",
         cat=_D, arch="mirror", w=600, d=40, h=900, price=79, fp="rect", pal="frame_black",
         tags=["mirror", "wall-mounted", "hallway"], builder=("floor_mirror", {}),
         place={"mount_h_mm": 1150}),
    dict(id="ai-floor-cushion-600", name="Floor cushion 600", ptype="Round floor cushion",
         cat="seating", arch="cushion", w=600, d=600, h=160, price=39, fp="round", pal="beige",
         tags=["floor-seating", "soft", "living-room"], builder=("floor_cushion", {})),
    dict(id="ai-beanbag-900", name="Bean bag 900", ptype="Bean bag chair",
         cat="seating", arch="cushion", w=900, d=900, h=750, price=89, fp="round", pal="denim",
         tags=["floor-seating", "soft", "lounge"], builder=("beanbag", {})),
    dict(id="ai-laundry-hamper-420", name="Laundry hamper 420", ptype="Lidded laundry hamper",
         cat=_S, arch="storage_box", w=420, d=420, h=620, price=25, fp="rect", pal="natural",
         tags=["laundry", "bedroom", "bathroom"], builder=("hamper", {})),
    dict(id="ai-drying-rack-folding", name="Drying rack", ptype="Folding clothes airer",
         cat=_S, arch="rack", w=700, d=550, h=1050, price=30, fp="rect", pal="steel",
         tags=["laundry", "folding", "utility"], builder=("drying_rack", {})),
    dict(id="ai-ironing-board", name="Ironing board", ptype="Folding ironing board",
         cat=_S, arch="rack", w=1400, d=400, h=900, price=40, fp="rect", pal="gray",
         tags=["laundry", "folding", "utility"], builder=("ironing_board", {}),
         note="Standard full-size board: 1400×400mm top at 900mm working height."),
    dict(id="ai-moving-box-s", name="Moving box S", ptype="Small moving box (16×12×12\")",
         cat=_S, arch="storage_box", w=406, d=305, h=305, price=2, fp="rect", pal="kraft",
         tags=["moving", "cardboard", "stackable"], builder=("moving_box", {})),
    dict(id="ai-moving-box-m", name="Moving box M", ptype="Medium moving box (18×18×16\")",
         cat=_S, arch="storage_box", w=457, d=457, h=406, price=3, fp="rect", pal="kraft",
         tags=["moving", "cardboard", "stackable"], builder=("moving_box", {})),
    dict(id="ai-moving-box-l", name="Moving box L", ptype="Large moving box (24×18×18\")",
         cat=_S, arch="storage_box", w=610, d=457, h=457, price=4, fp="rect", pal="kraft",
         tags=["moving", "cardboard", "stackable"], builder=("moving_box", {})),
    dict(id="ai-storage-bin-fabric", name="Storage bin, fabric", ptype="Collapsible fabric storage bin",
         cat=_S, arch="storage_box", w=400, d=330, h=330, price=12, fp="rect", pal="gray",
         tags=["storage", "shelf-insert", "fabric"], builder=("storage_bin", {"fabric": True}),
         note="Sized to drop into a 330mm cube shelf opening."),
    dict(id="ai-storage-tote-60l", name="Storage tote 60L", ptype="Lidded plastic storage tote",
         cat=_S, arch="storage_box", w=600, d=400, h=340, price=18, fp="rect", pal="white_black",
         tags=["storage", "plastic", "stackable"], builder=("storage_bin", {})),
    dict(id="ai-shoe-rack-3tier", name="Shoe rack, 3 tier", ptype="Three-tier shoe rack",
         cat=_S, arch="shelf_unit", w=700, d=300, h=800, price=35, fp="rect", pal="steel",
         tags=["hallway", "shoes", "open-storage"], builder=("shoe_rack", {"tiers": 3})),
    dict(id="ai-coat-stand", name="Coat stand", ptype="Freestanding coat stand",
         cat=_S, arch="rack", w=500, d=500, h=1780, price=45, fp="round", pal="frame_wood",
         tags=["hallway", "coats", "freestanding"], builder=("coat_stand", {})),
    dict(id="ai-umbrella-stand", name="Umbrella stand", ptype="Cylindrical umbrella stand",
         cat=_S, arch="storage_box", w=240, d=240, h=500, price=25, fp="round", pal="steel",
         tags=["hallway", "entryway"], builder=("umbrella_stand", {})),
    dict(id="ai-waste-bin-30l", name="Waste bin 30L", ptype="Pedal waste bin, 30 litre",
         cat=_S, arch="storage_box", w=300, d=300, h=620, price=30, fp="round", pal="steel",
         tags=["kitchen", "bin", "pedal"], builder=("waste_bin", {})),
    dict(id="ai-radiator-cover-1100", name="Radiator cover 1100", ptype="Slatted radiator cover",
         cat=_S, arch="cabinet", w=1100, d=250, h=800, price=120, fp="rect", pal="white",
         tags=["radiator", "wall", "slatted"], builder=("radiator_cover", {}),
         note="Fits a standard 1000mm double-panel radiator with airflow gap."),
    dict(id="ai-curtain-rod-1800", name="Curtain rod 1800", ptype="Curtain rod with finials, 1800mm",
         cat=_D, arch="curtain_rod", w=1800, d=95, h=120, price=22, fp="rect", pal="steel",
         tags=["window", "curtain", "wall-mounted"], builder=("curtain_rod", {}),
         place={"mount_h_mm": 2250}),
    dict(id="ai-roller-blind-1200", name="Roller blind 1200", ptype="Roller blind, 1200×1800",
         cat=_D, arch="curtain", w=1200, d=60, h=1800, price=35, fp="rect", pal="beige",
         tags=["window", "blind", "wall-mounted"], builder=("roller_blind", {}),
         place={"mount_h_mm": 2150}),
    dict(id="ai-door-mat-750x450", name="Door mat 750×450", ptype="Coir entrance mat",
         cat="rugs", arch="rug", w=750, d=450, h=18, price=18, fp="rect", pal="kraft",
         tags=["entryway", "mat", "coir"], builder=("door_mat", {})),

    # ---------------------------------------------------------- tech / appliance envelopes
    dict(id="ai-monitor-24", name="Monitor 24\"", ptype="24-inch desktop monitor",
         cat=_A, arch="monitor", w=545, d=200, h=460, price=180, fp="rect", pal="tech_black",
         tags=["desk", "screen", "24in"], builder=("monitor", {}),
         note="531×299mm 16:9 active area plus bezel and stand foot."),
    dict(id="ai-monitor-27", name="Monitor 27\"", ptype="27-inch desktop monitor",
         cat=_A, arch="monitor", w=615, d=220, h=500, price=250, fp="rect", pal="tech_black",
         tags=["desk", "screen", "27in"], builder=("monitor", {})),
    dict(id="ai-monitor-32", name="Monitor 32\"", ptype="32-inch desktop monitor",
         cat=_A, arch="monitor", w=715, d=240, h=560, price=350, fp="rect", pal="tech_black",
         tags=["desk", "screen", "32in"], builder=("monitor", {})),
    dict(id="ai-monitor-arm", name="Monitor arm", ptype="Clamp-on single monitor arm",
         cat=_A, arch="monitor", w=300, d=340, h=560, price=90, fp="rect", pal="steel",
         tags=["desk", "mount", "clamp"], builder=("monitor_arm", {})),
    dict(id="ai-desktop-tower", name="Desktop tower", ptype="Mid-tower desktop PC",
         cat=_A, arch="appliance", w=200, d=450, h=450, price=700, fp="rect", pal="tech_black",
         tags=["desk", "computer", "under-desk"], builder=("tower_pc", {}),
         note="ATX mid-tower envelope."),
    dict(id="ai-printer-inkjet", name="Printer", ptype="Desktop inkjet all-in-one printer",
         cat=_A, arch="appliance", w=450, d=370, h=250, price=130, fp="rect", pal="tech_black",
         tags=["desk", "office", "printer"], builder=("printer", {})),
    dict(id="ai-router-wifi", name="Wi-Fi router", ptype="Wi-Fi router with antennas",
         cat=_A, arch="appliance", w=230, d=160, h=180, price=90, fp="rect", pal="tech_black",
         tags=["network", "shelf", "small"], builder=("router", {})),
    dict(id="ai-desk-lamp", name="Desk lamp", ptype="Adjustable LED desk lamp",
         cat="lighting", arch="table_lamp", w=180, d=400, h=480, price=35, fp="rect", pal="tech_black",
         tags=["desk", "task-light", "adjustable"], builder=("desk_lamp", {})),
    dict(id="ai-space-heater", name="Space heater", ptype="Portable ceramic space heater",
         cat=_A, arch="appliance", w=350, d=200, h=480, price=60, fp="rect", pal="tech_white",
         tags=["heating", "portable", "floor"], builder=("space_heater", {})),
    dict(id="ai-pedestal-fan", name="Pedestal fan", ptype="Oscillating pedestal fan, 400mm",
         cat=_A, arch="appliance", w=450, d=450, h=1300, price=45, fp="round", pal="tech_white",
         tags=["cooling", "fan", "floor"], builder=("pedestal_fan", {})),
    dict(id="ai-tower-fan", name="Tower fan", ptype="Bladeless-style tower fan",
         cat=_A, arch="appliance", w=300, d=300, h=1050, price=70, fp="round", pal="tech_black",
         tags=["cooling", "fan", "floor"], builder=("tower_fan", {})),
    dict(id="ai-air-purifier", name="Air purifier", ptype="HEPA air purifier, medium room",
         cat=_A, arch="appliance", w=330, d=330, h=620, price=200, fp="round", pal="tech_white",
         tags=["air", "hepa", "floor"], builder=("air_purifier", {})),
    dict(id="ai-humidifier", name="Humidifier", ptype="Cool-mist humidifier, 4L",
         cat=_A, arch="appliance", w=240, d=240, h=320, price=60, fp="round", pal="tech_white",
         tags=["air", "bedroom", "tabletop"], builder=("humidifier", {})),
    dict(id="ai-mini-fridge-90l", name="Mini fridge 90L", ptype="Under-counter mini fridge, 90 litre",
         cat=_A, arch="appliance", w=480, d=500, h=850, price=150, fp="rect", pal="tech_white",
         tags=["kitchen", "fridge", "under-counter"], builder=("mini_fridge", {})),
    dict(id="ai-microwave-25l", name="Microwave 25L", ptype="Countertop microwave, 25 litre",
         cat=_A, arch="appliance", w=500, d=400, h=300, price=110, fp="rect", pal="tech_black",
         tags=["kitchen", "countertop"], builder=("microwave", {})),
    dict(id="ai-electric-kettle", name="Electric kettle", ptype="Cordless electric kettle, 1.7L",
         cat=_A, arch="appliance", w=220, d=170, h=250, price=35, fp="rect", pal="steel",
         tags=["kitchen", "countertop", "small"], builder=("kettle", {})),
    dict(id="ai-robot-vacuum", name="Robot vacuum", ptype="Robot vacuum cleaner",
         cat=_A, arch="appliance", w=350, d=350, h=95, price=300, fp="round", pal="tech_black",
         tags=["cleaning", "floor", "robot"], builder=("robot_vacuum", {})),
    dict(id="ai-robot-vacuum-dock", name="Robot vacuum dock", ptype="Charging dock for robot vacuum",
         cat=_A, arch="appliance", w=260, d=300, h=450, price=None, fp="rect", pal="tech_black",
         tags=["cleaning", "dock", "against-wall"], builder=("vacuum_dock", {}),
         note="Ships with the vacuum, so it has no standalone price."),

    # ---------------------------------------------------------- life stuff
    dict(id="ai-plant-small", name="Houseplant S", ptype="Small potted plant",
         cat=_D, arch="plant", w=200, d=200, h=350, price=15, fp="round", pal="green",
         tags=["greenery", "tabletop", "small"], builder=("plant", {})),
    dict(id="ai-plant-medium", name="Houseplant M", ptype="Medium potted plant",
         cat=_D, arch="plant", w=350, d=350, h=900, price=40, fp="round", pal="green",
         tags=["greenery", "floor-plant", "medium"], builder=("plant", {})),
    dict(id="ai-plant-large", name="Houseplant L", ptype="Large floor plant",
         cat=_D, arch="plant", w=500, d=500, h=1600, price=90, fp="round", pal="green",
         tags=["greenery", "floor-plant", "statement"], builder=("plant", {})),
    dict(id="ai-plant-hanging", name="Hanging plant", ptype="Ceiling-hung trailing plant",
         cat=_D, arch="plant", w=350, d=350, h=900, price=35, fp="round", pal="green",
         tags=["greenery", "hanging", "ceiling"], builder=("hanging_plant", {}),
         place={"ceiling_mounted": True, "center_ok": True, "corner_ok": True, "against_wall": False},
         note="Height is pot plus hanger drop; trailing foliage adds an indeterminate amount."),
    dict(id="ai-yoga-mat", name="Yoga mat", ptype="Rolled-out yoga mat, 24×68\"",
         cat="rugs", arch="rug", w=610, d=1730, h=6, price=25, fp="rect", pal="teal",
         tags=["fitness", "floor", "mat"], builder=("yoga_mat", {})),
    dict(id="ai-dumbbell-rack", name="Dumbbell rack", ptype="Two-tier dumbbell rack",
         cat=_S, arch="rack", w=800, d=400, h=750, price=150, fp="rect", pal="black",
         tags=["fitness", "weights", "against-wall"], builder=("dumbbell_rack", {})),
    dict(id="ai-bike-floor", name="Bike, floor", ptype="Adult bicycle on a floor stand",
         cat=_S, arch="bike", w=1750, d=450, h=1050, price=None, fp="rect", pal="teal",
         tags=["bike", "hallway", "against-wall"], builder=("bike", {}),
         note="Medium-frame hybrid: 1750mm wheelbase-to-tyre length, 700c wheels."),
    dict(id="ai-bike-wall-mount", name="Bike, wall mount", ptype="Wall-mounted bicycle rack with bike",
         cat=_S, arch="bike", w=1750, d=450, h=700, price=None, fp="rect", pal="teal",
         tags=["bike", "wall-mounted", "space-saving"], builder=("bike_wall", {}),
         place={"wall_mounted": True, "mount_h_mm": 1250, "against_wall": True}),
    dict(id="ai-guitar-stand", name="Guitar stand", ptype="A-frame guitar stand with guitar",
         cat=_D, arch="rack", w=400, d=400, h=950, price=25, fp="rect", pal="frame_wood",
         tags=["music", "corner", "stand"], builder=("guitar_stand", {})),
    dict(id="ai-keyboard-stand", name="Keyboard stand", ptype="X-frame keyboard stand with 61-key keyboard",
         cat=_D, arch="rack", w=950, d=450, h=900, price=60, fp="rect", pal="black",
         tags=["music", "stand", "x-frame"], builder=("keyboard_stand", {})),
    dict(id="ai-pet-bed", name="Pet bed", ptype="Bolstered pet bed, medium",
         cat=_D, arch="cushion", w=700, d=550, h=220, price=45, fp="rect", pal="gray",
         tags=["pet", "soft", "floor"], builder=("pet_bed", {})),
    dict(id="ai-litter-box-hooded", name="Litter box, hooded", ptype="Hooded cat litter box",
         cat=_S, arch="storage_box", w=560, d=430, h=450, price=40, fp="rect", pal="white_black",
         tags=["pet", "cat", "utility"], builder=("litter_box", {})),
    dict(id="ai-cat-tree", name="Cat tree", ptype="Cat tree with perch and cubby",
         cat=_D, arch="rack", w=600, d=500, h=1500, price=90, fp="rect", pal="beige",
         tags=["pet", "cat", "corner"], builder=("cat_tree", {})),
    dict(id="ai-whiteboard-1200x900", name="Whiteboard 1200×900", ptype="Magnetic dry-erase whiteboard",
         cat=_D, arch="art_frame", w=1200, d=40, h=900, price=70, fp="rect", pal="white",
         tags=["office", "wall-mounted", "board"], builder=("board", {"cork": False}),
         place={"mount_h_mm": 1400}),
    dict(id="ai-corkboard-900x600", name="Corkboard 900×600", ptype="Framed cork pin board",
         cat=_D, arch="art_frame", w=900, d=35, h=600, price=35, fp="rect", pal="cork",
         tags=["office", "wall-mounted", "board"], builder=("board", {"cork": True}),
         place={"mount_h_mm": 1450}),
    dict(id="ai-string-lights-3m", name="String lights 3m", ptype="Festoon string lights, 3 metre span",
         cat="lighting", arch="string_lights", w=3000, d=70, h=700, price=20, fp="rect", pal="warm_white",
         tags=["lighting", "ceiling", "festoon"], builder=("string_lights", {}),
         note="Hung as a 3m catenary; h is the sag envelope, not a fixed drop."),
    dict(id="ai-standing-desk-converter", name="Standing desk converter", ptype="Sit-stand desktop riser",
         cat="desks", arch="rack", w=800, d=600, h=400, price=180, fp="rect", pal="black",
         tags=["desk", "sit-stand", "on-desk"], builder=("desk_riser", {}),
         note="Height is the raised position measured from the desktop it sits on."),
    dict(id="ai-folding-chair", name="Folding chair", ptype="Folding chair",
         cat="seating", arch="dining_chair", w=460, d=480, h=800, seat_h=450, price=25, fp="rect",
         pal="steel", tags=["folding", "extra-seating", "stackable"], builder=("folding_chair", {})),
    dict(id="ai-folding-table-1220", name="Folding table 1220", ptype="Folding utility table, 4ft",
         cat="tables", arch="dining_table_rect", w=1220, d=610, h=740, price=60, fp="rect",
         pal="white_black", tags=["folding", "utility", "party"], builder=("folding_table", {})),
]

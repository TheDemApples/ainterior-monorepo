// packages/layout-engine/tests/fixtures.js
// Self-contained test catalog + rooms. Real IKEA dimensions (mm), so the tests
// exercise the same numbers the product ships with. No deps, no DOM.

const P = (o = {}) => ({
  against_wall: false, wall_offset_mm: 40, corner_ok: false, center_ok: true,
  needs_wall_len_mm: null, stackable: false, wall_mounted: false,
  mount_h_mm: null, ceiling_mounted: false, ...o,
});
const C = (o = {}) => ({ front: 0, back: 0, left: 0, right: 0, ...o });

function item(id, brand, name, product_type, category, archetype, w, d, h, extra = {}) {
  return {
    id, brand, name, product_type, category, archetype,
    sku: extra.sku || null,
    dims_mm: { w, d, h },
    seat_h_mm: extra.seat_h_mm != null ? extra.seat_h_mm : null,
    footprint: extra.footprint || 'rect',
    l_shape_mm: null,
    clearance_mm: extra.clearance_mm || C(),
    placement: extra.placement || P(),
    colorways: extra.colorways || [{ name: 'Default', hex: '#D8D2C4' }],
    price_usd: extra.price_usd != null ? extra.price_usd : 0,
    url: extra.url || null,
    tags: extra.tags || [],
    proxy: { parts: [{ shape: 'box', pos: [0, 0, h / 2], size: [w, d, h], color: 'body' }] },
  };
}

export const ITEMS = [
  item('ikea-ektorp-3s', 'IKEA', 'EKTORP', '3-seat sofa', 'seating', 'sofa_3seat', 2180, 880, 880, {
    sku: '302.383.65', seat_h_mm: 450, price_usd: 599,
    clearance_mm: C({ front: 750, back: 50, left: 100, right: 100 }),
    placement: P({ against_wall: true, wall_offset_mm: 40, needs_wall_len_mm: 2280, center_ok: true }),
  }),
  item('ikea-klippan-2s', 'IKEA', 'KLIPPAN', '2-seat sofa', 'seating', 'sofa_2seat', 1800, 880, 660, {
    sku: '602.992.51', seat_h_mm: 430, price_usd: 349,
    clearance_mm: C({ front: 700, back: 50 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 1900, center_ok: true }),
  }),
  item('ikea-poang-chair', 'IKEA', 'POÄNG', 'Armchair', 'seating', 'armchair', 680, 820, 1000, {
    sku: '892.408.30', seat_h_mm: 420, price_usd: 149,
    clearance_mm: C({ front: 600 }), placement: P({ corner_ok: true, center_ok: true }),
  }),
  item('ikea-lack-coffee', 'IKEA', 'LACK', 'Coffee table', 'tables', 'coffee_table', 900, 550, 450, {
    sku: '104.041.35', price_usd: 49, clearance_mm: C({ front: 300 }),
    placement: P({ center_ok: true }),
  }),
  item('ikea-vittsjo-side', 'IKEA', 'VITTSJÖ', 'Side table', 'tables', 'side_table', 500, 500, 500, {
    sku: '102.992.32', price_usd: 45, placement: P({ corner_ok: true, center_ok: true }),
  }),
  item('ikea-stockholm-rug', 'IKEA', 'STOCKHOLM', 'Flatwoven rug', 'rugs', 'rug', 2500, 1700, 10, {
    sku: '000.000.01', price_usd: 399, placement: P({ center_ok: true }),
  }),
  item('ikea-lohals-rug-s', 'IKEA', 'LOHALS', 'Flatwoven rug', 'rugs', 'rug', 2000, 1400, 10, {
    sku: '000.000.02', price_usd: 179, placement: P({ center_ok: true }),
  }),
  item('ikea-billy-bookcase', 'IKEA', 'BILLY', 'Bookcase', 'storage', 'bookcase', 800, 280, 2020, {
    sku: '002.638.50', price_usd: 69, clearance_mm: C({ front: 600 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 840, center_ok: false }),
  }),
  item('ikea-besta-tv', 'IKEA', 'BESTÅ', 'TV bench', 'storage', 'tv_bench', 1800, 420, 470, {
    sku: '405.386.65', price_usd: 259, clearance_mm: C({ front: 400 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 1860, center_ok: false }),
  }),
  item('generic-tv-55', 'Generic', '55" TV', 'Television', 'appliance', 'tv', 1230, 80, 720, {
    price_usd: 449,
    placement: P({ against_wall: true, wall_offset_mm: 60, wall_mounted: true, mount_h_mm: 700, center_ok: false }),
  }),
  item('ikea-malm-queen', 'IKEA', 'MALM', 'Queen bed frame', 'beds', 'bed_queen', 1560, 2090, 1000, {
    sku: '002.494.83', seat_h_mm: 380, price_usd: 379,
    clearance_mm: C({ front: 700, left: 700, right: 700 }),
    placement: P({ against_wall: true, wall_offset_mm: 20, needs_wall_len_mm: 1600, center_ok: false }),
  }),
  item('ikea-malm-single', 'IKEA', 'MALM', 'Single bed frame', 'beds', 'bed_single', 970, 2090, 1000, {
    sku: '002.494.80', price_usd: 249, clearance_mm: C({ front: 700 }),
    placement: P({ against_wall: true, wall_offset_mm: 20, needs_wall_len_mm: 1000, center_ok: false }),
  }),
  item('ikea-hemnes-nightstand', 'IKEA', 'HEMNES', 'Nightstand', 'storage', 'nightstand', 460, 350, 700, {
    sku: '302.004.29', price_usd: 99, placement: P({ against_wall: true, needs_wall_len_mm: 480, center_ok: false }),
  }),
  item('ikea-pax-wardrobe', 'IKEA', 'PAX', 'Wardrobe', 'storage', 'wardrobe', 1500, 580, 2010, {
    sku: '992.741.15', price_usd: 620, clearance_mm: C({ front: 760 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 1540, center_ok: false }),
  }),
  item('ikea-hemnes-dresser', 'IKEA', 'HEMNES', '3-drawer chest', 'storage', 'dresser', 1080, 500, 950, {
    sku: '502.392.79', price_usd: 279, clearance_mm: C({ front: 700 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 1120, center_ok: false }),
  }),
  item('ikea-lisabo-table', 'IKEA', 'LISABO', 'Dining table', 'tables', 'dining_table_rect', 1400, 780, 740, {
    sku: '702.919.24', price_usd: 279, clearance_mm: C({ front: 1100 }),
    placement: P({ center_ok: true }),
  }),
  item('ikea-teodores-chair', 'IKEA', 'TEODORES', 'Dining chair', 'seating', 'dining_chair', 440, 490, 820, {
    sku: '304.049.20', seat_h_mm: 450, price_usd: 45, placement: P({ center_ok: true }),
  }),
  item('ikea-micke-desk', 'IKEA', 'MICKE', 'Desk', 'desks', 'desk', 1050, 500, 750, {
    sku: '802.130.74', price_usd: 129, clearance_mm: C({ front: 800 }),
    placement: P({ against_wall: true, needs_wall_len_mm: 1090, center_ok: false }),
  }),
  item('ikea-langfjall-chair', 'IKEA', 'LÅNGFJÄLL', 'Office chair', 'seating', 'office_chair', 680, 680, 1040, {
    sku: '291.775.61', seat_h_mm: 460, price_usd: 199, placement: P({ center_ok: true }),
  }),
  item('ikea-not-floorlamp', 'IKEA', 'NOT', 'Floor uplighter', 'lighting', 'floor_lamp', 320, 320, 1750, {
    sku: '801.451.44', price_usd: 25, placement: P({ corner_ok: true, center_ok: true }),
  }),
  item('ikea-fejka-plant', 'IKEA', 'FEJKA', 'Artificial potted plant', 'decor', 'plant', 300, 300, 800, {
    sku: '404.933.53', price_usd: 24, placement: P({ corner_ok: true, center_ok: true }),
  }),
  item('ikea-ribba-frame', 'IKEA', 'RIBBA', 'Frame 61×91', 'decor', 'art_frame', 610, 30, 910, {
    sku: '302.892.83', price_usd: 25,
    placement: P({ against_wall: true, wall_mounted: true, mount_h_mm: 1150, wall_offset_mm: 20, center_ok: false }),
  }),
];

export const CATALOG = new Map(ITEMS.map((i) => [i.id, i]));

// --- rooms ----------------------------------------------------------------
export const LIVING = {
  id: 'room_living', name: 'Living room',
  polygon_mm: [[0, 0], [4200, 0], [4200, 3600], [0, 3600]],
  height_mm: 2600,
  openings: [
    { id: 'd1', type: 'door', wall_index: 0, offset_mm: 300, width_mm: 900, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
    { id: 'w1', type: 'window', wall_index: 2, offset_mm: 1200, width_mm: 1600, height_mm: 1400, sill_mm: 800, swing: null },
  ],
  features: [
    { id: 'f1', type: 'radiator', wall_index: 2, offset_mm: 1300, width_mm: 1400, depth_mm: 120 },
  ],
  source: 'manual', confidence: 1,
};

export const BEDROOM = {
  id: 'room_bed', name: 'Bedroom',
  polygon_mm: [[0, 0], [3000, 0], [3000, 3400], [0, 3400]],
  height_mm: 2500,
  openings: [
    { id: 'd1', type: 'door', wall_index: 0, offset_mm: 250, width_mm: 800, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
    { id: 'w1', type: 'window', wall_index: 2, offset_mm: 900, width_mm: 1200, height_mm: 1300, sill_mm: 900, swing: null },
  ],
  features: [],
  source: 'manual', confidence: 1,
};

export const STUDIO = {
  id: 'room_studio', name: 'Studio',
  polygon_mm: [[0, 0], [5500, 0], [5500, 3200], [0, 3200]],
  height_mm: 2700,
  openings: [
    { id: 'd1', type: 'door', wall_index: 3, offset_mm: 400, width_mm: 900, height_mm: 2040, sill_mm: 0, swing: 'in-right' },
    { id: 'w1', type: 'window', wall_index: 2, offset_mm: 800, width_mm: 1800, height_mm: 1500, sill_mm: 700, swing: null },
    { id: 'w2', type: 'window', wall_index: 1, offset_mm: 1000, width_mm: 900, height_mm: 1400, sill_mm: 900, swing: null },
  ],
  features: [
    { id: 'f1', type: 'radiator', wall_index: 2, offset_mm: 900, width_mm: 1600, depth_mm: 120 },
  ],
  source: 'blueprint', confidence: 0.9,
};

/** A deliberately impossible brief: too much furniture for the floor. */
export const TINY = {
  id: 'room_tiny', name: 'Box room',
  polygon_mm: [[0, 0], [2000, 0], [2000, 1900], [0, 1900]],
  height_mm: 2400,
  openings: [
    { id: 'd1', type: 'door', wall_index: 0, offset_mm: 200, width_mm: 800, height_mm: 2040, sill_mm: 0, swing: 'in-left' },
  ],
  features: [], source: 'manual', confidence: 1,
};

export const LIVING_ITEMS = [
  { item_id: 'ikea-ektorp-3s', qty: 1 },
  { item_id: 'ikea-lack-coffee', qty: 1 },
  { item_id: 'ikea-poang-chair', qty: 2 },
  { item_id: 'generic-tv-55', qty: 1 },
  { item_id: 'ikea-besta-tv', qty: 1 },
  { item_id: 'ikea-stockholm-rug', qty: 1 },
  { item_id: 'ikea-billy-bookcase', qty: 1 },
  { item_id: 'ikea-not-floorlamp', qty: 1 },
];

export const BEDROOM_ITEMS = [
  { item_id: 'ikea-malm-queen', qty: 1 },
  { item_id: 'ikea-hemnes-nightstand', qty: 2 },
  { item_id: 'ikea-pax-wardrobe', qty: 1 },
  { item_id: 'ikea-lohals-rug-s', qty: 1 },
  { item_id: 'ikea-ribba-frame', qty: 1 },
];

export const STUDIO_ITEMS = [
  { item_id: 'ikea-malm-single', qty: 1 },
  { item_id: 'ikea-klippan-2s', qty: 1 },
  { item_id: 'ikea-lack-coffee', qty: 1 },
  { item_id: 'ikea-lisabo-table', qty: 1 },
  { item_id: 'ikea-teodores-chair', qty: 2 },
  { item_id: 'ikea-micke-desk', qty: 1 },
  { item_id: 'ikea-langfjall-chair', qty: 1 },
  { item_id: 'ikea-lohals-rug-s', qty: 1 },
];

export const TINY_ITEMS = [
  { item_id: 'ikea-malm-queen', qty: 1 },
  { item_id: 'ikea-pax-wardrobe', qty: 1 },
  { item_id: 'ikea-hemnes-dresser', qty: 1 },
  { item_id: 'ikea-lisabo-table', qty: 1 },
];

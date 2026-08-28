// demo/sample-catalog.js
// ~14 real IKEA pieces with true dimensions and complete `proxy` geometry (SPEC §4.1).
// SWAP POINT: demo/editor.js first tries to fetch ../packages/catalog/catalog.json and
// only falls back to this module, so dropping the 100+ item catalog in needs no code change.

const legs = (w, d, h, size = 50, color = 'dark', inset = 40) => {
  const hx = w / 2 - inset - size / 2, hy = d / 2 - inset - size / 2;
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => ({
    shape: 'box', pos: [x, y, h / 2], size: [size, size, h], color,
  }));
};
const roundLegs = (w, d, h, dia = 36, color = 'metal', inset = 40) => {
  const hx = w / 2 - inset, hy = d / 2 - inset;
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => ({
    shape: 'cyl', pos: [x, y, h / 2], size: [dia, dia, h], color,
  }));
};

export const SAMPLE_CATALOG = {
  version: '1.0.0-demo',
  items: [
    // ------------------------------------------------------------- seating
    {
      id: 'ikea-ektorp-3s', brand: 'IKEA', name: 'EKTORP', product_type: '3-seat sofa',
      sku: '302.383.65', category: 'seating', archetype: 'sofa_3seat',
      dims_mm: { w: 2180, d: 880, h: 880 }, seat_h_mm: 450,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 750, back: 50, left: 100, right: 100 },
      placement: {
        against_wall: true, wall_offset_mm: 40, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 2280, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Totebo light beige', hex: '#D8D2C4' }, { name: 'Hallarp grey', hex: '#9C9A96' }],
      price_usd: 599, url: 'https://www.ikea.com/us/en/p/ektorp-sofa/',
      tags: ['living-room', 'upholstered', 'family'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 240], size: [2180, 880, 400], color: 'body', radius: 40 },
          { shape: 'box', pos: [0, 60, 480], size: [1830, 700, 90], color: 'fabric', radius: 40 },
          { shape: 'box', pos: [0, -350, 660], size: [2180, 180, 440], color: 'body', radius: 34 },
          { shape: 'box', pos: [-1015, 0, 330], size: [150, 880, 620], color: 'body', radius: 40 },
          { shape: 'box', pos: [1015, 0, 330], size: [150, 880, 620], color: 'body', radius: 40 },
          ...roundLegs(2180, 880, 40, 46, 'dark', 120),
        ],
      },
    },
    {
      id: 'ikea-poang-armchair', brand: 'IKEA', name: 'POÄNG', product_type: 'Armchair',
      sku: '892.409.19', category: 'seating', archetype: 'armchair',
      dims_mm: { w: 680, d: 820, h: 1000 }, seat_h_mm: 420,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 600, back: 60, left: 120, right: 120 },
      placement: {
        against_wall: false, wall_offset_mm: 80, corner_ok: true, center_ok: true,
        needs_wall_len_mm: 780, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Knisa light beige', hex: '#CFC7B6' }, { name: 'Skiftebo dark grey', hex: '#4C4C51' }],
      price_usd: 149, url: 'https://www.ikea.com/us/en/p/poaeng-armchair/',
      tags: ['living-room', 'accent'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 70, 400], size: [560, 560, 110], color: 'fabric', radius: 44 },
          { shape: 'box', pos: [0, -250, 700], size: [560, 110, 580], color: 'fabric', radius: 44 },
          { shape: 'box', pos: [-310, 0, 440], size: [58, 820, 90], color: 'wood', radius: 20 },
          { shape: 'box', pos: [310, 0, 440], size: [58, 820, 90], color: 'wood', radius: 20 },
          { shape: 'box', pos: [-310, 340, 200], size: [58, 90, 400], color: 'wood' },
          { shape: 'box', pos: [310, 340, 200], size: [58, 90, 400], color: 'wood' },
          { shape: 'box', pos: [-310, -340, 200], size: [58, 90, 400], color: 'wood' },
          { shape: 'box', pos: [310, -340, 200], size: [58, 90, 400], color: 'wood' },
        ],
      },
    },
    {
      id: 'ikea-teodores-chair', brand: 'IKEA', name: 'TEODORES', product_type: 'Dining chair',
      sku: '203.508.65', category: 'seating', archetype: 'dining_chair',
      dims_mm: { w: 440, d: 510, h: 800 }, seat_h_mm: 450,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 300, back: 1100, left: 50, right: 50 },
      placement: {
        against_wall: false, wall_offset_mm: 0, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 0, stackable: true, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EDEAE4' }, { name: 'Black', hex: '#26262B' }],
      price_usd: 45, url: 'https://www.ikea.com/us/en/p/teodores-chair/',
      tags: ['dining', 'stackable'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 445], size: [440, 440, 34], color: 'body', radius: 40 },
          { shape: 'box', pos: [0, -205, 630], size: [430, 34, 340], color: 'body', radius: 40 },
          ...roundLegs(440, 510, 445, 34, 'body', 22),
        ],
      },
    },

    // ------------------------------------------------------------- tables
    {
      id: 'ikea-lack-coffee', brand: 'IKEA', name: 'LACK', product_type: 'Coffee table',
      sku: '104.041.32', category: 'tables', archetype: 'coffee_table',
      dims_mm: { w: 900, d: 550, h: 450 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 400, back: 400, left: 300, right: 300 },
      placement: {
        against_wall: false, wall_offset_mm: 0, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 0, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EEEBE5' }, { name: 'Black-brown', hex: '#3A2E26' }],
      price_usd: 49, url: 'https://www.ikea.com/us/en/p/lack-coffee-table/',
      tags: ['living-room', 'budget'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 430], size: [900, 550, 40], color: 'body', radius: 8 },
          ...legs(900, 550, 410, 50, 'body', 6),
        ],
      },
    },
    {
      id: 'ikea-ekedalen-table', brand: 'IKEA', name: 'EKEDALEN', product_type: 'Extendable dining table',
      sku: '603.407.69', category: 'tables', archetype: 'dining_table_rect',
      dims_mm: { w: 1200, d: 800, h: 750 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 1100, back: 1100, left: 1100, right: 1100 },
      placement: {
        against_wall: false, wall_offset_mm: 0, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 0, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Oak', hex: '#C39A6B' }, { name: 'White', hex: '#EDEAE4' }],
      price_usd: 299, url: 'https://www.ikea.com/us/en/p/ekedalen-extendable-table/',
      tags: ['dining'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 730], size: [1200, 800, 40], color: 'wood', radius: 10 },
          { shape: 'box', pos: [0, 0, 660], size: [1060, 660, 100], color: 'wood' },
          ...legs(1200, 800, 660, 70, 'wood', 70),
        ],
      },
    },
    {
      id: 'ikea-micke-desk', brand: 'IKEA', name: 'MICKE', product_type: 'Desk',
      sku: '802.130.74', category: 'desks', archetype: 'desk',
      dims_mm: { w: 1050, d: 500, h: 750 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 900, back: 20, left: 100, right: 100 },
      placement: {
        against_wall: true, wall_offset_mm: 20, corner_ok: true, center_ok: false,
        needs_wall_len_mm: 1150, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EDEAE4' }, { name: 'Black-brown', hex: '#38302A' }],
      price_usd: 129, url: 'https://www.ikea.com/us/en/p/micke-desk/',
      tags: ['wfh', 'small-space'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 730], size: [1050, 500, 40], color: 'body', radius: 6 },
          { shape: 'box', pos: [-505, 0, 355], size: [40, 500, 710], color: 'body' },
          { shape: 'box', pos: [505, 0, 355], size: [40, 500, 710], color: 'body' },
          { shape: 'box', pos: [250, 20, 600], size: [460, 440, 180], color: 'body', radius: 4 },
          { shape: 'box', pos: [250, 245, 600], size: [430, 18, 140], color: 'dark', radius: 4 },
          { shape: 'box', pos: [0, -240, 400], size: [960, 20, 600], color: 'body' },
        ],
      },
    },

    // ------------------------------------------------------------- storage
    {
      id: 'ikea-besta-tv-bench', brand: 'IKEA', name: 'BESTÅ', product_type: 'TV bench',
      sku: '805.385.61', category: 'storage', archetype: 'tv_bench',
      dims_mm: { w: 1800, d: 420, h: 380 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 700, back: 20, left: 60, right: 60 },
      placement: {
        against_wall: true, wall_offset_mm: 20, corner_ok: false, center_ok: false,
        needs_wall_len_mm: 1900, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EDEAE4' }, { name: 'Black-brown', hex: '#332B25' }],
      price_usd: 200, url: 'https://www.ikea.com/us/en/p/besta-tv-bench/',
      tags: ['living-room', 'media'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 215], size: [1800, 420, 300], color: 'body', radius: 6 },
          { shape: 'box', pos: [0, 0, 33], size: [1700, 380, 66], color: 'dark' },
          { shape: 'box', pos: [-450, 212, 215], size: [860, 16, 280], color: 'body', radius: 4 },
          { shape: 'box', pos: [450, 212, 215], size: [860, 16, 280], color: 'body', radius: 4 },
        ],
      },
    },
    {
      id: 'ikea-billy-bookcase', brand: 'IKEA', name: 'BILLY', product_type: 'Bookcase',
      sku: '002.638.50', category: 'storage', archetype: 'bookcase',
      dims_mm: { w: 800, d: 280, h: 2020 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 700, back: 10, left: 20, right: 20 },
      placement: {
        against_wall: true, wall_offset_mm: 10, corner_ok: true, center_ok: false,
        needs_wall_len_mm: 850, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EEEBE5' }, { name: 'Oak veneer', hex: '#C8A377' }],
      price_usd: 69, url: 'https://www.ikea.com/us/en/p/billy-bookcase/',
      tags: ['storage', 'books'],
      proxy: {
        parts: [
          { shape: 'box', pos: [-390, 0, 1010], size: [20, 280, 2020], color: 'body' },
          { shape: 'box', pos: [390, 0, 1010], size: [20, 280, 2020], color: 'body' },
          { shape: 'box', pos: [0, -136, 1010], size: [760, 8, 1990], color: 'dark' },
          { shape: 'box', pos: [0, 0, 22], size: [760, 280, 20], color: 'body' },
          { shape: 'box', pos: [0, 0, 360], size: [760, 280, 18], color: 'body' },
          { shape: 'box', pos: [0, 0, 690], size: [760, 280, 18], color: 'body' },
          { shape: 'box', pos: [0, 0, 1020], size: [760, 280, 18], color: 'body' },
          { shape: 'box', pos: [0, 0, 1350], size: [760, 280, 18], color: 'body' },
          { shape: 'box', pos: [0, 0, 1680], size: [760, 280, 18], color: 'body' },
          { shape: 'box', pos: [0, 0, 2008], size: [800, 280, 24], color: 'body' },
        ],
      },
    },
    {
      id: 'ikea-hemnes-nightstand', brand: 'IKEA', name: 'HEMNES', product_type: '2-drawer chest',
      sku: '302.004.53', category: 'storage', archetype: 'nightstand',
      dims_mm: { w: 460, d: 350, h: 700 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 550, back: 10, left: 20, right: 20 },
      placement: {
        against_wall: true, wall_offset_mm: 10, corner_ok: true, center_ok: false,
        needs_wall_len_mm: 500, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White stain', hex: '#E4E0D8' }, { name: 'Black-brown', hex: '#372C24' }],
      price_usd: 119, url: 'https://www.ikea.com/us/en/p/hemnes-2-drawer-chest/',
      tags: ['bedroom'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 420], size: [460, 350, 520], color: 'body', radius: 4 },
          { shape: 'box', pos: [0, 178, 300], size: [420, 16, 190], color: 'body', radius: 4 },
          { shape: 'box', pos: [0, 178, 520], size: [420, 16, 190], color: 'body', radius: 4 },
          { shape: 'box', pos: [0, 182, 300], size: [78, 18, 22], color: 'metal', radius: 8 },
          { shape: 'box', pos: [0, 182, 520], size: [78, 18, 22], color: 'metal', radius: 8 },
          ...legs(460, 350, 160, 44, 'body', 26),
        ],
      },
    },
    {
      id: 'ikea-pax-wardrobe', brand: 'IKEA', name: 'PAX', product_type: 'Wardrobe',
      sku: '993.301.29', category: 'storage', archetype: 'wardrobe',
      dims_mm: { w: 1000, d: 580, h: 2010 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 900, back: 10, left: 20, right: 20 },
      placement: {
        against_wall: true, wall_offset_mm: 10, corner_ok: true, center_ok: false,
        needs_wall_len_mm: 1050, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'White', hex: '#EEEBE5' }, { name: 'Dark grey', hex: '#4A4A50' }],
      price_usd: 425, url: 'https://www.ikea.com/us/en/p/pax-wardrobe/',
      tags: ['bedroom', 'storage'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, -20, 1005], size: [1000, 540, 2010], color: 'body', radius: 4 },
          { shape: 'box', pos: [-252, 280, 1010], size: [488, 22, 1950], color: 'body', radius: 4 },
          { shape: 'box', pos: [252, 280, 1010], size: [488, 22, 1950], color: 'body', radius: 4 },
          { shape: 'cyl', pos: [-30, 296, 1050], size: [22, 22, 320], color: 'metal' },
          { shape: 'cyl', pos: [30, 296, 1050], size: [22, 22, 320], color: 'metal' },
        ],
      },
    },

    // ------------------------------------------------------------- beds
    {
      id: 'ikea-malm-queen', brand: 'IKEA', name: 'MALM', product_type: 'Queen bed frame',
      sku: '002.494.83', category: 'beds', archetype: 'bed_queen',
      dims_mm: { w: 1560, d: 2090, h: 1000 }, seat_h_mm: 590,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 700, back: 20, left: 700, right: 700 },
      placement: {
        against_wall: true, wall_offset_mm: 20, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 1700, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Oak veneer', hex: '#C6A175' }, { name: 'White', hex: '#EDEAE4' }],
      price_usd: 379, url: 'https://www.ikea.com/us/en/p/malm-bed-frame/',
      tags: ['bedroom'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 145], size: [1560, 2090, 290], color: 'wood', radius: 6 },
          { shape: 'box', pos: [0, -20, 460], size: [1520, 2030, 250], color: 'fabric', radius: 50 },
          { shape: 'box', pos: [0, -1030, 500], size: [1560, 70, 1000], color: 'wood', radius: 6 },
          { shape: 'box', pos: [-360, -730, 630], size: [660, 440, 130], color: 'fabric', radius: 60 },
          { shape: 'box', pos: [360, -730, 630], size: [660, 440, 130], color: 'fabric', radius: 60 },
        ],
      },
    },

    // ------------------------------------------------------------- rugs / lighting / decor
    {
      id: 'ikea-stoense-rug', brand: 'IKEA', name: 'STOENSE', product_type: 'Rug, low pile 170x240',
      sku: '104.268.03', category: 'rugs', archetype: 'rug',
      dims_mm: { w: 1700, d: 2400, h: 18 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 0, back: 0, left: 0, right: 0 },
      placement: {
        against_wall: false, wall_offset_mm: 0, corner_ok: false, center_ok: true,
        needs_wall_len_mm: 0, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Off-white', hex: '#DCD6C9' }, { name: 'Medium blue', hex: '#5A7391' }],
      price_usd: 149, url: 'https://www.ikea.com/us/en/p/stoense-rug/',
      tags: ['living-room', 'soft'],
      proxy: {
        parts: [
          { shape: 'plane', pos: [0, 0, 14], size: [1700, 2400], color: 'fabric' },
          { shape: 'box', pos: [0, 0, 7], size: [1700, 2400, 14], color: 'fabric', radius: 20 },
        ],
      },
    },
    {
      id: 'ikea-hektar-floor-lamp', brand: 'IKEA', name: 'HEKTAR', product_type: 'Floor lamp',
      sku: '702.153.30', category: 'lighting', archetype: 'floor_lamp',
      dims_mm: { w: 350, d: 350, h: 1810 }, seat_h_mm: null,
      footprint: 'round', l_shape_mm: null,
      clearance_mm: { front: 150, back: 150, left: 150, right: 150 },
      placement: {
        against_wall: false, wall_offset_mm: 60, corner_ok: true, center_ok: false,
        needs_wall_len_mm: 0, stackable: false, wall_mounted: false, mount_h_mm: null,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Dark grey', hex: '#45454B' }, { name: 'White', hex: '#E8E5DF' }],
      price_usd: 79, url: 'https://www.ikea.com/us/en/p/hektar-floor-lamp/',
      tags: ['lighting', 'reading'],
      proxy: {
        parts: [
          { shape: 'cyl', pos: [0, 0, 14], size: [300, 300, 28], color: 'dark' },
          { shape: 'cyl', pos: [0, 0, 850], size: [32, 32, 1700], color: 'metal' },
          { shape: 'cyl', pos: [0, 0, 1700], size: [350, 350, 220], color: 'dark' },
          { shape: 'sphere', pos: [0, 0, 1610], size: [120, 120, 120], color: '#F3E7C8' },
        ],
      },
    },
    {
      id: 'generic-tv-55', brand: 'Generic', name: '55" TV', product_type: 'Television 55" wall-mounted',
      sku: null, category: 'decor', archetype: 'tv',
      dims_mm: { w: 1230, d: 70, h: 720 }, seat_h_mm: null,
      footprint: 'rect', l_shape_mm: null,
      clearance_mm: { front: 1600, back: 0, left: 0, right: 0 },
      placement: {
        against_wall: true, wall_offset_mm: 40, corner_ok: false, center_ok: false,
        needs_wall_len_mm: 1300, stackable: false, wall_mounted: true, mount_h_mm: 700,
        ceiling_mounted: false,
      },
      colorways: [{ name: 'Black', hex: '#1D1D21' }],
      price_usd: 449, url: 'https://www.ikea.com/us/en/rooms/living-room/',
      tags: ['media', 'wall-mounted'],
      proxy: {
        parts: [
          { shape: 'box', pos: [0, 0, 360], size: [1230, 62, 720], color: 'dark', radius: 8 },
          { shape: 'box', pos: [0, 24, 366], size: [1180, 18, 650], color: '#141922' },
          { shape: 'box', pos: [0, -28, 360], size: [300, 20, 300], color: 'metal' },
        ],
      },
    },
  ],
};

export default SAMPLE_CATALOG;

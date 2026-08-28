#!/usr/bin/env node
/**
 * ainterior :: packages/catalog/importer/import.js
 *
 * Normalises an external product feed into CatalogItem[] (SPEC v1 §4.1), validates the
 * result and prints a report. Dependency-free.
 *
 *   node importer/import.js feed.json                       # dry run, prints report
 *   node importer/import.js feed.csv  --out items.json      # write normalised items
 *   node importer/import.js feed.json --merge               # merge into ../catalog.json
 *   node importer/import.js feed.json --map map.json        # custom column mapping
 *
 * Accepted input: JSON array, JSON {items:[...]}, or CSV with a header row.
 * Units: the importer accepts cm / m / in and converts to integer millimetres. Anything it
 * cannot resolve confidently is emitted with dims_confidence:"low" and listed under
 * NEEDS REVIEW -- the importer never silently guesses a dimension.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARCHFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'archetypes.json'), 'utf8'));
const ARCH = ARCHFILE.archetypes;
const CATEGORIES = ARCHFILE.categories;

/* ------------------------------------------------------------------ CLI */
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[k] = v;
  } else positional.push(argv[i]);
}
if (!positional.length) {
  console.error('usage: node importer/import.js <feed.json|feed.csv> [--out f.json] [--merge] [--map map.json]');
  process.exit(2);
}
const feedPath = path.resolve(positional[0]);

/* ------------------------------------------------------------------ field mapping */
const DEFAULT_MAP = {
  id: ['id', 'slug', 'item_id', 'handle'],
  name: ['name', 'title', 'product_name', 'series'],
  product_type: ['product_type', 'type', 'subtitle', 'description_short', 'variant'],
  brand: ['brand', 'vendor', 'manufacturer'],
  sku: ['sku', 'item_number', 'article_number', 'gtin'],
  category: ['category', 'cat', 'department'],
  archetype: ['archetype', 'furniture_type', 'form'],
  w: ['w', 'width', 'width_mm', 'width_cm', 'dim_w'],
  d: ['d', 'depth', 'depth_mm', 'depth_cm', 'dim_d', 'length'],
  h: ['h', 'height', 'height_mm', 'height_cm', 'dim_h'],
  seat_h: ['seat_h', 'seat_height', 'seat_height_mm', 'seat_height_cm'],
  price_usd: ['price_usd', 'price', 'msrp', 'amount'],
  url: ['url', 'link', 'product_url'],
  color: ['color', 'colour', 'colorway', 'finish'],
  color_hex: ['color_hex', 'hex', 'swatch'],
  tags: ['tags', 'keywords', 'labels'],
  unit: ['unit', 'units', 'uom'],
};
const MAP = flags.map ? Object.assign({}, DEFAULT_MAP, JSON.parse(fs.readFileSync(path.resolve(flags.map), 'utf8'))) : DEFAULT_MAP;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function pick(row, key) {
  const keys = MAP[key] || [key];
  const flat = {};
  for (const k of Object.keys(row)) flat[norm(k)] = row[k];
  for (const cand of keys) {
    const v = flat[norm(cand)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return { value: v, from: cand };
  }
  return { value: undefined, from: null };
}

/* ------------------------------------------------------------------ parsing */
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function readFeed(p) {
  const raw = fs.readFileSync(p, 'utf8');
  if (p.toLowerCase().endsWith('.csv')) return parseCSV(raw);
  const j = JSON.parse(raw);
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.products)) return j.products;
  throw new Error('unrecognised JSON feed shape (want an array, {items:[]} or {products:[]})');
}

/* ------------------------------------------------------------------ units (SPEC §1: store integer mm) */
function toMM(raw, fieldName, unitHint) {
  if (raw === undefined) return { mm: null, note: 'missing' };
  const s = String(raw).trim().toLowerCase().replace(/,/g, '.');
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(mm|millimet\w*|cm|centimet\w*|m|met\w*|in|inch\w*|")?/);
  if (!m) return { mm: null, note: `unparseable "${raw}"` };
  let n = parseFloat(m[1]);
  let unit = m[2] || (unitHint ? String(unitHint).toLowerCase() : null);
  if (!unit) {
    // No unit anywhere: infer from magnitude but flag it. Never silently trust.
    if (/_mm$|mm/.test(fieldName)) unit = 'mm';
    else if (/_cm$|cm/.test(fieldName)) unit = 'cm';
    else if (n > 0 && n < 400) unit = 'cm';
    else unit = 'mm';
    return { mm: Math.round(convert(n, unit)), note: `unit inferred as ${unit}` };
  }
  return { mm: Math.round(convert(n, unit)), note: null };
}
function convert(n, unit) {
  if (unit.startsWith('mm') || unit.startsWith('millimet')) return n;
  if (unit.startsWith('cm') || unit.startsWith('centimet')) return n * 10;
  if (unit === 'm' || unit.startsWith('met')) return n * 1000;
  if (unit.startsWith('in') || unit === '"') return n * 25.4;
  return n;
}

/* ------------------------------------------------------------------ archetype inference */
const ARCH_KEYWORDS = [
  [/\b3[-\s]?seat|three[-\s]?seat|sofa,?\s*3\b/, 'sofa_3seat'],
  [/\b2[-\s]?seat|two[-\s]?seat|loveseat/, 'sofa_2seat'],
  [/sectional|corner sofa|chaise sofa/, 'sofa_sectional_l'],
  [/chaise/, 'chaise'],
  [/wing chair|armchair|easy chair|accent chair/, 'armchair'],
  [/footstool|ottoman|pouffe/, 'ottoman'],
  [/bench/, 'bench'],
  [/bar stool|counter stool/, 'bar_stool'],
  [/office chair|swivel chair|desk chair|task chair/, 'office_chair'],
  [/dining chair|\bchair\b/, 'dining_chair'],
  [/stool/, 'stool'],
  [/\bcrib\b|\bcot\b/, 'crib'],
  [/king bed|bed.*\bking\b/, 'bed_king'],
  [/queen bed|bed.*\bqueen\b/, 'bed_queen'],
  [/(double|full) bed|bed.*\b(double|full)\b/, 'bed_double'],
  [/(single|twin) bed|bed.*\b(single|twin)\b|bed frame/, 'bed_single'],
  [/nightstand|bedside table/, 'nightstand'],
  [/chest of drawers|\d[-\s]?drawer chest|dresser/, 'dresser'],
  [/wardrobe|armoire|closet/, 'wardrobe'],
  [/bookcase|bookshelf/, 'bookcase'],
  [/shelf unit|shelving|cube storage/, 'shelf_unit'],
  [/sideboard|buffet|credenza/, 'sideboard'],
  [/tv bench|tv unit|media console/, 'tv_bench'],
  [/wall shelf|picture ledge|floating shelf/, 'wall_shelf'],
  [/storage box|\bbox\b|\bbin\b/, 'storage_box'],
  [/cabinet/, 'cabinet'],
  [/coffee table/, 'coffee_table'],
  [/side table|end table|tray table/, 'side_table'],
  [/console table/, 'console_table'],
  [/kitchen island/, 'kitchen_island'],
  [/round (dining )?table|table.*round/, 'dining_table_round'],
  [/dining table|\btable\b/, 'dining_table_rect'],
  [/desk/, 'desk'],
  [/\brug\b|carpet/, 'rug'],
  [/floor lamp|uplighter|reading lamp/, 'floor_lamp'],
  [/pendant|chandelier/, 'pendant_lamp'],
  [/wall lamp|sconce|spotlight/, 'wall_lamp'],
  [/table lamp|work lamp|desk lamp/, 'table_lamp'],
  [/\btv\b|television|flat[-\s]?panel/, 'tv'],
  [/mirror/, 'mirror'],
  [/frame|picture|poster|art/, 'art_frame'],
  [/plant|ficus|monstera|greenery/, 'plant'],
  [/curtain|drape/, 'curtain'],
];
function inferArchetype(text) {
  const t = text.toLowerCase();
  for (const [re, a] of ARCH_KEYWORDS) if (re.test(t)) return a;
  return null;
}
const ARCH_CATEGORY = {
  sofa_2seat: 'seating', sofa_3seat: 'seating', sofa_sectional_l: 'seating', loveseat: 'seating',
  chaise: 'seating', armchair: 'seating', ottoman: 'seating', bench: 'seating',
  dining_chair: 'seating', office_chair: 'seating', stool: 'seating', bar_stool: 'seating',
  bed_single: 'beds', bed_double: 'beds', bed_queen: 'beds', bed_king: 'beds', crib: 'kids',
  nightstand: 'storage', dresser: 'storage', wardrobe: 'storage', bookcase: 'storage',
  shelf_unit: 'storage', sideboard: 'storage', cabinet: 'storage', tv_bench: 'storage',
  storage_box: 'storage', coffee_table: 'tables', side_table: 'tables',
  dining_table_rect: 'tables', dining_table_round: 'tables', desk: 'desks',
  console_table: 'tables', kitchen_island: 'tables', rug: 'rugs',
  floor_lamp: 'lighting', table_lamp: 'lighting', pendant_lamp: 'lighting', wall_lamp: 'lighting',
  tv: 'decor', art_frame: 'decor', mirror: 'decor', plant: 'decor', curtain: 'decor',
  wall_shelf: 'decor',
};
const SEAT_ARCH = new Set(['sofa_2seat', 'sofa_3seat', 'sofa_sectional_l', 'loveseat', 'chaise',
  'armchair', 'ottoman', 'bench', 'dining_chair', 'office_chair', 'stool', 'bar_stool',
  'bed_single', 'bed_double', 'bed_queen', 'bed_king']);

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------------------------------------------ generic proxy fallback
 * The importer cannot author bespoke geometry, so it emits an honest, archetype-shaped
 * block proxy and flags the item so a human runs tools/gen_catalog.py-quality geometry.
 */
function fallbackProxy(arch, w, d, h, seatH) {
  const P = [];
  const bx = (x, y, z, sx, sy, sz, color, radius) => {
    const p = { shape: 'box', pos: [Math.round(x), Math.round(y), Math.round(z)],
      size: [Math.round(sx), Math.round(sy), Math.round(sz)], color };
    if (radius) p.radius = Math.round(radius);
    return p;
  };
  if (SEAT_ARCH.has(arch) && seatH && !arch.startsWith('bed_')) {
    P.push(bx(0, 0, seatH / 2, w, d, seatH, 'body', 20));
    P.push(bx(0, -(d / 2 - d * 0.12), (seatH + h) / 2, w, d * 0.24, h - seatH, 'fabric', 20));
    P.push(bx(0, d * 0.1, seatH + 40, w * 0.86, d * 0.6, 80, 'fabric', 25));
  } else if (arch.startsWith('bed_')) {
    P.push(bx(0, 0, (seatH || h * 0.4) / 2, w, d, seatH || h * 0.4, 'wood', 10));
    P.push(bx(0, -(d / 2 - 25), h / 2, w, 50, h, 'wood', 10));
    P.push(bx(0, 15, (seatH || h * 0.4) + 100, w - 120, d - 120, 200, '#EDE9E2', 25));
  } else if (arch === 'rug') {
    P.push(bx(0, 0, h / 2, w, d, h, 'fabric', 20));
  } else if (/lamp/.test(arch)) {
    P.push(bx(0, 0, h * 0.06, w * 0.6, d * 0.6, h * 0.12, 'metal'));
    P.push(bx(0, 0, h * 0.5, 40, 40, h * 0.8, 'metal'));
    P.push(bx(0, 0, h * 0.86, w, d, h * 0.26, '#F1EDE4'));
  } else {
    P.push(bx(0, 0, h * 0.5 + 30, w, d, h - 60, 'wood', 6));
    P.push(bx(0, 0, 30, w - 60, d - 40, 60, 'dark'));
    P.push(bx(0, d / 2 - 10, h * 0.55, w * 0.9, 20, h * 0.5, '#E9E4DB', 4));
  }
  return { parts: P };
}

/* ------------------------------------------------------------------ normalise one row */
function normaliseRow(row, idx, report) {
  const g = (k) => pick(row, k).value;
  const name = g('name');
  const ptype = g('product_type') || '';
  const issues = [];

  if (!name) { report.skipped.push({ idx, reason: 'no name/title field' }); return null; }

  let arch = g('archetype');
  if (arch && !ARCH[arch]) { issues.push(`feed archetype "${arch}" not in closed set -- re-inferred`); arch = null; }
  if (!arch) arch = inferArchetype(`${name} ${ptype} ${g('category') || ''} ${g('tags') || ''}`);
  if (!arch) { report.skipped.push({ idx, name, reason: 'archetype could not be inferred' }); return null; }

  let category = g('category');
  if (!category || !CATEGORIES.includes(category)) {
    if (category) issues.push(`category "${category}" not in SPEC §4.2 -- mapped from archetype`);
    category = ARCH_CATEGORY[arch];
  }

  const unitHint = g('unit');
  const W = toMM(g('w'), 'width', unitHint);
  const D = toMM(g('d'), 'depth', unitHint);
  const H = toMM(g('h'), 'height', unitHint);
  if (W.note) issues.push('w: ' + W.note);
  if (D.note) issues.push('d: ' + D.note);
  if (H.note) issues.push('h: ' + H.note);
  if (W.mm == null || D.mm == null || H.mm == null) {
    report.skipped.push({ idx, name, reason: 'incomplete dimensions (w/d/h all required)' });
    return null;
  }

  const A = ARCH[arch];
  const S = A.dims_sanity_mm;
  for (const [axis, v] of [['w', W.mm], ['d', D.mm], ['h', H.mm]]) {
    if (S[axis] && (v < S[axis][0] || v > S[axis][1])) {
      issues.push(`${axis}=${v}mm outside the ${arch} envelope ${S[axis][0]}-${S[axis][1]}mm`);
    }
  }

  let seatH = null;
  if (S.seat_h) {
    const sh = toMM(g('seat_h'), 'seat_height', unitHint);
    seatH = sh.mm;
    if (seatH == null) { seatH = Math.round((S.seat_h[0] + S.seat_h[1]) / 2); issues.push('seat_h_mm absent -- archetype midpoint substituted'); }
  }

  const confidence = issues.length === 0 ? 'medium' : 'low';   // never "high" from a machine import
  const place = Object.assign({ needs_wall_len_mm: null }, A.placement_defaults);
  if (place.against_wall || place.wall_mounted) {
    place.needs_wall_len_mm = W.mm + (arch === 'curtain' ? 200 : 100);
  }

  const hex = /^#[0-9A-Fa-f]{6}$/.test(String(g('color_hex') || '')) ? g('color_hex') : '#C9C4BB';
  if (hex === '#C9C4BB') issues.push('no usable colour swatch -- neutral placeholder used');

  const brand = g('brand') || 'Unknown';
  const id = slug(g('id') || `${brand}-${name}-${ptype || arch}`);
  const tagsRaw = g('tags');
  const tags = (Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw || '').split(/[;,|]/))
    .map((t) => slug(t)).filter(Boolean);
  if (!tags.length) tags.push(A.layout_hints.zone || 'imported');
  tags.push('imported');

  const item = {
    id, brand, name: String(name), product_type: String(ptype || arch.replace(/_/g, ' ')),
    sku: g('sku') ? String(g('sku')) : null,
    category, archetype: arch,
    dims_mm: { w: W.mm, d: D.mm, h: H.mm },
    seat_h_mm: seatH,
    footprint: /round/.test(`${name} ${ptype}`.toLowerCase()) && Math.abs(W.mm - D.mm) <= 2 ? 'round' : 'rect',
    l_shape_mm: null,
    clearance_mm: Object.assign({}, A.clearance_mm),
    placement: place,
    colorways: [{ name: String(g('color') || 'Default'), hex }],
    price_usd: Math.max(0, Math.round(parseFloat(String(g('price_usd') || '0').replace(/[^0-9.]/g, '')) || 0)),
    url: g('url') ? String(g('url')) : null,
    tags: [...new Set(tags)],
    dims_confidence: confidence,
    dims_note: issues.length ? 'IMPORTED: ' + issues.join('; ') : 'IMPORTED: feed dimensions accepted as-is.',
    proxy: fallbackProxy(arch, W.mm, D.mm, H.mm, seatH),
  };
  if (issues.length) report.review.push({ id, name: item.name, issues });
  return item;
}

/* ------------------------------------------------------------------ run */
const rows = readFeed(feedPath);
const report = { skipped: [], review: [], dupes: [] };
const items = [];
const seen = new Set();
rows.forEach((r, i) => {
  const it = normaliseRow(r, i, report);
  if (!it) return;
  if (seen.has(it.id)) { report.dupes.push(it.id); return; }
  seen.add(it.id);
  items.push(it);
});

const line = (n) => '-'.repeat(n);
console.log('ainterior catalog importer');
console.log('  feed   : ' + path.relative(process.cwd(), feedPath));
console.log('  rows   : ' + rows.length);
console.log('  items  : ' + items.length + '   skipped: ' + report.skipped.length + '   duplicate ids: ' + report.dupes.length);

const hist = {};
items.forEach((i) => { hist[i.archetype] = (hist[i.archetype] || 0) + 1; });
console.log('\nARCHETYPE HISTOGRAM\n' + line(40));
Object.entries(hist).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log('  ' + k.padEnd(22) + String(v).padStart(4)));

const conf = {};
items.forEach((i) => { conf[i.dims_confidence] = (conf[i.dims_confidence] || 0) + 1; });
console.log('\nCONFIDENCE (machine imports never claim "high")\n' + line(40));
Object.entries(conf).forEach(([k, v]) => console.log('  ' + k.padEnd(22) + String(v).padStart(4)));

if (report.skipped.length) {
  console.log('\nSKIPPED\n' + line(40));
  report.skipped.slice(0, 30).forEach((s) => console.log(`  row ${s.idx}: ${s.name || '(unnamed)'} -- ${s.reason}`));
  if (report.skipped.length > 30) console.log(`  ... ${report.skipped.length - 30} more`);
}
if (report.review.length) {
  console.log('\nNEEDS REVIEW (dimension or metadata uncertainty -- do NOT publish as verified)\n' + line(40));
  report.review.slice(0, 40).forEach((r) => console.log(`  ${r.id}\n      ${r.issues.join('\n      ')}`));
  if (report.review.length > 40) console.log(`  ... ${report.review.length - 40} more`);
}
console.log('\nEVERY imported item carries a block-level fallback proxy. Hand-author real');
console.log('geometry in tools/proxy_builders.py before publishing (published=false until then).');

/* ------------------------------------------------------------------ output */
let outPath = null;
if (flags.merge) {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const byId = new Map(cat.items.map((i) => [i.id, i]));
  let added = 0, updated = 0;
  for (const it of items) { if (byId.has(it.id)) updated++; else added++; byId.set(it.id, it); }
  cat.items = [...byId.values()];
  fs.writeFileSync(path.join(ROOT, 'catalog.json'), JSON.stringify(cat, null, 1));
  outPath = path.join(ROOT, 'catalog.json');
  console.log(`\nmerged into catalog.json  (+${added} new, ${updated} updated, ${cat.items.length} total)`);
} else if (flags.out) {
  outPath = path.resolve(flags.out);
  fs.writeFileSync(outPath, JSON.stringify({ version: 1, items }, null, 1));
  console.log('\nwrote ' + path.relative(process.cwd(), outPath));
} else {
  outPath = path.join(require('os').tmpdir(), 'ainterior-import-' + Date.now() + '.json');
  fs.writeFileSync(outPath, JSON.stringify({ version: 1, items }, null, 1));
  console.log('\ndry run -- normalised items written to ' + outPath);
}

/* ------------------------------------------------------------------ validate the result */
console.log('\n' + line(60) + '\nrunning validate.js on the normalised output\n' + line(60));
try {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'validate.js'), outPath, '--partial'], { encoding: 'utf8' });
  console.log(out.split('\n').filter((l) => /ERRORS|WARNINGS|PASS|FAIL|\[ERR|\[warn/.test(l)).slice(0, 40).join('\n'));
} catch (e) {
  console.log((e.stdout || '').split('\n').filter((l) => /ERRORS|FAIL|\[ERR/.test(l)).slice(0, 40).join('\n'));
  console.log('\nimport produced items that fail validation -- fix the feed or the mapping.');
  process.exit(1);
}

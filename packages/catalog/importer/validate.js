#!/usr/bin/env node
/**
 * ainterior :: packages/catalog/importer/validate.js
 *
 * Validates catalog.json against schema.json plus the semantic rules that the schema
 * cannot express. Dependency-free (SPEC v1 §8.7) -- includes a small draft-07 subset
 * validator covering exactly the keywords schema.json uses.
 *
 *   node importer/validate.js [path/to/catalog.json] [--partial]
 *
 * Exit 0 = clean, 1 = errors. Warnings never fail the build but are always printed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const PARTIAL = args.includes('--partial');   // a feed slice, not the shipping catalog
const target = args.find((a) => !a.startsWith('--'));
const catalogPath = target ? path.resolve(target) : path.join(ROOT, 'catalog.json');
const schemaPath = path.join(ROOT, 'schema.json');
const archPath = path.join(ROOT, 'archetypes.json');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const archFile = JSON.parse(fs.readFileSync(archPath, 'utf8'));
const ARCH = archFile.archetypes;
const CATEGORIES = archFile.categories;

const COLOR_ROLES = ['body', 'wood', 'metal', 'glass', 'fabric', 'dark'];
const SHAPES = ['box', 'cyl', 'sphere', 'plane'];
const BOUNDS_TOL_MM = 2; // integer rounding slack only

const errors = [];
const warns = [];
const err = (id, code, msg) => errors.push({ id, code, msg });
const warn = (id, code, msg) => warns.push({ id, code, msg });

/* ------------------------------------------------------------------ mini JSON Schema (draft-07 subset) */
function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error('unsupported $ref ' + ref);
  return ref.slice(2).split('/').reduce((o, k) => o[k], root);
}

function validateSchema(value, sch, root, ptr, out) {
  if (sch.$ref) return validateSchema(value, resolveRef(sch.$ref, root), root, ptr, out);

  if (sch.oneOf) {
    const hits = sch.oneOf.filter((s) => {
      const sub = [];
      validateSchema(value, s, root, ptr, sub);
      return sub.length === 0;
    });
    if (hits.length !== 1) out.push(`${ptr}: matched ${hits.length} of oneOf branches (need exactly 1)`);
    return;
  }
  if (sch.enum && !sch.enum.includes(value)) {
    out.push(`${ptr}: ${JSON.stringify(value)} not in enum [${sch.enum.join(', ')}]`);
    return;
  }
  if (sch.type) {
    const types = Array.isArray(sch.type) ? sch.type : [sch.type];
    const actual =
      value === null ? 'null'
        : Array.isArray(value) ? 'array'
          : Number.isInteger(value) ? 'integer'
            : typeof value === 'number' ? 'number' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      out.push(`${ptr}: expected ${types.join('|')}, got ${actual}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (sch.minLength != null && value.length < sch.minLength) out.push(`${ptr}: shorter than ${sch.minLength}`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) out.push(`${ptr}: "${value}" fails /${sch.pattern}/`);
  }
  if (typeof value === 'number') {
    if (sch.minimum != null && value < sch.minimum) out.push(`${ptr}: ${value} < minimum ${sch.minimum}`);
    if (sch.maximum != null && value > sch.maximum) out.push(`${ptr}: ${value} > maximum ${sch.maximum}`);
  }
  if (Array.isArray(value)) {
    if (sch.minItems != null && value.length < sch.minItems) out.push(`${ptr}: ${value.length} items < minItems ${sch.minItems}`);
    if (sch.maxItems != null && value.length > sch.maxItems) out.push(`${ptr}: ${value.length} items > maxItems ${sch.maxItems}`);
    if (sch.items) value.forEach((v, i) => validateSchema(v, sch.items, root, `${ptr}[${i}]`, out));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    (sch.required || []).forEach((k) => {
      if (!(k in value)) out.push(`${ptr}: missing required field "${k}"`);
    });
    if (sch.properties) {
      for (const [k, v] of Object.entries(value)) {
        if (sch.properties[k]) validateSchema(v, sch.properties[k], root, `${ptr}.${k}`, out);
        else if (sch.additionalProperties === false) out.push(`${ptr}: unexpected field "${k}"`);
      }
    }
  }
}

/* ------------------------------------------------------------------ geometry helpers */
function partHalfExtents(p) {
  const [sx, sy, sz] = p.size;
  if (p.shape === 'sphere') { const r = sx / 2; return [r, r, r]; }
  if (p.shape === 'cyl') return [sx / 2, sy / 2, sz / 2]; // size = [dia, dia, height]
  if (p.shape === 'plane') return [sx / 2, sy / 2, 0];
  return [sx / 2, sy / 2, sz / 2];
}

/* ------------------------------------------------------------------ run */
if (catalog.version !== 1) err('<file>', 'VERSION', `catalog.version must be 1, got ${catalog.version}`);
if (!Array.isArray(catalog.items)) {
  err('<file>', 'SHAPE', 'catalog.items must be an array');
} else if (catalog.items.length < 100) {
  (PARTIAL ? warn : err)('<file>', 'COUNT', `catalog must hold >=100 items, has ${catalog.items.length}`);
}

const items = catalog.items || [];
const seenIds = new Map();
const hist = { category: {}, archetype: {}, confidence: {}, footprint: {}, brand: {} };
const bump = (b, k) => { hist[b][k] = (hist[b][k] || 0) + 1; };

for (const it of items) {
  const id = it && it.id ? it.id : '<no id>';

  /* 1. schema conformance */
  const sErrs = [];
  validateSchema(it, schema, schema, id, sErrs);
  sErrs.forEach((m) => err(id, 'SCHEMA', m));
  if (!it || !it.dims_mm || !it.archetype) continue;

  /* 2. unique ids */
  if (seenIds.has(id)) err(id, 'DUP_ID', `duplicate id (first seen at index ${seenIds.get(id)})`);
  else seenIds.set(id, items.indexOf(it));

  /* 3. archetype membership in the closed set + category membership */
  if (!ARCH[it.archetype]) { err(id, 'ARCHETYPE', `"${it.archetype}" is not in the SPEC §4.3 closed set`); continue; }
  if (!CATEGORIES.includes(it.category)) err(id, 'CATEGORY', `"${it.category}" is not a SPEC §4.2 category`);

  const A = ARCH[it.archetype];
  const { w, d, h } = it.dims_mm;
  bump('category', it.category); bump('archetype', it.archetype);
  bump('confidence', it.dims_confidence); bump('footprint', it.footprint); bump('brand', it.brand);

  /* 4. integer millimetres (SPEC §1) */
  for (const [k, v] of Object.entries(it.dims_mm)) {
    if (!Number.isInteger(v)) err(id, 'UNITS', `dims_mm.${k} = ${v} is not an integer millimetre value`);
  }

  /* 5. dims sanity per archetype */
  const S = A.dims_sanity_mm;
  for (const axis of ['w', 'd', 'h']) {
    const rng = S[axis];
    const v = it.dims_mm[axis];
    if (rng && (v < rng[0] || v > rng[1])) {
      err(id, 'DIMS_OUTLIER', `${it.archetype} ${axis}=${v}mm outside expected ${rng[0]}-${rng[1]}mm`);
    }
  }
  if (S.seat_h == null) {
    if (it.seat_h_mm != null) warn(id, 'SEAT_H', `${it.archetype} should not carry seat_h_mm (got ${it.seat_h_mm})`);
  } else if (it.seat_h_mm == null) {
    warn(id, 'SEAT_H', `${it.archetype} is expected to carry seat_h_mm`);
  } else if (it.seat_h_mm < S.seat_h[0] || it.seat_h_mm > S.seat_h[1]) {
    err(id, 'SEAT_H_OUTLIER', `seat_h_mm=${it.seat_h_mm} outside ${S.seat_h[0]}-${S.seat_h[1]}mm for ${it.archetype}`);
  }
  if (it.seat_h_mm != null && it.seat_h_mm > h) {
    err(id, 'SEAT_H_GT_H', `seat_h_mm=${it.seat_h_mm} exceeds overall height ${h}`);
  }
  if (it.footprint === 'round' && Math.abs(w - d) > 2) {
    err(id, 'ROUND_FOOTPRINT', `footprint "round" requires w==d, got ${w}x${d}`);
  }
  if (it.footprint === 'L' && !it.l_shape_mm) err(id, 'L_SHAPE', 'footprint "L" requires l_shape_mm');
  if (it.footprint !== 'L' && it.l_shape_mm) err(id, 'L_SHAPE', 'l_shape_mm set on a non-L footprint');
  if (it.l_shape_mm) {
    if (it.l_shape_mm.notch_w >= w) err(id, 'L_SHAPE', `notch_w ${it.l_shape_mm.notch_w} >= w ${w}`);
    if (it.l_shape_mm.notch_d >= d) err(id, 'L_SHAPE', `notch_d ${it.l_shape_mm.notch_d} >= d ${d}`);
  }

  /* 6. placement coherence */
  const p = it.placement;
  if (p.wall_mounted && p.mount_h_mm == null) err(id, 'PLACEMENT', 'wall_mounted requires mount_h_mm');
  if (!p.wall_mounted && p.mount_h_mm != null) warn(id, 'PLACEMENT', 'mount_h_mm set but wall_mounted is false');
  if (p.ceiling_mounted && p.wall_mounted) err(id, 'PLACEMENT', 'cannot be both ceiling_mounted and wall_mounted');
  if ((p.against_wall || p.wall_mounted) && p.needs_wall_len_mm == null) {
    err(id, 'PLACEMENT', 'against_wall / wall_mounted requires needs_wall_len_mm');
  }
  if (p.needs_wall_len_mm != null && p.needs_wall_len_mm < w) {
    err(id, 'PLACEMENT', `needs_wall_len_mm ${p.needs_wall_len_mm} < item width ${w}`);
  }
  if (!p.against_wall && !p.center_ok && !p.corner_ok && !p.wall_mounted && !p.ceiling_mounted) {
    err(id, 'PLACEMENT', 'item has no legal placement (all placement flags false)');
  }
  // archetype default agreement -- drift check, warn only
  for (const k of ['against_wall', 'wall_mounted', 'ceiling_mounted', 'center_ok', 'corner_ok']) {
    if (A.placement_defaults[k] !== p[k]) {
      warn(id, 'PLACEMENT_DRIFT', `${k}=${p[k]} differs from ${it.archetype} default ${A.placement_defaults[k]}`);
    }
  }
  for (const side of ['front', 'back', 'left', 'right']) {
    if (it.clearance_mm[side] !== A.clearance_mm[side]) {
      warn(id, 'CLEARANCE_DRIFT', `clearance_mm.${side}=${it.clearance_mm[side]} differs from ${it.archetype} default ${A.clearance_mm[side]}`);
    }
  }

  /* 7. proxy: non-empty, in bounds, on/above floor, legal colours */
  const parts = (it.proxy && it.proxy.parts) || [];
  if (parts.length === 0) { err(id, 'PROXY_EMPTY', 'proxy.parts is empty'); continue; }
  if (parts.length < 3 && it.archetype !== 'rug') {
    warn(id, 'PROXY_THIN', `only ${parts.length} primitive(s) -- unlikely to read as ${it.archetype}`);
  }
  let volume = 0;
  parts.forEach((pt, i) => {
    const tag = `proxy.parts[${i}]`;
    if (!SHAPES.includes(pt.shape)) err(id, 'PROXY_SHAPE', `${tag}: unknown shape "${pt.shape}"`);
    if (!COLOR_ROLES.includes(pt.color) && !/^#[0-9A-Fa-f]{6}$/.test(pt.color)) {
      err(id, 'PROXY_COLOR', `${tag}: "${pt.color}" is not a named role or #RRGGBB`);
    }
    pt.pos.concat(pt.size).forEach((v) => {
      if (!Number.isInteger(v)) err(id, 'UNITS', `${tag}: ${v} is not an integer millimetre value`);
    });
    const [hx, hy, hz] = partHalfExtents(pt);
    const [x, y, z] = pt.pos;
    if (Math.abs(x) + hx > w / 2 + BOUNDS_TOL_MM) err(id, 'PROXY_BOUNDS', `${tag}: x extent ${Math.round(Math.abs(x) + hx) * 2}mm exceeds w ${w}mm`);
    if (Math.abs(y) + hy > d / 2 + BOUNDS_TOL_MM) err(id, 'PROXY_BOUNDS', `${tag}: y extent ${Math.round(Math.abs(y) + hy) * 2}mm exceeds d ${d}mm`);
    if (z - hz < -BOUNDS_TOL_MM) err(id, 'PROXY_BOUNDS', `${tag}: dips below the floor (z=${z}, half-h=${Math.round(hz)})`);
    if (z + hz > h + BOUNDS_TOL_MM) err(id, 'PROXY_BOUNDS', `${tag}: top ${Math.round(z + hz)}mm exceeds h ${h}mm`);
    if (pt.shape === 'cyl' && pt.size[0] !== pt.size[1]) err(id, 'PROXY_CYL', `${tag}: cyl size must be [dia, dia, height]`);
    if (pt.shape === 'sphere' && !(pt.size[0] === pt.size[1] && pt.size[1] === pt.size[2])) err(id, 'PROXY_SPHERE', `${tag}: sphere size must be cubic`);
    if (pt.shape === 'plane' && pt.size[2] !== 0) err(id, 'PROXY_PLANE', `${tag}: plane size[2] must be 0`);
    if (pt.shape !== 'plane') volume += (2 * hx) * (2 * hy) * (2 * hz);
  });
  // the proxy must actually occupy the declared envelope, not float as a token sliver
  const fill = volume / (w * d * h);
  if (fill < 0.05) warn(id, 'PROXY_SPARSE', `primitives fill only ${(fill * 100).toFixed(1)}% of the bbox`);
  // vertical coverage: something must reach near the top and near the floor
  const topReach = Math.max(...parts.map((pt) => pt.pos[2] + partHalfExtents(pt)[2]));
  if (topReach < h * 0.8) warn(id, 'PROXY_SHORT', `tallest primitive reaches only ${Math.round(topReach)}mm of ${h}mm`);

  /* 8. commercial metadata */
  if (!it.colorways.length) err(id, 'COLORWAYS', 'at least one colorway required');
  if (it.price_usd <= 0) warn(id, 'PRICE', 'price_usd is 0');
  if (!it.tags.length) err(id, 'TAGS', 'at least one tag required');
}

/* ------------------------------------------------------------------ report */
const pad = (s, n) => String(s).padEnd(n);
function printHist(title, obj, sortKey) {
  const rows = Object.entries(obj).sort((a, b) => (sortKey === 'key' ? a[0].localeCompare(b[0]) : b[1] - a[1]));
  const total = rows.reduce((s, r) => s + r[1], 0);
  console.log(`\n${title}  (${rows.length} distinct / ${total} items)`);
  for (const [k, v] of rows) {
    console.log(`  ${pad(k, 22)} ${String(v).padStart(4)}  ${'#'.repeat(Math.max(1, Math.round(v / Math.max(1, total / 60))))}`);
  }
}

console.log('ainterior catalog validation');
console.log('  file        : ' + path.relative(process.cwd(), catalogPath));
console.log('  items       : ' + items.length);
console.log('  proxy parts : ' + items.reduce((s, i) => s + ((i.proxy && i.proxy.parts) || []).length, 0)
  + '  (avg ' + (items.reduce((s, i) => s + ((i.proxy && i.proxy.parts) || []).length, 0) / Math.max(1, items.length)).toFixed(1) + ' per item)');

printHist('CATEGORY', hist.category);
printHist('ARCHETYPE', hist.archetype, 'key');
printHist('FOOTPRINT', hist.footprint);
printHist('BRAND', hist.brand);

const conf = hist.confidence;
const ct = (conf.high || 0) + (conf.medium || 0) + (conf.low || 0);
console.log('\nDIMS CONFIDENCE');
for (const k of ['high', 'medium', 'low']) {
  const v = conf[k] || 0;
  console.log(`  ${pad(k, 22)} ${String(v).padStart(4)}  ${(100 * v / Math.max(1, ct)).toFixed(1)}%`);
}
const missingArch = Object.keys(ARCH).filter((a) => !hist.archetype[a]);
console.log('\nARCHETYPE COVERAGE: ' + Object.keys(hist.archetype).length + '/' + Object.keys(ARCH).length
  + (missingArch.length ? '   uncovered: ' + missingArch.join(', ') : '   (complete)'));

const byCode = {};
for (const w of warns) byCode[w.code] = (byCode[w.code] || 0) + 1;
console.log('\nWARNINGS: ' + warns.length + (warns.length ? '  ' + JSON.stringify(byCode) : ''));
warns.slice(0, 40).forEach((w) => console.log(`  [warn] ${pad(w.code, 16)} ${w.id}: ${w.msg}`));
if (warns.length > 40) console.log(`  ... ${warns.length - 40} more warnings suppressed`);

console.log('\nERRORS: ' + errors.length);
errors.slice(0, 80).forEach((e) => console.log(`  [ERR ] ${pad(e.code, 16)} ${e.id}: ${e.msg}`));
if (errors.length > 80) console.log(`  ... ${errors.length - 80} more errors suppressed`);

if (errors.length) {
  console.log('\nFAIL -- ' + errors.length + ' error(s).');
  process.exit(1);
}
console.log('\nPASS -- catalog is schema-clean and semantically consistent.');

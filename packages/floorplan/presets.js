/* packages/floorplan/presets.js
 * The four starter plans (SPEC2 §H). Every one is a complete, valid floorplan:
 * integer mm, CCW room polygons in shared absolute plan coordinates, rooms tiled so
 * that abutting edges become single interior walls, and a door path from the entrance
 * to every room.
 *
 * Coordinates: x -> right, y -> up the page (SPEC §1). Rect wall_index mapping is
 *   0 = south (y0), 1 = east (x1), 2 = north (y1), 3 = west (x0).
 */

import { rectPolygon } from './geometry.js';

const H = 2600;
const S = 0, E = 1, N = 2, W = 3;   // wall indices of a rect room

function room(id, name, x, y, w, d, floor, openings = []) {
  return {
    id, name,
    polygon_mm: rectPolygon(x, y, w, d),
    height_mm: H,
    floor_material: floor,
    openings: openings.map((o, i) => ({
      id: o.id || `${id}_o${i + 1}`,
      type: o.type,
      wall_index: o.wall,
      offset_mm: o.offset,
      width_mm: o.width,
      height_mm: o.height ?? (o.type === 'door' ? 2040 : 1400),
      sill_mm: o.sill ?? (o.type === 'door' ? 0 : 900),
      swing: o.type === 'door' ? (o.swing ?? 'in-left') : null,
    })),
    features: o_features(o_none),
    source: 'manual',
    confidence: 1.0,
  };
}
const o_none = [];
function o_features(f) { return f.map(x => ({ ...x })); }

function plan(id, name, rooms, connections, opts = {}) {
  return {
    schema: 2,
    id, name,
    unit: 'cm',
    wall_thickness_mm: opts.wall_thickness_mm ?? 200,
    interior_thickness_mm: opts.interior_thickness_mm ?? 110,
    default_height_mm: H,
    rooms,
    connections: connections.map((c, i) => ({
      id: c.id || `c${i + 1}`,
      a_room: c.a, b_room: c.b,
      type: c.type || 'door',
      offset_mm: c.offset, width_mm: c.width,
      height_mm: c.height ?? 2040, sill_mm: 0,
      swing: c.type === 'opening' ? null : (c.swing ?? 'in-left'),
    })),
    interior_walls: [],
    brief: {},
    preset: true,
    blurb: opts.blurb || '',
    created_at: null,
  };
}

/* ─── 1. Single room 4.6 × 3.8 m ────────────────────────────────────── */
/* area 17.48 m²  ·  perimeter 16 800 mm */
const singleRoom = plan('fp_single_room', 'Single room 4.6 × 3.8 m', [
  room('r_main', 'Room', 0, 0, 4600, 3800, 'oak', [
    { id: 'd_front', type: 'door', wall: S, offset: 400, width: 900 },
    { id: 'w_n1', type: 'window', wall: N, offset: 900, width: 1600 },
    { id: 'w_e1', type: 'window', wall: E, offset: 1200, width: 1200 },
  ]),
], [], { blurb: 'One square-ish room — the quickest way into the studio.' });

/* ─── 2. Studio 6.0 × 4.2 m ─────────────────────────────────────────── */
/* area 25.20 m²  ·  perimeter 20 400 mm */
const studio = plan('fp_studio', 'Studio 6.0 × 4.2 m', [
  room('r_studio', 'Studio', 0, 0, 6000, 4200, 'oak', [
    { id: 'd_front', type: 'door', wall: W, offset: 300, width: 900 },
    { id: 'w_n1', type: 'window', wall: N, offset: 800, width: 1800 },
    { id: 'w_n2', type: 'window', wall: N, offset: 3400, width: 1800 },
    { id: 'w_e1', type: 'window', wall: E, offset: 1500, width: 1200 },
  ]),
], [], { blurb: 'Open-plan studio: living, sleeping and kitchen in one 25 m² space.' });

/* ─── 3. One-bed apartment ──────────────────────────────────────────── */
/* envelope 9200 × 4200 = 38.64 m²
 *   Living  0..4800   × 0..4200   20.16 m²
 *   Hall    4800..6000 × 0..4200   5.04 m²
 *   Bath    6000..9200 × 0..1800   5.76 m²
 *   Bedroom 6000..9200 × 1800..4200 7.68 m²
 */
const oneBed = plan('fp_1bed', '1-bed apartment', [
  room('r_living', 'Living / kitchen', 0, 0, 4800, 4200, 'oak', [
    { id: 'w_s1', type: 'window', wall: S, offset: 900, width: 1800 },
    { id: 'w_w1', type: 'window', wall: W, offset: 1200, width: 1400 },
    { id: 'w_n1', type: 'window', wall: N, offset: 1400, width: 1800 },
  ]),
  room('r_hall', 'Hall', 4800, 0, 1200, 4200, 'tile', [
    { id: 'd_front', type: 'door', wall: S, offset: 150, width: 900 },
  ]),
  room('r_bath', 'Bathroom', 6000, 0, 3200, 1800, 'tile', [
    { id: 'w_bath', type: 'window', wall: E, offset: 600, width: 700, height: 700, sill: 1500 },
  ]),
  room('r_bed', 'Bedroom', 6000, 1800, 3200, 2400, 'ash', [
    { id: 'w_bed1', type: 'window', wall: N, offset: 900, width: 1600 },
    { id: 'w_bed2', type: 'window', wall: E, offset: 700, width: 1200 },
  ]),
], [
  // Living | Hall share x=4800 over y 0..4200 (4200mm)
  { id: 'c_living_hall', a: 'r_living', b: 'r_hall', type: 'opening', offset: 1600, width: 1100 },
  // Hall | Bath share x=6000 over y 0..1800 (1800mm)
  { id: 'c_hall_bath', a: 'r_hall', b: 'r_bath', offset: 500, width: 800 },
  // Hall | Bedroom share x=6000 over y 1800..4200 (2400mm)
  { id: 'c_hall_bed', a: 'r_hall', b: 'r_bed', offset: 700, width: 900 },
], { blurb: 'Living/kitchen, bedroom, bathroom off a short hall — 38.6 m².' });

/* ─── 4. Two-bed apartment ──────────────────────────────────────────── */
/* envelope 11000 × 4600 = 50.60 m²
 *   Hall     0..11000 × 3400..4600  13.20 m²   (spine along the top)
 *   Living   0..4600  × 0..3400     15.64 m²
 *   Bed 1    4600..7400 × 0..3400    9.52 m²
 *   Bed 2    7400..9800 × 0..3400    8.16 m²
 *   Bath     9800..11000 × 0..3400   4.08 m²
 */
const twoBed = plan('fp_2bed', '2-bed apartment', [
  room('r_hall', 'Hall', 0, 3400, 11000, 1200, 'tile', [
    { id: 'd_front', type: 'door', wall: N, offset: 600, width: 950 },
  ]),
  room('r_living', 'Living / kitchen', 0, 0, 4600, 3400, 'oak', [
    { id: 'w_ls', type: 'window', wall: S, offset: 700, width: 2000 },
    { id: 'w_lw', type: 'window', wall: W, offset: 900, width: 1400 },
  ]),
  room('r_bed1', 'Bedroom 1', 4600, 0, 2800, 3400, 'ash', [
    { id: 'w_b1', type: 'window', wall: S, offset: 700, width: 1600 },
  ]),
  room('r_bed2', 'Bedroom 2', 7400, 0, 2400, 3400, 'ash', [
    { id: 'w_b2', type: 'window', wall: S, offset: 500, width: 1400 },
  ]),
  room('r_bath', 'Bathroom', 9800, 0, 1200, 3400, 'tile', [
    { id: 'w_ba', type: 'window', wall: E, offset: 1200, width: 700, height: 700, sill: 1500 },
  ]),
], [
  // every room shares its north edge (y=3400) with the hall
  { id: 'c_h_living', a: 'r_hall', b: 'r_living', type: 'opening', offset: 1500, width: 1200 },
  { id: 'c_h_bed1', a: 'r_hall', b: 'r_bed1', offset: 1000, width: 900 },
  { id: 'c_h_bed2', a: 'r_hall', b: 'r_bed2', offset: 750, width: 900 },
  { id: 'c_h_bath', a: 'r_hall', b: 'r_bath', offset: 200, width: 800 },
], { blurb: 'Two bedrooms, bathroom and living/kitchen off a full-width hall — 50.6 m².' });

export const PRESETS = [singleRoom, studio, oneBed, twoBed];

export function presetById(id) {
  const p = PRESETS.find(x => x.id === id);
  if (!p) return null;
  return typeof structuredClone === 'function' ? structuredClone(p) : JSON.parse(JSON.stringify(p));
}

export default PRESETS;

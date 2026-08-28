// packages/layout-engine/augment.js
// mode:"augment" — the AI may add a small number of sensible common pieces to
// fix genuine gaps (never to fill space). Pure, dependency-free, DOM-free.

import { makeRng, frontAxis, distToBoundary, obbGap, clamp } from './geom.js';
import {
  RULES, buildRoom, expand, catGet, isSofa, isBed, isSeating, isDiningTable,
} from './rules.js';
import { frontLegOverlap } from './rules.js';

const MAX_ADDITIONS = 4;

/** Smallest catalog item of an archetype that still fits `limit` (w,d) in mm. */
function pickByArchetype(catalog, archetypes, fit) {
  const items = [];
  const push = (it) => { if (it && archetypes.indexOf(it.archetype) >= 0) items.push(it); };
  if (typeof catalog.forEach === 'function' && typeof catalog.get === 'function') {
    catalog.forEach((v) => push(v));
  } else {
    for (const k of Object.keys(catalog)) push(catalog[k]);
  }
  const ok = items.filter((it) => !fit
    || (it.dims_mm.w <= fit[0] && it.dims_mm.d <= fit[1]));
  ok.sort((a, b) => {
    const ai = archetypes.indexOf(a.archetype), bi = archetypes.indexOf(b.archetype);
    if (ai !== bi) return ai - bi;
    // prefer the largest that fits (a rug should be generous), then id for stability
    const av = a.dims_mm.w * a.dims_mm.d, bv = b.dims_mm.w * b.dims_mm.d;
    if (av !== bv) return bv - av;
    return a.id < b.id ? -1 : 1;
  });
  return ok[0] || null;
}

/**
 * suggestAdditions({room, layout, catalog, style, seed}) => [{item_id, reason}]
 * Each suggestion answers a real deficiency found in the current layout.
 */
export function suggestAdditions({ room, layout, catalog, style, seed }) {
  const rm = room && room.walls ? room : buildRoom(room);
  const rng = makeRng((seed || 0) + 0x5f3a);
  const ents = expand(rm, layout, catalog);
  const has = (pred) => ents.some(pred);
  const out = [];
  const add = (archetypes, reason, fit) => {
    if (out.length >= MAX_ADDITIONS) return;
    const it = pickByArchetype(catalog, archetypes, fit);
    if (it && !out.some((o) => o.item_id === it.id)) out.push({ item_id: it.id, reason });
  };

  const sofas = ents.filter((e) => isSofa(e.arche));
  const beds = ents.filter((e) => isBed(e.arche));
  const rugs = ents.filter((e) => e.arche === 'rug');
  const seating = ents.filter((e) => isSeating(e.arche));
  const bb = rm.bbox;

  // 1. seating group with no rug under it, or a rug that misses the front legs
  if (sofas.length) {
    const ok = rugs.some((r) => sofas.some((s) => frontLegOverlap(s.box, r.box) >= RULES.RUG_SOFA_OVERLAP_MM));
    if (!ok) {
      const limit = [Math.max(1400, bb.w - 900), Math.max(1000, bb.h - 900)];
      add(['rug'], rugs.length
        ? 'The existing rug does not reach the sofa front legs; a larger one ties the group together.'
        : 'The seating group has no rug to define it \u2014 one that runs 200mm+ under the sofa front legs anchors the zone.',
      limit);
    }
  }

  // 2. no floor-level lighting anywhere (ceiling fixture alone is flat)
  const lamps = ents.filter((e) => ['floor_lamp', 'table_lamp'].indexOf(e.arche) >= 0);
  if (!lamps.length && (sofas.length || beds.length)) {
    add(['floor_lamp'], 'No lamp at seated height \u2014 a floor lamp beside the main seat gives a second, warmer light layer.', [700, 700]);
  }

  // 3. sofa with nothing within arm's reach to put a drink on
  if (sofas.length) {
    const reachable = ents.some((e) => ['side_table', 'coffee_table'].indexOf(e.arche) >= 0
      && sofas.some((s) => obbGap(s.box, e.box) < 700));
    if (!reachable) {
      add(['side_table'], 'Nothing within arm\u2019s reach of the sofa \u2014 a side table gives the seat somewhere to set a cup.', [700, 700]);
    }
  }

  // 4. a long blank wall run with nothing on it above furniture height
  const wallDecor = ents.filter((e) => ['art_frame', 'mirror'].indexOf(e.arche) >= 0);
  if (!wallDecor.length) {
    const blank = rm.walls.slice().sort((a, b) => b.len - a.len)[0];
    if (blank && blank.len >= 2400) {
      add(['art_frame', 'mirror'], `The ${Math.round(blank.len)}mm wall reads blank above furniture height \u2014 framed art gives the elevation a focal point.`);
    }
  }

  // 5. corner with no soft mass (only when there is genuinely spare floor)
  const coverage = rm.area ? ents.filter((e) => e.collider).reduce((s, e) => s + e.area, 0) / rm.area : 1;
  if (coverage < 0.34 && !has((e) => e.arche === 'plant')) {
    add(['plant'], 'A slack corner and light coverage \u2014 a plant softens it without eating a walkway.', [900, 900]);
  }

  // style nudges, still gap-driven not space-filling
  if (style === 'cozy' && out.length < MAX_ADDITIONS && !lamps.length) {
    add(['table_lamp'], 'Cozy brief: a second low light source at seated height.', [500, 500]);
  }
  if (style === 'wfh' && out.length < MAX_ADDITIONS && !has((e) => e.arche === 'floor_lamp')) {
    add(['floor_lamp'], 'Work-from-home brief: directional light near the desk to cut screen glare.', [700, 700]);
  }
  return out.slice(0, MAX_ADDITIONS);
}

// packages/layout-engine/index.js
// Public API per SPEC §5.1. Pure, deterministic, dependency-free, DOM-free.
//
//   solveLayouts({room, items, catalog, mode, style, seed, count}) => Layout[]
//   scoreLayout({room, layout, catalog})   => {score, metrics, violations}
//   validatePlacement({room, layout, catalog, instance_id}) => Violation[]
//   suggestAdditions({room, layout, catalog, style, seed}) => [{item_id, reason}]

import { makeRng } from './geom.js';
import { buildRoom, catGet, RULES, VIOLATION_CODES } from './rules.js';
import { solveOne, analyseRoom, STRATEGIES, wallName } from './solver.js';
import { scoreLayout, validatePlacement } from './scoring.js';
import { suggestAdditions } from './augment.js';

export { scoreLayout, validatePlacement, suggestAdditions };
export { RULES, VIOLATION_CODES, buildRoom } from './rules.js';
export { STRATEGIES } from './solver.js';

function expandItems(items, catalog, startIndex = 1) {
  const out = [];
  let n = startIndex;
  for (const req of items || []) {
    const item = catGet(catalog, req.item_id);
    if (!item) continue;
    const qty = Math.max(1, req.qty || 1);
    for (let k = 0; k < qty; k++) {
      out.push({
        instance_id: req.instance_id && qty === 1 ? req.instance_id : `i${n}`,
        item_id: req.item_id,
        item,
        qty_index: k,
        locked_placement: k === 0 ? (req.locked_placement || null) : null,
        added_by_ai: !!req.added_by_ai,
      });
      n++;
    }
  }
  return out;
}

export function solveLayouts({
  room, items, catalog, mode = 'use-mine', style = 'neutral', seed = 1, count = 3,
}) {
  const rm = buildRoom(room);
  const analysis = analyseRoom(rm);
  const base = makeRng(seed);
  // strategy order itself depends on the seed, so seed+1 re-rolls the *approach*
  // not just the jitter (§5.1 deterministic re-roll).
  const order = base.shuffle(STRATEGIES);
  const baseInstances = expandItems(items, catalog);

  // Candidate generation is best-of-K *per strategy*.
  //
  // Previously this drew exactly `count` samples as (order[c], seed + c*7919),
  // so `count` controlled how deeply we searched rather than how many results we
  // returned. On a real 4.6x3.8m brief that meant count:3 returned three layouts
  // that all wall-mounted the TV across the window (every one scoring ~0.25 with
  // an error), while asking for count:6 surfaced a clean 0.706 layout — the good
  // arrangement existed, we simply never sampled it. A user asking for three
  // options must not get three broken ones because the search was too shallow.
  //
  // So: give every strategy up to MAX_ATTEMPTS re-seeded tries, stop as soon as a
  // strategy yields a clean layout (no errors, nothing unplaced), keep that
  // strategy's best, then return the top `count`. This keeps one candidate per
  // strategy — so re-rolls stay strategically distinct — while no longer letting a
  // single unlucky seed decide the answer. Fully deterministic for a given seed.
  const MAX_ATTEMPTS = 3;
  const isClean = (l) => (l.metrics.errors || 0) === 0 && (l.metrics.unplaced || 0) === 0;

  const buildCandidate = (strategy, candSeed) => {
    let instances = baseInstances;

    // --- augment pass: fix genuine gaps with a few common pieces -----------
    let additions = [];
    if (mode === 'augment') {
      const dry = solveOne({ rm, instances, style, seed: candSeed, strategy, analysis });
      additions = suggestAdditions({
        room: rm,
        layout: { placements: dry.placements },
        catalog, style, seed: candSeed,
      });
      if (additions.length) {
        const extra = expandItems(
          additions.map((a) => ({ item_id: a.item_id, qty: 1, added_by_ai: true })),
          catalog, baseInstances.length + 1,
        );
        instances = baseInstances.concat(extra);
      }
    }

    const res = solveOne({ rm, instances, style, seed: candSeed, strategy, analysis });
    const layout = {
      id: 'layout_pending',   // final ids assigned after sorting, below
      seed: candSeed,
      mode, style,
      score: 0,
      placements: res.placements,
      rationale: res.rationale.slice(),
      violations: [],
      metrics: {},
    };
    layout.__functional = res.functional;
    const scored = scoreLayout({ room: rm, layout, catalog });
    layout.score = scored.score;
    layout.metrics = scored.metrics;
    layout.violations = scored.violations.concat(res.extraViolations);

    // `scoreLayout` only sees violations it can derive from the placements it was
    // given, so it already applied RULES.ERROR_SCORE_FACTOR to those. Errors
    // reported by the solver itself (chiefly OUT_OF_BOUNDS for a piece it refused
    // to shrink or overlap) arrive here in `extraViolations` and were previously
    // charged a token 0.02 each. That let an incomplete layout win: dropping an
    // awkward piece removes its clearance conflicts and frees floor area, so the
    // raw score rose by far more than 0.02. Apply the same multiplicative
    // dominance to these so a layout that fails to place the user's furniture can
    // never out-rank one that fits it all.
    const extraErrs = res.extraViolations.filter((v) => v.severity === 'error').length;
    if (extraErrs) {
      layout.score = Math.round(
        layout.score * Math.pow(RULES.ERROR_SCORE_FACTOR, extraErrs) * 1000,
      ) / 1000;
    }

    // completeness is a first-class, reportable metric (§4.5 metrics)
    const requested = baseInstances.length;
    const placedRequested = res.placements.filter((p) => !p.added_by_ai).length;
    layout.metrics.requested = requested;
    layout.metrics.placed = placedRequested;
    layout.metrics.unplaced = Math.max(0, requested - placedRequested);

    // strategy + measurement sentences, so the rationale is never generic
    layout.rationale.unshift(`Strategy: ${strategy.id} \u2014 ${strategy.label}.`);
    layout.rationale.push(
      `Tightest measured route is ${layout.metrics.walkway_min_mm}mm `
      + `(${layout.metrics.walkway_min_mm >= RULES.WALKWAY_PRIMARY_MM ? 'clears the 900mm primary standard'
        : layout.metrics.walkway_min_mm >= RULES.WALKWAY_SECONDARY_MM ? 'meets the 760mm secondary standard'
          : layout.metrics.walkway_min_mm >= RULES.WALKWAY_ABS_MIN_MM ? 'above the 600mm hard floor but tight'
            : 'below the 600mm hard floor'}), `
      + `floor coverage ${Math.round(layout.metrics.coverage * 100)}%, balance ${layout.metrics.balance}.`,
    );
    if (additions.length) {
      layout.rationale.push(
        `AI added ${additions.length} piece${additions.length > 1 ? 's' : ''}: `
        + additions.map((a) => a.reason).join(' '),
      );
    }
    const focalW = rm.walls[analysis.focalWall];
    if (focalW) {
      layout.rationale.push(
        `Focal wall read as the ${wallName(focalW)} wall `
        + `(${Math.round(analysis.walls[analysis.focalWall].longestFree)}mm uninterrupted`
        + `${analysis.mainWindow ? `, opposite the ${analysis.mainWindow.width_mm}mm window` : ''}).`,
      );
    }
    delete layout.__functional;
    layout.__strategy = strategy.id;
    return layout;
  };

  const want = Math.max(1, count);
  const layouts = [];

  // one entry per strategy, each the best of up to MAX_ATTEMPTS seeded attempts
  for (let s = 0; s < order.length; s++) {
    const strategy = order[s];
    let bestForStrategy = null;
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      const candSeed = (seed + s * 7919 + k * 104729) >>> 0;
      const cand = buildCandidate(strategy, candSeed);
      if (!bestForStrategy || cand.score > bestForStrategy.score) bestForStrategy = cand;
      if (isClean(cand)) break;          // good enough; don't burn cycles
    }
    if (bestForStrategy) layouts.push(bestForStrategy);
  }

  // asked for more candidates than we have strategies: top up by cycling
  // strategies with fresh seeds
  for (let c = order.length; layouts.length < want; c++) {
    const strategy = order[c % order.length];
    const candSeed = (seed + 7919 * (c + 41) + 13) >>> 0;
    layouts.push(buildCandidate(strategy, candSeed));
    if (c > order.length + want + 8) break;   // safety valve
  }

  layouts.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  const outp = layouts.slice(0, want);
  outp.forEach((l, i) => { l.id = `layout_${i + 1}`; });
  return outp;
}

export default { solveLayouts, scoreLayout, validatePlacement, suggestAdditions };

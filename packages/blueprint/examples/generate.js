// packages/blueprint/examples/generate.js
// node examples/generate.js [outDir]   — writes three sample sheets.
import { solveLayouts } from '../../layout-engine/index.js';
import { renderBlueprint, renderSchedule } from '../index.js';
import * as F from '../../layout-engine/tests/fixtures.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.argv[2] || '.';
mkdirSync(out, { recursive: true });

const CASES = [
  ['living', F.LIVING, F.LIVING_ITEMS, 'A3', 'Living room 4.2 × 3.6m', 'augment'],
  ['bedroom', F.BEDROOM, F.BEDROOM_ITEMS, 'A4', 'Bedroom 3.0 × 3.4m', 'use-mine'],
  ['studio', F.STUDIO, F.STUDIO_ITEMS, 'A3', 'Studio 5.5 × 3.2m', 'use-mine'],
];

for (const [name, room, items, paper, title, mode] of CASES) {
  const t = Date.now();
  const layouts = solveLayouts({
    room, items, catalog: F.CATALOG, mode, style: 'neutral', seed: 84213, count: 3,
  });
  const l = layouts[0];
  const svg = renderBlueprint({
    room, layout: l, catalog: F.CATALOG,
    opts: {
      paper, unit: 'mm', scale: 'fit', title, project: 'ainterior demo',
      author: 'ainterior layout engine v1', date: '2026-08-28', sheet: `A-10${CASES.indexOf(CASES.find((c) => c[0] === name)) + 1}`,
      show: { dimensions: true, names: true, schedule: true, northArrow: true, scaleBar: true, titleBlock: true, clearances: false },
    },
  });
  writeFileSync(`${out}/${name}.svg`, svg);
  const s = renderSchedule({ layout: l, catalog: F.CATALOG });
  console.log(`${name.padEnd(8)} ${paper}  ${Date.now() - t}ms  strategy=${l.__strategy}  score=${l.score}  `
    + `walkway=${l.metrics.walkway_min_mm}mm  pieces=${l.placements.length}  `
    + `sched=${s.rows.length} lines / $${s.total}  viol=${l.violations.map((v) => v.code).join(',') || 'none'}`);
}

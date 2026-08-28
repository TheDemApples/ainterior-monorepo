// packages/blueprint/index.js
// renderBlueprint / renderSchedule per SPEC §5.2.
// Standalone SVG, no external refs, system font stack, print-clean B/W.
// Dependency-free, DOM-free.

import { buildRoom } from '../layout-engine/rules.js';
import { makeRegistry, text, esc, n } from './dimensions.js';
import { dimChain } from './dimensions.js';
import { renderSchedule, assignTags, catGet } from './schedule.js';
import {
  PAPER, WALL_T, makeTransform, defs, wallBand, openings as drawOpenings,
  features as drawFeatures, furniture, northArrow, scaleBar, legend,
  scheduleTable, titleBlock, metricsStrip, fmtLen, unitSuffix,
} from './svg.js';

export { renderSchedule, assignTags } from './schedule.js';

const DEFAULT_SHOW = {
  dimensions: true, names: true, schedule: true, northArrow: true,
  scaleBar: true, titleBlock: true, clearances: false,
};

/** Wall dimension chain stations: 0, every opening edge, wall length. */
function wallStations(w) {
  const t = [0];
  for (const o of w.openings.slice().sort((a, b) => a.t0 - b.t0)) {
    t.push(Math.max(0, o.t0)); t.push(Math.min(w.len, o.t1));
  }
  t.push(w.len);
  const uniq = [];
  for (const v of t.sort((a, b) => a - b)) {
    if (!uniq.length || v - uniq[uniq.length - 1] > 1) uniq.push(v);
  }
  return uniq;
}

export function renderBlueprint({ room, layout, catalog, opts = {} }) {
  const show = { ...DEFAULT_SHOW, ...(opts.show || {}) };
  const unit = opts.unit || 'mm';
  const paperKey = PAPER[opts.paper] ? opts.paper : 'A3';
  const paper = PAPER[paperKey];
  const rm = room && room.walls ? room : buildRoom(room);
  const tags = assignTags(layout, catalog);
  const sched = renderSchedule({ layout, catalog });

  const M = 8;                       // sheet margin
  const colW = Math.round(paper.w * (paperKey === 'A4' ? 0.36 : 0.33));
  const headerH = 11;
  const planRect = {
    x0: M, y0: M + headerH,
    x1: paper.w - M - colW - 6,
    y1: paper.h - M - 16,
  };
  const gutter = 19;                 // room for the dimension chains
  const roomW = rm.bbox.w + WALL_T * 2, roomH = rm.bbox.h + WALL_T * 2;
  const availW = (planRect.x1 - planRect.x0) - gutter * 2;
  const availH = (planRect.y1 - planRect.y0) - gutter * 2;
  let k;
  if (typeof opts.scale === 'number' && opts.scale > 0) k = 1 / opts.scale;
  else k = Math.min(availW / roomW, availH / roomH);
  const drawnW = rm.bbox.w * k, drawnH = rm.bbox.h * k;
  const ox = planRect.x0 + ((planRect.x1 - planRect.x0) - drawnW) / 2;
  const oy = planRect.y0 + ((planRect.y1 - planRect.y0) - drawnH) / 2;
  const T = makeTransform(rm.bbox, k, ox, oy);
  const reg = makeRegistry();
  const colX = paper.w - M - colW;
  const northAt = [planRect.x1 - 6, planRect.y0 + 13];
  // sheet furniture claims its space up front, so plan labels and dimension
  // text can never land on top of the header, schedule column or scale bar.
  reg.add({ x0: 0, y0: 0, x1: paper.w, y1: M + headerH - 0.5 });
  reg.add({ x0: colX - 4.5, y0: 0, x1: paper.w, y1: paper.h });
  reg.add({ x0: 0, y0: paper.h - M - 13, x1: colX - 4.5, y1: paper.h });
  reg.add({ x0: northAt[0] - 6.5, y0: northAt[1] - 8, x1: northAt[0] + 6.5, y1: northAt[1] + 6.5 });

  const body = [];
  body.push(`<rect x="0" y="0" width="${n(paper.w)}" height="${n(paper.h)}" fill="#fff"/>`);
  body.push(`<rect x="${n(M / 2)}" y="${n(M / 2)}" width="${n(paper.w - M)}" height="${n(paper.h - M)}" fill="none" stroke="#000" stroke-width="0.4"/>`);
  body.push(defs());

  // ---- header ------------------------------------------------------------
  const title = opts.title || `${rm.raw.name || 'Room'} \u2014 furniture plan`;
  body.push(text(M + 1.5, M + 5.4, 'AINTERIOR \u00b7 ANNOTATED FURNITURE PLAN', { size: 1.7, anchor: 'start', mono: true, spacing: 0.22 }));
  body.push(text(M + 1.5, M + 10.4, title, { size: 4.0, anchor: 'start', weight: 'bold', spacing: -0.05 }));
  const rDims = `${fmtLen(rm.bbox.w, unit)} \u00d7 ${fmtLen(rm.bbox.h, unit)}${unitSuffix(unit)}  \u00b7  ceiling ${fmtLen(rm.height_mm, unit)}${unitSuffix(unit)}  \u00b7  ${(rm.area / 1e6).toFixed(2)}m\u00b2`;
  body.push(text(planRect.x1, M + 10.4, rDims, { size: 2.0, anchor: 'end', mono: true }));

  // ---- plan --------------------------------------------------------------
  body.push(wallBand(rm, T));
  body.push(drawFeatures(rm, T));
  body.push(drawOpenings(rm, T));

  // door aprons (dashed) so the reader can see the rule being honoured
  for (const d of rm.doors) {
    const w = d.wall, ap = 900;
    const pts = [
      d.p0, d.p1,
      [d.p1[0] + w.normal[0] * ap, d.p1[1] + w.normal[1] * ap],
      [d.p0[0] + w.normal[0] * ap, d.p0[1] + w.normal[1] * ap],
    ].map((p) => T.P(p[0], p[1]));
    body.push(`<polygon points="${pts.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" fill="none" stroke="#000" stroke-width="0.1" stroke-dasharray="1.4,1.2"/>`);
  }

  // reserve the plan's own footprint rects so labels avoid dimension chains
  body.push(furniture(rm, layout, catalog, tags, T, reg, { show, planRect, labelSize: paperKey === 'A4' ? 1.8 : 2.0 }));

  // ---- dimension chains --------------------------------------------------
  if (show.dimensions) {
    const fmt = (mm) => `${fmtLen(mm, unit)}`;
    // per-wall chains, offset outside the wall band
    for (const w of rm.walls) {
      const A = T.P(w.a[0], w.a[1]), B = T.P(w.b[0], w.b[1]);
      const outN = [-w.normal[0], w.normal[1]]; // paper y is flipped
      const st = wallStations(w);
      if (st.length < 2) continue;
      body.push(dimChain({
        A, B, ticksMm: st, lenMm: w.len, outN,
        off: WALL_T * k + 5.5, reg, size: paperKey === 'A4' ? 1.5 : 1.7, unitFmt: fmt,
      }));
    }
    // overall dimensions, further out on the south and west edges
    const bb = rm.bbox;
    const sw = T.P(bb.x0, bb.y0), se = T.P(bb.x1, bb.y0), nw = T.P(bb.x0, bb.y1);
    body.push(dimChain({
      A: sw, B: se, ticksMm: [0, bb.w], lenMm: bb.w, outN: [0, 1],
      off: WALL_T * k + 13.5, reg, size: paperKey === 'A4' ? 1.7 : 1.9, unitFmt: fmt,
    }));
    body.push(dimChain({
      A: sw, B: nw, ticksMm: [0, bb.h], lenMm: bb.h, outN: [-1, 0],
      off: WALL_T * k + 13.5, reg, size: paperKey === 'A4' ? 1.7 : 1.9, unitFmt: fmt,
    }));
  }

  // ---- north arrow + scale bar ------------------------------------------
  if (show.northArrow) body.push(northArrow(northAt[0], northAt[1], 9));
  if (show.scaleBar) body.push(scaleBar(M + 2, paper.h - M - 8, k, unit));
  body.push(text(planRect.x1, paper.h - M - 4.5, `${rm.raw.source || 'manual'} survey \u00b7 confidence ${(rm.raw.confidence != null ? rm.raw.confidence : 1).toFixed(2)}`, { size: 1.5, anchor: 'end', mono: true }));

  // ---- right column ------------------------------------------------------
  const cx = colX;
  let cy = M + headerH + 2;
  body.push(`<line x1="${n(cx - 3)}" y1="${n(M + 2)}" x2="${n(cx - 3)}" y2="${n(paper.h - M - 2)}" stroke="#000" stroke-width="0.2"/>`);
  body.push(metricsStrip(cx, cy, colW, layout, unit));
  cy += 8;
  if (show.schedule) {
    const tbl = scheduleTable(cx, cy, colW, sched, unit, {
      size: paperKey === 'A4' ? 1.6 : 1.75,
      lineHeight: paperKey === 'A4' ? 3.1 : 3.5,
    });
    body.push(tbl.svg);
    cy += tbl.height + 3;
  }
  const lg = legend(cx, cy, colW, opts);
  body.push(lg.svg);
  cy += lg.height + 2;

  // rationale, if it fits above the title block
  const tbH = 26;
  const tbY = paper.h - M - tbH - 1;
  if (layout.rationale && layout.rationale.length && cy < tbY - 14) {
    body.push(text(cx, cy, 'DESIGN NOTES', { size: 2.0, anchor: 'start', mono: true, weight: 'bold', spacing: 0.16 }));
    let ry = cy + 3.4;
    const maxChars = Math.floor(colW / 0.92);
    for (const line of layout.rationale) {
      if (ry > tbY - 3) break;
      let rest = String(line);
      while (rest.length && ry <= tbY - 3) {
        let cut = rest.length <= maxChars ? rest.length : rest.lastIndexOf(' ', maxChars);
        if (cut <= 0) cut = Math.min(maxChars, rest.length);
        body.push(text(cx, ry, rest.slice(0, cut), { size: 1.6, anchor: 'start' }));
        rest = rest.slice(cut).trim();
        ry += 2.5;
      }
      ry += 0.6;
    }
  }
  if (show.titleBlock) {
    body.push(titleBlock(cx, tbY, colW, tbH, {
      title: opts.title || rm.raw.name || 'FURNITURE PLAN',
      project: opts.project || 'ainterior',
      author: opts.author || 'ainterior layout engine',
      date: opts.date || new Date().toISOString().slice(0, 10),
      scale: `1:${Math.round(1 / k)} @ ${paperKey}`,
      sheet: opts.sheet || 'A-101',
    }));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `
    + `width="${n(paper.w)}mm" height="${n(paper.h)}mm" `
    + `viewBox="0 0 ${n(paper.w)} ${n(paper.h)}">\n`
    + `<title>${esc(title)}</title>\n`
    + body.join('\n')
    + `\n</svg>\n`;
}

export default { renderBlueprint, renderSchedule, assignTags };

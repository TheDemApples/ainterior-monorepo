// packages/blueprint/svg.js
// Drawing primitives for the annotated plan. Pure black/white, print-clean.
// Paper units are millimetres; the SVG viewBox is the paper sheet.
// Dependency-free, DOM-free.

import {
  dimChain, makeRegistry, text, textRect, textWidth, esc, n, leader,
  FONT_SANS, FONT_MONO,
} from './dimensions.js';
import { catGet } from './schedule.js';

export const PAPER = {
  A3: { w: 420, h: 297 }, A4: { w: 297, h: 210 }, Letter: { w: 279.4, h: 215.9 },
};

export const WALL_T = 100; // mm, drawn wall thickness

export function fmtLen(mm, unit) {
  if (unit === 'cm') return `${Math.round(mm / 10)}`;
  if (unit === 'ft') {
    const inch = mm / 25.4;
    let ft = Math.floor(inch / 12);
    let i = Math.round((inch - ft * 12) * 2) / 2;
    if (i >= 12) { ft += 1; i -= 12; }
    return `${ft}'-${i}"`;
  }
  return `${Math.round(mm)}`;
}
export const unitSuffix = (u) => (u === 'cm' ? 'cm' : u === 'ft' ? '' : 'mm');

// ---- transform -----------------------------------------------------------
export function makeTransform(bbox, k, ox, oy) {
  return {
    k, ox, oy, bbox,
    X(x) { return ox + (x - bbox.x0) * k; },
    Y(y) { return oy + (bbox.y1 - y) * k; },
    P(x, y) { return [this.X(x), this.Y(y)]; },
  };
}

// ---- polygon offset (outward for a CCW polygon) --------------------------
function lineIsect(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

export function offsetPolygon(poly, t) {
  const N = poly.length, out = [];
  for (let i = 0; i < N; i++) {
    const p0 = poly[(i - 1 + N) % N], p1 = poly[i], p2 = poly[(i + 1) % N];
    const seg = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const d = [dx / L, dy / L];
      const o = [dy / L, -dx / L]; // CCW polygon => outward is to the right of travel
      return { d, a: [a[0] + o[0] * t, a[1] + o[1] * t] };
    };
    const s0 = seg(p0, p1), s1 = seg(p1, p2);
    const ip = lineIsect(s0.a, s0.d, s1.a, s1.d);
    out.push(ip || [p1[0] + s1.d[1] * t, p1[1] - s1.d[0] * t]);
  }
  return out;
}

const pathOf = (pts, T) => pts.map((p, i) => `${i ? 'L' : 'M'}${n(T.X(p[0]))},${n(T.Y(p[1]))}`).join('') + 'Z';

export function defs() {
  return `<defs>
<pattern id="hatch" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<line x1="0" y1="0" x2="0" y2="1.5" stroke="#000" stroke-width="0.14"/>
</pattern>
<pattern id="hatch-lite" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<line x1="0" y1="0" x2="0" y2="2.4" stroke="#000" stroke-width="0.09"/>
</pattern>
</defs>`;
}

// ---- walls ---------------------------------------------------------------
export function wallBand(rm, T) {
  const outer = offsetPolygon(rm.poly, WALL_T);
  const inner = rm.poly;
  const d = `${pathOf(outer, T)} ${pathOf(inner.slice().reverse(), T)}`;
  return `<path d="${d}" fill="url(#hatch)" fill-rule="evenodd" stroke="none"/>`
    + `<path d="${pathOf(outer, T)}" fill="none" stroke="#000" stroke-width="0.32"/>`
    + `<path d="${pathOf(inner, T)}" fill="none" stroke="#000" stroke-width="0.32"/>`;
}

/** Punch openings through the band and draw door/window symbols. */
export function openings(rm, T) {
  const out = [];
  for (const o of rm.openings) {
    const w = o.wall;
    const outward = [-w.normal[0], -w.normal[1]];
    const i0 = o.p0, i1 = o.p1;
    const o0 = [i0[0] + outward[0] * WALL_T, i0[1] + outward[1] * WALL_T];
    const o1 = [i1[0] + outward[0] * WALL_T, i1[1] + outward[1] * WALL_T];
    const quad = [i0, i1, o1, o0].map((p) => T.P(p[0], p[1]));
    out.push(`<polygon points="${quad.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" fill="#fff" stroke="none"/>`);
    // jambs
    for (const [a, b] of [[i0, o0], [i1, o1]]) {
      const A = T.P(a[0], a[1]), B = T.P(b[0], b[1]);
      out.push(`<line x1="${n(A[0])}" y1="${n(A[1])}" x2="${n(B[0])}" y2="${n(B[1])}" stroke="#000" stroke-width="0.3"/>`);
    }
    if (o.type === 'door') {
      const swing = o.swing || 'in-left';
      const inward = swing.indexOf('out') === 0 ? -1 : 1;
      const rightHung = swing.indexOf('right') >= 0;
      const H = rightHung ? i1 : i0;
      const J = rightHung ? i0 : i1;
      const nrm = [w.normal[0] * inward, w.normal[1] * inward];
      const tip = [H[0] + nrm[0] * o.width_mm, H[1] + nrm[1] * o.width_mm];
      const Hp = T.P(H[0], H[1]), Tp = T.P(tip[0], tip[1]), Jp = T.P(J[0], J[1]);
      // leaf, drawn as a thin panel
      const lt = 1.0;
      const perp = [-(Tp[1] - Hp[1]), Tp[0] - Hp[0]];
      const pl = Math.hypot(perp[0], perp[1]) || 1;
      const pn = [perp[0] / pl * lt / 2, perp[1] / pl * lt / 2];
      out.push(`<polygon points="${n(Hp[0] + pn[0])},${n(Hp[1] + pn[1])} ${n(Tp[0] + pn[0])},${n(Tp[1] + pn[1])} ${n(Tp[0] - pn[0])},${n(Tp[1] - pn[1])} ${n(Hp[0] - pn[0])},${n(Hp[1] - pn[1])}" fill="#fff" stroke="#000" stroke-width="0.22"/>`);
      // swing arc, tip -> far jamb about the hinge
      const R = Math.hypot(Tp[0] - Hp[0], Tp[1] - Hp[1]);
      const u = [Tp[0] - Hp[0], Tp[1] - Hp[1]], v = [Jp[0] - Hp[0], Jp[1] - Hp[1]];
      const cross = u[0] * v[1] - u[1] * v[0];
      const sweep = cross > 0 ? 1 : 0;
      out.push(`<path d="M${n(Tp[0])},${n(Tp[1])} A${n(R)},${n(R)} 0 0 ${sweep} ${n(Jp[0])},${n(Jp[1])}" fill="none" stroke="#000" stroke-width="0.14" stroke-dasharray="1.1,0.8"/>`);
    } else {
      // window: glass lines across the wall band + centre mullion
      for (const f of [0.18, 0.5, 0.82]) {
        const a = [i0[0] + outward[0] * WALL_T * f, i0[1] + outward[1] * WALL_T * f];
        const b = [i1[0] + outward[0] * WALL_T * f, i1[1] + outward[1] * WALL_T * f];
        const A = T.P(a[0], a[1]), B = T.P(b[0], b[1]);
        out.push(`<line x1="${n(A[0])}" y1="${n(A[1])}" x2="${n(B[0])}" y2="${n(B[1])}" stroke="#000" stroke-width="${f === 0.5 ? 0.26 : 0.14}"/>`);
      }
      const mid = [(i0[0] + i1[0]) / 2, (i0[1] + i1[1]) / 2];
      const mo = [mid[0] + outward[0] * WALL_T, mid[1] + outward[1] * WALL_T];
      const A = T.P(mid[0], mid[1]), B = T.P(mo[0], mo[1]);
      out.push(`<line x1="${n(A[0])}" y1="${n(A[1])}" x2="${n(B[0])}" y2="${n(B[1])}" stroke="#000" stroke-width="0.2"/>`);
    }
  }
  return out.join('');
}

export function features(rm, T) {
  const out = [];
  for (const f of rm.features) {
    const b = f.box;
    const c = obbPaper(b, T);
    out.push(`<polygon points="${c.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" fill="url(#hatch-lite)" stroke="#000" stroke-width="0.16"/>`);
    const ctr = T.P(b.cx, b.cy);
    out.push(text(ctr[0], ctr[1] + 0.5, f.type.toUpperCase().slice(0, 3), { size: 1.4, mono: true }));
  }
  return out.join('');
}

// ---- furniture -----------------------------------------------------------
export function obbPaper(box, T) {
  const a = box.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const hw = box.w / 2, hd = box.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => {
    const x = box.cx + u * ca - v * sa, y = box.cy + u * sa + v * ca;
    return T.P(x, y);
  });
}

function boxOf(p, item) {
  return { cx: p.x_mm, cy: p.y_mm, w: item.dims_mm.w, d: item.dims_mm.d, rot: p.rot_deg || 0 };
}

const MOUNTED = (item) => (item.placement || {}).wall_mounted || (item.placement || {}).ceiling_mounted;
const SOFT = (item) => item.archetype === 'rug' || item.category === 'rugs';

export function furniture(rm, layout, catalog, tags, T, reg, opts) {
  const shapes = [];
  const labels = [];
  const showNames = !opts.show || opts.show.names !== false;
  const size = opts.labelSize || 2.0;
  const plan = opts.planRect;

  // pass 1: footprints (so labels can sit on top of everything)
  const recs = [];
  for (const p of layout.placements) {
    const item = catGet(catalog, p.item_id);
    if (!item) continue;
    const box = boxOf(p, item);
    const c = obbPaper(box, T);
    const pts = c.map((q) => `${n(q[0])},${n(q[1])}`).join(' ');
    const dash = SOFT(item) ? ' stroke-dasharray="2,1.4"' : MOUNTED(item) ? ' stroke-dasharray="1,1"' : '';
    const sw = SOFT(item) ? 0.18 : MOUNTED(item) ? 0.18 : 0.26;
    if (item.footprint === 'round') {
      const ctr = T.P(box.cx, box.cy);
      shapes.push(`<circle cx="${n(ctr[0])}" cy="${n(ctr[1])}" r="${n(box.w / 2 * T.k)}" fill="#fff" stroke="#000" stroke-width="${sw}"${dash}/>`);
    } else {
      shapes.push(`<polygon points="${pts}" fill="${SOFT(item) ? 'none' : '#fff'}" stroke="#000" stroke-width="${sw}"${dash}/>`);
    }
    // orientation cue: thicken the back edge of seating and beds
    if (/sofa|bed_|loveseat|armchair|chaise|desk|bench/.test(item.archetype)) {
      shapes.push(`<line x1="${n(c[0][0])}" y1="${n(c[0][1])}" x2="${n(c[1][0])}" y2="${n(c[1][1])}" stroke="#000" stroke-width="0.62"/>`);
    }
    if (opts.show && opts.show.clearances && (item.clearance_mm || {}).front) {
      const cl = item.clearance_mm.front;
      const rad = box.rot * Math.PI / 180;
      const f = [-Math.sin(rad), Math.cos(rad)];
      const env = {
        cx: box.cx + f[0] * (box.d / 2 + cl / 2), cy: box.cy + f[1] * (box.d / 2 + cl / 2),
        w: box.w, d: cl, rot: box.rot,
      };
      shapes.push(`<polygon points="${obbPaper(env, T).map((q) => `${n(q[0])},${n(q[1])}`).join(' ')}" fill="none" stroke="#000" stroke-width="0.1" stroke-dasharray="0.8,0.8"/>`);
    }
    recs.push({ p, item, box, c });
  }

  // pass 2: labels — inside the footprint when it fits, otherwise leader-lined
  for (const r of recs) {
    const { p, item, box, c } = r;
    const tag = tags[p.instance_id] || '?';
    const name = showNames ? String(item.name) : '';
    const ctr = T.P(box.cx, box.cy);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of c) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    const availW = Math.min(x1 - x0, Math.max(box.w, box.d) * T.k) - 1.0;
    const availH = (y1 - y0) - 0.8;
    const tagW = textWidth(tag, size, true);
    const nameW = textWidth(name, size * 0.86, false);
    const bothH = name ? size * 2.05 : size * 1.1;
    const wide = Math.max(tagW, nameW);

    if (availW >= wide && availH >= bothH) {
      const ty = name ? ctr[1] - size * 0.24 : ctr[1] + size * 0.35;
      const rect = {
        x0: ctr[0] - wide / 2 - 0.3, y0: ty - size, x1: ctr[0] + wide / 2 + 0.3,
        y1: ty + (name ? size * 1.25 : size * 0.3),
      };
      if (reg.tryAdd(rect, 0.15)) {
        labels.push(text(ctr[0], ty, tag, { size, mono: true, weight: 'bold' }));
        if (name) labels.push(text(ctr[0], ty + size * 1.02, name, { size: size * 0.86 }));
        continue;
      }
    }
    // tag alone inside?
    if (availW >= tagW + 0.4 && availH >= size * 1.2) {
      const rect = textRect(ctr[0], ctr[1] + size * 0.34, tag, size, 'middle', true);
      if (reg.tryAdd(rect, 0.1)) {
        labels.push(text(ctr[0], ctr[1] + size * 0.34, tag, { size, mono: true, weight: 'bold' }));
        if (name) {
          const slot = findSlot(ctr, [x0, y0, x1, y1], name, size, reg, plan, true);
          if (slot) labels.push(leader([ (x0+x1)/2, (y0+y1)/2 ], slot, '', name, size, reg));
        }
        continue;
      }
    }
    const slot = findSlot(ctr, [x0, y0, x1, y1], `${tag} ${name}`, size, reg, plan, false);
    if (slot) {
      labels.push(leader(ctr, slot, tag, name, size, reg));
    } else {
      labels.push(text(ctr[0], ctr[1] + size * 0.3, tag, { size: size * 0.85, mono: true, weight: 'bold' }));
    }
  }
  return shapes.join('') + labels.join('');
}

/** Ring search for a free label slot outside a footprint, inside the plan area. */
function findSlot(ctr, aabb, label, size, reg, plan, nameOnly) {
  const w = textWidth(label, size, false) + 4.2;
  const h = size * 1.3;
  const radii = [3.4, 6.2, 9.4, 13, 17];
  const angles = [0, 180, 45, 135, 225, 315, 90, 270, 22, 202, 68, 248];
  const halfW = (aabb[2] - aabb[0]) / 2, halfH = (aabb[3] - aabb[1]) / 2;
  for (const R of radii) {
    for (const A of angles) {
      const a = A * Math.PI / 180;
      const x = ctr[0] + Math.cos(a) * (halfW + R);
      const y = ctr[1] + Math.sin(a) * (halfH + R);
      const dir = Math.cos(a) >= 0 ? 1 : -1;
      const rect = {
        x0: dir > 0 ? x - 2 : x - w + 2, y0: y - h / 2,
        x1: dir > 0 ? x + w - 2 : x + 2, y1: y + h / 2,
      };
      if (plan && (rect.x0 < plan.x0 || rect.x1 > plan.x1 || rect.y0 < plan.y0 || rect.y1 > plan.y1)) continue;
      if (reg.free(rect, 0.3)) { reg.add(rect); return [x, y]; }
    }
  }
  return null;
}

// ---- annotations ---------------------------------------------------------
export function northArrow(x, y, s = 9) {
  return `<g><polygon points="${n(x)},${n(y - s / 2)} ${n(x + s * 0.24)},${n(y + s / 2)} ${n(x)},${n(y + s * 0.22)} ${n(x - s * 0.24)},${n(y + s / 2)}" fill="#000" stroke="#000" stroke-width="0.15"/>`
    + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(s * 0.62)}" fill="none" stroke="#000" stroke-width="0.15"/>`
    + text(x, y - s * 0.72, 'N', { size: 2.4, mono: true, weight: 'bold' }) + '</g>';
}

export function scaleBar(x, y, k, unit) {
  // choose a round real-world length that draws ~30mm on paper
  const cands = [500, 1000, 2000, 5000];
  let real = cands[0];
  for (const c of cands) if (c * k <= 34) real = c;
  const L = real * k;
  const seg = L / 4;
  const out = [`<g>`];
  for (let i = 0; i < 4; i++) {
    out.push(`<rect x="${n(x + i * seg)}" y="${n(y)}" width="${n(seg)}" height="1.5" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.14"/>`);
  }
  out.push(text(x, y + 4.2, '0', { size: 1.7, mono: true }));
  out.push(text(x + L, y + 4.2, `${fmtLen(real, unit)}${unitSuffix(unit)}`, { size: 1.7, mono: true }));
  out.push(text(x + L / 2, y - 1.1, `SCALE 1:${Math.round(1 / k)}`, { size: 1.7, mono: true, spacing: 0.14 }));
  out.push('</g>');
  return out.join('');
}

export function legend(x, y, w, opts) {
  const rows = [
    ['hatch', 'Wall / structure'],
    ['arc', 'Door swing + 900mm apron'],
    ['glass', 'Window (sill noted)'],
    ['dash', 'Rug / soft goods (not a collider)'],
    ['dot', 'Wall or ceiling mounted'],
    ['tag', 'Tag: category letter + index'],
  ];
  const out = [`<g>`, text(x, y, 'LEGEND', { size: 2.1, anchor: 'start', mono: true, weight: 'bold', spacing: 0.16 })];
  let yy = y + 3.6;
  for (const [kind, label] of rows) {
    const bx = x, by = yy - 1.5;
    if (kind === 'hatch') out.push(`<rect x="${n(bx)}" y="${n(by)}" width="6" height="2.4" fill="url(#hatch)" stroke="#000" stroke-width="0.16"/>`);
    if (kind === 'arc') out.push(`<path d="M${n(bx)},${n(by + 2.4)} A6,6 0 0 1 ${n(bx + 6)},${n(by + 2.4)}" fill="none" stroke="#000" stroke-width="0.16" stroke-dasharray="1.1,0.8"/>`);
    if (kind === 'glass') out.push(`<rect x="${n(bx)}" y="${n(by + 0.4)}" width="6" height="1.6" fill="#fff" stroke="#000" stroke-width="0.16"/><line x1="${n(bx)}" y1="${n(by + 1.2)}" x2="${n(bx + 6)}" y2="${n(by + 1.2)}" stroke="#000" stroke-width="0.26"/>`);
    if (kind === 'dash') out.push(`<rect x="${n(bx)}" y="${n(by + 0.2)}" width="6" height="2" fill="none" stroke="#000" stroke-width="0.18" stroke-dasharray="2,1.4"/>`);
    if (kind === 'dot') out.push(`<rect x="${n(bx)}" y="${n(by + 0.2)}" width="6" height="2" fill="none" stroke="#000" stroke-width="0.18" stroke-dasharray="1,1"/>`);
    if (kind === 'tag') out.push(`<circle cx="${n(bx + 1.8)}" cy="${n(by + 1.2)}" r="1.6" fill="#fff" stroke="#000" stroke-width="0.2"/>` + text(bx + 1.8, by + 1.8, 'A1', { size: 1.5, mono: true, weight: 'bold' }));
    out.push(text(bx + 7.6, yy, label, { size: 1.8, anchor: 'start' }));
    yy += 4.0;
  }
  out.push('</g>');
  return { svg: out.join(''), height: yy - y };
}

export function scheduleTable(x, y, w, data, unit, opts = {}) {
  const rows = data.rows;
  const s = opts.size || 1.75;
  const lh = opts.lineHeight || 3.5;
  const cols = [
    { key: 'tag', label: 'TAG', frac: 0.10, anchor: 'start', mono: true },
    { key: 'qty', label: 'QTY', frac: 0.07, anchor: 'middle', mono: true },
    { key: 'desc', label: 'BRAND / ITEM', frac: 0.34, anchor: 'start' },
    { key: 'dims', label: 'W\u00d7D\u00d7H (mm)', frac: 0.21, anchor: 'start', mono: true },
    { key: 'sku', label: 'SKU', frac: 0.15, anchor: 'start', mono: true },
    { key: 'total', label: 'USD', frac: 0.13, anchor: 'end', mono: true },
  ];
  let acc = 0;
  for (const c of cols) { c.x = x + acc * w; acc += c.frac; c.w = c.frac * w; }
  const out = [`<g>`];
  out.push(text(x, y, 'FF&E SCHEDULE', { size: 2.1, anchor: 'start', mono: true, weight: 'bold', spacing: 0.16 }));
  let yy = y + 3.4;
  out.push(`<line x1="${n(x)}" y1="${n(yy - 2.4)}" x2="${n(x + w)}" y2="${n(yy - 2.4)}" stroke="#000" stroke-width="0.3"/>`);
  for (const c of cols) {
    const tx = c.anchor === 'end' ? c.x + c.w : c.anchor === 'middle' ? c.x + c.w / 2 : c.x;
    out.push(text(tx, yy, c.label, { size: s * 0.88, anchor: c.anchor, mono: true, spacing: 0.06 }));
  }
  yy += 1.2;
  out.push(`<line x1="${n(x)}" y1="${n(yy)}" x2="${n(x + w)}" y2="${n(yy)}" stroke="#000" stroke-width="0.22"/>`);
  yy += lh * 0.85;
  const clip = (str, colW, mono) => {
    let t2 = String(str);
    while (t2.length > 2 && textWidth(t2, s, mono) > colW - 0.8) t2 = t2.slice(0, -1);
    return t2.length < String(str).length ? `${t2.slice(0, -1)}\u2026` : t2;
  };
  for (const r of rows) {
    const vals = {
      tag: r.tag, qty: String(r.qty),
      desc: `${r.brand} ${r.name}${r.added_by_ai ? ' \u2020' : ''}`,
      dims: r.dims, sku: r.sku,
      total: r.total ? r.total.toFixed(0) : '\u2014',
    };
    for (const c of cols) {
      const tx = c.anchor === 'end' ? c.x + c.w : c.anchor === 'middle' ? c.x + c.w / 2 : c.x;
      out.push(text(tx, yy, clip(vals[c.key], c.w, c.mono), { size: s, anchor: c.anchor, mono: c.mono }));
    }
    yy += lh;
  }
  out.push(`<line x1="${n(x)}" y1="${n(yy - lh + 1.2)}" x2="${n(x + w)}" y2="${n(yy - lh + 1.2)}" stroke="#000" stroke-width="0.22"/>`);
  out.push(text(x, yy - lh + 4.4, `${rows.reduce((a, r) => a + r.qty, 0)} items \u00b7 ${rows.length} lines`, { size: s * 0.9, anchor: 'start' }));
  out.push(text(x + w, yy - lh + 4.4, `TOTAL  USD ${data.total.toFixed(0)}`, { size: s * 1.05, anchor: 'end', mono: true, weight: 'bold' }));
  if (rows.some((r) => r.added_by_ai)) {
    out.push(text(x, yy - lh + 7.6, '\u2020 added by ainterior layout AI', { size: s * 0.85, anchor: 'start' }));
  }
  out.push('</g>');
  return { svg: out.join(''), height: yy - lh + 9 - y };
}

export function titleBlock(x, y, w, h, meta) {
  const out = [`<g>`];
  out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="#000" stroke-width="0.34"/>`);
  const rowH = h / 3;
  out.push(`<line x1="${n(x)}" y1="${n(y + rowH)}" x2="${n(x + w)}" y2="${n(y + rowH)}" stroke="#000" stroke-width="0.18"/>`);
  out.push(`<line x1="${n(x)}" y1="${n(y + rowH * 2)}" x2="${n(x + w)}" y2="${n(y + rowH * 2)}" stroke="#000" stroke-width="0.18"/>`);
  out.push(`<line x1="${n(x + w * 0.62)}" y1="${n(y + rowH)}" x2="${n(x + w * 0.62)}" y2="${n(y + h)}" stroke="#000" stroke-width="0.18"/>`);
  out.push(text(x + 1.6, y + rowH * 0.62, meta.title || 'FLOOR PLAN', { size: 3.4, anchor: 'start', weight: 'bold', spacing: -0.04 }));
  out.push(text(x + w - 1.6, y + rowH * 0.62, meta.sheet || 'A-101', { size: 2.6, anchor: 'end', mono: true }));
  const cell = (cx, cy, label, val, anchor = 'start') => {
    out.push(text(cx, cy, label, { size: 1.4, anchor, mono: true, spacing: 0.14 }));
    out.push(text(cx, cy + 2.9, val || '\u2014', { size: 2.0, anchor }));
  };
  cell(x + 1.6, y + rowH + 2.6, 'PROJECT', meta.project);
  cell(x + w * 0.62 + 1.6, y + rowH + 2.6, 'SCALE', meta.scale);
  cell(x + 1.6, y + rowH * 2 + 2.6, 'DRAWN BY', meta.author);
  cell(x + w * 0.62 + 1.6, y + rowH * 2 + 2.6, 'DATE', meta.date);
  out.push('</g>');
  return out.join('');
}

export function metricsStrip(x, y, w, layout, unit) {
  const mt = layout.metrics || {};
  const bits = [
    ['WALKWAY MIN', `${fmtLen(mt.walkway_min_mm || 0, unit)}${unitSuffix(unit)}`],
    ['FLOOR COVERAGE', `${Math.round((mt.coverage || 0) * 100)}%`],
    ['BALANCE', String(mt.balance != null ? mt.balance : '\u2014')],
    ['SCORE', String(layout.score != null ? layout.score : '\u2014')],
  ];
  const out = [`<g>`];
  let xx = x;
  const cw = w / bits.length;
  for (const [k, v] of bits) {
    out.push(text(xx, y, k, { size: 1.4, anchor: 'start', mono: true, spacing: 0.14 }));
    out.push(text(xx, y + 3.1, v, { size: 2.2, anchor: 'start', mono: true }));
    xx += cw;
  }
  out.push('</g>');
  return out.join('');
}

export default {
  PAPER, WALL_T, makeTransform, defs, wallBand, openings, features, furniture,
  northArrow, scaleBar, legend, scheduleTable, titleBlock, metricsStrip, fmtLen,
};

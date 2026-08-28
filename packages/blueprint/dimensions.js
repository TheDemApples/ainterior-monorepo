// packages/blueprint/dimensions.js
// Dimension chains with witness/extension lines and arrowheads, plus the label
// collision registry used by the whole drawing. Paper units are millimetres.
// Dependency-free, DOM-free.

export const FONT_SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
export const FONT_MONO = "'DejaVu Sans Mono','Courier New',monospace";

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const n = (v) => (Math.round(v * 1000) / 1000).toString();

/** Approximate text width in paper mm. Conservative so labels never collide. */
export function textWidth(str, size, mono) {
  const k = mono ? 0.62 : 0.55;
  return String(str).length * size * k;
}

export function makeRegistry() {
  const rects = [];
  return {
    rects,
    free(r, pad = 0.35) {
      for (const q of rects) {
        if (r.x1 + pad < q.x0 || r.x0 - pad > q.x1 || r.y1 + pad < q.y0 || r.y0 - pad > q.y1) continue;
        return false;
      }
      return true;
    },
    add(r) { rects.push(r); return r; },
    tryAdd(r, pad) { if (this.free(r, pad)) { this.add(r); return true; } return false; },
  };
}

export function textRect(x, y, str, size, anchor = 'middle', mono = false) {
  const w = textWidth(str, size, mono);
  const h = size * 1.15;
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return { x0, y0: y - h * 0.82, x1: x0 + w, y1: y + h * 0.3 };
}

export function text(x, y, str, o = {}) {
  const size = o.size || 2;
  const parts = [
    `x="${n(x)}"`, `y="${n(y)}"`,
    `font-family="${o.mono ? FONT_MONO : FONT_SANS}"`,
    `font-size="${n(size)}"`,
    `text-anchor="${o.anchor || 'middle'}"`,
    'fill="#000"',
  ];
  if (o.weight) parts.push(`font-weight="${o.weight}"`);
  if (o.spacing) parts.push(`letter-spacing="${n(o.spacing)}"`);
  if (o.rotate) parts.push(`transform="rotate(${n(o.rotate)} ${n(x)} ${n(y)})"`);
  if (o.opacity) parts.push(`opacity="${o.opacity}"`);
  return `<text ${parts.join(' ')}>${esc(str)}</text>`;
}

function arrow(px, py, dx, dy, L = 1.5, W = 0.5) {
  // filled triangle, tip at (px,py), pointing along (dx,dy)
  const bx = px - dx * L, by = py - dy * L;
  const nx = -dy, ny = dx;
  return `<polygon points="${n(px)},${n(py)} ${n(bx + nx * W)},${n(by + ny * W)} ${n(bx - nx * W)},${n(by - ny * W)}" fill="#000"/>`;
}

/**
 * A dimension chain along the paper-space segment A -> B.
 *  A,B    : [x,y] paper mm (the measured feature itself)
 *  ticksMm: measurement stations in mm along the feature, ascending, first 0 last lenMm
 *  lenMm  : true length of the feature in mm
 *  outN   : unit normal in paper space pointing away from the drawing
 *  off    : offset of the dimension line from the feature, paper mm
 */
export function dimChain({ A, B, ticksMm, lenMm, outN, off, reg, size = 1.7, unitFmt }) {
  const out = [];
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const paperLen = Math.hypot(dx, dy) || 1;
  const ux = dx / paperLen, uy = dy / paperLen;
  const P = (mm) => [
    A[0] + ux * (mm / lenMm) * paperLen,
    A[1] + uy * (mm / lenMm) * paperLen,
  ];
  const O = (p) => [p[0] + outN[0] * off, p[1] + outN[1] * off];

  const ends = [P(ticksMm[0]), P(ticksMm[ticksMm.length - 1])].map(O);
  out.push(`<line x1="${n(ends[0][0])}" y1="${n(ends[0][1])}" x2="${n(ends[1][0])}" y2="${n(ends[1][1])}" stroke="#000" stroke-width="0.18"/>`);

  // witness / extension lines
  for (const mm of ticksMm) {
    const p = P(mm);
    const a = [p[0] + outN[0] * 1.0, p[1] + outN[1] * 1.0];
    const b = [p[0] + outN[0] * (off + 1.4), p[1] + outN[1] * (off + 1.4)];
    out.push(`<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke="#000" stroke-width="0.13"/>`);
  }

  // arrowheads + labels per segment
  for (let i = 0; i < ticksMm.length - 1; i++) {
    const mmA = ticksMm[i], mmB = ticksMm[i + 1];
    const segMm = mmB - mmA;
    if (segMm <= 0) continue;
    const pa = O(P(mmA)), pb = O(P(mmB));
    const segPaper = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    if (segPaper > 5) {
      out.push(arrow(pa[0], pa[1], ux, uy));
      out.push(arrow(pb[0], pb[1], -ux, -uy));
    } else {
      out.push(arrow(pa[0], pa[1], -ux, -uy));
      out.push(arrow(pb[0], pb[1], ux, uy));
    }
    const label = unitFmt ? unitFmt(segMm) : String(Math.round(segMm));
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const vertical = Math.abs(uy) > Math.abs(ux);
    const rotate = vertical ? -90 : 0;
    const tw = textWidth(label, size, true);
    // label sits just outside the dimension line; nudge further out on collision
    let placed = false;
    for (let step = 0; step < 4 && !placed; step++) {
      const lift = 1.15 + step * 1.9;
      const lx = mid[0] + outN[0] * lift, ly = mid[1] + outN[1] * lift;
      const cy = vertical ? ly : ly + size * 0.32;
      let r;
      if (vertical) r = { x0: lx - size * 0.9, y0: cy - tw / 2, x1: lx + size * 0.5, y1: cy + tw / 2 };
      else r = textRect(lx, cy, label, size, 'middle', true);
      if (segPaper < tw + 1.2 && step === 0) continue; // too tight, jump straight out
      if (reg.tryAdd(r)) {
        out.push(text(lx, cy, label, { size, mono: true, rotate }));
        if (step > 0) {
          out.push(`<line x1="${n(mid[0] + outN[0] * 0.6)}" y1="${n(mid[1] + outN[1] * 0.6)}" x2="${n(mid[0] + outN[0] * (lift - 0.8))}" y2="${n(mid[1] + outN[1] * (lift - 0.8))}" stroke="#000" stroke-width="0.1"/>`);
        }
        placed = true;
      }
    }
    if (!placed) {
      const lx = mid[0] + outN[0] * 9, ly = mid[1] + outN[1] * 9;
      out.push(text(lx, ly, label, { size, mono: true, rotate }));
      reg.add(textRect(lx, ly, label, size, 'middle', true));
    }
  }
  return out.join('');
}

/** Leader line from an item to a label slot, with a tag bubble at the label end. */
export function leader(from, to, tag, name, size, reg) {
  const out = [];
  const elbow = [to[0] - Math.sign(to[0] - from[0]) * 1.6, to[1]];
  out.push(`<polyline points="${n(from[0])},${n(from[1])} ${n(elbow[0])},${n(elbow[1])} ${n(to[0])},${n(to[1])}" fill="none" stroke="#000" stroke-width="0.13"/>`);
  out.push(`<circle cx="${n(from[0])}" cy="${n(from[1])}" r="0.42" fill="#000"/>`);
  const r = 1.7;
  out.push(`<circle cx="${n(to[0])}" cy="${n(to[1])}" r="${n(r)}" fill="#fff" stroke="#000" stroke-width="0.2"/>`);
  out.push(text(to[0], to[1] + size * 0.34, tag, { size: size * 0.92, mono: true, weight: 'bold' }));
  if (name) {
    const nx = to[0] + r + 0.7;
    out.push(text(nx, to[1] + size * 0.34, name, { size: size * 0.88, anchor: 'start' }));
    reg.add(textRect(nx, to[1] + size * 0.34, name, size * 0.88, 'start'));
  }
  reg.add({ x0: to[0] - r, y0: to[1] - r, x1: to[0] + r, y1: to[1] + r });
  return out.join('');
}

export default { dimChain, makeRegistry, text, textRect, textWidth, esc, n, leader };

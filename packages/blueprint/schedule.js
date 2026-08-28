// packages/blueprint/schedule.js
// FF&E schedule + tag assignment. Dependency-free, DOM-free. mm in, mm out.

export const CATEGORY_LETTER = {
  seating: 'A', tables: 'B', beds: 'C', storage: 'D', desks: 'E',
  lighting: 'F', rugs: 'G', decor: 'H', appliance: 'I', outdoor: 'J', kids: 'K',
};

export function catGet(catalog, id) {
  if (!catalog) return null;
  if (typeof catalog.get === 'function') return catalog.get(id) || null;
  return catalog[id] || null;
}

export function letterFor(item) {
  return CATEGORY_LETTER[item.category] || 'Z';
}

/**
 * Stable per-instance tags, grouped by category: A1, A2, B1...
 * Order follows the placement order so tags are reproducible.
 */
export function assignTags(layout, catalog) {
  const counters = {};
  const byInstance = {};
  for (const p of layout.placements) {
    const item = catGet(catalog, p.item_id);
    if (!item) continue;
    const L = letterFor(item);
    counters[L] = (counters[L] || 0) + 1;
    byInstance[p.instance_id] = `${L}${counters[L]}`;
  }
  return byInstance;
}

export function fmtDims(item) {
  const d = item.dims_mm;
  return `${d.w}\u00d7${d.d}\u00d7${d.h}`;
}

/** renderSchedule({layout, catalog}) => { rows, total } per SPEC §5.2 */
export function renderSchedule({ layout, catalog }) {
  const tags = assignTags(layout, catalog);
  const groups = new Map();
  for (const p of layout.placements) {
    const item = catGet(catalog, p.item_id);
    if (!item) continue;
    const key = p.item_id;
    if (!groups.has(key)) {
      groups.set(key, {
        item, tags: [], qty: 0,
        added_by_ai: false,
      });
    }
    const g = groups.get(key);
    g.tags.push(tags[p.instance_id]);
    g.qty += 1;
    if (p.added_by_ai) g.added_by_ai = true;
  }
  const rows = [];
  for (const g of groups.values()) {
    const price = g.item.price_usd != null ? g.item.price_usd : 0;
    const sorted = g.tags.slice().sort((a, b) => {
      const na = parseInt(a.slice(1), 10), nb = parseInt(b.slice(1), 10);
      return a[0] === b[0] ? na - nb : (a[0] < b[0] ? -1 : 1);
    });
    const tag = sorted.length > 1
      ? `${sorted[0]}\u2013${sorted[sorted.length - 1]}`
      : sorted[0];
    rows.push({
      tag,
      tags: sorted,
      qty: g.qty,
      brand: g.item.brand || '',
      name: g.item.name || g.item.id,
      product_type: g.item.product_type || '',
      dims: fmtDims(g.item),
      sku: g.item.sku || '\u2014',
      price,
      total: Math.round(price * g.qty * 100) / 100,
      added_by_ai: g.added_by_ai,
      item_id: g.item.id,
    });
  }
  rows.sort((a, b) => {
    const A = a.tags[0], B = b.tags[0];
    if (A[0] !== B[0]) return A[0] < B[0] ? -1 : 1;
    return parseInt(A.slice(1), 10) - parseInt(B.slice(1), 10);
  });
  const total = Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100;
  return { rows, total };
}

export default { renderSchedule, assignTags, CATEGORY_LETTER, letterFor };

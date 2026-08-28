import { solveLayouts } from '../../layout-engine/index.js';
import { renderBlueprint } from '../index.js';
import { assignTags } from '../schedule.js';
import * as F from '../../layout-engine/tests/fixtures.js';
import { readFileSync } from 'node:fs';

// scale check: parse polygons out of the sheet and compare drawn edge lengths
// against the catalogue's real millimetre dimensions.
const L = solveLayouts({room:F.LIVING, items:F.LIVING_ITEMS, catalog:F.CATALOG, mode:'augment', seed:84213, count:3})[0];
const svg = readFileSync('/home/user/render/living.svg','utf8');
const m = svg.match(/1:(\d+)/); const scale = +m[1];
const k = 1/scale;
const polys=[...svg.matchAll(/<polygon points="([^"]+)"[^>]*stroke-width="0\.26"/g)].map(x=>x[1].split(' ').map(p=>p.split(',').map(Number)));
const wanted = L.placements.map(p=>{const it=F.CATALOG.get(p.item_id);return {name:it.name,w:it.dims_mm.w,d:it.dims_mm.d};});
let checked=0, bad=0;
for(const pts of polys){
  if(pts.length!==4) continue;
  const e1=Math.hypot(pts[1][0]-pts[0][0],pts[1][1]-pts[0][1])/k;
  const e2=Math.hypot(pts[2][0]-pts[1][0],pts[2][1]-pts[1][1])/k;
  const hit=wanted.find(w=>Math.abs(w.w-e1)<12 && Math.abs(w.d-e2)<12);
  checked++;
  if(!hit){bad++;console.log('  unmatched footprint',Math.round(e1),'x',Math.round(e2));}
}
console.log(`scale 1:${scale}  footprints parsed=${checked}  dimension mismatches=${bad}`);
const tags=assignTags(L,F.CATALOG);
const missing=Object.values(tags).filter(t=>svg.indexOf('>'+t+'<')<0);
console.log('tags drawn:',Object.keys(tags).length-missing.length,'/',Object.keys(tags).length, missing.length?('missing '+missing.join(',')):'');
console.log('door arcs:', (svg.match(/A[\d.]+,[\d.]+ 0 0 [01]/g)||[]).length, ' window mullions/glass lines:', (svg.match(/stroke-width="0\.26"\/>/g)||[]).length);
console.log('arrowheads:', (svg.match(/<polygon points="[^"]*" fill="#000"\/>/g)||[]).length);

// Regenerates demo/catalog-data.js from packages/catalog/catalog.json.
// The demo must run from file:// (SPEC §8.1), where fetch() of a local .json is
// blocked by the browser, so the catalog ships as an ES module instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(readFileSync(join(ROOT, 'packages/catalog/catalog.json'), 'utf8'));
const body = JSON.stringify(d);
writeFileSync(join(ROOT, 'demo/catalog-data.js'),
  `// demo/catalog-data.js — GENERATED from packages/catalog/catalog.json.\n`
+ `// Regenerate with: node tools/gen-catalog-module.mjs\n`
+ `// Shipped as an ES module (not fetched JSON) so the demo also runs from file://\n`
+ `// per SPEC §8.1 — fetch() of a local .json is blocked under the file: origin.\n`
+ `// ${d.items.length} items.\n`
+ `export const CATALOG_DATA = ${body};\nexport default CATALOG_DATA;\n`);
console.log(`demo/catalog-data.js regenerated — ${d.items.length} items, ${body.length} bytes`);

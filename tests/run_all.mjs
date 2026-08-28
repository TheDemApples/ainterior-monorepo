// Runs the whole backend test suite: schema validator + vision + recon.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const steps = [
  ['python3', [path.join(root, 'tools', 'validate_schema.py'), root]],
  ['node', [path.join(here, 'test_vision.mjs')]],
  ['node', [path.join(here, 'test_recon.mjs')]],
];
let failed = 0;
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nALL SUITES PASSED');
process.exit(failed ? 1 : 0);

// tools/verify-recon.mjs -- zero-dependency contract checks for services/recon
import { createReconProvider, PROVIDERS } from '../services/recon/index.js';

const REQUIRED = ['createRoomFromImages', 'createRoomFromBlueprint', 'createObjectFromImages', 'getJob'];
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

ok(PROVIDERS.includes('huggingface'), `PROVIDERS registers huggingface -> ${JSON.stringify(PROVIDERS)}`);

const def = createReconProvider();
ok(def.kind === 'mock', `default provider is still mock (got "${def.kind}") -- offline demo unbroken`);

const hf = createReconProvider('huggingface');
ok(hf.kind === 'huggingface', 'createReconProvider("huggingface") constructs');
for (const m of REQUIRED) ok(typeof hf[m] === 'function', `huggingface implements ${m}()`);
ok(createReconProvider('hf').kind === 'hf', 'alias "hf" works');

// rooms must fail loudly, not fabricate
const r = hf.getJob(hf.createRoomFromImages({ images: [1] }).job_id);
ok(r.status === 'failed' && /NOT AT ALL|single-object/.test(r.error), `rooms fail explicitly: ${String(r.error).slice(0, 60)}…`);

// unknown provider rejected
let threw = false;
try { createReconProvider('nope'); } catch { threw = true; }
ok(threw, 'unknown provider throws');

// honesty: no measurement -> unscaled, dims null
const j = hf.createObjectFromImages({ images: [{ url: 'https://example.invalid/x.png' }], name: 'X' });
ok(typeof j.job_id === 'string', 'createObjectFromImages returns { job_id }');
const env = hf.getJob(j.job_id);
ok(['queued', 'running', 'failed'].includes(env.status), `job envelope status = ${env.status}`);
ok(hf.getJob('bogus').error === 'UNKNOWN_JOB', 'unknown job id -> UNKNOWN_JOB');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CONTRACT CHECKS PASSED');
process.exit(fails ? 1 : 0);

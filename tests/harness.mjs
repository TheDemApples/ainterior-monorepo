// Tiny zero-dependency test harness so `node tests/*.mjs` just works.
let pass = 0, fail = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    pass++; console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++; failures.push([name, e]);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
export async function testAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
export const assert = {
  ok(v, m = 'expected truthy') { if (!v) throw new Error(`${m} (got ${v})`); },
  eq(a, b, m = 'not equal') { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); },
  gte(a, b, m = 'not >=') { if (!(a >= b)) throw new Error(`${m}: ${a} < ${b}`); },
  lt(a, b, m = 'not <') { if (!(a < b)) throw new Error(`${m}: ${a} >= ${b}`); },
  lte(a, b, m = 'not <=') { if (!(a <= b)) throw new Error(`${m}: ${a} > ${b}`); },
  close(a, b, tol, m = 'not close') { if (Math.abs(a - b) > tol) throw new Error(`${m}: |${a}-${b}| > ${tol}`); },
  throws(fn, m = 'expected throw') { try { fn(); } catch { return; } throw new Error(m); },
};
export function summary(label) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
  return { pass, fail };
}

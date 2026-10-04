// Smoke workload for scripts/ab/ab.mjs: runs the tool end to end (bundle, size,
// child, report) without the library. It measures nothing; tests/ab-tool.test.ts
// runs it. __DIST__ is unused on purpose, so any directory serves as an arm.
const xs = Array.from({ length: 64 }, (_, i) => ({ v: i }));
export const N = { sum: 20_000 };
export function sum(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += xs[i & 63].v;
  return s;
}

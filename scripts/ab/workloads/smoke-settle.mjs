// Smoke workload for the SETTLE hook of scripts/ab/child.cjs: `pending` refuses a call while the
// previous one is unsettled, so the run passes only when the child awaits SETTLE.pending after
// each call, outside the timed window. tests/ab-tool.test.ts runs it. __DIST__ is unused.
let open = false;
export const N = { pending: 20_000 };
export const SETTLE = {
  pending: async () => {
    await new Promise((r) => setImmediate(r));
    open = false;
  },
};
export function pending(n) {
  if (open) throw new Error('pending: called before SETTLE.pending ran');
  open = true;
  let s = 0;
  for (let i = 0; i < n; i++) s += i & 7;
  return s;
}

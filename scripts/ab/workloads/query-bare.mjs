// Workload for scripts/ab/ab.mjs: a query on a bare sync bus, no plugins, no listeners (phase 2
// study, candidate C7: syncQuery builds its command before the depth's try, as syncDispatch does).
// Four actions with handlers of different shapes, over number, string and object targets, in a
// seeded mix of 64. Rows: query_bare, and dispatch_bare, the control: the same actions and targets
// dispatched, a path C7 does not change (reads 1.000).
import { createCommandBus } from '__DIST__/index.js';

const bus = createCommandBus();
bus.register('userGet', (cmd) => cmd.target);
bus.register('priceGet', (cmd) => cmd.target * 2);
bus.register('nameGet', (cmd) => cmd.target.length);
bus.register('itemGet', (cmd) => cmd.target.id);

let seed = 0x9e3779b9;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const CALLS = Array.from({ length: 64 }, (_, i) => {
  const v = Math.floor(rand() * 1000);
  switch (Math.floor(rand() * 4)) {
    case 0: return ['userGet', v];
    case 1: return ['priceGet', v + i / 4];
    case 2: return ['nameGet', `name-${v}`];
    default: return ['itemGet', { id: v, i }];
  }
});

// One loop per row, so neither row's call site sees the other's method.
export const N = { query_bare: 200_000, dispatch_bare: 200_000 };
export const query_bare = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [action, target] = CALLS[i & 63];
    s += bus.query(action, target).ok ? 1 : 0;
  }
  return s;
};
export const dispatch_bare = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [action, target] = CALLS[i & 63];
    s += bus.dispatch(action, target).ok ? 1 : 0;
  }
  return s;
};

/** Every call answers ok with its handler's value, and a query answers as a dispatch does. */
export const check = () => {
  const values = CALLS.map(([action, target]) => {
    const q = bus.query(action, target);
    const d = bus.dispatch(action, target);
    if (!q.ok || !d.ok || q.value !== d.value) throw new Error(`${action}: query ${JSON.stringify(q)} dispatch ${JSON.stringify(d)}`);
    return q.value;
  });
  if (new Set(CALLS.map(([a]) => a)).size !== 4) throw new Error('the mix lost an action');
  return values.map(String);
};

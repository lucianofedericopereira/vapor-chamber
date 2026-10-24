// Workload for scripts/ab/ab.mjs: a store write that is saved, per write. Each arm saves the
// way its build does: a build with the `persist()` plugin saves the store's state after each
// dispatch (log s35.208's rows); a build with the store's `persist: saveTo()` saves once per
// microtask (plan 1.32 step 4b). Two state sizes on a working storage (the normal action), a
// store without persist (the control: an untouched path), and blocked storage, where reading
// `localStorage` throws (a failure path, which may pay). Each call awaits one microtask, so a
// save scheduled for it is inside the timed call. Console output is silenced.
import * as root from '__DIST__/index.js';
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store/core.js';

export const ASYNC = true;
console.warn = () => {};
console.error = () => {};

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
};

let ids = 0;
const make = (state, save, storage) => {
  const bus = createCommandBus();
  const options = { state: () => state, reducers: { x: (s, n) => ({ ...s, n }) } };
  const plugin = typeof root.persist === 'function';
  const own = { key: 'vc:ab', ...(storage ? { storage } : {}) };
  // A build between the plugin and saveTo took the option as a plain object (step 4b's first form).
  if (save && !plugin) options.persist = typeof root.saveTo === 'function' ? root.saveTo(own) : own;
  const store = defineChamberStore(`ab${ids++}`, options)(bus);
  if (save && plugin) bus.use(root.persist({ key: 'vc:ab', getState: () => store.state.value, ...(storage ? { storage } : {}) }));
  return store;
};

const small = { n: 1, label: 'cart' };
const items = { n: 0, items: Array.from({ length: 50 }, (_, i) => ({ id: i, qty: i & 3 })) };

const plain = make(small, false);
const saveSmall = make(small, true, memory());
const saveItems = make(items, true, memory());
// The default lookup, `globalThis.localStorage`, through a getter that throws.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
const blocked = make(small, true);

const run = async (store, n) => { let s = 0; for (let i = 0; i < n; i++) s += store.x(i).ok ? 1 : 0; await Promise.resolve(); return s; };
export const N = { no_persist: 400_000, persist_small: 100_000, persist_items: 20_000, persist_blocked: 50_000 };
export const no_persist = (n) => run(plain, n);
export const persist_small = (n) => run(saveSmall, n);
export const persist_items = (n) => run(saveItems, n);
export const persist_blocked = (n) => run(blocked, n);
export const check = async () => [await run(plain, 8), await run(saveSmall, 8), await run(saveItems, 8)];

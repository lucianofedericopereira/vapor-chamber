// Workload for scripts/ab/ab.mjs (log s35.208): what persist's save costs per
// dispatch once the storage lookup sits inside its try. Two state sizes on a
// working storage (the normal action), a bus without persist (the control:
// an untouched path), and blocked storage, where reading `localStorage`
// throws (a failure path, which may pay). Console output is silenced: the
// blocked row warns on every save in the fixed build.
import { createCommandBus, persist } from '__DIST__/index.js';

console.warn = () => {};
console.error = () => {};

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
};

const make = (state, storage) => {
  const bus = createCommandBus();
  bus.register('x', (cmd) => cmd.target + 1);
  if (state !== undefined) bus.use(persist({ key: 'vc:ab', getState: () => state, ...(storage ? { storage } : {}) }));
  return bus;
};

const small = { n: 1, label: 'cart' };
const items = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, qty: i & 3 })) };

const plain = make(undefined);
const saveSmall = make(small, memory());
const saveItems = make(items, memory());
// The default lookup, `globalThis.localStorage`, through a getter that throws.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
const blocked = make(small);

// `ok` counted, not `value`: on blocked storage the old build answers a failure.
const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).ok ? 1 : 0; return s; };
export const N = { no_persist: 400_000, persist_small: 100_000, persist_items: 20_000, persist_blocked: 50_000 };
export const no_persist = (n) => run(plain, n);
export const persist_small = (n) => run(saveSmall, n);
export const persist_items = (n) => run(saveItems, n);
export const persist_blocked = (n) => run(blocked, n);
export const check = () => [run(plain, 8), run(saveSmall, 8), run(saveItems, 8)];

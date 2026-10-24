// Workload for scripts/ab/ab.mjs: commandKey and the key text it writes (src/canonical.ts).
// Written for compat step 1 (log 36.25), widened for the V8 round's item 1 (log 36.36). Rows:
// - object_cache: dispatch an object target through `cache` (a key per dispatch, mostly hits).
// - object_tracked: dispatch an object target with per-key loading tracking armed (_targetKey).
// - key_mixed: commandKey alone over four target shapes (flat, nested, array, numbers).
// - primitive_cache: the same as object_cache with a number target, which takes the fast
//   path before the key writer. One type only, so V8 speculates its typeof.
// - key_primitives: commandKey alone over strings and numbers, the fast path with mixed types.
// - mixed: one bus with cache on one action and tracking on both, objects and primitives,
//   hits and misses: commandKey from two callers (docs/V8-RULES.md rule 13).
// - bare: a dispatch with no plugin and no key, a path no key change runs: the known control.
import { effectScope } from 'vue';
import { cache, commandKey, createCommandBus } from '__DIST__/index.js';
import { useSharedCommandState } from '__DIST__/vue.js';
// Arms one key: `pending` from 1.32 step 5, `isLoading` in the base arm.
const armKey = (s, a, t) => (s.pending ?? s.isLoading)(a, t);

const targets = [
  { id: 1, sku: 'a-1' },
  { q: { page: 2, size: 20 }, sort: 'name' },
  { ids: [1, 2, 3], kind: 'bulk' },
  { lat: 45.4642, lng: 9.19, zoom: 12 },
];
const prims = ['sku-1', 42, 'sku-2', 7];
const both = [targets[0], 'sku-1', targets[1], 7];

const cached = createCommandBus();
cached.register('x', () => 1);
cached.use(cache({ actions: ['x'], ttl: 60_000 }));

const tracked = createCommandBus();
tracked.register('x', () => 1);
const scope = effectScope();
const shared = scope.run(() => useSharedCommandState({ bus: tracked }));
armKey(shared, 'x', targets[0]);

const mix = createCommandBus();
mix.register('x', () => 1);
mix.register('y', () => 1);
mix.use(cache({ actions: ['x'], ttl: 60_000 }));
const mixShared = scope.run(() => useSharedCommandState({ bus: mix }));
armKey(mixShared, 'y', 'sku-1');

const plain = createCommandBus();
plain.register('x', () => 1);

export const N = {
  object_cache: 200_000,
  object_tracked: 200_000,
  key_mixed: 200_000,
  primitive_cache: 200_000,
  key_primitives: 200_000,
  mixed: 200_000,
  bare: 200_000,
};
export function object_cache(n) { let s = 0; for (let i = 0; i < n; i++) s += cached.dispatch('x', targets[i & 3]).value; return s; }
export function object_tracked(n) { let s = 0; for (let i = 0; i < n; i++) s += tracked.dispatch('x', targets[i & 3]).value; return s; }
export function key_mixed(n) { let s = 0; for (let i = 0; i < n; i++) s += commandKey('x', targets[i & 3]).length; return s; }
export function primitive_cache(n) { let s = 0; for (let i = 0; i < n; i++) s += cached.dispatch('x', i & 3).value; return s; }
export function key_primitives(n) { let s = 0; for (let i = 0; i < n; i++) s += commandKey('x', prims[i & 3]).length; return s; }
// Each action sees all four targets: the action flips every fourth dispatch.
export function mixed(n) { let s = 0; for (let i = 0; i < n; i++) s += mix.dispatch((i >> 2) & 1 ? 'y' : 'x', both[i & 3]).value; return s; }
export function bare(n) { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i & 3).value; return s; }
export const check = () => [object_cache(8), object_tracked(8), key_mixed(8), primitive_cache(8), key_primitives(8), mixed(8), bare(8)];

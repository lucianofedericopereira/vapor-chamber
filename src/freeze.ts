/**
 * vapor-chamber - dev-only deep freeze for shared cache entries.
 *
 * Internal. FOUR stores in this library hand the SAME object to every later
 * hit: the HTTP response cache (`http-cache.ts`), the bus-level `cache()`
 * plugin, `idempotent()`'s completed-result map (both `plugins-extra.ts`), and
 * a compiled route record's `meta` (`router/table.ts`), which the router hands
 * out as `location.meta`, `MenuItem.meta` and `Breadcrumb.meta` for its whole
 * life. A consumer that mutates what it got back - sorts a list, deletes a row
 * optimistically, stashes a computed title on `route.meta` - therefore rewrites
 * what every later hit reads, silently and at a distance.
 *
 * A policy applied by hand at each call site is easy to miss at one of them, so
 * keep this list in step: add to it when adding a store, or that store's
 * entries stay mutable.
 *
 * The contract is "treat cached values as immutable", and this makes that
 * contract enforceable where it matters: in dev, mutation throws at the
 * mutation site instead of surfacing later as a phantom cache value. It is the
 * same discipline the router applies to its snapshot, which solved this exact
 * problem with Object.freeze. Production leaves the object alone - freezing has
 * a cost, and by then the contract has been tested.
 */

import { DEV } from './dev';
export const FREEZE_IN_DEV = DEV;

/**
 * Walks plain objects and arrays only. Blobs, FormData, Maps, class instances
 * and anything else with its own prototype are frozen shallowly and not
 * descended into - deep-freezing a foreign object graph is not this module's
 * business, and would break types that rely on internal mutation.
 */
export function freezeDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key], seen);
}

/** Freeze `value` in dev, no-op in production. Returns `value` for chaining. */
export function freezeCached<T>(value: T): T {
  if (FREEZE_IN_DEV) freezeDeep(value);
  return value;
}

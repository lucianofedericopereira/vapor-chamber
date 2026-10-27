/**
 * vapor-chamber - SSR by the stores' states
 *
 * The server reads every store's state on the request's bus into the page
 * (`storeStates`), and the client gives them to its stores (`seedStores`): a
 * store already on the bus takes its state through its own write, one created
 * later starts from it. Nothing replays: a reducer that mints an id or reads a
 * clock ends on the server's state in the browser too. It works above Vue's DOM
 * hydration: no DOM references, anchors or interop state. Route data stays the
 * router's.
 *
 * CONCURRENCY. The shared bus is a module global, one per Node process. A
 * server that renders requests concurrently creates a bus per request: it
 * provides it to that request's app, and each store is created on it
 * (`useCart(bus)`). Its stores, and so its states, are that request's alone
 * (tests/ssr-per-request-bus.test.ts, tests/ssr-store-states.test.ts).
 *
 * The HTTP client has the same rule: its cache and in-flight dedupe map live
 * in `createHttpClient()`'s closure, and while the cache key holds the
 * request's headers it has no cookie dimension, so **create it per request** too. A client created once at module scope and
 * shared across renders lets user A's authenticated GET answer user B's.
 *
 * @example Server entry, per request
 * import { createSSRApp } from 'vue';
 * import { renderToString } from 'vue/server-renderer';
 * import { createCommandBus } from 'vapor-chamber';
 * import { storeStates, serializeForScript } from 'vapor-chamber/ssr';
 *
 * export async function render(App) {
 *   const bus = createCommandBus();
 *   const app = createSSRApp(App);
 *   app.provide('bus', bus); // in a component: useCart(inject('bus'))
 *   const html = await renderToString(app);
 *   return { html, states: storeStates(bus) };
 * }
 * // Embed: <script>window.__VAPOR_STATES__ = ${serializeForScript(states)}</script>
 * // (never JSON.stringify here: it leaves `</script>` in user text intact)
 *
 * @example Client entry
 * import { createVaporChamberApp, getCommandBus } from 'vapor-chamber/vapor';
 * import { seedStores } from 'vapor-chamber/ssr';
 *
 * seedStores(getCommandBus(), window.__VAPOR_STATES__);
 * createVaporChamberApp(App).mount('#app');
 */

import type { BaseBus } from './command-bus';
import type { ChamberStore } from './store-base';
import { _busStores, _registryEntry, _storesOf, type RegistryEntry, type StoreFact } from './applied-remotely';

/** What a <script> element, or an engine older than ES2019, would read in JSON text. */
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;
const SCRIPT_ESCAPES: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };

/**
 * JSON for a `<script>` element: `JSON.stringify` with `<`, `>`, `&`, U+2028
 * and U+2029 written as `\u` escapes. Still JSON, and it parses to the same
 * value, but a string holding `</script>` cannot close the element it is
 * embedded in. Use it wherever the stores' states - which carry user text -
 * go into the page.
 *
 * @example
 * `<script>window.__VAPOR_STATES__ = ${serializeForScript(storeStates(bus))}</script>`
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, (c) => SCRIPT_ESCAPES[c] as string);
}

type Entry = RegistryEntry;

/**
 * storeStates - the state of every store the request wrote on a bus, by store
 * id: what a server render puts into the page. A store still on the state it
 * was created with is left out, so the client's own load stands (its persist,
 * or `state()`): the server declares only what it wrote. A seeded id whose
 * store was never created is left out too.
 *
 * @example
 * const states = storeStates(bus); // { cart: { items: [...] }, user: { ... } }
 */
export function storeStates(bus: BaseBus): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const registry = _busStores.get(bus)?.entries as Map<string, Entry> | undefined;
  if (registry !== undefined) {
    for (const [id, entry] of registry) {
      // Only a store this request wrote: one still on the state it was created
      // with says nothing the client does not know, and seeding it would
      // overwrite the client's own (a saved cart, a preference). A write
      // `coalesce` holds lands first, so one made this tick is read.
      entry.land();
      const cell = entry.cell;
      if (cell !== null && cell.value !== entry.first) out[id] = cell.value;
    }
  }
  return out;
}

/**
 * liveStores - the stores in use on a bus, in the order they were created: a
 * new array each call, so disposing or creating a store while iterating is
 * safe. A disposed store, and a seeded id whose store was never created, are
 * left out. It reads the registry the bus keeps, so no dispatch or write pays
 * for it. tests/live-stores.test.ts.
 *
 * @example
 * for (const store of liveStores(bus)) store.$reset();
 */
export function liveStores(bus: BaseBus): Array<ChamberStore<any, any>> {
  const out: Array<ChamberStore<any, any>> = [];
  const registry = _busStores.get(bus)?.entries as Map<string, Entry> | undefined;
  if (registry !== undefined) {
    for (const entry of registry.values()) if (entry.store !== null) out.push(entry.store as ChamberStore<any, any>);
  }
  return out;
}

/** A placeholder has no write `coalesce` could hold. */
const nothingHeld = (): void => {};

/**
 * seedStores - give a server render's states to the client's stores, by id.
 * Each state is a fact on the bus's stores' lane: a store already on the bus
 * writes it at once through its own write (a step of its ring, saved by its
 * persist: the server's state wins over a saved one). For an id with no store
 * yet a placeholder holds the state, and a server's later one (a push before
 * the store exists) replaces it; the store starts from it when it is created.
 * Only an object is a state, as for a store. Call it before the app mounts.
 *
 * @example
 * seedStores(getCommandBus(), window.__VAPOR_STATES__);
 */
export function seedStores(bus: BaseBus, states: Record<string, unknown>): void {
  const { entries, lane } = _storesOf(bus);
  const registry = entries;
  const cmd = { action: '$seeded', target: undefined };
  for (const id of Object.keys(states)) {
    if (!registry.has(id)) {
      const entry = _registryEntry(null, [], null, nothingHeld, nothingHeld, nothingHeld, undefined, null, undefined);
      entry.unlisten = lane.on(id, (f: StoreFact) => { if (f.state !== null && typeof f.state === 'object') entry.seeded = f.state; });
      registry.set(id, entry);
    }
    lane.emit(id, { cmd, state: states[id] });
  }
}

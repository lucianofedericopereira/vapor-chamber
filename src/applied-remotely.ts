/**
 * vapor-chamber - the commands a transport carried out.
 *
 * Its own module so the store reaches it without importing the bus, as
 * library-names.ts is (log s35.184). The bus's stores and their lane live
 * here for the same reason.
 */
import { type FastLane, createFastLane } from './fast-lane';
import { _report } from './report';

/**
 * @internal The commands a transport carried out, each with the store states its
 * reply declared (`stores`, by store id), when any: the server applied the
 * command and the local handler never ran. History reads it when it undoes,
 * the bus when it hands a handler the answer and the stores their states
 * (`RegisterOptions.answer`), a store's rebase when it replays; never per
 * dispatch. A map rather than a field, so a command keeps its shape.
 * tests/undo-remote-step.test.ts (log s35.159), tests/store-declared-by-server.test.ts.
 */
export const _appliedRemotely = /* @__PURE__ */ new WeakMap<object, Record<string, unknown> | undefined>();

/**
 * @internal A state from outside a store, for the store with the lane's key:
 * another tab's, a server's (`stores` in a reply or a push), a seed, a form's
 * write. A fact: the store writes it as it arrives, a step of `cmd`, never
 * merged by `coalesce` and never dispatched (src/store-base.ts, `write`).
 */
export type StoreFact = { readonly cmd: { action: string; target: any; payload?: any }; readonly state: unknown };

/**
 * @internal A bus's stores: the registry by store id (src/store-base.ts), and
 * the lane their facts ride, keyed by store id, each store listening to its
 * own. The async bus makes the record at creation and reads it at a
 * transport's level; the first store or seed makes the lane, so a bus with
 * no store carries none of it. A store adds itself and removes only itself. A
 * Map, so an id from the wire never reads an inherited name (src/dict.ts).
 * tests/store-facts-lane.test.ts.
 */
export type BusStores = { readonly entries: Map<string, RegistryEntry>; lane: FastLane | null };

/**
 * @internal One id of a bus's stores: a store and what its lifetime needs,
 * or a seeded id's placeholder (`store` null, the state in `seeded`). Every
 * entry comes from `_registryEntry`, one literal (docs/V8-RULES.md rule 1).
 */
export type RegistryEntry = {
  store: unknown;
  offs: Array<() => void>;
  /** The live component scopes holding the store (src/store-base.ts, `join`). */
  holders: number;
  /** The definition that built it (its `useStore`): another one takes over. */
  def: unknown;
  /** Held by a caller outside any scope, who owns `$dispose()` (docs/store.md). */
  pinned: boolean;
  /** Stops this entry's listening on the stores' lane: a store taking the id over calls it. */
  unlisten: () => void;
  /** Lands a write `coalesce` holds, so `storeStates` reads it. */
  land: () => void;
  /** The store's one write of a state set outside its reducers, a step of `cmd`: what its facts reach, and a form's own commands. */
  write: (cmd: { action: string; target: any; payload?: any }, next: unknown) => void;
  /** A placeholder's state (`seedStores`, src/ssr.ts): `store` null, the state waiting for its store. */
  seeded: unknown;
  /** The store's raw cell, and the state it was created with: `storeStates` reads a store only once a write replaced it. */
  cell: { readonly value: unknown } | null;
  first: unknown;
};

/** @internal The one literal of a registry entry: a store's or a placeholder's. */
export function _registryEntry(
  store: unknown, offs: Array<() => void>, def: unknown, unlisten: () => void, land: () => void,
  write: RegistryEntry['write'], seeded: unknown, cell: RegistryEntry['cell'], first: unknown,
): RegistryEntry {
  return { store, offs, holders: 0, def, pinned: false, unlisten, land, write, seeded, cell, first };
}

/** @internal Per bus: its stores (`BusStores`). */
export const _busStores = /* @__PURE__ */ new WeakMap<object, BusStores>();

/** @internal A bus's stores with their lane, made on first use: what a store or a seed joins. */
export function _storesOf(bus: object): BusStores & { lane: FastLane } {
  let stores = _busStores.get(bus);
  if (stores === undefined) _busStores.set(bus, (stores = { entries: new Map(), lane: null }));
  if (stores.lane === null) stores.lane = createFastLane();
  return stores as BusStores & { lane: FastLane };
}

/**
 * @internal What a history hears of another tab, with no dispatch: a command
 * that tab ran, one it undid or redid, and a state that moved this tab's.
 */
export type TabHearer = {
  /** `under`: the ids of this tab's writes the lead ran it under, so it goes under them. */
  heard(cmd: { action: string; meta?: unknown }, under?: readonly string[]): void;
  undone(cmd: object): void;
  redone(cmd: object): void;
  moved(): void;
};

/**
 * @internal Per bus: the histories recording on it (src/ledger.ts,
 * `recordOn`). A store across tabs tells them what another tab did. Here so
 * the store reaches them without importing the ledger.
 */
export const _hearers = /* @__PURE__ */ new WeakMap<object, Set<TabHearer>>();

/** @internal What a display binding reads of a store: its state and its field events. */
export type BoundStore = {
  readonly state: { readonly value: Record<string, unknown> };
  $onField(key: string, fn: (value: unknown) => void): () => void;
};

/**
 * @internal The store with id `id` on `bus`, or undefined: the registry's one
 * reader for a page's display bindings (src/page-bindings.ts). A seeded id
 * with no store yet is undefined.
 */
export function _storeOf(bus: object, id: string): BoundStore | undefined {
  const store = (_busStores.get(bus)?.entries.get(id) as { store?: unknown } | undefined)?.store;
  return store !== null && typeof store === 'object' ? (store as BoundStore) : undefined;
}

/**
 * @internal Per async bus with a transport: whether one sends an action,
 * resolved as a dispatch resolves it. Set at the bus's creation, here so a
 * store reads it without importing the bus module (`exclusive: true` keys
 * only the store's sent actions).
 */
export const _sendsOn = /* @__PURE__ */ new WeakMap<object, (action: string) => boolean>();

/** The mark vaporChamberHMR's shim sets for one hot update (src/vite-hmr.ts HMR_HOT_KEY). */
const HOT_KEY = '__VAPOR_CHAMBER_HOT__';

/**
 * @internal DEV: the mark of a hot update, undefined outside one. A store
 * replaced inside it carries its state, and register() does not warn over a
 * handler. The plugin is serve-only, so a build never has it.
 */
export function _hotUpdate(): WeakMap<object, unknown> | undefined {
  return (globalThis as Record<string, unknown>)[HOT_KEY] as WeakMap<object, unknown> | undefined;
}

/**
 * @internal A server's push, on every wire a name and data (docs/contract.md 4):
 * each store state its data declares under `stores` goes on the stores' lane,
 * as a reply's do, then the fact is emitted on the bus, so a listener
 * reads the new state. Never dispatched: no plugin runs and nothing is sent
 * back. The write is a step of `<event>$push`, a `$` name no reducer has, so
 * a store's rollback keeps the state it set, as a tab's state. Not a mark
 * in `_appliedRemotely`: its WeakMap insert per push made a push 166 ns, the
 * command it replaces 44.6 ns (scripts/ab/workloads/push.mjs, log 36.52).
 * A store's throw (an app's `version`) is logged and the fact still goes
 * out. tests/inbound-push.test.ts.
 */
export function _pushed(bus: { emit(event: string, data?: unknown): void }, event: string, data: unknown): void {
  // A fact with no `stores` pays one property read: the lane is looked up after.
  const stores = (data as { stores?: unknown } | null | undefined)?.stores;
  if (stores !== null && typeof stores === 'object') written(bus, event, data, stores as Record<string, unknown>);
  bus.emit(event, data);
}

/** The store states a push declares, each a fact on the stores' lane. Its own function: the try stays off the fact's path. */
function written(bus: object, event: string, data: unknown, states: Record<string, unknown>): void {
  const lane = _busStores.get(bus)?.lane;
  if (lane == null) return;
  const cmd = { action: event + '$push', target: data };
  try {
    for (const id of Object.keys(states)) lane.emit(id, { cmd, state: states[id] });
  } catch (e) {
    _report('error', 'store:failed:push', `the push "${event}" failed to write a store`, e, { event });
  }
}

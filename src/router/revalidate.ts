/**
 * vapor-chamber/router/revalidate - mutation-driven revalidation.
 *
 * A BUS plugin that lives on the ROUTER side. After a command that changed
 * server state, the data behind the current route is stale; this re-runs the
 * affected loaders and patches the snapshot. It listens to settled results
 * (`attach`, one `on` per pattern), and holds no `next`. Where the server
 * declares what a write made stale (RFC 9875 `Cache-Group-Invalidation`), the
 * router refreshes those reads itself, with no map (index.ts `refreshGroup`).
 *
 *   bus.use(revalidateRoutes(router, loaders, {
 *     'cart*':        ['shop.cart'],   // command pattern -> record names
 *     'productSave':  'affected',      // or: the whole current load chain
 *   }));
 *
 * PLACEMENT, and why it is here rather than with the bus plugins. The plugin
 * needs `runLoaders` from the router, and there is no public substitute
 * (`reload()` reloads the TABLE, not data); bus-side, it would have to import
 * a router module into the root barrel, which is forbidden. What it needs from
 * the BUS is two shapes, the plugin function and `on`, declared inline below,
 * so the edge exists in exactly one direction, the cheap one.
 *
 * WHY `loaders` IS AN ARGUMENT. `createRouter` closes over its `LoaderHandlers`
 * and does not expose them, so the plugin cannot recover the preset the router
 * is using. Passing the same instance is the composition's one wiring cost; a
 * plugin building its own would be a second HTTP client and a second cache,
 * silently diverging from the router's.
 *
 * WHY THE PLUGIN OWNS ITS `isRevalidating`. `router.isRevalidating` is
 * `Readonly`, and its only writer is the engine's `trackRevalidation`, which is
 * on neither the router object nor the `Router` type. Driving it would mean
 * casting the readonly away and becoming a second writer to another module's
 * state. Two refresh sources, two flags; a consumer wanting one spinner ORs
 * them. See tests/revalidate-routes.test.ts for the full argument.
 *
 * ZERO new router capability: this composes `runLoaders`, `currentRoute` and
 * `setRouteData`, all already public.
 */

import { shallowRef } from 'vue';
import { routerError } from './errors';
import { _report } from '../report';
import { type LoaderHandlers, _routerClients, runLoaders } from './loaders';
import type { Router } from './router-type';
import type { TableRecord } from './types';

/**
 * The bus's plugin and listener shapes, declared here rather than imported.
 *
 * Structural on purpose - it is the whole of this module's dependency on the
 * bus, and importing it would pull the command bus into the router's graph to
 * borrow a function signature.
 */
type BusResult = { ok: boolean; value?: unknown; error?: unknown };
type BusCommand = { action: string };
type ListeningBus = { on(pattern: string, listener: (cmd: BusCommand, result: BusResult) => void): () => void };
// A plugin made of an `attach` part, so `bus.use(revalidateRoutes(...))`
// type-checks on either bus as docs/router.md writes it (tests/router/cache-groups.test.ts).
export type RevalidatePlugin = {
  readonly id: 'revalidateRoutes';
  /** True while at least one plugin-driven refresh is in flight. */
  isRevalidating: { readonly value: boolean };
  /** Stop revalidating and abort anything in flight. */
  dispose: () => void;
  /** The map's patterns, each one listener (`attach`). */
  readonly actions: string[];
  /** `use()` gives the bus: one listener per pattern (PluginParts.attach). */
  attach: (bus: ListeningBus) => () => void;
};

/** Command pattern -> record names to refresh, or 'affected' for the current
 *  route's whole load chain. Patterns use the bus's glob shape (`cart*`). */
export type RevalidateMap = Record<string, readonly string[] | 'affected'>;

export type RevalidateOptions = {
  /** Called when a revalidation fails. Default: reported as
   *  `router:failed:revalidate`, never thrown - a failed refresh must not
   *  take down the command that succeeded. */
  onError?: (error: unknown) => void;
};

export function revalidateRoutes(
  router: Router,
  loaders: LoaderHandlers,
  map: RevalidateMap,
  options: RevalidateOptions = {},
): RevalidatePlugin {
  const flag = shallowRef(false);
  let disposed = false;
  /** Every failure here is REPORTED, never thrown: the command it follows has
   *  already succeeded, and a refresh must not take it down. */
  const report = (error: unknown): void => {
    if (options.onError) options.onError(error);
    else _report('error', 'router:failed:revalidate', 'a revalidateRoutes refresh failed; the page keeps its data', error);
  };

  /**
   * One controller PER REFRESH, aborted only by a refresh that overlaps it.
   *
   * A shared controller would make every revalidation cancel every other:
   * `cartAdd` then `wishlistAdd`, mapped to different records, would discard
   * the cart's fresh data with no error anywhere. Two refreshes of the SAME
   * record must not both land - the later one wins - while two refreshes of
   * disjoint records have no reason to interfere.
   */
  type InFlight = { controller: AbortController; names: ReadonlySet<string> };
  const inFlight = new Set<InFlight>();
  function syncFlag(): void {
    flag.value = inFlight.size > 0;
  }

  // Own keys only: an action never indexes the map, the bus matches it to a
  // pattern (`on`), so `constructor` or `toString` never answers. See `../dict`.
  const patterns = Object.keys(map);
  const detaches = new Set<() => void>();

  // A settled result: refresh after a success, and after an `Accepted`'s
  // `done` settles ok (read by its shape: the router imports no bus).
  function settled(targets: readonly string[] | 'affected', result: BusResult): void {
    if (disposed || !result.ok) return;
    const done = (result.value as { done?: unknown } | null | undefined)?.done;
    // settled.ts isThenable's test, inline: importing it split a shared chunk out
    // of the store's bundle (tests/chamber-store.test.ts).
    if (typeof (done as PromiseLike<unknown> | undefined)?.then === 'function') {
      void (done as Promise<BusResult>).then((end) => {
        if (!disposed && end.ok) revalidate(targets);
      });
    } else revalidate(targets);
  }

  function revalidate(targets: readonly string[] | 'affected'): void {
    const snapshot = router.currentRoute.value;
    const matched = snapshot.location.matched;
    const leaf = matched[matched.length - 1];
    if (!leaf) return;

    let records: readonly TableRecord[];
    if (targets === 'affected') {
      records = leaf.loadChain;
    } else {
      // A name that is not in the current chain is a wiring mistake, and a
      // silent no-op is exactly how it would survive to production - so it is
      // reported as a coded error in every build (a revalidation map is written
      // once and then trusted forever), and nothing is refreshed.
      const found: TableRecord[] = [];
      for (const name of targets) {
        const record = leaf.loadChain.find((r) => r.name === name);
        if (!record) {
          report(
            routerError(
              'missing:record',
              `revalidateRoutes: "${name}" is not a loader-bearing record of the current route (chain: ${
                leaf.loadChain.map((r) => r.name).join(', ') || 'none'
              })`,
            ),
          );
          return;
        }
        found.push(record);
      }
      records = found;
    }
    if (!records.length) return;

    const names: ReadonlySet<string> = new Set(records.map((record) => record.name));
    for (const entry of inFlight) {
      let overlaps = false;
      for (const name of names) {
        if (entry.names.has(name)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        entry.controller.abort();
        inFlight.delete(entry);
      }
    }

    const own = new AbortController();
    const entry: InFlight = { controller: own, names };
    inFlight.add(entry);
    const at = snapshot.location;
    syncFlag();

    void runLoaders(loaders, records, at, own.signal, undefined, true, _routerClients.get(router))
      .then((fresh) => {
        if (own.signal.aborted) return;
        // Superseded by a navigation while we were fetching: the data belongs
        // to a page nobody is looking at.
        if (router.currentRoute.value.location.fullPath !== at.fullPath) return;
        for (const [name, value] of fresh) router.setRouteData(name, value);
      })
      .catch((error) => {
        // Stale data stays on screen - the command itself succeeded.
        if (!own.signal.aborted) report(error);
      })
      .finally(() => {
        inFlight.delete(entry);
        syncFlag();
      });
  }

  // A listener, not a wrapper: `attach` subscribes one `on` per pattern, so
  // the bus's matcher decides and its listeners hear every settled result
  // (plan-router gap 1). An action two patterns match refreshes both targets.
  const attach = (bus: ListeningBus): (() => void) => {
    const offs = patterns.map((pattern) => bus.on(pattern, (_cmd, result) => settled(map[pattern], result)));
    const detach = (): void => {
      detaches.delete(detach);
      for (const off of offs) off();
    };
    detaches.add(detach);
    return detach;
  };
  const dispose = (): void => {
    disposed = true;
    for (const detach of detaches) detach();
    for (const entry of inFlight) entry.controller.abort();
    inFlight.clear();
    flag.value = false;
  };
  return { id: 'revalidateRoutes', actions: patterns, attach, dispose, isRevalidating: flag };
}

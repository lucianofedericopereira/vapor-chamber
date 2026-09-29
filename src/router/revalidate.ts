/**
 * vapor-chamber/router/revalidate - mutation-driven revalidation.
 *
 * A BUS plugin that lives on the ROUTER side. After a command that changed
 * server state, the data behind the current route is stale; this re-runs the
 * affected loaders and patches the snapshot.
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
 * the BUS is a single function shape, `(cmd, next) => result`, declared inline
 * below, so the edge exists in exactly one direction, the cheap one.
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
import { type LoaderHandlers, runLoaders } from './loaders';
import type { Router } from './router-type';
import type { TableRecord } from './types';

/**
 * The bus's plugin shape, declared here rather than imported.
 *
 * Structural on purpose - it is the whole of this module's dependency on the
 * bus, and importing it would pull the command bus into the router's graph to
 * borrow a function signature.
 */
type BusResult = { ok: boolean; value?: unknown; error?: unknown };
type BusCommand = { action: string };
export type RevalidatePlugin = ((cmd: BusCommand, next: () => unknown) => unknown) & {
  /** True while at least one plugin-driven refresh is in flight. */
  isRevalidating: { readonly value: boolean };
  /** Stop revalidating and abort anything in flight. */
  dispose: () => void;
};

/** Command pattern -> record names to refresh, or 'affected' for the current
 *  route's whole load chain. Patterns use the bus's glob shape (`cart*`). */
export type RevalidateMap = Record<string, readonly string[] | 'affected'>;

export type RevalidateOptions = {
  /** Called when a revalidation fails. Default: rethrow-free console.error -
   *  a failed refresh must not take down the command that succeeded. */
  onError?: (error: unknown) => void;
};

/** Prefix glob, matching the bus's `matchesPattern` semantics without
 *  importing it: `'*'` matches everything, `'cart*'` matches by prefix, and
 *  anything else is an exact match. */
function matches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

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
    else console.error('[vapor-chamber-router] revalidateRoutes refresh failed', error);
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

  // `Object.hasOwn`, never `map[action]`: the keys are command patterns, which
  // are external strings, and a `{}` answers for `constructor`/`toString`. The
  // rule and its evidence live in `../dict`.
  const patterns = Object.keys(map);

  function targetsFor(action: string): readonly string[] | 'affected' | null {
    for (const pattern of patterns) {
      if (matches(pattern, action) && Object.hasOwn(map, pattern)) return map[pattern] as never;
    }
    return null;
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
              'unknown_route_name',
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

    void runLoaders(loaders, records, at, own.signal)
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

  const plugin = ((cmd: BusCommand, next: () => unknown) => {
    const result = next();
    if (disposed) return result;
    const targets = targetsFor(cmd.action);
    if (!targets) return result;

    // Async buses hand back a promise; revalidate only once it has resolved ok,
    // so a failed mutation never refreshes as though it had worked.
    if (result && typeof (result as Promise<BusResult>).then === 'function') {
      void (result as Promise<BusResult>).then((settled) => {
        if (!disposed && settled?.ok) revalidate(targets);
      });
      return result;
    }
    if ((result as BusResult)?.ok) revalidate(targets);
    return result;
  }) as RevalidatePlugin;

  Object.defineProperty(plugin, 'id', { value: 'revalidateRoutes' });
  plugin.isRevalidating = flag;
  plugin.dispose = () => {
    disposed = true;
    for (const entry of inFlight) entry.controller.abort();
    inFlight.clear();
    flag.value = false;
  };
  return plugin;
}

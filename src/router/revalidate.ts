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
 * PLACEMENT, and why it is here rather than with the bus plugins. The first
 * decision put it bus-side with the router passed structurally, on the grounds
 * that `src/router` imports nothing from the bus and the root barrel imports
 * nothing from the router - so hosting it on the router would create an edge
 * that does not exist. That counted edges without weighing them, and the weights
 * are lopsided: the plugin needs `runLoaders` from the router, and there is no
 * public substitute (`reload()` reloads the TABLE, not data). Bus-side would
 * therefore have had to import a router module into the root barrel, which is
 * the one thing the constraint forbids outright. What it needs from the BUS is
 * a single function shape, `(cmd, next) => result`, which is declared inline
 * below and imports nothing. So the edge exists in exactly one direction, and
 * it is the cheap one.
 *
 * WHY `loaders` IS AN ARGUMENT. `createRouter` closes over its `LoaderHandlers`
 * and does not expose them, so the plugin cannot recover the preset the router
 * is using. Passing the same instance is the composition's one wiring cost. The
 * plan's sketch read `revalidateRoutes(router, MAP)`; it could not have, and the
 * two-argument form would have had to build a second preset - a second HTTP
 * client, a second cache - silently diverging from the router's.
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
  let inFlight = 0;
  let disposed = false;
  let controller: AbortController | null = null;

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
      // silent no-op is exactly how it would survive to production - the same
      // reasoning as setRouteData's dev warning, made unconditional because a
      // revalidation map is written once and then trusted forever.
      records = targets.map((name) => {
        const record = leaf.loadChain.find((r) => r.name === name);
        if (!record) {
          throw routerError(
            'unknown_route_name',
            `revalidateRoutes: "${name}" is not a loader-bearing record of the current route (chain: ${
              leaf.loadChain.map((r) => r.name).join(', ') || 'none'
            })`,
          );
        }
        return record;
      });
    }
    if (!records.length) return;

    controller?.abort();
    const own = (controller = new AbortController());
    const at = snapshot.location;
    inFlight++;
    flag.value = true;

    void runLoaders(loaders, records, at, own.signal)
      .then((fresh) => {
        if (own.signal.aborted) return;
        // Superseded by a navigation while we were fetching: the data belongs
        // to a page nobody is looking at.
        if (router.currentRoute.value.location.fullPath !== at.fullPath) return;
        for (const [name, value] of fresh) router.setRouteData(name, value);
      })
      .catch((error) => {
        if (own.signal.aborted) return;
        // Stale data stays on screen - the command itself succeeded.
        if (options.onError) options.onError(error);
        else console.error('[vapor-chamber-router] revalidateRoutes refresh failed', error);
      })
      .finally(() => {
        inFlight--;
        if (inFlight === 0) flag.value = false;
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

  plugin.isRevalidating = flag;
  plugin.dispose = () => {
    disposed = true;
    controller?.abort();
    inFlight = 0;
    flag.value = false;
  };
  return plugin;
}

/**
 * vapor-chamber-router - the public Router shape (own module so outlet.ts
 * and composables.ts type against it without importing the implementation).
 */

import type { ShallowRef } from 'vue';
import type { RouterError } from './errors';
import type {
  AfterEachHook,
  NavigationGuard,
  QueryPatch,
  RouteLocation,
  RouteLocationRaw,
  RouteRecord,
  RouteSnapshot,
  TableRecord,
} from './types';

export type Router<TName extends string = string> = {
  /** Reactive snapshot: `.value.location` (URL state), `.value.render`
   *  (outlets), `.value.data` (loader results). One frozen object per commit. */
  currentRoute: Readonly<ShallowRef<RouteSnapshot>>;
  /** Reactive compiled route records - [] until the table is loaded, a new
   *  array on setRoutes()/reload(). Table projections (useMenu) read this. */
  routes: Readonly<ShallowRef<readonly TableRecord[]>>;
  /** The history base ('' or e.g. '/admin/it') - absolute hrefs are
   *  base + path. */
  base: string;
  /** True while loaders run (navigations and query refetches). */
  isLoading: Readonly<ShallowRef<boolean>>;
  /** True while a stale-while-revalidate refresh runs behind data already on
   *  screen. Deliberately separate from `isLoading`: a stale hit commits real
   *  data, so the page is showing something, not waiting for it. True whenever
   *  a loader hands the engine a refresh through `ctx.revalidate` - the in-box
   *  preset does that on a `cache.staleTtl` hit, but the SPI is open to any
   *  handler with stale data to refresh. */
  isRevalidating: Readonly<ShallowRef<boolean>>;
  /** Latest navigation error (null after clear) - see useRouteError(). */
  lastError: ShallowRef<unknown>;
  push: (to: RouteLocationRaw<TName>) => Promise<RouterError | null>;
  replace: (to: RouteLocationRaw<TName>) => Promise<RouterError | null>;
  back: () => void;
  forward: () => void;
  go: (delta: number) => void;
  setQuery: (patch: QueryPatch, opts?: { history?: 'push' | 'replace' }) => void;
  /** HOT PATH: patch a record's loader data directly (no loader run, no
   *  navigation) - for bus-command responses, websocket pushes, optimistic
   *  updates. One frozen snapshot, fully reactive. */
  setRouteData: (recordName: string, value: unknown) => void;
  /** Registrations auto-dispose with the component scope when made inside
   *  setup(); call the returned unsubscriber yourself elsewhere. */
  beforeEach: (guard: NavigationGuard) => () => void;
  afterEach: (hook: AfterEachHook) => () => void;
  onError: (handler: (error: unknown, to: RouteLocation) => void) => () => void;
  setRoutes: (rows: readonly RouteRecord[]) => void;
  /** Re-fetch the table from the configured { url } source (admin tasks:
   *  deploys, permission changes). Coded error when no url is configured. */
  reload: () => Promise<void>;
  start: () => Promise<void>;
  isReady: () => Promise<void>;
  /** Absolute href (base included) for plain <a :href>. */
  resolve: (to: RouteLocationRaw<TName>) => string;
  /** `app.use(router)` - provides the router and starts it. It does NOT
   *  register an outlet globally (that would pin the vDOM runtime into every
   *  consumer's bundle), so `component` is deliberately not required here:
   *  requiring it would have this type contradict the implementation. */
  install: (app: { provide: (key: symbol, value: unknown) => unknown }) => void;
  destroy: () => void;
};

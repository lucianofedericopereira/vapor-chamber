/**
 * vapor-chamber-router — the public Router shape (own module so outlet.ts
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
  /** Reactive compiled route records — [] until the table is loaded, a new
   *  array on setRoutes()/reload(). Table projections (useMenu) read this. */
  routes: Readonly<ShallowRef<readonly TableRecord[]>>;
  /** The history base ('' or e.g. '/admin/it') — absolute hrefs are
   *  base + path. */
  base: string;
  /** True while loaders run (navigations and query refetches). */
  isLoading: Readonly<ShallowRef<boolean>>;
  /** Latest navigation error (null after clear) — see useRouteError(). */
  lastError: ShallowRef<unknown>;
  push: (to: RouteLocationRaw<TName>) => Promise<RouterError | null>;
  replace: (to: RouteLocationRaw<TName>) => Promise<RouterError | null>;
  back: () => void;
  forward: () => void;
  go: (delta: number) => void;
  setQuery: (patch: QueryPatch, opts?: { history?: 'push' | 'replace' }) => void;
  /** HOT PATH: patch a record's loader data directly (no loader run, no
   *  navigation) — for bus-command responses, websocket pushes, optimistic
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
  install: (app: {
    provide: (key: symbol, value: unknown) => unknown;
    component: (name: string, comp: unknown) => unknown;
  }) => void;
  destroy: () => void;
};

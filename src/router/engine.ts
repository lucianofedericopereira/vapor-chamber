/**
 * vapor-chamber-router — the navigation engine. Vue 3.6-native: router state
 * IS a shallowRef (alien-signals-backed in 3.6) — no bridge layer.
 *
 * The two-layer URL model:
 *   PATH change   → resolve → guards → components + loaders (parallel, with
 *                   an AbortController created per navigation; starting a new
 *                   navigation aborts the previous one's fetches immediately)
 *                   → ONE atomic frozen snapshot commit (two-phase: data
 *                   loads during, commits with — a page never renders with
 *                   the previous page's data).
 *   QUERY/HASH-only change → fast path: location commits immediately (no
 *                   matching, no guards, no remount); loaders whose template
 *                   depends on a changed key refetch in the background and
 *                   patch `snapshot.data` when done (isLoading tracks it).
 *
 * `navigate()` resolves to `RouterError | null` — null means committed.
 * Guard refusals ('aborted') and superseded navigations ('cancelled') are
 * returned but NOT dispatched to onError.
 */

import { shallowRef } from 'vue';
import { isRouterError, routerError } from './errors';
import type { RouterError } from './errors';
import type { RouterHistory } from './history';
import type { RouteTable } from './table';
import type {
  AfterEachHook,
  NavigationGuard,
  QueryPatch,
  QueryValues,
  RenderEntry,
  RouteLocation,
  RouteLocationRaw,
  RouteSnapshot,
  TableRecord,
} from './types';
import { parseQuery, stringifyQuery } from './url';

export const START_LOCATION: RouteLocation = Object.freeze({
  name: null,
  path: '/',
  fullPath: '/',
  params: {},
  query: {},
  hash: '',
  matched: [],
  meta: {},
});

const EMPTY_DATA: ReadonlyMap<string, unknown> = new Map();

export type EngineContext = {
  getTable: () => RouteTable | null;
  history: RouterHistory;
  /** Resolve the renderable chain into render entries (components loaded,
   *  blade rows wrapped). Throws coded RouterErrors. */
  resolveRender: (records: readonly TableRecord[], to: RouteLocation) => Promise<RenderEntry[]>;
  /** Run the load chain through the configured preset. Throws coded RouterErrors. */
  runLoaders: (records: readonly TableRecord[], to: RouteLocation, signal: AbortSignal) => Promise<Map<string, unknown>>;
  /** Which loaders in the chain does a set of changed query keys affect? */
  loadAffectedBy: (records: readonly TableRecord[], keys: readonly string[]) => readonly TableRecord[];
  /** Real failures only — refusals never arrive here. */
  onError: (error: unknown, to: RouteLocation) => void;
  /** After a committed PATH navigation (not query-only). */
  onCommit?: (snapshot: RouteSnapshot, from: RouteLocation, info: { popstate: boolean }) => void;
};

export type NavigateOptions = { replace?: boolean; popstate?: boolean; delta?: number };

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(ctx: EngineContext) {
  const snapshot = shallowRef<RouteSnapshot>(Object.freeze({ location: START_LOCATION, render: [], data: EMPTY_DATA }));
  /** True while loaders run (full navigations and query refetches). */
  const isLoading = shallowRef(false);

  const beforeGuards: NavigationGuard[] = [];
  const afterHooks: AfterEachHook[] = [];
  let pendingId = 0;
  let controller: AbortController | null = null;

  // ---- location resolution ---------------------------------------------------

  function buildLocation(
    path: string,
    query: QueryValues,
    hash: string,
    hit: { record: TableRecord; params: RouteLocation['params'] } | null,
  ): RouteLocation {
    const search = stringifyQuery(query);
    return {
      name: hit?.record.name ?? null,
      path,
      fullPath: path + (search ? `?${search}` : '') + hash,
      params: hit?.params ?? {},
      query,
      hash,
      matched: hit?.record.chain ?? [],
      meta: hit?.record.meta ?? {},
    };
  }

  function resolveLocation(raw: RouteLocationRaw): RouteLocation {
    const table = ctx.getTable();
    if (!table) throw routerError('not_ready', 'routes not loaded yet — await router.isReady()');

    if (typeof raw === 'string') {
      const hashIndex = raw.indexOf('#');
      const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
      const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
      const queryIndex = beforeHash.indexOf('?');
      const path = (queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash) || '/';
      const query = queryIndex >= 0 ? parseQuery(beforeHash.slice(queryIndex)) : {};
      return buildLocation(path, query, hash, table.resolve(path));
    }

    const hash = raw.hash ?? '';
    const query = cleanQueryPatch(raw.query);
    if (raw.name) {
      const record = table.getRecord(raw.name);
      if (!record) throw routerError('unknown_route_name', `unknown route name "${raw.name}"`);
      // Param inheritance: missing params default from the current location —
      // push({ name }) keeps e.g. the :locale segment of /admin/:locale/…
      // without every call site carrying it (vue-router semantics).
      const path = table.buildPath(record, { ...snapshot.value.location.params, ...raw.params });
      return buildLocation(path, query, hash, table.resolve(path));
    }
    const path = raw.path ?? snapshot.value.location.path;
    return buildLocation(path, query, hash, table.resolve(path));
  }

  function cleanQueryPatch(patch: QueryPatch | undefined): QueryValues {
    const query: QueryValues = {};
    if (!patch) return query;
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value === null || value === undefined) continue;
      query[key] = Array.isArray(value) ? value.map(String) : String(value);
    }
    return query;
  }

  // ---- navigation ---------------------------------------------------------------

  function leafOf(location: RouteLocation): TableRecord | undefined {
    return location.matched[location.matched.length - 1];
  }

  /** Same leaf record (identity) + same path string ⇒ only query/hash moved. */
  function isQueryOnlyChange(to: RouteLocation): boolean {
    const currentLeaf = leafOf(snapshot.value.location);
    const toLeaf = leafOf(to);
    return toLeaf !== undefined && toLeaf === currentLeaf && to.path === snapshot.value.location.path;
  }

  async function navigate(raw: RouteLocationRaw, opts: NavigateOptions = {}): Promise<RouterError | null> {
    const from = snapshot.value.location;

    let to: RouteLocation;
    try {
      to = resolveLocation(raw);
    } catch (error) {
      ctx.onError(error, from);
      return error as RouterError;
    }

    // Duplicate — but never short-circuit before the first commit
    // (START_LOCATION shares '/' with a common initial URL).
    if (to.fullPath === from.fullPath && to.matched.length && from.matched.length) return null;

    if (to.matched.length && isQueryOnlyChange(to)) {
      commitQueryLocation(to, opts.replace ? 'replace' : 'push', opts.popstate === true);
      refetchAffected(to, changedKeys(from.query, to.query));
      return null;
    }

    if (!to.matched.length) {
      const error = routerError('unmatched', `no route matches "${to.fullPath}"`, { to });
      ctx.onError(error, to);
      return revert(error, opts);
    }

    const id = ++pendingId;
    const cancelled = () => pendingId !== id;
    // Abort the PREVIOUS navigation's in-flight loads the moment this one
    // starts (vue-router data-loaders timing — verified against source).
    controller?.abort();
    const own = (controller = new AbortController());

    try {
      for (const guard of beforeGuards) {
        const verdict = await guard(to, from);
        if (cancelled()) return revert(routerError('cancelled', `navigation to "${to.fullPath}" superseded`, { to }), opts);
        if (verdict === false) return revert(routerError('aborted', `navigation to "${to.fullPath}" refused by guard`, { to }), opts);
        if (verdict && verdict !== true) return navigate(verdict, { replace: opts.replace });
      }

      const leaf = leafOf(to) as TableRecord;
      isLoading.value = leaf.loadChain.length > 0;
      const [render, data] = await Promise.all([
        ctx.resolveRender(leaf.renderChain, to),
        leaf.loadChain.length ? ctx.runLoaders(leaf.loadChain, to, own.signal) : Promise.resolve(EMPTY_DATA as Map<string, unknown>),
      ]);
      if (cancelled()) return revert(routerError('cancelled', `navigation to "${to.fullPath}" superseded`, { to }), opts);

      const next: RouteSnapshot = Object.freeze({ location: to, render: Object.freeze(render), data });
      if (!opts.popstate) ctx.history[opts.replace ? 'replace' : 'push'](to.fullPath);
      snapshot.value = next;
      ctx.onCommit?.(next, from, { popstate: opts.popstate === true });
      for (const hook of afterHooks) hook(to, from);
      return null;
    } catch (error) {
      if (cancelled() || isRouterError(error, 'cancelled')) {
        return revert(routerError('cancelled', `navigation to "${to.fullPath}" superseded`, { to }), opts);
      }
      const wrapped = isRouterError(error)
        ? error
        : routerError('component_load_failed', `navigation to "${to.fullPath}" failed`, { to, cause: error });
      ctx.onError(wrapped, to);
      return revert(wrapped, opts);
    } finally {
      if (pendingId === id) isLoading.value = false;
    }
  }

  function revert<E>(error: E, opts: NavigateOptions): E {
    if (opts.popstate && opts.delta) ctx.history.go(-opts.delta);
    return error;
  }

  function handlePop(fullPath: string, info: { delta: number }): void {
    if (fullPath === snapshot.value.location.fullPath) return; // our own compensating go()
    void navigate(fullPath, { popstate: true, delta: info.delta });
  }

  // ---- query fast path -------------------------------------------------------------

  /** Location commits immediately; render/data carried over. */
  function commitQueryLocation(to: RouteLocation, mode: 'push' | 'replace', popstate: boolean): void {
    if (!popstate) ctx.history[mode](to.fullPath);
    snapshot.value = Object.freeze({ location: to, render: snapshot.value.render, data: snapshot.value.data });
  }

  function changedKeys(a: QueryValues, b: QueryValues): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((key) => String(a[key] ?? '') !== String(b[key] ?? ''));
  }

  /** Background refetch of loaders affected by a query-only change. The URL
   *  and location are already committed (optimistic); data patches in when
   *  ready. Stale refetches lose: abort + fullPath check before patching. */
  function refetchAffected(to: RouteLocation, keys: readonly string[]): void {
    const leaf = leafOf(to);
    if (!leaf?.loadChain.length || !keys.length) return;
    const affected = ctx.loadAffectedBy(leaf.loadChain, keys);
    if (!affected.length) return;

    controller?.abort();
    const own = (controller = new AbortController());
    isLoading.value = true;
    void ctx
      .runLoaders(affected, to, own.signal)
      .then((fresh) => {
        if (own.signal.aborted) return;
        const current = snapshot.value;
        if (current.location.fullPath !== to.fullPath) return; // superseded meanwhile
        const data = new Map(current.data);
        for (const [key, value] of fresh) data.set(key, value);
        snapshot.value = Object.freeze({ location: current.location, render: current.render, data });
      })
      .catch((error) => {
        if (own.signal.aborted || isRouterError(error, 'cancelled')) return;
        ctx.onError(error, to); // page keeps stale data; useRouteError surfaces it
      })
      .finally(() => {
        if (controller === own) isLoading.value = false;
      });
  }

  /** Merge a typed patch into the current query and commit via the fast path. */
  function setQuery(
    patch: QueryPatch,
    opts: { history?: 'push' | 'replace' },
    resolveMode: (key: string) => 'push' | 'replace',
  ): void {
    const current = snapshot.value.location;
    const merged: Record<string, unknown> = { ...current.query };
    let mode: 'push' | 'replace' = 'replace';
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value === null || value === undefined) {
        delete merged[key];
        continue;
      }
      merged[key] = Array.isArray(value) ? value.map(String) : String(value);
      if (resolveMode(key) === 'push') mode = 'push';
    }
    const search = stringifyQuery(merged);
    const to: RouteLocation = {
      ...current,
      query: merged as QueryValues,
      fullPath: current.path + (search ? `?${search}` : '') + current.hash,
    };
    if (to.fullPath === current.fullPath) return;
    const changed = changedKeys(current.query, to.query);
    commitQueryLocation(to, opts.history ?? mode, false);
    refetchAffected(to, changed);
  }

  /** HOT PATH — patch loader data directly, skipping loaders entirely (the
   *  fast-lane counterpart for route data). For when fresh state is already
   *  in hand: a bus command's response, a websocket push, an optimistic
   *  update. Snapshot rules preserved: one new frozen snapshot, reactive. */
  function setRouteData(recordName: string, value: unknown): void {
    const current = snapshot.value;
    const data = new Map(current.data);
    data.set(recordName, value);
    snapshot.value = Object.freeze({ location: current.location, render: current.render, data });
  }

  return {
    snapshot,
    isLoading,
    navigate,
    resolveLocation,
    handlePop,
    setQuery,
    setRouteData,
    beforeEach: (guard: NavigationGuard) => {
      beforeGuards.push(guard);
      return () => {
        const i = beforeGuards.indexOf(guard);
        if (i >= 0) beforeGuards.splice(i, 1);
      };
    },
    afterEach: (hook: AfterEachHook) => {
      afterHooks.push(hook);
      return () => {
        const i = afterHooks.indexOf(hook);
        if (i >= 0) afterHooks.splice(i, 1);
      };
    },
  };
}

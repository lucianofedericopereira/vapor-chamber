/**
 * vapor-chamber-router - the navigation engine. Vue 3.6-native: router state
 * IS a shallowRef (alien-signals-backed in 3.6) - no bridge layer.
 *
 * The two-layer URL model:
 *   PATH change   -> resolve -> guards -> components + loaders (parallel, with
 *                   an AbortController created per navigation; starting a new
 *                   navigation aborts the previous one's fetches immediately)
 *                   -> ONE atomic frozen snapshot commit (two-phase: data
 *                   loads during, commits with - a page never renders with
 *                   the previous page's data).
 *   QUERY/HASH-only change -> fast path: location commits immediately (no
 *                   matching, no guards, no remount); loaders whose template
 *                   depends on a changed key refetch in the background and
 *                   patch `snapshot.data` when done (isLoading tracks it).
 *
 * `navigate()` resolves to `RouterError | null` - null means committed.
 * Guard refusals (`refused:guard`) and superseded navigations
 * (`aborted:navigation`) are returned but NOT dispatched to onError.
 */

import { DEV } from '../dev';
import { dict } from '../dict';
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

/**
 * The location before the first commit, and a MODULE-LEVEL SINGLETON - one
 * object shared by every router in the process and exported publicly as a
 * sentinel. Both of its details are load-bearing:
 *
 * `Object.freeze` reaches one level, so the nested `params` / `query` / `meta`
 * are frozen too: otherwise `useRoute().value.params.id = 1` before the router
 * is ready would edit a global every other router hands out. Frozen
 * unconditionally rather than under DEV like ../freeze: this is four
 * empty objects frozen once at module load, so there is no per-commit cost to
 * weigh, and a shared constant is exactly where a silent write does the most
 * damage.
 *
 * `query` is a `dict()` because every OTHER query in this engine is - both arms
 * of resolveLocation, cleanQueryPatch, and setQuery stay prototype-free so a
 * consumer never has to know which branch built the query (a literal `{}` here
 * would make `route.query.constructor` answer before the first navigation and
 * not after it).
 */
export const START_LOCATION: RouteLocation = Object.freeze({
  name: null,
  path: '/',
  fullPath: '/',
  params: Object.freeze({}),
  query: Object.freeze(dict<string | string[]>()),
  hash: '',
  matched: Object.freeze([]),
  meta: Object.freeze({}),
});

const EMPTY_DATA: ReadonlyMap<string, unknown> = new Map();

/** A guard chain that keeps redirecting is a bug in the guards, not a slow
 *  navigation - bound it rather than looping forever. Ten is far above any
 *  legitimate chain (auth -> locale -> onboarding is three). */
const MAX_REDIRECTS = 10;

/** Absent, '' and [] are the same query value; ['a'] and 'a' are the same
 *  query value; ['a','b'] and 'a,b' are NOT. */
function sameQueryValue(a: string | string[] | undefined, b: string | string[] | undefined): boolean {
  const norm = (value: string | string[] | undefined): readonly string[] =>
    value === undefined ? [''] : Array.isArray(value) ? (value.length ? value.map(String) : ['']) : [String(value)];
  const left = norm(a);
  const right = norm(b);
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

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
  /** Real failures only - refusals never arrive here. */
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
  /** True while at least one stale-while-revalidate refresh is in flight. */
  const isRevalidating = shallowRef(false);

  const beforeGuards: NavigationGuard[] = [];
  const afterHooks: AfterEachHook[] = [];
  let pendingId = 0;
  /** The id of the path navigation in flight; 0 when none. */
  let inFlight = 0;

  // Two lanes, two controllers. They MUST NOT share one: a query REFETCH
  // aborting the controller would kill an in-flight PATH navigation's loaders,
  // and because runLoaders maps an aborted signal to an `aborted:navigation` RouterError,
  // the engine reads that as supersession - the navigation is dropped without
  // ever reaching onError. A query COMMIT does supersede it, on purpose and
  // through `supersede()` (commitQueryLocation).
  let navController: AbortController | null = null;
  let refetchController: AbortController | null = null;

  // `isLoading` is DERIVED, never assigned from a lane directly: with two lanes
  // writing one flag, a finishing navigation would clear it while a query
  // refetch is still in flight.
  let navLoading = false;
  let refetchLoading = false;
  function syncLoading(): void {
    isLoading.value = navLoading || refetchLoading;
  }

  // Revalidation is a THIRD lane, and deliberately not folded into
  // `isLoading`: a stale-while-revalidate hit commits real data immediately,
  // so the page is not loading - it is showing something while a refresh runs
  // behind it. That distinction is the one thing swrv's `isValidating` names
  // that this router had no word for. A counter rather than a boolean, since
  // several records in one chain can revalidate at once.
  let revalidateCount = 0;
  function syncRevalidating(): void {
    isRevalidating.value = revalidateCount > 0;
  }

  /**
   * A loader preset serving stale data reports its background refresh here
   * (`LoaderHandlers.onRevalidate`). The fresh value patches into the snapshot
   * exactly like a query refetch: only if this location is still the committed
   * one, and always as a new frozen snapshot.
   */
  function trackRevalidation(recordName: string, revalidation: Promise<unknown>, to: RouteLocation): void {
    revalidateCount++;
    // The chain that lowers the count is built in the `finally`: a sync
    // subscriber throwing on the write cannot leave `isRevalidating` stuck
    // (pinned by tests/router/engine-throwing-subscriber.test.ts).
    try {
      syncRevalidating();
    } finally {
      void revalidation
        .then((fresh) => {
          const current = snapshot.value;
          if (current.location.fullPath !== to.fullPath) return; // navigated away - drop it
          setRouteData(recordName, fresh);
        })
        .catch(() => {
          // A failed background refresh leaves the stale data in place. It is
          // not a navigation failure and must not reach ctx.onError: the commit
          // already succeeded, and `cache.serveStaleOnError` exists precisely so
          // this degrades quietly.
        })
        .finally(() => {
          revalidateCount--;
          syncRevalidating();
        });
    }
  }

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
    if (!table) throw routerError('missing:routes', 'routes not loaded yet - await router.isReady()');

    if (typeof raw === 'string') {
      const hashIndex = raw.indexOf('#');
      const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
      const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
      const queryIndex = beforeHash.indexOf('?');
      const path = (queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash) || '/';
      // Prototype-free on BOTH arms - a consumer must not have to know which
      // branch built the query to know whether `query.constructor` is theirs.
      const query = queryIndex >= 0 ? parseQuery(beforeHash.slice(queryIndex)) : dict<string | string[]>();
      return buildLocation(path, query, hash, table.resolve(path));
    }

    const hash = raw.hash ?? '';
    const query = cleanQueryPatch(raw.query);
    if (raw.name) {
      const record = table.getRecord(raw.name);
      if (!record) throw routerError('missing:record', `unknown route name "${raw.name}"`);
      // Param inheritance: missing params default from the current location -
      // push({ name }) keeps e.g. the :locale segment of /admin/:locale/...
      // without every call site carrying it (vue-router semantics).
      const path = table.buildPath(record, { ...snapshot.value.location.params, ...raw.params });
      return buildLocation(path, query, hash, table.resolve(path));
    }
    const path = raw.path ?? snapshot.value.location.path;
    return buildLocation(path, query, hash, table.resolve(path));
  }

  function cleanQueryPatch(patch: QueryPatch | undefined): QueryValues {
    // This path reads only own keys off `patch`, so it never had the lookup bug
    // - but the object it RETURNS becomes `location.query`, which must be
    // uniform with parseQuery's. See `../dict`.
    const query: QueryValues = dict<string | string[]>();
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

  /** Same leaf record (identity) + same path string => only query/hash moved. */
  function isQueryOnlyChange(to: RouteLocation): boolean {
    const currentLeaf = leafOf(snapshot.value.location);
    const toLeaf = leafOf(to);
    return toLeaf !== undefined && toLeaf === currentLeaf && to.path === snapshot.value.location.path;
  }

  async function navigate(
    raw: RouteLocationRaw,
    opts: NavigateOptions = {},
    /** Guard-redirect depth. Internal - the public push/replace never pass it. */
    redirects = 0,
  ): Promise<RouterError | null> {
    const from = snapshot.value.location;

    let to: RouteLocation;
    try {
      to = resolveLocation(raw);
    } catch (error) {
      ctx.onError(error, from);
      return error as RouterError;
    }

    // Duplicate - but never short-circuit before the first commit
    // (START_LOCATION shares '/' with a common initial URL). The page on
    // screen, asked for again, supersedes a navigation still in flight like
    // any newer one: answering null and letting that one commit afterwards
    // left the user on the page they had navigated away from. With nothing in
    // flight it changes nothing (the committed navigation's controller is not
    // aborted). tests/router/navigation-to-current-page.test.ts.
    if (to.fullPath === from.fullPath && to.matched.length && from.matched.length) {
      if (inFlight) supersede();
      return null;
    }

    if (to.matched.length && isQueryOnlyChange(to)) {
      commitQueryLocation(to, opts.replace ? 'replace' : 'push', opts.popstate === true);
      refetchAffected(to, changedKeys(from.query, to.query));
      return null;
    }

    if (!to.matched.length) {
      const error = routerError('missing:route', `no route matches "${to.fullPath}"`, { to });
      ctx.onError(error, to);
      return revert(error, opts);
    }

    const id = ++pendingId;
    inFlight = id;
    const cancelled = () => pendingId !== id;
    // Abort the PREVIOUS navigation's in-flight loads the moment this one
    // starts (vue-router data-loaders timing - verified against source), and
    // any query refetch too: its results are keyed to a snapshot this
    // navigation is about to replace.
    navController?.abort();
    refetchController?.abort();
    const own = (navController = new AbortController());
    let committed = false;

    try {
      // Indexed, not for...of: a guard's unsubscribe closure splices this same
      // array, so a self-removing guard - `const off = router.beforeEach(() =>
      // { off(); ... })`, the one-shot pattern - shifts it under a live iterator
      // and the next guard is silently skipped for this navigation. Same lesson
      // the bus learned in `fanOutListeners`, INCLUDING its correction: the
      // cursor moves by IDENTITY, not by length. A guard that removes a LATER
      // peer shrinks the array without moving anything at or before `i`, so a
      // bare `i -= shrinkage` walked the cursor back onto the guard that had
      // just run and re-awaited it. `beforeGuards[i] !== guard` is the exact
      // test for "the cursor moved". Here the loop is async, so both are
      // compared after each await.
      for (let i = 0; i < beforeGuards.length; i++) {
        const lenBefore = beforeGuards.length;
        const guard = beforeGuards[i];
        let verdict;
        try {
          verdict = await guard(to, from);
        } catch (cause) {
          // A guard's throw is a bug in app code: its own code, not a hard
          // navigation (the server cannot fix it), the throw as its cause.
          throw routerError('failed:guard', `guard threw navigating to "${to.fullPath}"`, { to, cause });
        }
        if (beforeGuards.length < lenBefore && beforeGuards[i] !== guard) {
          i -= lenBefore - beforeGuards.length;
        }
        if (cancelled()) return routerError('aborted:navigation', `navigation to "${to.fullPath}" superseded`, { to });
        if (verdict === false) return revert(routerError('refused:guard', `navigation to "${to.fullPath}" refused by guard`, { to }), opts);
        if (verdict && verdict !== true) {
          // Bounded: two guards that redirect at each other would otherwise
          // recurse forever - async, so no stack overflow to point at, just a
          // navigation that never resolves.
          if (redirects >= MAX_REDIRECTS) {
            // Code unconditional, explanatory tail DEV-only - the same shape
            // the Vapor outlet uses for invalid:component. Handlers switch on
            // `code`, so the tail is for the person reading the console, and a
            // production bundle drops the string in one step. This module is
            // on the shared side of the outlet size guard, so prose that only
            // helps in dev is not worth shipping to every consumer.
            const error = routerError(
              'exceeded:redirects',
              `redirect loop navigating to "${to.fullPath}"${
                DEV ? ` - exceeded ${MAX_REDIRECTS} hops; a guard is redirecting to a location another guard redirects back from` : ''
              }`,
              { to },
            );
            ctx.onError(error, to);
            return revert(error, opts);
          }
          // `replace` on a popstate redirect. The browser has ALREADY moved to
          // the entry being redirected away from, so pushing would leave that
          // entry behind and Back would land on it again - the redirect fires
          // once more and the user is stuck. Replacing consumes it.
          const result = await navigate(verdict, { replace: opts.replace || opts.popstate === true }, redirects + 1);
          // Unwound through every frame, so the ORIGINAL popstate frame - the
          // only one holding the delta - still compensates the history walk.
          // Inner frames carry no delta, so their revert() is a no-op.
          return isRouterError(result, 'router:exceeded:redirects') ? revert(result, opts) : result;
        }
      }

      const leaf = leafOf(to) as TableRecord;
      navLoading = leaf.loadChain.length > 0;
      syncLoading();
      const [render, data] = await Promise.all([
        ctx.resolveRender(leaf.renderChain, to),
        leaf.loadChain.length ? ctx.runLoaders(leaf.loadChain, to, own.signal) : Promise.resolve(EMPTY_DATA as Map<string, unknown>),
      ]);
      if (cancelled()) return routerError('aborted:navigation', `navigation to "${to.fullPath}" superseded`, { to });

      const next: RouteSnapshot = Object.freeze({ location: to, render: Object.freeze(render), data });
      if (!opts.popstate) {
        try {
          ctx.history[opts.replace ? 'replace' : 'push'](to.fullPath);
        } catch (cause) {
          // A history the app supplied threw writing the URL: its own code,
          // not a component failure, and not a hard navigation (log s35.118).
          throw routerError('failed:history', `writing the URL "${to.fullPath}" failed`, { to, cause });
        }
      }
      // `committed` is set BEFORE the write and the hooks run in its
      // `finally`: a sync subscriber of the snapshot that throws is a
      // post-commit observer like any other (pinned by
      // tests/router/engine-throwing-subscriber.test.ts).
      committed = true;
      try {
        snapshot.value = next;
      } finally {
        ctx.onCommit?.(next, from, { popstate: opts.popstate === true });
        runAfterHooks(to, from);
      }
      return null;
    } catch (error) {
      // A post-commit observer must never re-enter the pre-commit failure
      // path. `committed` is the boundary: past it the navigation succeeded,
      // the URL moved, and the snapshot is live - reporting `onError` and
      // running `revert()` (which on a popstate walks the URL back while the
      // snapshot still shows the new page) would manufacture a phantom
      // failure. runAfterHooks contains its own throws, so in practice only
      // ctx.onCommit and a throwing subscriber of the snapshot land here
      // after the commit.
      if (committed) {
        console.error('[vapor-chamber-router] post-commit hook threw (logged, not fatal)', error);
        return null;
      }
      if (cancelled() || isRouterError(error, 'router:aborted:navigation')) {
        return routerError('aborted:navigation', `navigation to "${to.fullPath}" superseded`, { to });
      }
      const wrapped = isRouterError(error)
        ? error
        : routerError('failed:component', `navigation to "${to.fullPath}" failed`, { to, cause: error });
      ctx.onError(wrapped, to);
      return revert(wrapped, opts);
    } finally {
      if (pendingId === id) {
        inFlight = 0;
        navLoading = false;
        syncLoading();
      }
    }
  }

  /** Supersede the path navigation in flight, as a newer one would: it
   *  answers `cancelled` at its next check, its loaders are aborted, and its
   *  loading state is cleared here because no successor will clear it. */
  function supersede(): void {
    pendingId++;
    inFlight = 0;
    navController?.abort();
    navLoading = false;
    syncLoading();
  }

  /**
   * After-hooks are post-commit observers - user surface (`router.afterEach`)
   * *and* internal (the active-link stamp registers here). Two rules, both
   * learned elsewhere in this codebase:
   *
   * - **Each hook is contained.** One throwing analytics hook must not wrap a
   *   committed navigation as `failed:component`, fire `ctx.onError`, and
   *   `revert()` the URL out from under a live snapshot. The bus's
   *   `fanOutListeners` does it the same way (logs "Listener error", not fatal).
   * - **Self-removal doesn't skip a neighbour, and doesn't re-run one either.**
   *   The unsubscribe closure splices this array, so the one-shot pattern
   *   (`const off = router.afterEach(() => { off(); ... })` - "scroll to top on
   *   this next navigation") would shift it under a `for...of` iterator. As in
   *   `fanOutListeners`, the cursor moves by IDENTITY, not by length: a hook
   *   that tears down a LATER sibling shrinks the array without moving anything
   *   at or before `i`, and a bare `i -= shrinkage` would re-run the hook that
   *   had just fired.
   */
  function runAfterHooks(to: RouteLocation, from: RouteLocation): void {
    for (let i = 0; i < afterHooks.length; i++) {
      const lenBefore = afterHooks.length;
      const hook = afterHooks[i];
      try {
        hook(to, from);
      } catch (error) {
        console.error('[vapor-chamber-router] afterEach hook threw (logged, not fatal)', error);
      }
      if (afterHooks.length < lenBefore && afterHooks[i] !== hook) {
        i -= lenBefore - afterHooks.length;
      }
    }
  }

  /**
   * A REFUSED or failed popstate navigation walks the history back, so the
   * address bar returns to the page still on screen. A CANCELLED one never
   * comes here: the user replaced it with a newer navigation, and the browser
   * is already where that one put it. Walking back from there stepped into a
   * third navigation (two quick Backs during a slow page ended a page off,
   * with the address bar on another), and after `cancel()` it would move the
   * page under whatever replaces the router.
   * tests/router/superseded-navigation-history.test.ts.
   */
  function revert<E>(error: E, opts: NavigateOptions): E {
    if (opts.popstate && opts.delta) ctx.history.go(-opts.delta);
    return error;
  }

  /** Every pop navigates. One that lands on the page on screen is a
   *  duplicate: our own compensating go() after a refusal (nothing in flight,
   *  answered null), or a Forward back to the page during a pending Back,
   *  which supersedes that Back. */
  function handlePop(fullPath: string, info: { delta: number }): void {
    void navigate(fullPath, { popstate: true, delta: info.delta });
  }

  // ---- query fast path -------------------------------------------------------------

  /** Location commits immediately; render/data carried over. */
  function commitQueryLocation(to: RouteLocation, mode: 'push' | 'replace', popstate: boolean): void {
    // The latest request wins: a page navigation still in flight is superseded
    // (it answers `aborted:navigation`), or it would commit over this query
    // and lose it. The refetch lane is untouched. Log s35.120.
    if (inFlight) supersede();
    if (!popstate) ctx.history[mode](to.fullPath);
    snapshot.value = Object.freeze({ location: to, render: snapshot.value.render, data: snapshot.value.data });
  }

  /**
   * Which query keys actually differ.
   *
   * Compared element-wise, not through `String()`, which would fold an ARRAY
   * into a comma-joined scalar: `?tag=a&tag=b` and `?tag=a,b` are different
   * queries, and the loader that depends on `tag` must refetch. `'a'` equals
   * `['a']`, and `''`, `[]` and an absent key collapse together.
   */
  function changedKeys(a: QueryValues, b: QueryValues): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((key) => !sameQueryValue(a[key], b[key]));
  }

  /** Background refetch of loaders affected by a query-only change. The URL
   *  and location are already committed (optimistic); data patches in when
   *  ready. Stale refetches lose: abort + fullPath check before patching. */
  function refetchAffected(to: RouteLocation, keys: readonly string[]): void {
    const leaf = leafOf(to);
    if (!leaf?.loadChain.length || !keys.length) return;
    const affected = ctx.loadAffectedBy(leaf.loadChain, keys);
    if (!affected.length) return;

    refetchController?.abort();
    const own = (refetchController = new AbortController());
    refetchLoading = true;
    // The loaders start in the `finally`, as in trackRevalidation: a sync
    // subscriber throwing on the write cannot leave `isLoading` stuck.
    try {
      syncLoading();
    } finally {
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
          if (own.signal.aborted || isRouterError(error, 'router:aborted:navigation')) return;
          ctx.onError(error, to); // page keeps stale data; useRouteError surfaces it
        })
        .finally(() => {
          if (refetchController === own) {
            refetchLoading = false;
            syncLoading();
          }
        });
    }
  }

  /** Merge a typed patch into the current query and commit via the fast path. */
  function setQuery(
    patch: QueryPatch,
    opts: { history?: 'push' | 'replace' },
    resolveMode: (key: string) => 'push' | 'replace',
  ): void {
    const current = snapshot.value.location;
    // `Object.assign(dict(), ...)`, never `{ ...current.query }`: a SPREAD of a
    // null-prototype object produces a plain one, so `location.query` would be
    // prototype-free after navigate() and plain after setQuery(), and a
    // `__proto__` write here would vanish through the inherited setter. See
    // `../dict`.
    const merged: Record<string, unknown> = Object.assign(dict<string | string[]>(), current.query);
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

  /** HOT PATH - patch loader data directly, skipping loaders entirely (the
   *  fast-lane counterpart for route data). For when fresh state is already
   *  in hand: a bus command's response, a websocket push, an optimistic
   *  update. Snapshot rules preserved: one new frozen snapshot, reactive. */
  function setRouteData(recordName: string, value: unknown): void {
    // A typo'd recordName creates an orphan entry no outlet ever reads, so it
    // is loud in dev and lenient in prod, checked against the compiled table.
    if (DEV) {
      const table = ctx.getTable();
      if (table && !table.getRecord(recordName)) {
        console.warn(
          `[vapor-chamber-router] setRouteData("${recordName}") - no route record by that name. ` +
            'The value lands in the snapshot but no outlet reads it (useRouteData resolves by record name). ' +
            'Check the spelling against your route table.',
        );
      }
    }
    const current = snapshot.value;
    const data = new Map(current.data);
    data.set(recordName, value);
    snapshot.value = Object.freeze({ location: current.location, render: current.render, data });
  }

  return {
    snapshot,
    isLoading,
    isRevalidating,
    trackRevalidation,
    navigate,
    resolveLocation,
    handlePop,
    setQuery,
    setRouteData,
    /** Cancel the navigation in flight, as a newer one would (router.destroy).
     *  No successor will clear the loading flag, so this does; a cancelled
     *  navigation walks no history back (see revert). */
    cancel: () => {
      supersede();
      refetchController?.abort();
    },
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

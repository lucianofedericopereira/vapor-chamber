/**
 * vapor-chamber/router — router for Vue 3.6 over a server-owned catch-all.
 *
 * Hard requirement by design: Vue >= 3.6. Rows come from a server-side route
 * generator emitting the RouteRecord schema (types.ts).
 * The server owns one catch-all (`/admin/{any?}` → Blade shell → one island);
 * this router owns every URL inside it. Path = navigation, query = state.
 *
 * Route table delivery:
 *   routes: adminRoutes                          // generated TS module — primary
 *   routes: { inline: '#vcr-routes' }            // Blade-inlined, per-user filtered
 *   routes: { url: '/api/vc/routes' }            // admin tasks / router.reload()
 *
 * Data delivery: each row's `load` string is resolved by a loader PRESET (see
 * loaders.ts SPI) — `vapor-chamber/router-fetch` (in-box, plain JSON backends)
 * or your own LoaderHandlers for any other backend convention.
 *
 * `createRouter()` is pure — IO and listeners begin at start()/app.use().
 */

import { createHttpClient } from '../http';
import type { HttpClient } from '../http';
import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import { makeBladeComponent } from './blade';
import { installDomIntegration, preheatIdle, stampActiveLinks } from './dom';
import { createEngine } from './engine';
import { HARD_NAV_CODES, isRouterError, routerError } from './errors';
import { type RouterHistory, canUseWebHistory, createMemoryHistory, createWebHistory, stripBase } from './history';
import { ROUTER_KEY } from './keys';
import { type LoaderHandlers, defaultAffects, runLoaders } from './loaders';
import { RouterOutlet } from './outlet';
import type { Router } from './router-type';
import { type RouteTable, createRouteTable } from './table';
import type {
  ComponentMap,
  QueryParamDef,
  QueryPatch,
  RenderEntry,
  RouteLocation,
  RouteLocationRaw,
  RouteRecord,
  RoutesPayload,
  TableRecord,
} from './types';
import { resolveQueryHistory } from './url';

// ---- public surface ------------------------------------------------------------

export { makeBladeComponent } from './blade';
export type { BladeHooks } from './blade';
export {
  onBeforeLeave,
  useBreadcrumbs,
  useMenu,
  useQueryParam,
  useRoute,
  useRouteData,
  useRouteError,
  useRouter,
  usePagination,
} from './composables';
export type { Pagination, PaginationOptions, QueryParamHandle } from './composables';
export { buildBreadcrumbs, buildMenu } from './menu';
export type { Breadcrumb, MenuItem } from './menu';
export { preheatIdle, stampActiveLinks } from './dom';
export { START_LOCATION } from './engine';
export { HARD_NAV_CODES, isRouterError, routerError } from './errors';
export type { RouterError, RouterErrorCode } from './errors';
export { canUseWebHistory, createMemoryHistory, createWebHistory, normalizeBase, resolveBase, stripBase } from './history';
export type { ResolveBaseOptions } from './history';
export type { RouterHistory } from './history';
export { defaultAffects, interpolateLoad, runLoaders } from './loaders';
export type { LoaderHandlers, PrefixHandler, UrlHandler } from './loaders';
export { RouterOutlet } from './outlet';
export type { Router } from './router-type';
export { compilePath, createRouteTable } from './table';
export type { RouteTable } from './table';
export type * from './types';
export { decodeQueryParam, encodeQueryParam, parseQuery, pathActivity, resolveQueryHistory, stringifyQuery } from './url';

export type RoutesSource =
  | readonly RouteRecord[]
  | RoutesPayload
  | { inline: string }
  | { url: string };

export type RouterOptions = {
  /** Mount base, e.g. '/admin'. Falls back to the payload's base, then ''. */
  base?: string;
  routes: RoutesSource;
  /** component key → component | () => import(...) */
  components?: ComponentMap;
  /** Loader preset resolving `load` values — vapor-chamber/router-fetch (in-box)
   *  or your own LoaderHandlers. Routes without `load` never need this. */
  loaders?: LoaderHandlers;
  /** Override history (createMemoryHistory for tests/SSR). Default: web. */
  history?: RouterHistory;
  /** Override the http client (tests). Default: chamber client with
   *  X-Vapor-Router marker. */
  http?: HttpClient;
  /** Document-level link interception + active stamping + hover preheat.
   *  Default: true in the browser. */
  links?: boolean;
  /** Selector scoping data-active stamping (e.g. the admin shell) — stamping
   *  walks only this subtree instead of the whole document. Interception
   *  stays document-level. */
  linksRoot?: string;
  /** Island hooks for blade rows — app conventions injected, never assumed. */
  hydrate?: (el: Element) => unknown;
  dehydrate?: (el: Element) => unknown;
  /** Fetch server HTML for blade rows. Default: http client + bladeRoot. */
  fetchBlade?: (href: string) => Promise<string>;
  /** Selector extracted from fetched blade HTML. Default: 'main'. */
  bladeRoot?: string;
  /** Terminal error handler. Default: hard-navigate on HARD_NAV_CODES, log
   *  the rest. */
  onError?: (error: unknown, to: RouteLocation) => void;
  /** Scroll to top after committed push navigations. Default: true. */
  scroll?: boolean;
};

/** Accept a bare RoutesPayload or the house envelope { ok: true, state }. */
export function unwrapRoutesPayload(raw: unknown): RoutesPayload {
  const candidate = raw as { ok?: boolean; state?: unknown; error?: string } & RoutesPayload;
  if (candidate && typeof candidate === 'object' && 'ok' in candidate) {
    if (candidate.ok !== true) {
      throw routerError('routes_load_failed', `routes endpoint failed: ${candidate.error ?? 'unknown error'}`);
    }
    return candidate.state as RoutesPayload;
  }
  if (!candidate || !Array.isArray(candidate.routes)) {
    throw routerError('invalid_routes_payload', 'routes payload has no routes array');
  }
  return candidate;
}

// ---- assembly ---------------------------------------------------------------------

/**
 * Read an inline route payload synchronously, for the one thing that cannot
 * wait: `base`, which the history needs before anything else happens.
 *
 * Deliberately total — a missing element, malformed JSON or a non-DOM
 * environment all return null and leave the real diagnosis to
 * `loadInlineTable()` during start(), which throws a coded router error. This
 * runs inside the constructor, and the constructor is documented as pure.
 */
function readInlinePayload(selector: string): RoutesPayload | null {
  if (typeof document === 'undefined') return null;
  try {
    const text = document.querySelector(selector)?.textContent;
    return text ? unwrapRoutesPayload(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function createRouter<TName extends string = string>(options: RouterOptions): Router<TName> {
  const hasWindow = typeof window !== 'undefined';

  const source = options.routes;
  const syncPayload: RoutesPayload | null = Array.isArray(source)
    ? { routes: source }
    : 'routes' in (source as RoutesPayload)
      ? (source as RoutesPayload)
      : 'inline' in (source as { inline?: string })
        ? // An inline payload is already in the DOM, so read it NOW rather than
          // at start(): `base` has to be known before the history is created,
          // and a payload-declared base that arrives later is a base that never
          // applies. Without this, `{ inline }` + a payload base silently ran
          // on base '' — every link fell outside the base, nothing was
          // intercepted, and every in-app navigation was a full page load.
          readInlinePayload((source as { inline: string }).inline)
        : null;

  const base = options.base ?? syncPayload?.base ?? '';
  // Probe before touching the History API: sandboxed/srcdoc iframes and
  // data: documents throw SecurityError on replaceState. Embedded contexts
  // degrade to a memory history seeded from the (still readable) location,
  // so a preview renders the right route without crashing at boot.
  const history =
    options.history ??
    (hasWindow && canUseWebHistory()
      ? createWebHistory(base)
      : createMemoryHistory(
          base,
          hasWindow
            ? (stripBase(window.location.pathname, normalizeBaseSafe(base)) ?? '/') + window.location.search + window.location.hash
            : '/',
        ));
  const http: HttpClient = options.http ?? createHttpClient({ headers: { 'X-Vapor-Router': '1' } });
  const loaders: LoaderHandlers = options.loaders ?? {};
  // The affect policy is resolved once: loaders are fixed for the router's life
  // (setRoutes swaps rows, never loaders), so there is nothing to recompute per
  // navigation or per table swap.
  const affects: (record: TableRecord, keys: readonly string[]) => boolean =
    loaders.affects ?? ((record, keys) => defaultAffects(record, keys, loaders));

  // A ref so table projections (router.routes → useMenu) track swaps from
  // start()/{ url } loads, setRoutes() and reload().
  const tableRef = shallowRef<RouteTable | null>(syncPayload ? createRouteTable(syncPayload.routes) : null);

  // ---- render resolution (component cache + blade wrapping) ------------------

  const componentCache = new Map<string, unknown>();

  async function loadComponent(record: TableRecord, to: RouteLocation): Promise<unknown> {
    const key = record.component as string;
    const cached = componentCache.get(key);
    if (cached !== undefined) return cached;
    const entry = options.components?.[key];
    if (entry === undefined) {
      throw routerError('component_missing', `no component registered for key "${key}"`, { to });
    }
    if (typeof entry === 'function' && !isComponentLike(entry)) {
      let mod: unknown;
      try {
        mod = await (entry as () => Promise<unknown>)();
      } catch (cause) {
        // Stale chunk after a deploy — default handler hard-navigates.
        throw routerError('component_load_failed', `failed to load component "${key}"`, { to, cause });
      }
      const component = unwrapModule(mod);
      componentCache.set(key, component);
      return component;
    }
    componentCache.set(key, entry);
    return entry;
  }

  const fetchBlade =
    options.fetchBlade ?? (hasWindow ? defaultFetchBlade(http, options.bladeRoot ?? 'main') : undefined);

  async function resolveRender(records: readonly TableRecord[], to: RouteLocation): Promise<RenderEntry[]> {
    return Promise.all(
      records.map(async (record): Promise<RenderEntry> => {
        if (record.blade) {
          if (!fetchBlade) {
            throw routerError('blade_unconfigured', `blade route "${record.name}" hit but no fetchBlade available`, {
              to,
            });
          }
          let html: string;
          try {
            html = await fetchBlade(history.createHref(to.fullPath));
          } catch (cause) {
            throw routerError('blade_fetch_failed', `blade fetch failed for "${to.fullPath}"`, { to, cause });
          }
          return {
            record,
            component: makeBladeComponent(html, { hydrate: options.hydrate, dehydrate: options.dehydrate }),
          };
        }
        return { record, component: await loadComponent(record, to) };
      }),
    );
  }

  // ---- engine + errors ---------------------------------------------------------

  const errorSubscribers = new Set<(error: unknown, to: RouteLocation) => void>();
  const lastError = shallowRef<unknown>(null);

  function dispatchError(error: unknown, to: RouteLocation): void {
    lastError.value = error;
    for (const subscriber of errorSubscribers) subscriber(error, to);
    if (options.onError) {
      options.onError(error, to);
      return;
    }
    if (hasWindow && isRouterError(error) && HARD_NAV_CODES.has(error.code)) {
      const href = history.createHref(to.fullPath);
      // Handing the URL back to the server only helps if the server can answer
      // it differently. Under the catch-all this router is built for, it
      // cannot: the shell comes back, the router says `unmatched` again, and
      // location.assign() fires again — an endless reload storm that survives
      // refreshes, because the offending URL stays in the address bar.
      // Hard-navigate only when it actually moves us somewhere else.
      const here = window.location.pathname + window.location.search + window.location.hash;
      if (href !== here) {
        window.location.assign(href);
        return;
      }
      if (process.env.NODE_ENV !== 'production') {
        console.error(
          `[vapor-chamber-router] ${error.code} for "${href}", which is already the current URL — refusing to hard-navigate (it would reload forever behind a catch-all). Add a catch-all row (path: "/*") so the client can render its own 404.`,
          error,
        );
        return;
      }
    }
    console.error(error);
  }

  const engine = createEngine({
    getTable: () => tableRef.value,
    history,
    resolveRender,
    runLoaders: (records, to, signal) => runLoaders(loaders, records, to, signal),
    loadAffectedBy: (records, keys) => records.filter((record) => affects(record, keys)),
    onError: dispatchError,
    onCommit: (snapshot, _from, info) => {
      if (options.scroll === false || !hasWindow) return;
      const hash = snapshot.location.hash;
      if (hash) {
        try {
          const anchor = document.querySelector(hash);
          if (anchor) {
            anchor.scrollIntoView();
            return;
          }
        } catch {
          /* invalid selector in hash — fall through */
        }
      }
      if (!info.popstate) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
  });

  // ---- start (all IO and listeners — the constructor is pure) -------------------

  let started: Promise<void> | null = null;
  const teardowns: Array<() => void> = [];

  async function loadRemoteTable(url: string): Promise<void> {
    try {
      const response = await http.get<unknown>(url, { retry: 2 });
      const payload = unwrapRoutesPayload(response.data);
      if (process.env.NODE_ENV !== 'production') warnRemoteBase(payload);
      tableRef.value = createRouteTable(payload.routes);
    } catch (cause) {
      throw isRouterError(cause)
        ? cause
        : routerError('routes_load_failed', `could not load routes from "${url}"`, { cause });
    }
  }

  function loadInlineTable(selector: string): void {
    if (typeof document === 'undefined') {
      throw routerError('inline_routes_missing', 'inline routes need a DOM — pass rows or { url } instead');
    }
    const el = document.querySelector(selector);
    if (!el?.textContent) {
      throw routerError('inline_routes_missing', `no inline routes element matches "${selector}"`);
    }
    tableRef.value = createRouteTable(unwrapRoutesPayload(JSON.parse(el.textContent)).routes);
  }

  /** Remote payloads cannot inform `base` — the history exists before the
   *  fetch resolves. Say so loudly in dev instead of running on the wrong
   *  base, which manifests as "no link is ever intercepted". */
  function warnRemoteBase(payload: RoutesPayload): void {
    if (payload.base && payload.base !== history.base && options.base === undefined) {
      console.warn(
        `[vapor-chamber-router] the fetched route payload declares base "${payload.base}", but the router was already created with base "${history.base}". A remote payload arrives after the history is built — pass \`base\` to createRouter() explicitly (or deliver the table inline).`,
      );
    }
  }

  function preheatPath(path: string): void {
    const hit = tableRef.value?.resolve(path);
    if (!hit) return;
    for (const record of hit.record.renderChain) {
      if (record.component && !componentCache.has(record.component)) {
        void loadComponent(record, engine.snapshot.value.location).catch(() => {});
      }
    }
  }

  function start(): Promise<void> {
    if (started) return started;
    started = (async () => {
      if (!tableRef.value) {
        if ('inline' in (source as { inline?: string })) loadInlineTable((source as { inline: string }).inline);
        else await loadRemoteTable((source as { url: string }).url);
      }

      teardowns.push(history.listen((fullPath, info) => engine.handlePop(fullPath, { delta: info.delta })));

      // Idle preheat: rows flagged meta.preheat load their lazy components
      // after the page settles (saveData/2g-aware, aborts on interaction).
      // Re-armable — the original wiring is tied to the page's `load` event,
      // which never fires again on a bfcache restore (`pageshow` instead) —
      // onRestore below calls this again for any record still uncached.
      let stopIdlePreheat: (() => void) | null = null;
      const armIdlePreheat = () => {
        if (!hasWindow || !tableRef.value) return;
        stopIdlePreheat?.();
        const flagged = tableRef.value.records.filter(
          (record) => record.meta.preheat === true && record.component && !componentCache.has(record.component),
        );
        if (flagged.length === 0) return;
        stopIdlePreheat = preheatIdle(flagged.map((record) => () => loadComponent(record, engine.snapshot.value.location)));
        teardowns.push(stopIdlePreheat);
      };

      if (hasWindow && options.links !== false) {
        const stampRoot = (options.linksRoot ? document.querySelector(options.linksRoot) : null) ?? document;
        const stamp = () => stampActiveLinks(history.base, engine.snapshot.value.location.path, stampRoot);

        teardowns.push(
          installDomIntegration({
            base: history.base,
            canHandle: (path) => tableRef.value !== null && tableRef.value.resolve(path) !== null,
            navigate: (fullPath, replace) => void engine.navigate(fullPath, { replace }),
            preheat: preheatPath,
            // The frozen page's active-link stamps and any still-uncached
            // preheat targets are exactly as stale as they were at freeze
            // time — nothing here re-runs on its own otherwise.
            onRestore: () => {
              stamp();
              armIdlePreheat();
            },
          }),
        );
        const stampOnCommit = engine.afterEach(stamp);
        teardowns.push(stampOnCommit);
      }

      await engine.navigate(history.location(), { replace: true });

      armIdlePreheat();
    })();
    started.catch((error) => dispatchError(error, engine.snapshot.value.location));
    return started;
  }

  // ---- the router object -----------------------------------------------------------

  function currentLeafDefs(): Record<string, QueryParamDef> {
    const matched = engine.snapshot.value.location.matched;
    return matched[matched.length - 1]?.queryDefs ?? {};
  }

  /** Auto-dispose with the surrounding Vue scope; no-op outside. */
  function scoped(off: () => void): () => void {
    if (getCurrentScope()) onScopeDispose(off);
    return off;
  }

  const noRecords: readonly TableRecord[] = Object.freeze([]);
  const routes = computed(() => tableRef.value?.records ?? noRecords);

  const router: Router = {
    currentRoute: engine.snapshot,
    routes,
    base: history.base,
    isLoading: engine.isLoading,
    lastError,
    push: (to: RouteLocationRaw) => engine.navigate(to),
    replace: (to: RouteLocationRaw) => engine.navigate(to, { replace: true }),
    back: () => history.go(-1),
    forward: () => history.go(1),
    go: (delta) => history.go(delta),
    setQuery: (patch: QueryPatch, opts = {}) =>
      engine.setQuery(patch, opts, (key) => resolveQueryHistory(key, currentLeafDefs()[key])),
    setRouteData: engine.setRouteData,
    beforeEach: (guard) => scoped(engine.beforeEach(guard)),
    afterEach: (hook) => scoped(engine.afterEach(hook)),
    onError: (handler) => {
      errorSubscribers.add(handler);
      return scoped(() => void errorSubscribers.delete(handler));
    },
    setRoutes: (rows: readonly RouteRecord[]) => {
      tableRef.value = createRouteTable(rows);
    },
    reload: async () => {
      if (!('url' in (source as { url?: string }))) {
        throw routerError('routes_load_failed', 'reload() needs a { url } routes source');
      }
      await loadRemoteTable((source as { url: string }).url);
    },
    start,
    isReady: () => start(),
    resolve: (to) => {
      // Full normalization (params inheritance, typed query, hash) when the
      // table is ready; graceful degradation before start().
      try {
        return history.createHref(engine.resolveLocation(to).fullPath);
      } catch {
        if (typeof to === 'string') return history.createHref(to);
        return history.createHref(to.path ?? '/');
      }
    },
    install: (app) => {
      app.provide(ROUTER_KEY, router);
      app.component('RouterOutlet', RouterOutlet);
      void start();
    },
    destroy: () => {
      for (const teardown of teardowns.splice(0)) teardown();
      history.destroy();
    },
  };
  return router as Router<TName>;
}

// ---- helpers ------------------------------------------------------------------------

function normalizeBaseSafe(base: string): string {
  return base && !base.startsWith('/') ? `/${base}` : base.replace(/\/$/, '');
}

function isComponentLike(fn: unknown): boolean {
  const candidate = fn as { render?: unknown; setup?: unknown; __vccOpts?: unknown };
  return Boolean(candidate.render || candidate.setup || candidate.__vccOpts);
}

function unwrapModule(mod: unknown): unknown {
  const candidate = mod as { default?: unknown };
  return candidate && typeof candidate === 'object' && 'default' in candidate ? candidate.default : mod;
}

/** Blade HTML through the chamber http client — inherits timeout, retry,
 *  session-expired hook and error mapping. */
function defaultFetchBlade(http: HttpClient, bladeRoot: string): (href: string) => Promise<string> {
  return async (href) => {
    const response = await http.get<string>(href, {
      responseType: 'text',
      headers: { Accept: 'text/html' },
    });
    if (typeof DOMParser === 'undefined') return response.data;
    const doc = new DOMParser().parseFromString(response.data, 'text/html');
    return (doc.querySelector(bladeRoot) ?? doc.body).innerHTML;
  };
}

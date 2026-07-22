/**
 * vapor-chamber-router — composables. Vue 3.6-native: cleanup via
 * onScopeDispose directly, reads through the router's shallowRefs.
 */

import { type Ref, computed, customRef, getCurrentScope, inject, onScopeDispose } from 'vue';
import { ROUTER_KEY } from './keys';
import { type Breadcrumb, type MenuItem, buildBreadcrumbs, buildMenu } from './menu';
import type { Router } from './router-type';
import type { QueryParamDef, RouteLocation } from './types';
import { decodeQueryParam, encodeQueryParam, resolveQueryHistory } from './url';

export function useRouter(): Router {
  const router = inject<Router>(ROUTER_KEY);
  if (!router) throw new Error('[vapor-chamber-router] no router provided — did you app.use(router)?');
  return router;
}

/** Reactive current location (URL state — outlets read snapshot.render). */
export function useRoute(): { readonly value: RouteLocation } {
  const router = useRouter();
  return computed(() => router.currentRoute.value.location);
}

/**
 * A real Vue `Ref` whose backing store is the URL, plus explicit history
 * controls.
 *
 * Being an actual ref matters: refs returned from `setup()` are AUTO-UNWRAPPED
 * in templates, so `{{ page }}` works and `.value` is script-only — exactly
 * like `useRoute()`, `useRouteData()` and every sibling composable. A
 * lookalike object with a `value` accessor does NOT unwrap, which made this
 * the one composable whose templates needed `.value`.
 */
export type QueryParamHandle<T> = Ref<T> & {
  /** Write with an explicit pushState (back returns to the old value). */
  push: (next: T) => void;
  /** Write with an explicit replaceState (no history entry). */
  replace: (next: T) => void;
  /** Remove the key from the URL (reads fall back to the declared default). */
  clear: () => void;
};

/**
 * Typed, writable access to one query param through the query fast path —
 * never triggers matching, guards or remounts. Loaders whose template
 * depends on the key refetch automatically.
 */
export function useQueryParam<T = unknown>(key: string, def?: QueryParamDef): QueryParamHandle<T> {
  const router = useRouter();
  const definition = (): QueryParamDef => {
    if (def) return def;
    const matched = router.currentRoute.value.location.matched;
    return matched[matched.length - 1]?.queryDefs[key] ?? {};
  };
  const write = (next: T | null, override?: 'push' | 'replace') => {
    const d = definition();
    router.setQuery(
      { [key]: next === null ? null : encodeQueryParam(next, d) },
      { history: resolveQueryHistory(key, d, override) },
    );
  };
  // customRef, not a hand-rolled { get value() } object: this produces a
  // genuine ref (isRef() true), so templates unwrap it like every other
  // composable here. Dependency tracking still flows through
  // `router.currentRoute` — read inside get(), so any effect reading this ref
  // re-runs when a navigation commits; track()/trigger() are not the source of
  // truth, the URL is.
  const handle = customRef<T>((track, trigger) => ({
    get() {
      track();
      return decodeQueryParam(router.currentRoute.value.location.query[key], definition()) as T;
    },
    set(next: T) {
      write(next);
      trigger();
    },
  })) as QueryParamHandle<T>;

  handle.push = (next) => write(next, 'push');
  handle.replace = (next) => write(next, 'replace');
  handle.clear = () => write(null, 'replace');
  return handle;
}

/**
 * Loader data of the current route (two-phase committed — never the previous
 * page's data). By default the LEAF record's data; pass a record name when a
 * layout ancestor also loads.
 */
export function useRouteData<T = unknown>(recordName?: string): { readonly value: T | undefined } {
  const router = useRouter();
  return computed(() => {
    const { location, data } = router.currentRoute.value;
    const name = recordName ?? location.matched[location.matched.length - 1]?.name;
    return (name ? data.get(name) : undefined) as T | undefined;
  });
}

/**
 * Route-level error boundary: the latest navigation error (RouterError with
 * a machine-readable `code`) plus clear().
 */
export function useRouteError(): { latestError: { readonly value: unknown }; clear: () => void } {
  const router = useRouter();
  return {
    latestError: router.lastError,
    clear: () => {
      router.lastError.value = null;
    },
  };
}

/**
 * The navigation menu, projected from the route table (see menu.ts for the
 * contract: `meta.menu` position + `meta.title` i18n key, nested by nearest
 * menued ancestor, server-side permission filtering, data-active semantics).
 * Reactive to navigation AND table swaps (setRoutes / reload).
 */
export function useMenu(): { readonly value: readonly MenuItem[] } {
  const router = useRouter();
  return computed(() => buildMenu(router.routes.value, router.currentRoute.value.location.path, router.base));
}

/**
 * Parent-chain breadcrumbs of the current route: matched records carrying a
 * `meta.title`, root-first, the page itself last (`current: true`). Group
 * rows and ancestors whose params the location can't supply come href-less.
 */
export function useBreadcrumbs(): { readonly value: readonly Breadcrumb[] } {
  const router = useRouter();
  return computed(() => buildBreadcrumbs(router.currentRoute.value.location, router.base));
}

/**
 * Leave guard scoped to the calling component's lifetime: fires on every
 * PATH navigation (query changes never trigger it) while mounted; return
 * false to refuse. Pairs with dirty-state trackers for unsaved-changes
 * protection. Auto-disposes with the component scope.
 */
export function onBeforeLeave(
  guard: (to: RouteLocation, from: RouteLocation) => boolean | void | Promise<boolean | void>,
): () => void {
  const router = useRouter();
  const off = router.beforeEach(async (to, from) => {
    const verdict = await guard(to, from);
    return verdict === false ? false : undefined;
  });
  if (getCurrentScope()) onScopeDispose(off);
  return off;
}

/** What a paginated loader response is read as. Every field has a default
 *  extractor covering the common envelope shapes; override any of them when
 *  your backend disagrees. */
export type PaginationOptions<T> = {
  /** Read another record's loader data (default: the leaf record). */
  recordName?: string;
  /** Query key carrying the page number. Default: 'page'. */
  key?: string;
  items?: (data: any) => readonly T[];
  total?: (data: any) => number;
  perPage?: (data: any) => number;
  lastPage?: (data: any) => number;
  /** How many numbered links `pageRange` produces. Default: 7. */
  window?: number;
};

export type Pagination<T> = {
  /** Rows of the current page — the loader's, committed with the snapshot. */
  items: Readonly<Ref<readonly T[]>>;
  /** The page number, backed by the URL. Writable: `page.value = 3`. */
  page: QueryParamHandle<number>;
  perPage: Readonly<Ref<number>>;
  total: Readonly<Ref<number>>;
  lastPage: Readonly<Ref<number>>;
  hasNext: Readonly<Ref<boolean>>;
  hasPrev: Readonly<Ref<boolean>>;
  /** Windowed page numbers for a pager UI; 0 marks an elision ("…"). */
  pageRange: Readonly<Ref<readonly number[]>>;
  /** True while a loader for the current navigation is in flight. */
  loading: Readonly<Ref<boolean>>;
  next: () => void;
  prev: () => void;
  go: (page: number) => void;
};

/**
 * Pagination over a loader-backed list, driven entirely by the URL.
 *
 * `page` is a query param, so a page change is STATE, not navigation: no
 * matching, no guards, no remount — only the loaders whose template depends
 * on the key refetch, with the previous request aborted. `page` pushes by
 * convention, so Back steps through pages, and the URL is shareable.
 *
 *   const { items, page, hasNext, next, pageRange, loading } = usePagination<Product>();
 *
 * Reading the response is the only part that varies between backends, so each
 * extractor is overridable; the defaults accept `{ items | data }` with
 * `{ total, per_page | perPage, last_page | lastPage }` (or their `meta`
 * nesting), which covers Laravel's paginator and most plain-JSON APIs.
 */
export function usePagination<T = unknown>(options: PaginationOptions<T> = {}): Pagination<T> {
  const router = useRouter();
  const data = useRouteData<any>(options.recordName);
  const page = useQueryParam<number>(options.key ?? 'page');

  const pick = <R>(read: ((data: any) => R) | undefined, fallback: (data: any) => R): Ref<R> =>
    computed(() => (read ?? fallback)(data.value ?? {}));

  const items = pick<readonly T[]>(options.items, (d) => d.items ?? d.data ?? []);
  const total = pick<number>(options.total, (d) => d.total ?? d.meta?.total ?? items.value.length);
  const perPage = pick<number>(options.perPage, (d) => {
    const n = d.per_page ?? d.perPage ?? d.meta?.per_page ?? d.meta?.perPage;
    return Number(n) || items.value.length || 1;
  });
  const lastPage = pick<number>(options.lastPage, (d) => {
    const n = d.last_page ?? d.lastPage ?? d.meta?.last_page ?? d.meta?.lastPage;
    return Number(n) || Math.max(1, Math.ceil(total.value / Math.max(1, perPage.value)));
  });

  const current = computed(() => Math.max(1, Number(page.value) || 1));
  const go = (next: number) => {
    page.value = Math.min(Math.max(1, Math.trunc(next)), lastPage.value);
  };

  return {
    items,
    page,
    perPage,
    total,
    lastPage,
    loading: router.isLoading,
    hasPrev: computed(() => current.value > 1),
    hasNext: computed(() => current.value < lastPage.value),
    pageRange: computed(() => buildPageRange(current.value, lastPage.value, options.window ?? 7)),
    next: () => go(current.value + 1),
    prev: () => go(current.value - 1),
    go,
  };
}

/**
 * Page numbers for a pager, capped at `window` entries: always the first and
 * last page, a run around the current one, and `0` where numbers were elided
 * (render it as "…"). 0 is used rather than null so the array stays
 * `number[]` for `v-for` keys.
 */
function buildPageRange(current: number, last: number, window: number): readonly number[] {
  if (last <= window) return Array.from({ length: last }, (_, i) => i + 1);

  const side = Math.max(1, Math.floor((window - 3) / 2));
  const start = Math.max(2, current - side);
  const end = Math.min(last - 1, current + side);
  const pages: number[] = [1];
  if (start > 2) pages.push(0);
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < last - 1) pages.push(0);
  pages.push(last);
  return pages;
}

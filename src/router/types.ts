/**
 * vapor-chamber-router — public types.
 *
 * `RouteRecord` is the router's own row schema — the contract a server-side
 * route generator emits against. A generator may ship a matching
 * `route-record.generated.d.ts`, but this interface is the source of truth for
 * the shape. Rows arrive pre-sorted by match priority — ordering is the
 * server's job; matching is linear first-hit-wins.
 */

/** Cast applied to a path param or scalar query param. */
export type ParamType = 'string' | 'int' | 'bool';

/** Declaration for a typed query param (`?page=2` → `useQueryParam('page')`). */
export type QueryParamDef = {
  /** Value cast. 'array' collects repeated keys as string[]. Default: 'string'. */
  type?: ParamType | 'array';
  /** Fallback when the key is absent or fails the cast. Values equal to the
   *  default are dropped from the URL on write. */
  default?: unknown;
  /** How a write to this param lands in browser history. Unset → the
   *  convention: 'page' pushes, everything else replaces. */
  history?: 'push' | 'replace';
};

/** One route row, as emitted by a route generator against this schema. */
export type RouteRecord = {
  name: string;
  /** Pattern relative to the router base. `:param`, `:param(regex)`,
   *  `:param?`, trailing `*` splat (→ params.pathMatch). */
  path: string;
  parent?: string | null;
  /** Key into the client component map. null/absent + !blade = group record:
   *  contributes to the layout chain, never matches a URL, renders nothing. */
  component?: string | null;
  /** Hybrid row: fetch the server-rendered HTML for the URL and swap it into
   *  the outlet (hydrate/dehydrate hooks fire). */
  blade?: boolean;
  /**
   * Server-declared data loader: a URL template fetched on navigation with
   * `{placeholders}` filled from path params, then typed query params.
   *   "/api/vc/products?page={page}&sort={sort}"
   * Fetched with an AbortController — a newer navigation aborts it. The
   * response (house envelope or bare JSON) lands on `snapshot.data` atomically
   * with the commit; `useRouteData()` reads it.
   */
  load?: string | null;
  params?: Record<string, ParamType>;
  query?: Record<string, QueryParamDef>;
  /** Server data: permissions, titles, `preheat` flag, … */
  meta?: Record<string, unknown>;
};

/** Envelope for a delivered route table. */
export type RoutesPayload = {
  base?: string;
  /** Cache-busting tag (deploy version). */
  version?: string;
  routes: readonly RouteRecord[];
};

/** Raw query values as parsed from the URL string. */
export type QueryValues = Record<string, string | string[]>;

/** Writable query patch: null/undefined removes a key. */
export type QueryPatch = Record<string, unknown | null | undefined>;

/** Typed path params of a resolved location. */
export type RouteParams = Record<string, string | number | boolean>;

/** Compiled table record — a RouteRecord after createRouteTable(). Object
 *  identity of these drives reuse-vs-remount classification. */
export type TableRecord = {
  name: string;
  path: string;
  parent: TableRecord | null;
  component: string | null;
  blade: boolean;
  group: boolean;
  load: string | null;
  paramTypes: Record<string, ParamType>;
  meta: Record<string, unknown>;
  /** Root-first parent chain (this record last). */
  chain: readonly TableRecord[];
  /** chain filtered to renderable records — what outlets index by depth. */
  renderChain: readonly TableRecord[];
  /** chain filtered to records with a `load` template. */
  loadChain: readonly TableRecord[];
  /** Chain-merged query declarations, leaf wins. Precomputed. */
  queryDefs: Record<string, QueryParamDef>;
  /** @internal matching/build artifacts */
  re: RegExp;
  keys: readonly string[];
  segments: readonly Segment[];
};

/** @internal path compiler segment */
export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string; pattern: string; optional: boolean }
  | { kind: 'splat' };

/** A resolved, normalized location — what guards and useRoute() see. */
export type RouteLocation = {
  name: string | null;
  /** Decoded path relative to base, no query/hash. */
  path: string;
  /** path + query + hash, relative to base. */
  fullPath: string;
  params: RouteParams;
  query: QueryValues;
  hash: string;
  /** Root-first record chain (leaf last). Empty when unmatched. */
  matched: readonly TableRecord[];
  /** Meta of the leaf record. */
  meta: Record<string, unknown>;
};

/** One outlet depth: the record plus its RESOLVED component (blade rows
 *  arrive here already wrapped as a component). */
export type RenderEntry = {
  record: TableRecord;
  component: unknown;
};

/** The atomic unit of router state — one frozen object per commit. Loader
 *  data commits WITH the navigation (two-phase: load during, commit after),
 *  so a page never renders with the previous page's data. */
export type RouteSnapshot = {
  location: RouteLocation;
  /** Renderable-only, depth-indexed. Outlets read render[depth]. */
  render: readonly RenderEntry[];
  /** Loader results keyed by record name (records with a `load` template). */
  data: ReadonlyMap<string, unknown>;
};

/** Target of a programmatic navigation. TName narrows `name` to the
 *  generated route-name union (AdminRouteName) when the router is created
 *  as `createRouter<AdminRouteName>(…)` — typos become compile errors. */
export type RouteLocationRaw<TName extends string = string> =
  | string
  | {
      name?: TName;
      path?: string;
      params?: RouteParams;
      query?: QueryPatch;
      hash?: string;
      replace?: boolean;
    };

/**
 * Navigation guard. Return:
 *  - nothing / true   → continue
 *  - false            → abort (URL reverted on popstate navigations)
 *  - RouteLocationRaw → redirect
 */
export type NavigationGuard = (
  to: RouteLocation,
  from: RouteLocation,
) => void | boolean | RouteLocationRaw | Promise<void | boolean | RouteLocationRaw>;

export type AfterEachHook = (to: RouteLocation, from: RouteLocation) => void;

/** Component map entry: a component, or a lazy loader returning one
 *  (module `default` unwrapped automatically). */
export type ComponentEntry = unknown | (() => Promise<unknown>);
export type ComponentMap = Record<string, ComponentEntry>;

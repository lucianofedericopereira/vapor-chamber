# vapor-chamber/router

A router for **Vue 3.6** over a server-owned catch-all (Laravel Blade is the
worked example). One hard requirement by design: Vue ≥ 3.6. Ships in-box as a
subpath of `vapor-chamber` and uses its http client.

The server owns one catch-all (`/admin/{any?}` → Blade shell → one island); the
router owns every URL inside. **Path = navigation, query = state.**

Data loading is **pluggable**: the router owns *when* loaders run (on
navigation, abort-on-supersede, two-phase commit); a loader **preset** owns
*how* each row's `load` string resolves, via the loader SPI. In-box:
[`vapor-chamber/router-fetch`](../src/router-fetch/index.ts) (plain-JSON
backends). Bring your own preset for any other backend convention.

```ts
import { createRouter } from 'vapor-chamber/router';
import { fetchLoaders } from 'vapor-chamber/router-fetch';
import { adminRoutes } from './admin-routes.generated'; // any generator emitting RouteRecord[]
import { products } from './products.generated';

const router = createRouter({
  base: '/admin',
  routes: adminRoutes,                     // or { inline: '#vcr-routes' } / { url: '/api/vc/routes' }
  loaders: fetchLoaders(),                 // in-box preset — or your own LoaderHandlers
  components: { 'Catalog/ListPage': () => import('./pages/CatalogList.vue') },
  hydrate:   el => window.__mountIslandsIn?.(el),   // blade rows only
  dehydrate: el => window.__unmountIslandsIn?.(el),
});
app.use(router);
```

## Loaders — the SPI

A route row declares its data in the `load` column; HOW it resolves is a loader
preset plugged into the SPI: prefix handlers (registered `rows:`-style
prefixes), a url handler (plain URL templates), and an optional `affects` hook
(which query-key changes trigger a refetch). A `load` with no matching handler
is a coded `load_failed`.

```jsonc
{ "load": "rows:products" }               // a prefix handler: whatever the preset registers "rows:" to mean
{ "load": "/api/items?page={page}" }      // the url handler: interpolate {placeholders}, fetch
```

| Subpath / extension point | Role |
|---|---|
| `vapor-chamber/router` (this) | the router: table, engine, dom, outlet, loader SPI |
| `vapor-chamber/router-fetch` | in-box preset: plain-JSON URL loaders, any backend |
| your own preset | implement `LoaderHandlers` (`prefixes` + `url` + `affects`) |

Core mechanics are preset-independent: loaders run on navigation with an
AbortController created per navigation (**a newer navigation aborts the
previous one's fetches at start** — vue-router data-loaders timing, verified
from source), and results commit **atomically on the snapshot** (two-phase:
a page never renders with the previous page's data). Query-only changes
refetch only the loaders affected by the changed keys.

## Pagination, productized

```ts
const { items, page, total, lastPage, hasNext, next, prev, pageRange, loading }
  = usePagination<Product>();

page.value = 3;   // URL → ?page=3 (pushState), loader refetches (abort-on-supersede),
                  // items update — NO matching, NO guards, NO remount
```

`page` is a real `Ref`, so templates auto-unwrap it (`{{ page }}`) and `.value`
is script-only — same as every other composable here. Reading the response is
the only backend-specific part, so each extractor is overridable; the defaults
accept `{ items | data }` alongside `{ total, per_page | perPage,
last_page | lastPage }` (or their `meta` nesting), which covers Laravel's
paginator and most plain-JSON APIs:

```ts
usePagination<Product>({ items: d => d.rows, total: d => d.count });
```

`pageRange` is windowed for a pager UI — first and last page always present, a
run around the current one, and `0` where numbers were elided (render it as
"…"). `loading` is the router's own in-flight flag, so a slow page can show a
spinner without tracking request state by hand.

Query-only changes commit the URL immediately (optimistic) and refetch only
the loaders whose template depends on a changed key. Back/forward steps
through pages. History ladder: explicit call → route declaration →
convention (**`page` pushes, everything else replaces**); defaults drop from
the URL.

## Menus + breadcrumbs, projected — never authored twice

The table already knows the navigation UI; `useMenu()` / `useBreadcrumbs()`
only project it:

```ts
const menu = useMenu();       // rows flagged meta.menu (an INTEGER — the
                              // server-owned menu position), nested by nearest
                              // menued ancestor, labels = meta.title i18n keys
const crumbs = useBreadcrumbs(); // the matched parent chain, titled rows only,
                                 // root-first, current page last
```

- **Permission-correct by construction** — rows arrive server-filtered
  (`visibleTo`), so whatever the table holds is what the user may see.
- **active/exact share `pathActivity()`** with `data-active` stamping — a
  Blade-rendered menu and a Vue-rendered menu can never disagree.
- **Menu rows are static navigation**: `meta.menu` needs `meta.title` and a
  path without required params — loud in dev, rejected by `Routes::validate`
  at export. Group rows become href-less section nodes.
- Reactive to navigation **and** table swaps (`setRoutes` / `reload` — the
  compiled records are exposed as `router.routes`, a reactive ref).

## Hot paths (fast-lane philosophy: opt-in, never the default)

- **`router.setRouteData(name, value)`** — patch loader data directly: zero
  loader run, zero navigation, one frozen snapshot, fully reactive. For when
  fresh state is already in hand — a bus command's response
  (`{ ok, state }` → straight onto the page), a websocket push, an
  optimistic update.
- **Preset-internal compile caches** — a prefix handler may pre-compile
  per-record closures (record identity → fn); the SPI never sees it.
- **Chamber http LRU** — url handlers can pass `cache: { ttl }` for
  reference-data endpoints.
- Measured baseline: the SPI itself costs ~20µs per navigation on a
  5k-row local source — specialize only past profiling, not before.

## Everything else

- **One atomic snapshot** — `{ location, render, data }`, frozen per commit;
  `<RouterOutlet/>` = `render[depth]`, keyless (record identity ⇒ reuse).
- **One error taxonomy** — `push()` resolves to `RouterError | null`;
  machine-readable codes; `HARD_NAV_CODES` hard-navigate by default (server
  gets the last word; stale chunks recover). `useRouteError()` for boundaries.
- **Blade rows** are wrapped as ordinary components (hydrate/dehydrate in
  lifecycle) — incremental Blade→Vue migration, flip `blade: true` to
  `component` per row.
- **dom.ts** is the single DOM point: page.js-checklist link interception
  (composed-path scan — crosses shadow roots), `data-active`/
  `data-exact-active` stamping on Blade anchors, hover + idle preheat
  (`meta.preheat` column).
- **Pure constructor** — IO/listeners begin at `start()` / `app.use()`.
- **Dev-trusts-generator** — table validation runs in dev only; production
  trusts the generated rows like a migration.
- Composables: `useRouter useRoute useQueryParam useRouteData useRouteError
  useMenu useBreadcrumbs usePagination onBeforeLeave` — all
  scope-auto-disposing.

## Status

Experimental, covered by the router node specs (`npm test`). Next: a reference
route generator + generated modules (E2E proof), browser playground,
Vapor-native outlet after measuring interop.

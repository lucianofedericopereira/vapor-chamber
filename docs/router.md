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
| `vapor-chamber/router` (this) | the router: table, engine, dom, loader SPI — **no vDOM** |
| `vapor-chamber/router/vdom` | `RouterOutlet`, `makeBladeComponent` — opts you into Vue's vDOM runtime |
| `vapor-chamber/router-fetch` | in-box preset: plain-JSON URL loaders, any backend |
| your own preset | implement `LoaderHandlers` (`prefixes` + `url` + `affects`) |

### Why the outlet is a separate subpath

`RouterOutlet` is a `defineComponent` + `h()` component. Anything that can
reach it *statically* pins Vue's virtual-DOM runtime into the consumer's
bundle — so a Vapor app that never renders one would still pay for it. Two
consequences, both deliberate:

- **`app.use(router)` does not register `<RouterOutlet>` globally.** Import it
  and register it locally where you use it.
- **It is not re-exported from `vapor-chamber/router`.** A static re-export is
  a static reference and would defeat the split.

Measured on the built `dist/` (`tests/router/vdom-boundary.test.ts`), the
bindings each entry retains from `vue`:

| entry | retains |
|---|---|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` |

Blade rows need no import from you: the router pulls `makeBladeComponent` in
on demand, as a separate chunk, the first time it renders one.

> **Breaking in v1.11.0:** `RouterOutlet`, `makeBladeComponent` and
> `BladeHooks` moved from `vapor-chamber/router` to `vapor-chamber/router/vdom`,
> and `app.use(router)` no longer registers `<RouterOutlet>` globally. Apps that
> relied on the global registration must register it locally. Shipped in a minor
> deliberately — the router is experimental, and keeping deprecated re-exports
> would reinstate the static reference this change exists to remove.

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
- **Chamber http LRU** — in-box since v1.12.0:
  `fetchLoaders({ cache: true })`, or `{ ttl, staleTtl, serveStaleOnError }`
  for the full fresh/stale window. Off by default. A route row overrides the
  preset per record via `meta.cache` — `{ cache: { ttl: 3_600_000 } }` on a
  countries table, `{ cache: false }` on live inventory. With `staleTtl` set,
  a past-fresh entry commits **immediately** and the refresh runs behind it:
  `router.isRevalidating` is true while it does (separate from `isLoading`,
  which stays false — the page has data), and the fresh value patches into
  `snapshot.data` when it lands. A custom preset gets the same channel through
  the loader SPI's `ctx.revalidate(promise)`.
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

## Vapor interop

Measured against `vue@3.6.0-rc.2`, not inferred from the
[Vapor roadmap](https://github.com/vuejs/core/issues/13687). Fixture:
`tests/router/vapor-fixture.test.ts`.

**provide/inject works in Vapor, at both levels.** The roadmap lists
"Provide/Inject System" unchecked, but on a real `createVaporApp` app both
`app.provide(...)` → `inject(...)` (which backs every composable here) and
component-level `provide(...)` → `inject(...)` (which backs nested
`<RouterOutlet>` depth) resolve correctly. So the composable surface and outlet
nesting are **not** blocked on that roadmap item.

What still ties the outlet to the vDOM runtime is its own render path:
`outlet.ts` uses `defineComponent` + `h()`. A Vapor-native outlet is a
`defineVaporComponent` + `createComponent` rewrite, not a wait on upstream.

Two constraints worth knowing before writing your own Vapor test or app:

- Vapor ships as a **physically separate dist file**
  (`vue/dist/vue.runtime-with-vapor.esm-*.js`). A bare `import 'vue'` never
  resolves to it outside a bundler's per-app alias — see `chamber.ts` §probeVue
  and whitepaper §11.6.
- Never mix that build with a plain `import 'vue'` in the same context. Two
  separately-imported Vue dists are two disconnected reactivity instances, and
  the failure is silent. Import `provide`, `inject`, `defineVaporComponent` and
  friends from the *same* module you got `createVaporApp` from.

Roadmap items this router does **not** depend on, by design:

| Item | Why |
| --- | --- |
| Async Component | lazy routes use the router's own `import()` + cache, resolved before the snapshot commits — never `defineAsyncComponent` |
| Suspense | the two-phase commit means a pending state is never rendered, so there is no boundary to need |

Still not usable here, though the reasons differ:

- **KeepAlive** — the roadmap box is now **checked**, and that is not the same
  as working. Two correctness issues are open against it:
  [#15228](https://github.com/vuejs/core/issues/15228) (a cached child renders
  against a nullish prop) and
  [#15237](https://github.com/vuejs/core/issues/15237) (KeepAlive scopes are
  not paused while deactivated). Nothing caches an inactive route's state here
  yet. Worth knowing if you rely on `tryKeepAliveHooks` in `chamber.ts`: it
  hand-solves what #15237 proposes doing natively, so if that lands the manual
  pause/resume becomes double-suppression and should be removed in the same
  release.
- **Transition** — route transitions; the View Transitions API is the
  DOM-native way around it.
- **SSR/Hydration** for blade rows — `fetchBlade` is undefined off-browser, so
  a blade row under SSR throws `blade_unconfigured`.

The rule applied symmetrically: an unchecked box does not mean missing (see the
provide/inject fixture above, measured working while the box was unchecked),
and a checked box does not mean working. Still unchecked and worth keeping in
mind when reading anything that cites the roadmap: Vue Router, Suspense
(VaporSuspense pending), DevTools Integration, Nuxt, VitePress, Vue Test
Utils.

## Status

Experimental, covered by the router node specs (`npm test`). Next: a reference
route generator + generated modules (E2E proof), browser playground,
Vapor-native outlet (interop now measured — see above).

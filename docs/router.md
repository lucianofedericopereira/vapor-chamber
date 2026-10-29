# vapor-chamber/router

A router for **Vue 3.6** over a server-owned catch-all, with Laravel Blade as the worked
example. It ships in-box as a subpath of `vapor-chamber`.

- Its entry and the vDOM outlet load on Vue 3.5 too.[^vue35] The Vapor outlet needs 3.6.
- It uses an HTTP client only if you hand it one (see the remote subpath below).

[^vue35]: `tests/vue35-entries.test.ts`.

The server owns one catch-all (`/admin/{any?}` -> Blade shell -> one island), and the router owns
every URL inside. **Path is navigation, query is state.**

**This is not vue-router.** It reuses several of vue-router's names for different things.
`router.currentRoute` is the frozen snapshot `{ location, render, data }`, and the
vue-router-shaped route object is `useRoute()`. So a habit carried over returns `undefined`
rather than an error.

Data loading is **pluggable**. The router owns *when* loaders run: on navigation, abort on
supersede, two-phase commit. A loader **preset** owns *how* each row's `load` string resolves,
through the loader SPI. The in-box preset is
[`vapor-chamber/router-fetch`](../src/router-fetch/index.ts), for plain-JSON backends. Bring your
own preset for any other backend convention.

```ts
import { createRouter } from 'vapor-chamber/router';
import { fetchLoaders } from 'vapor-chamber/router-fetch';
import { adminRoutes } from './admin-routes.generated'; // any generator emitting RouteRecord[]
import { products } from './products.generated';

const router = createRouter({
  base: '/admin',
  routes: adminRoutes,                     // or { inline: '#vcr-routes' } / { url: '/api/vc/routes' }
  loaders: fetchLoaders(),                 // in-box preset - or your own LoaderHandlers
  components: { 'Catalog/ListPage': () => import('./pages/CatalogList.vue') },
  hydrate:   el => window.__mountIslandsIn?.(el),   // blade rows only
  dehydrate: el => window.__unmountIslandsIn?.(el),
});
app.use(router);
```

## Loaders: the SPI

A route row declares its data in the `load` column. How it resolves is a loader preset plugged
into the SPI, with three parts:

- prefix handlers, registered for `rows:`-style prefixes.
- a url handler, for plain URL templates.
- an optional `affects` hook: which query-key changes trigger a refetch.

A `load` with no matching handler is a coded `router:missing:loader`.

```jsonc
{ "load": "rows:products" }               // a prefix handler: whatever the preset registers "rows:" to mean
{ "load": "/api/items?page={page}" }      // the url handler: interpolate {placeholders}, fetch
```

| Subpath / extension point | Role |
|---|---|
| `vapor-chamber/router` (this) | the router: table, engine, dom, loader SPI. **No renderer** |
| `vapor-chamber/router/vdom` | `RouterOutlet`, `makeBladeComponent`. Opts you into Vue's vDOM runtime |
| `vapor-chamber/router/vapor` | `RouterOutlet`, Vapor-native. Opts you into the Vapor runtime (Vue 3.6 only). Experimental |
| `vapor-chamber/router/remote` | `routerHttp()` + `bladeFetcher()`. Opts you into the chamber HTTP client |
| `vapor-chamber/router-fetch` | in-box preset: plain-JSON URL loaders, any backend |
| your own preset | write a `LoaderHandlers` (`prefixes` + `url` + `affects`) |

### Two features that need an HTTP client, and do not assume one

A `{ url }` route table and blade rows both make a request. Neither is built into the router: it
takes an `HttpClient` and a `fetchBlade` as ordinary options, and `vapor-chamber/router/remote`
supplies the in-box pair.

```ts
import { createRouter } from 'vapor-chamber/router';
import { routerHttp, bladeFetcher } from 'vapor-chamber/router/remote';

const http = routerHttp();                       // + X-Vapor-Router marker header
createRouter({
  routes: { url: '/api/vc/routes' }, http,       // needed for a { url } table
  fetchBlade: bladeFetcher({ http }),            // needed if any row is blade
});
```

The primary setup, generated route rows with no blade rows, needs neither.[^remote-split]
Forgetting one is a coded error, never a silent failure: `router:missing:http` for a `{ url }`
table, `router:missing:fetchBlade` for a blade row.

[^remote-split]: A router that built the client for everyone would put the whole client (CSRF, interceptors, retry, cache) in every consumer's bundle, to serve two optional features. The outlet subpaths below follow the same reasoning, and `tests/router/remote-boundary.test.ts` enforces this split the same way.

The router's `http` is the client for every request it makes. Its loaders get it as
`LoaderContext.http`, and `fetchBlade` gets it as its second argument.

- `fetchLoaders()` and `bladeFetcher()` read through it unless given their own `http`.
  `bladeFetcher()` marks it as router traffic.
- With no client anywhere, each builds its own, as before.
- One client is one cache, so a write through it reaches a loader's cached read.
- `routerHttp({ http })` marks the app's own client instead of building a second one:

```ts
const http = createHttpClient({ csrf: true });           // the app's one client
createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient: http }) });
createRouter({
  routes: { url: '/api/vc/routes' }, http: routerHttp({ http }),
  loaders: fetchLoaders(), fetchBlade: bladeFetcher(),   // both on that client
});
```

The one-client wiring is pinned by `tests/router/one-client.test.ts`.

Reads answer plain JSON, like a loader. The `{ url }` endpoint (and an inline element) holds the
table itself, `{ routes, base? }`. A failure is a non-2xx `application/problem+json`
(`router:failed:routes`, the client's error as its `cause`). The command envelope is not a read's
shape: a `{ state }` or a 2xx `{ problem }` is `router:unexpected:routes`.

### Deriving state from the route

`router.currentRoute` is a shallowRef of a **frozen** snapshot. Anything that wants
route-derived state writes a `computed` over it rather than subscribing:

```ts
// `params: { id: 'int' }` on the row: the id is a number, and `/products/7x`
// does not match the row at all.
const productId = computed(() => router.currentRoute.value.location.params.id);
const products  = computed(() => router.currentRoute.value.data.get('shop.products'));
```

For state, a computed over the snapshot is the better shape than an event.[^computed]

[^computed]: A computed is always consistent with the committed snapshot. An event handler can observe the world mid-navigation, and a computed over a frozen commit cannot. It has no subscription to dispose, no ordering contract and no listener list to fan out per navigation. It costs nothing while nothing reads it.

`afterEach` remains the right tool for *effects*: analytics beacons, imperative scroll
restoration, anything that should happen because a navigation happened. It is not the way to get
route state into a component. To hear the same effects on the bus, emit them as facts
("Navigation as a command" below).

### Refreshing data after a mutation

After a command changes server state, the data behind the current route is stale. Two sources
say which data: the server, or a map in the app.

**The server's groups (RFC 9875).** A loader read's `Cache-Groups` names the groups its data
belongs to, and a write's `Cache-Group-Invalidation` names the groups it changed.

- `fetchLoaders()` reports a read's groups (`LoaderContext.cacheGroups`), and the router listens
  to its client (`onInvalidateGroup`).
- A group refreshes the records on screen whose read named it, past the client's cache and the
  browser's (`cacheMode: 'no-cache'`), with `router.isRevalidating` true meanwhile.
- The router imports no bus: the write reaches it through the client. So give the transport the
  router's client.

```ts
const http = createHttpClient({ csrf: true });
createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient: http }) });
createRouter({ routes, http, loaders: fetchLoaders() });
```

A stale cached read refreshed with its `ETag` and answered 304 keeps its data object. The router
writes no snapshot for it, so nothing re-renders.[^cache-groups]

[^cache-groups]: `tests/router/cache-groups.test.ts`.

**A map in the app.** Where the server declares no groups, `revalidateRoutes` closes the loop as
a bus plugin. It adds no router capability: it composes `runLoaders`, `currentRoute` and
`setRouteData`, all public. It ships from the main `vapor-chamber/router` entry and tree-shakes
away for anyone who never calls it.[^revalidate-entry]

[^revalidate-entry]: It imports nothing the router core does not already have, so a subpath would isolate no cost.

```ts
import { createRouter, revalidateRoutes } from 'vapor-chamber/router';

const loaders = fetchLoaders();
const router = createRouter({ routes, loaders, components });

bus.use(revalidateRoutes(router, loaders, {
  'cart*':      ['shop.cart'],   // command pattern -> record names to refresh
  'productSave': 'affected',     // or: the current route's whole load chain
}));
```

Pass the SAME `loaders` instance the router uses. `createRouter` closes over its preset and
exposes it nowhere. A plugin that built its own would run a second HTTP client and a second
cache, diverging from the router's with no warning.

The plugin's rules:

- It listens to settled results, one bus listener per pattern, and holds no `next`. An action
  two patterns match refreshes both targets.
- Only successful commands refresh, so a failed mutation never refreshes as though it had worked.
  An `Accepted` answer (a 202) refreshes when its `done` settles ok.
- A superseded navigation drops its refresh.
- A rejected refresh leaves the stale data on screen.
- A record name that is not in the current load chain is a loud `router:missing:record`, not a
  silent no-op.

**It flips its own `isRevalidating`, not the router's.** `router.isRevalidating` means "a
refresh runs behind data on screen": a loader's, through `ctx.revalidate`, or a cache group's. It
has exactly one writer inside the engine. Two independent refresh sources get two flags rather
than one flag with two writers. OR them if you want a single spinner.

### Writing a preset

A preset is a plain `LoaderHandlers` object. Nothing registers it globally: you pass it to
`createRouter({ loaders })`, and it is fixed for the router's life. `setRoutes()` swaps rows,
never loaders.

```ts
import { interpolateLoad, type LoaderHandlers } from 'vapor-chamber/router';

export function myLoaders(): LoaderHandlers {
  return {
    // `load: "rows:products"` arrives here with the prefix stripped: ref is
    // "products". Register as many prefixes as your `load` vocabulary needs.
    prefixes: {
      'rows:': async (ref, location, _record, signal) => {
        const page = location.query.page ?? '1';
        const response = await fetch(`/api/${ref}?page=${page}`, { signal });
        if (!response.ok) throw new Error(`${ref} failed: ${response.status}`);
        return response.json();
      },
    },
    // Everything that is not a registered prefix arrives here as the RAW
    // template. Interpolating it is your choice; `interpolateLoad` is the
    // in-box implementation (path params first, then typed query params, so
    // `{page}` is the declared default when the URL omits it).
    url: async (template, location, record, signal) => {
      const response = await fetch(interpolateLoad(template, location, record.queryDefs), { signal });
      return response.json();
    },
  };
}
```

Six rules for a handler. The engine acts on what it returns, throws and reports.

**Return the data, and the router keys it.** Whatever a handler returns is committed into
`snapshot.data` under `record.name`, which is what `useRouteData()` reads. The router never
inspects the shape, so return what your components want.

**Honour the `signal`.** Starting a navigation aborts the previous one's loaders at once, and a
query-only change aborts the previous refetch. Pass the signal to `fetch`, or check
`signal.aborted` around a non-fetch source. Otherwise a superseded request keeps running and
resolves into a snapshot nobody is looking at.

**Throw, do not swallow.** Any error becomes a coded `router:failed:loader` carrying yours as
`cause`. A `RouterError` you throw yourself passes through untouched, so you can raise a more
specific code. If the signal aborted, it becomes `router:aborted:navigation` instead. The engine
reads that as supersession and does NOT report it to `onError`: a cancelled load is normal flow,
not a failure.

**Override `affects` only if the default is wrong for your dialect.** On a query-only change the
engine refetches just the loaders a changed key affects. By default a prefix loader depends on
every query param its record declares, plus `page`, `per_page` and `sort`. A url template depends
only on the `{placeholders}` it mentions. Supply `affects(record, changedKeys)` when your backend
has different query semantics. It is resolved once at `createRouter`, so nothing is recomputed per
navigation.

**Report a background refresh through `ctx.revalidate`.** A handler that serves stale data now
and refreshes behind it hands the refresh promise to `ctx.revalidate(promise)`, a member of the
fifth argument.

- The engine flips `router.isRevalidating` and patches `snapshot.data` when the promise resolves.
- It drops the refresh if the location changed meanwhile, and keeps the stale value if the
  refresh rejects.
- Without it, a stale-while-revalidate response refreshes your cache but never the page.

**Read past your cache when `ctx.refresh` is true.** The fifth argument's other member says why
the loader runs. It is `true` when `revalidateRoutes` or a cache group refreshes the page after a
command changed its data, and `false` on a navigation or a query refetch. A handler that caches
must not answer a refresh from the cache, or the page gets the copy from before the change.
`fetchLoaders` reads with `cacheMode: 'no-cache'`, so the server is asked before the client's
copy or the browser's is used.[^past-cache]

[^past-cache]: `tests/router-fetch/revalidate-past-cache.test.ts`.

**Name your read's groups through `ctx.cacheGroups(groups)`.** A read whose response carries
`Cache-Groups` (RFC 9875) hands over its group names, and a write that names one refreshes the
record. `fetchLoaders` does it.

`vapor-chamber/router-fetch` is a worked example of the **`url` handler** specifically. Read it
for the signature, the abort behaviour and the `ctx.revalidate` hand-off. It registers no
`prefixes` and no `affects`, so for those two the example above is the reference.

The core mechanics do not depend on the preset. Loaders run on navigation, with an
AbortController created per navigation. **A newer navigation aborts the previous one's fetches at
start**, as vue-router's data loaders do.[^vr-source] Results commit **atomically on the
snapshot**, in two phases, so a page never renders with the previous page's data.

[^vr-source]: Verified from vue-router's source.

### Why the outlet is a separate subpath

`RouterOutlet` is a `defineComponent` + `h()` component. Anything that can reach it
*statically* pins Vue's virtual-DOM runtime into the consumer's bundle, so a Vapor app that never
renders one would still pay for it. Two consequences, both deliberate:

- **`app.use(router)` does not register `<RouterOutlet>` globally.** Import it and register it
  locally where you use it.
- **It is not re-exported from `vapor-chamber/router`.** A static re-export is a static reference
  and would defeat the split. `RouterOutlet`, `makeBladeComponent` and `BladeHooks` all live in
  `vapor-chamber/router/vdom`.

The bindings each entry retains from `vue`, measured on the built `dist/`:[^boundary]

| entry | retains |
|---|---|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` |
| `vapor-chamber/router/vapor` | `createDynamicComponent createIf createSlot defineVaporComponent inject provide` |

[^boundary]: By the harness of `tests/router/vdom-boundary.test.ts` and `tests/router/vapor-boundary.test.ts`. The last row is asserted exactly.

Blade rows need no import from you: the router loads `makeBladeComponent` on demand, as a
separate chunk, the first time it renders one.

## Pagination, productized

```ts
const { items, page, total, lastPage, hasNext, next, prev, pageRange, loading }
  = usePagination<Product>();

page.value = 3;   // URL -> ?page=3 (pushState), loader refetches (abort-on-supersede),
                  // items update - NO matching, NO guards, NO remount
```

`page` is a real `Ref`, so templates unwrap it (`{{ page }}`), and `.value` is script-only, as
in every other composable here. Reading the response is the only backend-specific part, so each
extractor is overridable. The defaults accept `{ items | data }` alongside
`{ total, per_page | perPage, last_page | lastPage }`, or their `meta` nesting. That covers
Laravel's paginator and most plain-JSON APIs:

```ts
usePagination<Product>({ items: d => d.rows, total: d => d.count });
```

- `pageRange` is windowed for a pager UI. The first and last page are always present, with a run
  around the current one. A `0` marks elided numbers (render it as "...").
- `loading` is the router's own in-flight flag, so a slow page can show a spinner without
  tracking request state by hand.
- Query-only changes commit the URL at once (optimistic) and refetch only the loaders whose
  template depends on a changed key. Back and forward step through pages.
- Push or replace is decided by the first that applies: explicit call -> route declaration ->
  convention (**`page` pushes, everything else replaces**).
- Default values drop from the URL.

## Menus and breadcrumbs, projected: never authored twice

The table already knows the navigation UI. `useMenu()` and `useBreadcrumbs()` only project it:

```ts
const menu = useMenu();       // rows flagged meta.menu (an INTEGER - the
                              // server-owned menu position), nested by nearest
                              // menued ancestor, labels = meta.title i18n keys
const crumbs = useBreadcrumbs(); // the matched parent chain, titled rows only,
                                 // root-first, current page last
```

- **Permission-correct by construction:** rows arrive server-filtered (`visibleTo`), so whatever
  the table holds is what the user may see.
- **`active` and `exact` share `pathActivity()`** with `data-active` stamping, so a
  Blade-rendered menu and a Vue-rendered menu cannot disagree.
- **`aria-current="page"` goes on the exact match only:** `exactActive`, or the breadcrumb whose
  `current` is true. Never on `active`, which also lights up a section parent, so a screen reader
  would announce two current pages. `stampActiveLinks` does it for plain anchors, and leaves any
  other `aria-current` value the page set (`"step"`, `"location"`) alone.
- **Menu rows are static navigation:** `meta.menu` needs `meta.title` and a path with no
  mandatory params, loud in dev. Group rows become href-less section nodes.
- **Reactive to navigation and to table swaps** (`setRoutes` / `reload`). The compiled records
  are exposed as `router.routes`, a reactive ref.

## Hot paths (fast-lane philosophy: opt-in, never the default)

- **`router.setRouteData(name, value)`** patches loader data directly: no loader run, no
  navigation, one frozen snapshot, fully reactive. Use it when fresh state is already in hand: a
  bus command's response (`{ state }` straight onto the page), a WebSocket push, an optimistic
  update.
- **Preset-internal compile caches:** a prefix handler may pre-compile per-record closures
  (record identity -> fn). The SPI never sees them.
- **The chamber HTTP LRU, in-box:** `fetchLoaders({ cache: true })`, or
  `{ ttl, staleTtl, serveStaleOnError }` for the full fresh and stale window. Off by default.
  - A route row overrides the preset per record through `meta.cache`: `{ cache: { ttl: 3_600_000 } }`
    on a countries table, `{ cache: false }` on live inventory.
  - With `staleTtl` set, a past-fresh entry commits **at once** and the refresh runs behind it.
    `router.isRevalidating` is true while it does, and `isLoading` stays false, since the page
    has data. The fresh value patches into `snapshot.data` when it lands.
  - A custom preset gets the same channel through the loader SPI's `ctx.revalidate(promise)`.
- Specialize a preset only after profiling, not before.

## Everything else

- **One atomic snapshot:** `{ location, render, data }`, frozen per commit.
  `<RouterOutlet/>` = `render[depth]`, keyless (resolved-component identity => reuse, in both
  outlets).
- **The core's failure model, not a router taxonomy.** `push()` resolves to
  `RouterError | null`. A `RouterError` is the core's `BusError` under the core's rules, owner
  `router`, coded `router:condition:subject`. Every code is in `ERROR_CODE_REGISTRY` and
  [errors.md](errors.md). So `conditionOf`, `ownerOf` and `toJSON` read it like any other
  failure. The navigation target is `context.to`, the original error is `cause`, and only a
  `failed` code keeps a stack.
- **`HARD_NAV_CODES`** (a route, component or server HTML that is missing or failed) hard-navigate
  by default. The server gets the last word, and stale chunks recover. A guard that throws is
  `router:failed:guard` and does not hard-navigate. Use `useRouteError()` for boundaries.
- **Blade rows** are wrapped as ordinary components, with hydrate and dehydrate in the
  lifecycle. That allows an incremental Blade-to-Vue migration: flip `blade: true` to
  `component` per row.
- **`dom.ts` is the single DOM point.**
  - Link interception follows the page.js checklist, with a composed-path scan that crosses
    shadow roots, for a click, a hover and focus alike.
  - A link warms its page when the pointer rests on it or when it takes focus. Both follow the
    links of an open shadow root, nested roots included.
  - It stamps `data-active` and `data-exact-active` on Blade anchors, plus `aria-current="page"`
    on the exact one.
  - It runs hover, focus and idle preheat, set per route by `meta.preheat`. `true` warms the
    route's component when the page is idle, and on hover or focus. Absent, it warms on hover or
    focus only. `false`: a link to the route does not warm its component, though a route that
    names the same component still does.
  - No warm-up runs for a `download` link, or for a user saving data where the browser reports
    it (Save-Data or 2G).
- **Route changes reach assistive technology** (`announce.ts`).
  - Each client-side navigation is announced in an assertive live region. The text is
    `document.title`, else the first `<h1>`, else the path.
  - The initial load and a query-only change are not announced.
  - `announce: false` turns it off, and a function returns the text.
  - `focusOnNavigate: '<selector>'` also moves focus to a SMALL element the app gives (a
    heading, a skip link). It gets `tabindex="-1"` only if it is not focusable.[^announcer]
- **Route rows and guards:** the path syntax, typed params, the 404 row and `beforeEach` are in
  the manual, [chapter 6](manual/06-router.md#write-a-route-row).
- **Pure constructor:** IO and listeners begin at `start()` / `app.use()`.
- **Dev trusts the generator:** table validation runs in dev only. Production trusts the
  generated rows like a migration.
- **Composables:** `useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`,
  `useMenu`, `useBreadcrumbs`, `usePagination`, `onBeforeLeave`. All dispose with their scope.

[^announcer]: The rules follow Next.js's route announcer, and Gatsby's user testing with disabled users: a large focused wrapper broke magnification.

## Vapor interop

Measured on Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->, the installed version the fixtures run on, not
inferred from the [Vapor roadmap](https://github.com/vuejs/core/issues/13687). Two fixtures, and
the split matters:

- `tests/router/vapor-fixture.test.ts` mounts a real Vapor app and measures provide/inject as a
  *primitive*.
- `tests/vapor/router-composables.test.ts` runs the *composables themselves* inside
  `defineVaporComponent({ setup() })`, the shipped combination. It runs under
  `vitest.vapor.config.ts`, which aliases `vue` to the with-vapor dist.

**`provide`/`inject` works in Vapor, at both levels.** On a real `createVaporApp` app both levels
resolve correctly. `app.provide(...)` -> `inject(...)` backs every composable here.
Component-level `provide(...)` -> `inject(...)` backs nested `<RouterOutlet>` depth. So the
composable surface and outlet nesting are **not** blocked on the roadmap's "Provide/Inject
System" item.[^provide-rc4]

[^provide-rc4]: It worked from rc.4, while the roadmap's box was still unchecked. The box was checked by 2026-10-12.

**A Vapor-native outlet ships** (experimental, v1.x). `outlet.ts` renders through the vDOM, but
the router as a whole does not have to. `vapor-chamber/router/vapor` exports the same
`RouterOutlet` name, built from Vapor's own helpers: `createDynamicComponent` for the branch,
`createSlot` for the no-match fallback, and `createIf` to switch between them. So a pure-Vapor
app renders routes with **no `vaporInteropPlugin` installed at all**.

```ts
import { createRouter } from 'vapor-chamber/router';        // neither renderer
import { RouterOutlet } from 'vapor-chamber/router/vapor';  // Vapor, no interop
```

What it costs, and what it needs:

- **Measured saving: <!-- vc:outletSaving -->17.97<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->57.0<!-- /vc:outletSavingRaw --> KB raw** against the same
  app rendering through the vDOM outlet plus interop. The subpath's own cost is
  <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB brotli. The guard holds two limits:
  - the saving stays at least <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB.
  - the Vapor outlet's own machinery, over a router-without-outlet floor, stays at most
    <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB (measured <!-- vc:outletOwnArm -->4.14<!-- /vc:outletOwnArm --> KB).[^outlet-guard]
- **Route components must be `defineVaporComponent` output** (Vapor-compiled SFCs are). This is a
  real constraint, not a convention. The outlet checks the `__vapor` marker itself and throws a
  coded `router:invalid:component`: a loud failure in place of wrong-mode
  rendering.[^vapor-marker]
- **Blade rows still need the vDOM outlet.** `makeBladeComponent` is `defineComponent`/`h`, so a
  blade row that reaches the Vapor outlet throws the same `router:invalid:component`, with its own
  message pointing here. An app that mixes blade rows and Vapor pages renders through
  `vapor-chamber/router/vdom` and pays for interop. That is the most likely way to get a
  disappointing result from this subpath.
- **Parity with the vDOM outlet on everything else.**
  - It is keyless, so the same record at a depth keeps its instance across param and query
    changes.
  - Nested depth uses the same `Symbol.for` key, so the two outlets share one depth contract and
    can coexist.
  - Neither has `<Transition>`/`<KeepAlive>` integration or SSR/hydration.
  - Both reuse on resolved-component identity: two records that resolve to the same component
    reuse the instance.

[^outlet-guard]: `tests/vapor/vapor-outlet-size.test.ts` re-derives the saving on every test run from a Vite production build rather than quoting it. The same harness builds the baseline, so the two arms cannot differ by method.

[^vapor-marker]: With no interop installed, `createDynamicComponent` would otherwise create a vDOM component in Vapor mode, with no error of its own. The outlet deliberately does not fall back to interop, which would restore the whole interop cost the subpath exists to avoid (the saving above).

Two constraints to know before writing your own Vapor test or app:

- In Node and on a no-build page, Vapor ships as a **separate dist file**
  (`vue/dist/vue.runtime-with-vapor.esm-*.js`), and a bare `import 'vue'` has no Vapor. In a
  bundler the `vue` entry re-exports `@vue/runtime-vapor`. See `probeVue` in `chamber.ts`.
- Never mix that build with a plain `import 'vue'` in the same context. Two separately imported
  Vue dists are two disconnected reactivity instances, and the failure is silent. Import
  `provide`, `inject`, `defineVaporComponent` and the rest from the *same* module you got
  `createVaporApp` from.

Roadmap items this router does **not** depend on, by design:

| Item | Why |
| --- | --- |
| Async Component | lazy routes use the router's own `import()` + cache, resolved before the snapshot commits - never `defineAsyncComponent` |
| Suspense | the two-phase commit means a pending state is never rendered, so there is no boundary to need |

Still not usable here, for different reasons:

- **KeepAlive.** Nothing caches an inactive route's state here yet, so neither of KeepAlive's
  closed correctness issues reaches this router today.[^keepalive-issues]

  **`tryKeepAliveHooks` in `chamber.ts` stays**, with #15237 landed. It is not
  double-suppression.[^keepalive-pause] Vue's pausing suppresses reactive effects owned by the
  deactivated scope: a watcher in a paused scope does not run. `tryKeepAliveHooks` guards a
  `bus.onAfter` hook, a plain callback the bus calls synchronously from `dispatch`. That hook is
  owned by no scope and scheduled by no scheduler, so it still fires under a paused scope.

  - Vue's question: should this cached component re-render while off-screen?
  - This library's question: should a command dispatched while this component is deactivated be
    recorded into its undo history? That is a domain decision upstream has no view on.

  **The guard is gated on `hasInjectionContext()`**, true in both modes and false in a bare
  `effectScope()`. `getCurrentInstance()` is only a fallback for a partially supplied Vue
  namespace. It reads VDOM's `currentInstance`, where a Vapor component is not stored, so inside
  `defineVaporComponent({ setup() })` it returns null.[^gci-measured]

  **That null is by design, so the gate is permanent.** No future release should reintroduce an
  instance-accessor probe expecting it to start answering.[^gci-design] The same statement
  settles two roadmap boxes:

  - **Vue Test Utils** (unchecked): upstream has ruled out `findComponent`-style instance
    traversal. So this library's testing story, `createTestBus` and asserting at the bus
    boundary, needs no revision whichever way VTU lands.
  - **DevTools Integration** (unchecked): `src/devtools.ts` builds its inspector tree from
    buffered `bus.onAfter` entries, never from Vue's component tree. So the Commands timeline and
    inspector panel do not depend on the Vapor component-tree bookkeeping upstream has not built
    yet.
- **Transition:** route transitions. The View Transitions API is the DOM-native way around it.
- **SSR/hydration** for blade rows: no server-side render path exists.
  - `fetchBlade` is caller-supplied everywhere. A blade row without one throws
    `router:missing:fetchBlade`, in a browser or not.
  - `bladeFetcher()` off-DOM returns the document as fetched, rather than extracting
    `bladeRoot`. Fetching still works, and hydrating does not.

[^keepalive-issues]: The roadmap box is checked, and as of **rc.3** two correctness issues are closed. [#15228](https://github.com/vuejs/core/issues/15228) (a cached child renders against a nullish prop) was closed by [#15251](https://github.com/vuejs/core/pull/15251), which isolates cached component props and dynamic slots behind a commit boundary. [#15237](https://github.com/vuejs/core/issues/15237) (KeepAlive scopes not paused while deactivated) now propagates paused state through `EffectScope`/`ReactiveEffect`.

[^keepalive-pause]: `tests/keepalive-pause-fixture.test.ts` measures why.

[^gci-measured]: Measured on 3.6.0-rc.4: inside `defineVaporComponent({ setup() })` `getCurrentInstance()` returns null, while an `onDeactivated()` registered at the same point works and fires. While the guard was gated on it, `useCommandHistory` and `useCommandError` kept recording commands dispatched into a deactivated Vapor view. VDOM worked, so the suite stayed green. `tests/keepalive-input-scope-fixture.test.ts` drives a real `VaporKeepAlive` and pins it. The older stand-in fixture could not: a fixture that substitutes for the integration it reasons about only checks the half you already understood.

[^gci-design]: On the Vapor roadmap ([#13687](https://github.com/vuejs/core/issues/13687), July 20) a Vue core maintainer confirmed that `getCurrentInstance()` returning `null` inside Vapor components **is intentional**. An internal `useInstanceOption` API exists but is deliberately not public. In August they added that Vapor "does not expose a general-purpose component instance tree to userland", because user code should not depend on internal instances.

Read the roadmap both ways. An unchecked box does not mean missing (provide/inject, above), and a
checked box does not mean working. Still unchecked when read on 2026-10-12, and worth remembering
when reading anything that cites the roadmap: Suspense (VaporSuspense pending), DevTools
Integration, Vue Test Utils. Vue Router, Nuxt and VitePress are checked.

## Navigation as a command (optional)

A handler that calls `router.push()` puts navigation on the same timeline as every other
transition. That is occasionally what you want, and never needed:

```ts
bus.register('routeGo', (cmd) => router.push(cmd.target));
bus.dispatch('routeGo', '/orders/42');
```

The payoff is uniformity, not capability. The navigation appears in the devtools timeline, an
`authorize` rule on `routeGo` can refuse it as it refuses any other command, and `history`
treats it like any other command. Nothing in the router or the store depends on this. It is
sugar, and skipping it costs nothing.

To observe navigations without making them commands, emit facts:

```ts
import { routerFacts } from 'vapor-chamber/router';

const stop = routerFacts(router, bus);
bus.on('routerNavigated', (cmd) => track(cmd.target.to.fullPath));
```

- `routerNavigated` (`{ to, from }`) follows each committed path navigation, as `afterEach` does.
- `routerFailed` (`{ error, to }`) follows each failure the router reports to `onError`. A
  refusal or a superseded navigation emits nothing.
- `routerLoading` and `routerRevalidating` (`{ value }`) follow `router.isLoading` and
  `router.isRevalidating` as they change. `bindDisplay`'s `data-vc-router` reads them on a page
  outside the island.

No plugin runs, so the router's guards stay the only gate. DevTools shows the facts with
`setupDevtools(bus, app, { facts: ['router*'] })`.

## Status

Experimental, covered by the router node specs (`npm test`). The Vapor-native outlet ships (see
"Vapor interop" above). Next: a reference route generator with generated modules (end-to-end
proof), a browser playground, and a Vapor blade path. That path is the one caveat the Vapor
outlet does not close.

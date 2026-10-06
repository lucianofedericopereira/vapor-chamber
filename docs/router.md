# vapor-chamber/router

A router for **Vue 3.6** over a server-owned catch-all, with Laravel Blade as
the worked example. It needs Vue >= 3.6, by design. It ships in-box as a
subpath of `vapor-chamber`. It uses an http client only if you hand it one (see
the remote subpath below).

The server owns one catch-all (`/admin/{any?}` -> Blade shell -> one island).
The router owns every URL inside. **Path = navigation, query = state.**

**This is not vue-router.** It reuses several of its names for different
things. `router.currentRoute` is the frozen snapshot `{ location, render, data }`,
and the vue-router-shaped route object is `useRoute()`. So a habit from there
returns `undefined` rather than an error.

Data loading is **pluggable**. The router owns *when* loaders run (on
navigation, abort-on-supersede, two-phase commit). A loader **preset** owns
*how* each row's `load` string resolves, through the loader SPI. In-box:
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
  loaders: fetchLoaders(),                 // in-box preset - or your own LoaderHandlers
  components: { 'Catalog/ListPage': () => import('./pages/CatalogList.vue') },
  hydrate:   el => window.__mountIslandsIn?.(el),   // blade rows only
  dehydrate: el => window.__unmountIslandsIn?.(el),
});
app.use(router);
```

## Loaders: the SPI

A route row declares its data in the `load` column. HOW it resolves is a loader
preset plugged into the SPI, with three parts:

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
| `vapor-chamber/router` (this) | the router: table, engine, dom, loader SPI - **no renderer** |
| `vapor-chamber/router/vdom` | `RouterOutlet`, `makeBladeComponent` - opts you into Vue's vDOM runtime |
| `vapor-chamber/router/vapor` | `RouterOutlet`, Vapor-native - opts you into the Vapor runtime (Vue 3.6 only). Experimental |
| `vapor-chamber/router/remote` | `routerHttp()` + `bladeFetcher()` - opts you into the chamber http client |
| `vapor-chamber/router-fetch` | in-box preset: plain-JSON URL loaders, any backend |
| your own preset | write a `LoaderHandlers` (`prefixes` + `url` + `affects`) |

### Two features that need an http client, and do not assume one

A `{ url }` route table and blade rows both make a request. Neither is built
into the router: it takes an `HttpClient` and a `fetchBlade` as ordinary
options, and `vapor-chamber/router/remote` supplies the in-box pair.

```ts
import { createRouter } from 'vapor-chamber/router';
import { routerHttp, bladeFetcher } from 'vapor-chamber/router/remote';

const http = routerHttp();                       // + X-Vapor-Router marker header
createRouter({
  routes: { url: '/api/vc/routes' }, http,       // needed for a { url } table
  fetchBlade: bladeFetcher({ http }),            // needed if any row is blade
});
```

The primary setup, generated route rows with no blade rows, needs neither, and
that is the point. A router that built the client for everyone would put the
whole client (CSRF, interceptors, retry, cache) in every consumer's bundle. It
would do so to serve two optional features. The outlet subpaths below follow
the same reasoning, and `tests/router/remote-boundary.test.ts` enforces this
split the same way.

Forgetting one is a coded error, never a silent failure: `router:missing:http`
for a `{ url }` table, `router:missing:fetchBlade` for a blade row.

Reads answer plain JSON, like a loader. The `{ url }` endpoint (and an inline
element) holds the table itself, `{ routes, base? }`. A failure is a non-2xx
`application/problem+json` (`router:failed:routes`, the client's error as its
`cause`). The command envelope is not a read's shape: a `{ state }` or a 2xx
`{ problem }` is `router:unexpected:routes`.

### Deriving state from the route

`router.currentRoute` is a shallowRef of a **frozen** snapshot. So anything
that wants route-derived state writes a `computed` over it rather than
subscribing:

```ts
// `params: { id: 'int' }` on the row: the id is a number, and `/products/7x`
// does not match the row at all.
const productId = computed(() => router.currentRoute.value.location.params.id);
const products  = computed(() => router.currentRoute.value.data.get('shop.products'));
```

Pull-based derivation beats bridging navigation into events on every axis that
matters here. It is always consistent with the committed snapshot. An event
handler can observe the world mid-navigation, and a computed over a frozen
commit cannot. It has no subscription to dispose, no ordering contract, and no
listener list to fan out per navigation. It costs nothing while nothing reads
it.

`afterEach` remains the right tool for *effects*: analytics beacons, imperative
scroll restoration, anything that should happen because a navigation happened.
It is not the mechanism for getting route state into a component.

### Refreshing data after a mutation

After a command changes server state, the data behind the current route is
stale. `revalidateRoutes` closes that loop as a bus plugin. It adds no router
capability: it composes `runLoaders`, `currentRoute` and `setRouteData`, all
already public. It ships from the main `vapor-chamber/router` entry rather than
a subpath of its own. It imports nothing the router core does not already
have, so there is no cost for a subpath to isolate. It tree-shakes away for
anyone who never calls it.

```ts
import { createRouter, revalidateRoutes } from 'vapor-chamber/router';

const loaders = fetchLoaders();
const router = createRouter({ routes, loaders, components });

bus.use(revalidateRoutes(router, loaders, {
  'cart*':      ['shop.cart'],   // command pattern -> record names to refresh
  'productSave': 'affected',     // or: the current route's whole load chain
}));
```

Pass the SAME `loaders` instance the router uses. `createRouter` closes over its
preset and exposes it nowhere. A plugin that built its own would run a second
HTTP client and a second cache, silently diverging from the router's.

The plugin's rules:

- Only successful commands refresh. A failed mutation refreshing as though it
  had worked is the bug this avoids.
- A superseded navigation drops its refresh.
- A rejected refresh leaves the stale data on screen.
- A record name that is not in the current load chain is a loud
  `router:missing:record`, not a silent no-op.

**It flips its own `isRevalidating`, not the router's.** `router.isRevalidating`
means "a LOADER handed the engine a refresh through `ctx.revalidate`". It has
exactly one writer inside the engine. Two independent refresh sources get two
flags rather than one flag with two writers. OR them if you want a single
spinner.

### Writing a preset

A preset is a plain `LoaderHandlers` object. Nothing registers it globally: you
pass it to `createRouter({ loaders })`, and it is fixed for the router's life.
`setRoutes()` swaps rows, never loaders.

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

Five rules, each enforced by the engine rather than left to convention:

**Return the data, and the router keys it.** Whatever a handler returns is
committed into `snapshot.data` under `record.name`, which is what
`useRouteData()` reads. The router never inspects the shape, so return what
your components want.

**Honour the `signal`.** Starting a navigation aborts the previous one's loaders
immediately, and a query-only change aborts the previous refetch. Pass it to
`fetch`, or check `signal.aborted` around a non-fetch source. Otherwise a
superseded request keeps running and resolves into a snapshot nobody is looking
at.

**Throw, do not swallow.** Any error becomes a coded `router:failed:loader`
carrying yours as `cause`. A `RouterError` you throw yourself passes through
untouched, so you can raise a more specific code. If the signal aborted, it
becomes `router:aborted:navigation` instead. The engine reads that as
supersession and deliberately does NOT report it to `onError`: a cancelled load
is normal flow, not a failure.

**Override `affects` only if the default is wrong for your dialect.** On a
query-only change the engine refetches just the loaders a changed key affects.
By default, a prefix loader depends on every query param its record declares,
plus `page`, `per_page` and `sort`. A url template depends only on the
`{placeholders}` it mentions. Supply `affects(record, changedKeys)` when your
backend has different query semantics. It is resolved once at `createRouter`,
so there is nothing to recompute per navigation.

**Report a background refresh through `ctx.revalidate`.** A handler serving
stale data now and refreshing behind it hands the refresh promise to
`ctx.revalidate(promise)`, a member of the fifth argument. The engine flips
`router.isRevalidating` and patches `snapshot.data` when it resolves. It drops
the refresh if the location changed meanwhile, and keeps the stale value if it
rejects. Without it, a stale-while-revalidate response refreshes your cache but
never the page.

**Read past your cache when `ctx.refresh` is true.** The fifth argument's other
member says why the loader runs. It is `true` when `revalidateRoutes` refreshes
the page after a command changed its data, and `false` on a navigation or a
query refetch. A handler that caches must not answer a refresh from the cache,
or the page gets the copy from before the change. `fetchLoaders` drops its URL
from the client's cache first (`tests/router-fetch/revalidate-past-cache.test.ts`).

`vapor-chamber/router-fetch` is a worked example of the **`url` handler**
specifically. Read it for the signature, the abort behaviour and the
`ctx.revalidate` hand-off. It registers no `prefixes` and no `affects`, so for
those two the example above is the reference.

Core mechanics are preset-independent. Loaders run on navigation with an
AbortController created per navigation. **A newer navigation aborts the
previous one's fetches at start**, as vue-router's data loaders do (verified
from source). Results commit **atomically on the snapshot**, in two phases, so
a page never renders with the previous page's data.

### Why the outlet is a separate subpath

`RouterOutlet` is a `defineComponent` + `h()` component. Anything that can
reach it *statically* pins Vue's virtual-DOM runtime into the consumer's
bundle. So a Vapor app that never renders one would still pay for it. Two
consequences, both deliberate:

- **`app.use(router)` does not register `<RouterOutlet>` globally.** Import it
  and register it locally where you use it.
- **It is not re-exported from `vapor-chamber/router`.** A static re-export is
  a static reference and would defeat the split.

The bindings each entry retains from `vue`, measured on the built `dist/` by
the harness of `tests/router/vdom-boundary.test.ts` and
`tests/router/vapor-boundary.test.ts` (the last row is asserted exactly):

| entry | retains |
|---|---|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` |
| `vapor-chamber/router/vapor` | `createDynamicComponent createIf createSlot defineVaporComponent inject provide` |

Blade rows need no import from you: the router pulls `makeBladeComponent` in
on demand, as a separate chunk, the first time it renders one.

> `RouterOutlet`, `makeBladeComponent` and `BladeHooks` live in
> `vapor-chamber/router/vdom`, and `app.use(router)` does not register
> `<RouterOutlet>` globally: register it locally where you render it. A global
> registration or a re-export from the router entry would be the static
> reference that pins Vue's vDOM runtime into every bundle.

## Pagination, productized

```ts
const { items, page, total, lastPage, hasNext, next, prev, pageRange, loading }
  = usePagination<Product>();

page.value = 3;   // URL -> ?page=3 (pushState), loader refetches (abort-on-supersede),
                  // items update - NO matching, NO guards, NO remount
```

`page` is a real `Ref`, so templates auto-unwrap it (`{{ page }}`) and `.value`
is script-only, as in every other composable here. Reading the response is the
only backend-specific part, so each extractor is overridable. The defaults
accept `{ items | data }` alongside `{ total, per_page | perPage,
last_page | lastPage }` (or their `meta` nesting). That covers Laravel's
paginator and most plain-JSON APIs:

```ts
usePagination<Product>({ items: d => d.rows, total: d => d.count });
```

`pageRange` is windowed for a pager UI. The first and last page are always
present, with a run around the current one. A `0` marks elided numbers
(render it as "..."). `loading` is the router's own in-flight flag, so a slow page can show a
spinner without tracking request state by hand.

Query-only changes commit the URL immediately (optimistic) and refetch only
the loaders whose template depends on a changed key. Back and forward step
through pages. Push or replace is decided by the first that applies: explicit
call -> route declaration -> convention (**`page` pushes, everything else
replaces**). Default values drop from the URL.

## Menus + breadcrumbs, projected: never authored twice

The table already knows the navigation UI. `useMenu()` and `useBreadcrumbs()`
only project it:

```ts
const menu = useMenu();       // rows flagged meta.menu (an INTEGER - the
                              // server-owned menu position), nested by nearest
                              // menued ancestor, labels = meta.title i18n keys
const crumbs = useBreadcrumbs(); // the matched parent chain, titled rows only,
                                 // root-first, current page last
```

- **Permission-correct by construction**: rows arrive server-filtered
  (`visibleTo`), so whatever the table holds is what the user may see.
- **active/exact share `pathActivity()`** with `data-active` stamping, so a
  Blade-rendered menu and a Vue-rendered menu can never disagree.
- **`aria-current="page"` goes on the exact match only**: `exactActive`, or the
  breadcrumb whose `current` is true. Never on `active`, which also lights up a
  section parent: a screen reader would then announce two current pages.
  `stampActiveLinks` does it for plain anchors. It leaves any other
  `aria-current` value the page set (`"step"`, `"location"`) alone.
- **Menu rows are static navigation**: `meta.menu` needs `meta.title` and a
  path without mandatory params, loud in dev. Group rows become href-less
  section nodes.
- Reactive to navigation **and** table swaps (`setRoutes` / `reload`). The
  compiled records are exposed as `router.routes`, a reactive ref.

## Hot paths (fast-lane philosophy: opt-in, never the default)

- **`router.setRouteData(name, value)`** patches loader data directly: zero
  loader run, zero navigation, one frozen snapshot, fully reactive. Use it when
  fresh state is already in hand: a bus command's response (`{ state }` ->
  straight onto the page), a websocket push, an optimistic update.
- **Preset-internal compile caches**: a prefix handler may pre-compile
  per-record closures (record identity -> fn). The SPI never sees it.
- **Chamber http LRU**, in-box: `fetchLoaders({ cache: true })`, or
  `{ ttl, staleTtl, serveStaleOnError }` for the full fresh/stale window. Off by
  default. A route row overrides the preset per record through `meta.cache`:
  `{ cache: { ttl: 3_600_000 } }` on a countries table, `{ cache: false }` on
  live inventory. With `staleTtl` set, a past-fresh entry commits
  **immediately** and the refresh runs behind it. `router.isRevalidating` is
  true while it does. `isLoading` stays false, since the page has data. The
  fresh value patches into `snapshot.data` when it lands. A custom preset gets
  the same channel through the loader SPI's `ctx.revalidate(promise)`.
- Specialize a preset only past profiling, not before.

## Everything else

- **One atomic snapshot**: `{ location, render, data }`, frozen per commit.
  `<RouterOutlet/>` = `render[depth]`, keyless (resolved-component identity =>
  reuse, in both outlets).
- **The core's failure model, not a router taxonomy**: `push()` resolves to
  `RouterError | null`. A `RouterError` is the core's `BusError` under the
  core's rules, owner `router`. It is coded `router:condition:subject` (every
  code is in `ERROR_CODE_REGISTRY` and [errors.md](errors.md)). So
  `conditionOf`, `ownerOf` and `toJSON` read it like any other failure. The
  navigation target is `context.to`, the original error `cause`, and only a
  `failed` code keeps a stack.
- **`HARD_NAV_CODES`** (a route, component or server HTML that is missing or
  failed) hard-navigate by default. The server gets the last word, and stale
  chunks recover. A guard that throws is `router:failed:guard` and does not.
  `useRouteError()` for boundaries.
- **Blade rows** are wrapped as ordinary components (hydrate/dehydrate in
  lifecycle). That allows an incremental Blade->Vue migration: flip
  `blade: true` to `component` per row.
- **dom.ts** is the single DOM point. It does page.js-checklist link
  interception (a composed-path scan that crosses shadow roots). It stamps
  `data-active` and `data-exact-active` on Blade anchors, plus
  `aria-current="page"` on the exact one. It runs hover and idle preheat (the
  `meta.preheat` column).
- **Route changes reach assistive technology** (`announce.ts`). Each
  client-side navigation is announced in an assertive live region. The text is
  `document.title`, else the first `<h1>`, else the path. The initial load and
  a query-only change are not announced. `announce: false` turns it off, and a
  function returns the text. `focusOnNavigate: '<selector>'` also moves focus to
  a SMALL element the app gives (a heading, a skip link). It is made focusable
  with `tabindex="-1"` only if it is not. The rules follow Next.js's route
  announcer and Gatsby's user testing with disabled users: a large focused
  wrapper broke magnification.
- **Pure constructor**: IO and listeners begin at `start()` / `app.use()`.
- **Dev-trusts-generator**: table validation runs in dev only. Production
  trusts the generated rows like a migration.
- Composables: `useRouter useRoute useQueryParam useRouteData useRouteError
  useMenu useBreadcrumbs usePagination onBeforeLeave`, all
  scope-auto-disposing.

## Vapor interop

Measured against `vue@3.6.0-rc.5`, not inferred from the
[Vapor roadmap](https://github.com/vuejs/core/issues/13687). Two fixtures, and
the split matters:

- `tests/router/vapor-fixture.test.ts` mounts a real Vapor app and measures
  provide/inject as a *primitive*.
- `tests/vapor/router-composables.test.ts` runs the *composables themselves*
  inside `defineVaporComponent({ setup() })`, the actual shipped combination.
  It runs under `vitest.vapor.config.ts`, which aliases `vue` to the
  with-vapor dist.

**provide/inject works in Vapor, at both levels.** The roadmap lists
"Provide/Inject System" unchecked. But on a real `createVaporApp` app both
levels resolve correctly. `app.provide(...)` -> `inject(...)` backs every
composable here. Component-level `provide(...)` -> `inject(...)` backs nested
`<RouterOutlet>` depth. So the composable surface and outlet nesting are **not**
blocked on that roadmap item.

**A Vapor-native outlet ships** (experimental, v1.x). `outlet.ts` renders
through the vDOM, but the router as a whole does not have to.
`vapor-chamber/router/vapor` exports the same `RouterOutlet` name, built from
Vapor's own helpers: `createDynamicComponent` for the branch, `createSlot` for
the no-match fallback. So a pure-Vapor app renders routes with **no
`vaporInteropPlugin` installed at all**.

```ts
import { createRouter } from 'vapor-chamber/router';        // neither renderer
import { RouterOutlet } from 'vapor-chamber/router/vapor';  // Vapor, no interop
```

What it costs, and what it needs:

- **Measured saving: <!-- vc:outletSaving -->22.06<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->70.4<!-- /vc:outletSavingRaw --> KB raw** against the same app
  rendering through the vDOM outlet plus interop.
  `tests/vapor/vapor-outlet-size.test.ts` re-derives it every test run from a
  Vite production build rather than quoting it. The same harness builds the
  baseline, so the two arms cannot differ by method. The guard holds two
  limits. The saving stays >= <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB.
  The Vapor outlet's own machinery over a router-without-outlet floor stays
  <= <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB
  (measured <!-- vc:outletOwnArm -->4.71<!-- /vc:outletOwnArm --> KB). The
  subpath's own cost is <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB brotli.
- **Route components must be `defineVaporComponent` output** (Vapor-compiled
  SFCs are). This is a real constraint, not a convention. With no interop
  installed, `createDynamicComponent` would otherwise create a vDOM component
  in Vapor mode with no error of its own. The outlet therefore checks the
  `__vapor` marker itself and throws a coded `router:invalid:component`. That
  is a loud failure in place of wrong-mode rendering. It is deliberately not a
  silent fallback to interop, which would restore the whole interop cost the
  subpath exists to avoid (the saving above).
- **Blade rows still need the vDOM outlet.** `makeBladeComponent` is
  `defineComponent`/`h`. So a blade row reaching the Vapor outlet is the same
  `router:invalid:component` throw, with its own message pointing here. An app
  that mixes blade rows and Vapor pages renders through
  `vapor-chamber/router/vdom` and pays for interop. That is unchanged, and it is
  the single most likely way to get a disappointing result from this subpath.
- **Parity with the vDOM outlet on everything else.** It is keyless, so the
  same record at a depth keeps its instance across param and query changes.
  Nested depth uses the same `Symbol.for` key, so the two outlets share one
  depth contract and can coexist. Neither has `<Transition>`/`<KeepAlive>`
  integration or SSR/hydration.

Both outlets reuse on **resolved-component identity**. "Record identity implies
reuse" is shorthand, not the mechanism. Two different records resolving to the
same component reuse the instance, by design, in both.

Two constraints worth knowing before writing your own Vapor test or app:

- Vapor ships as a **physically separate dist file**
  (`vue/dist/vue.runtime-with-vapor.esm-*.js`). A bare `import 'vue'` never
  resolves to it outside a bundler's per-app alias. See `probeVue` in
  `chamber.ts` and whitepaper section 9.6.
- Never mix that build with a plain `import 'vue'` in the same context. Two
  separately-imported Vue dists are two disconnected reactivity instances, and
  the failure is silent. Import `provide`, `inject`, `defineVaporComponent` and
  friends from the *same* module you got `createVaporApp` from.

Roadmap items this router does **not** depend on, by design:

| Item | Why |
| --- | --- |
| Async Component | lazy routes use the router's own `import()` + cache, resolved before the snapshot commits - never `defineAsyncComponent` |
| Suspense | the two-phase commit means a pending state is never rendered, so there is no boundary to need |

Still not usable here, though the reasons differ:

- **KeepAlive.** The roadmap box is checked, and as of **rc.3** two correctness
  issues are closed. [#15228](https://github.com/vuejs/core/issues/15228) (a
  cached child renders against a nullish prop) was closed by
  [#15251](https://github.com/vuejs/core/pull/15251), which isolates cached
  component props and dynamic slots behind a commit boundary.
  [#15237](https://github.com/vuejs/core/issues/15237) (KeepAlive scopes not
  paused while deactivated) now propagates paused state through
  `EffectScope`/`ReactiveEffect`. Nothing caches an inactive route's state here
  yet, so neither reaches this router today.

  **`tryKeepAliveHooks` in `chamber.ts` stays** with #15237 landed. It is not
  double-suppression, and `tests/keepalive-pause-fixture.test.ts` measures why.
  Vue's pausing suppresses reactive effects owned by the deactivated scope: a
  watcher in a paused scope does not run. `tryKeepAliveHooks` guards a
  `bus.onAfter` hook, a plain callback the bus calls synchronously from
  `dispatch`. That hook is owned by no scope and scheduled by no scheduler, so
  it still fires under a paused scope. The two answer different questions.
  Vue's is "should this cached component re-render while off-screen?". Ours is
  "should a command dispatched while this component is deactivated be recorded
  into its undo history?", a domain decision upstream has no view on.

  **The guard is gated on `hasInjectionContext()`**, true in both modes and
  false in a bare `effectScope()`. `getCurrentInstance()` is only a fallback
  for a partially-supplied Vue namespace. `getCurrentInstance()` reads VDOM's
  `currentInstance`, where a Vapor component is not stored. Measured on
  3.6.0-rc.4: inside `defineVaporComponent({ setup() })` it returns null, while
  an `onDeactivated()` registered at the same point works and fires. While the
  guard was gated on it, `useCommandHistory` and `useCommandError` kept
  recording commands dispatched into a deactivated Vapor view. VDOM worked, so
  the suite stayed green. `tests/keepalive-input-scope-fixture.test.ts` drives a
  real `VaporKeepAlive` and pins it. The older stand-in fixture could not: a
  fixture that substitutes for the integration it reasons about only checks
  the half you already understood.

  **That null is by design, so the gate is permanent.** On the Vapor roadmap
  ([#13687](https://github.com/vuejs/core/issues/13687), July 20) a Vue core
  maintainer confirmed that `getCurrentInstance()` returning `null` inside
  Vapor components **is intentional**. An internal `useInstanceOption` API
  exists but is deliberately not public. In August they added that Vapor "does
  not expose a general-purpose component instance tree to userland", because
  user code should not depend on internal instances. So no future release
  should reintroduce an instance-accessor probe expecting it to start
  answering.

  The same statement settles two roadmap boxes people will ask about. **Vue
  Test Utils** (unchecked): `findComponent`-style instance traversal is what
  upstream has ruled out. So this library's testing story, `createTestBus` and
  asserting at the bus boundary, needs no revision whichever way VTU lands.
  **DevTools Integration** (unchecked): `src/devtools.ts` builds its inspector
  tree from buffered `bus.onAfter` entries, never from Vue's component tree. So
  the Commands timeline and inspector panel do not depend on the Vapor
  component-tree bookkeeping upstream has not built yet.
- **Transition**: route transitions. The View Transitions API is the
  DOM-native way around it.
- **SSR/Hydration** for blade rows: no server-side render path exists.
  `fetchBlade` is caller-supplied everywhere: a blade row without one throws
  `router:missing:fetchBlade`, browser or not. `bladeFetcher()` off-DOM returns
  the document as fetched rather than extracting `bladeRoot`. Fetching still
  works, and hydrating does not.

Read the roadmap both ways. An unchecked box does not mean missing
(provide/inject, above), and a checked box does not mean working. Still
unchecked, and worth remembering when reading anything that cites the roadmap:
Vue Router, Suspense (VaporSuspense pending), DevTools Integration, Nuxt,
VitePress, Vue Test Utils.

## Navigation as a command (optional)

A handler that calls `router.push()` puts navigation on the same timeline as
every other transition. That is occasionally what you want and never needed:

```ts
bus.register('routeGo', (cmd) => router.push(cmd.target));
bus.dispatch('routeGo', '/orders/42');
```

The payoff is uniformity, not capability. The navigation now appears in the
devtools timeline, `onBefore` can cancel it alongside everything else, and
`history` treats it like any other command. Nothing in the router or the store
depends on this. It is sugar, and skipping it costs nothing.

## Status

Experimental, covered by the router node specs (`npm test`). The Vapor-native
outlet ships (see the Vapor interop section above). Next: a reference route
generator + generated modules (E2E proof), a browser playground, and a Vapor
blade path. That path is the one caveat the Vapor outlet does not close.

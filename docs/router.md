# vapor-chamber/router

A router for **Vue 3.6** over a server-owned catch-all, with Laravel Blade as
the worked example. It requires Vue >= 3.6, by design. It ships in-box as a
subpath of `vapor-chamber` and uses an http client only if you hand it one (see
the remote subpath below).

The server owns one catch-all (`/admin/{any?}` -> Blade shell -> one island); the
router owns every URL inside. **Path = navigation, query = state.**

**This is not vue-router.** It reuses several of its names for different things -
`router.currentRoute` is the frozen snapshot `{ location, render, data }`, and
the vue-router-shaped route object is `useRoute()` - so a habit from there
returns `undefined` rather than an error.

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
  loaders: fetchLoaders(),                 // in-box preset - or your own LoaderHandlers
  components: { 'Catalog/ListPage': () => import('./pages/CatalogList.vue') },
  hydrate:   el => window.__mountIslandsIn?.(el),   // blade rows only
  dehydrate: el => window.__unmountIslandsIn?.(el),
});
app.use(router);
```

## Loaders: the SPI

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
| `vapor-chamber/router` (this) | the router: table, engine, dom, loader SPI - **no renderer** |
| `vapor-chamber/router/vdom` | `RouterOutlet`, `makeBladeComponent` - opts you into Vue's vDOM runtime |
| `vapor-chamber/router/vapor` | `RouterOutlet`, Vapor-native - opts you into the Vapor runtime (Vue 3.6 only). Experimental |
| `vapor-chamber/router/remote` | `routerHttp()` + `bladeFetcher()` - opts you into the chamber http client |
| `vapor-chamber/router-fetch` | in-box preset: plain-JSON URL loaders, any backend |
| your own preset | implement `LoaderHandlers` (`prefixes` + `url` + `affects`) |

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
that is the point. The router used to construct the client for everyone, which
put the whole client (CSRF, interceptors, retry, cache) in every consumer's
bundle to serve two optional features. The outlet subpaths below follow the
same reasoning, and `tests/router/remote-boundary.test.ts` enforces this split
the same way.

Forgetting one is a coded error, never a silent failure: `http_unconfigured`
for a `{ url }` table, `blade_unconfigured` for a blade row.

### Deriving state from the route

`router.currentRoute` is a shallowRef of a **frozen** snapshot, so anything that
wants route-derived state writes a `computed` over it rather than subscribing:

```ts
const productId = computed(() => Number(router.currentRoute.value.location.params.id));
const products  = computed(() => router.currentRoute.value.data.get('shop.products'));
```

Pull-based derivation beats bridging navigation into events on every axis that
matters here. It is always consistent with the committed snapshot - an event
handler can observe the world mid-navigation, a computed over a frozen commit
cannot. It has no subscription to dispose, no ordering contract, no listener
list to fan out per navigation, and it costs nothing while nothing reads it.

`afterEach` remains the right tool for *effects* - analytics beacons, imperative
scroll restoration, anything that should happen because a navigation happened.
It is not the mechanism for getting route state into a component.

### Refreshing data after a mutation

After a command changes server state, the data behind the current route is
stale. `revalidateRoutes` closes that loop as a bus plugin. It adds no router
capability: it composes `runLoaders`, `currentRoute` and `setRouteData`, all
already public. It ships from the main `vapor-chamber/router` entry rather than
a subpath of its own because it imports nothing the router core does not
already have, so there is no cost for a subpath to isolate, and it tree-shakes
away for anyone who never calls it.

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
preset and exposes it nowhere, so a plugin that built its own would be running a
second HTTP client and a second cache, silently diverging from the router's.

Only successful commands refresh (a failed mutation refreshing as though it had
worked is the bug this avoids), a superseded navigation drops its refresh, a
rejected refresh leaves the stale data on screen, and a record name that is not
in the current load chain is a loud `unknown_route_name` rather than a silent
no-op.

**It flips its own `isRevalidating`, not the router's.** `router.isRevalidating`
means "a LOADER handed the engine a refresh through `ctx.revalidate`" and has
exactly one writer inside the engine. Two independent refresh sources get two
flags rather than one flag with two writers; OR them if you want a single
spinner.

### Writing a preset

A preset is a plain `LoaderHandlers` object. Nothing registers it globally: you
pass it to `createRouter({ loaders })`, and it is fixed for the router's life -
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

**Return the data; the router keys it.** Whatever a handler returns is committed
into `snapshot.data` under `record.name` - which is what `useRouteData()` reads.
The router never inspects the shape, so return what your components want.

**Honour the `signal`.** Starting a navigation aborts the previous one's loaders
immediately, and a query-only change aborts the previous refetch. Pass it to
`fetch` (or check `signal.aborted` around a non-fetch source) or a superseded
request keeps running and resolves into a snapshot nobody is looking at.

**Throw, do not swallow.** Any error becomes a coded `load_failed` carrying
yours as `cause`; a `RouterError` you throw yourself passes through untouched,
so you can raise a more specific code. If the signal aborted, it becomes
`cancelled` instead, which the engine reads as supersession and deliberately
does NOT report to `onError` - a cancelled load is normal flow, not a failure.

**Override `affects` only if the default is wrong for your dialect.** On a
query-only change the engine refetches just the loaders a changed key affects.
The default: a prefix loader depends on every query param its record declares
plus `page`, `per_page` and `sort`; a url template depends only on the
`{placeholders}` it mentions. Supply `affects(record, changedKeys)` when your
backend has different query semantics. It is resolved once at `createRouter`,
so there is nothing to recompute per navigation.

**Report a background refresh through `ctx.revalidate`.** A handler serving
stale data now and refreshing behind it hands the refresh promise to
`ctx.revalidate(promise)` - the fifth argument's one member. The engine flips
`router.isRevalidating`, patches `snapshot.data` when it resolves, drops it if
the location changed meanwhile, and keeps the stale value if it rejects.
Without it, a stale-while-revalidate response refreshes your cache but never
the page.

`vapor-chamber/router-fetch` is a worked implementation of the **`url` handler**
specifically - read it for the signature, the abort behaviour and the
`ctx.revalidate` hand-off. It registers no `prefixes` and no `affects`, so for
those two the example above is the reference.

Core mechanics are preset-independent. Loaders run on navigation with an
AbortController created per navigation, and **a newer navigation aborts the
previous one's fetches at start** (vue-router data-loaders timing, verified
from source). Results commit **atomically on the snapshot** (two-phase: a page
never renders with the previous page's data).

### Why the outlet is a separate subpath

`RouterOutlet` is a `defineComponent` + `h()` component. Anything that can
reach it *statically* pins Vue's virtual-DOM runtime into the consumer's
bundle - so a Vapor app that never renders one would still pay for it. Two
consequences, both deliberate:

- **`app.use(router)` does not register `<RouterOutlet>` globally.** Import it
  and register it locally where you use it.
- **It is not re-exported from `vapor-chamber/router`.** A static re-export is
  a static reference and would defeat the split.

Measured on the built `dist/` (`tests/router/vdom-boundary.test.ts` and
`tests/router/vapor-boundary.test.ts`), the bindings each entry retains from
`vue`:

| entry | retains |
|---|---|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` |
| `vapor-chamber/router/vapor` | `createDynamicComponent createSlot defineVaporComponent inject provide` |

Blade rows need no import from you: the router pulls `makeBladeComponent` in
on demand, as a separate chunk, the first time it renders one.

> **Breaking in v1.11.0:** `RouterOutlet`, `makeBladeComponent` and
> `BladeHooks` moved from `vapor-chamber/router` to `vapor-chamber/router/vdom`,
> and `app.use(router)` no longer registers `<RouterOutlet>` globally. Apps that
> relied on the global registration must register it locally. It shipped in a
> minor release deliberately: the router is experimental, and keeping deprecated
> re-exports would reinstate the static reference this change exists to remove.

## Pagination, productized

```ts
const { items, page, total, lastPage, hasNext, next, prev, pageRange, loading }
  = usePagination<Product>();

page.value = 3;   // URL -> ?page=3 (pushState), loader refetches (abort-on-supersede),
                  // items update - NO matching, NO guards, NO remount
```

`page` is a real `Ref`, so templates auto-unwrap it (`{{ page }}`) and `.value`
is script-only - same as every other composable here. Reading the response is
the only backend-specific part, so each extractor is overridable; the defaults
accept `{ items | data }` alongside `{ total, per_page | perPage,
last_page | lastPage }` (or their `meta` nesting), which covers Laravel's
paginator and most plain-JSON APIs:

```ts
usePagination<Product>({ items: d => d.rows, total: d => d.count });
```

`pageRange` is windowed for a pager UI - first and last page always present, a
run around the current one, and `0` where numbers were elided (render it as
"..."). `loading` is the router's own in-flight flag, so a slow page can show a
spinner without tracking request state by hand.

Query-only changes commit the URL immediately (optimistic) and refetch only
the loaders whose template depends on a changed key. Back and forward step
through pages. Push or replace is decided by the first that applies: explicit
call -> route declaration -> convention (**`page` pushes, everything else
replaces**). Default values drop from the URL.

## Menus + breadcrumbs, projected: never authored twice

The table already knows the navigation UI; `useMenu()` / `useBreadcrumbs()`
only project it:

```ts
const menu = useMenu();       // rows flagged meta.menu (an INTEGER - the
                              // server-owned menu position), nested by nearest
                              // menued ancestor, labels = meta.title i18n keys
const crumbs = useBreadcrumbs(); // the matched parent chain, titled rows only,
                                 // root-first, current page last
```

- **Permission-correct by construction** - rows arrive server-filtered
  (`visibleTo`), so whatever the table holds is what the user may see.
- **active/exact share `pathActivity()`** with `data-active` stamping - a
  Blade-rendered menu and a Vue-rendered menu can never disagree.
- **Menu rows are static navigation**: `meta.menu` needs `meta.title` and a
  path without required params - loud in dev. Group rows become href-less section nodes.
- Reactive to navigation **and** table swaps (`setRoutes` / `reload` - the
  compiled records are exposed as `router.routes`, a reactive ref).

## Hot paths (fast-lane philosophy: opt-in, never the default)

- **`router.setRouteData(name, value)`** - patch loader data directly: zero
  loader run, zero navigation, one frozen snapshot, fully reactive. For when
  fresh state is already in hand - a bus command's response
  (`{ ok, state }` -> straight onto the page), a websocket push, an
  optimistic update.
- **Preset-internal compile caches** - a prefix handler may pre-compile
  per-record closures (record identity -> fn); the SPI never sees it.
- **Chamber http LRU** - in-box since v1.12.0:
  `fetchLoaders({ cache: true })`, or `{ ttl, staleTtl, serveStaleOnError }`
  for the full fresh/stale window. Off by default. A route row overrides the
  preset per record via `meta.cache` - `{ cache: { ttl: 3_600_000 } }` on a
  countries table, `{ cache: false }` on live inventory. With `staleTtl` set,
  a past-fresh entry commits **immediately** and the refresh runs behind it:
  `router.isRevalidating` is true while it does (separate from `isLoading`,
  which stays false - the page has data), and the fresh value patches into
  `snapshot.data` when it lands. A custom preset gets the same channel through
  the loader SPI's `ctx.revalidate(promise)`.
- Measured baseline: the SPI itself costs ~20µs per navigation on a
  5k-row local source - specialize only past profiling, not before.

## Everything else

- **One atomic snapshot** - `{ location, render, data }`, frozen per commit;
  `<RouterOutlet/>` = `render[depth]`, keyless (resolved-component identity =>
  reuse, in both outlets).
- **One error taxonomy** - `push()` resolves to `RouterError | null`;
  machine-readable codes; `HARD_NAV_CODES` hard-navigate by default (server
  gets the last word; stale chunks recover). `useRouteError()` for boundaries.
- **Blade rows** are wrapped as ordinary components (hydrate/dehydrate in
  lifecycle) - incremental Blade->Vue migration, flip `blade: true` to
  `component` per row.
- **dom.ts** is the single DOM point: page.js-checklist link interception
  (composed-path scan - crosses shadow roots), `data-active`/
  `data-exact-active` stamping on Blade anchors, hover + idle preheat
  (`meta.preheat` column).
- **Pure constructor** - IO/listeners begin at `start()` / `app.use()`.
- **Dev-trusts-generator** - table validation runs in dev only; production
  trusts the generated rows like a migration.
- Composables: `useRouter useRoute useQueryParam useRouteData useRouteError
  useMenu useBreadcrumbs usePagination onBeforeLeave` - all
  scope-auto-disposing.

## Vapor interop

Measured against `vue@3.6.0-rc.5`, not inferred from the
[Vapor roadmap](https://github.com/vuejs/core/issues/13687). Two fixtures, and the
split matters: `tests/router/vapor-fixture.test.ts` mounts a real Vapor app and
measures provide/inject as a *primitive*, while
`tests/vapor/router-composables.test.ts` (under `vitest.vapor.config.ts`, which
aliases `vue` to the with-vapor dist) runs the *composables themselves* inside
`defineVaporComponent({ setup() })` - the actual shipped combination.

**provide/inject works in Vapor, at both levels.** The roadmap lists
"Provide/Inject System" unchecked, but on a real `createVaporApp` app both
`app.provide(...)` -> `inject(...)` (which backs every composable here) and
component-level `provide(...)` -> `inject(...)` (which backs nested
`<RouterOutlet>` depth) resolve correctly. So the composable surface and outlet
nesting are **not** blocked on that roadmap item.

**A Vapor-native outlet now ships** (experimental, v1.x), which supersedes what
this section used to say. It read: *"what still ties the outlet to the vDOM
runtime is its own render path"* - true of `outlet.ts`, and no longer true of
the router as a whole. `vapor-chamber/router/vapor` exports the same
`RouterOutlet` name built from Vapor's own helpers
(`createDynamicComponent` for the branch, `createSlot` for the no-match
fallback), so a pure-Vapor app renders routes with **no `vaporInteropPlugin`
installed at all**.

```ts
import { createRouter } from 'vapor-chamber/router';        // neither renderer
import { RouterOutlet } from 'vapor-chamber/router/vapor';  // Vapor, no interop
```

What it costs, and what it requires:

- **Measured saving: <!-- vc:outletSaving -->21.14<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->67.4<!-- /vc:outletSavingRaw --> KB raw** against the same app
  rendering through the vDOM outlet plus interop - re-derived every test run by
  `tests/vapor/vapor-outlet-size.test.ts` from a Vite production build rather
  than quoted, with the baseline built by the same harness so the two arms
  cannot differ by method. The guard holds two limits: the saving stays
  >= <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB, and the Vapor
  outlet's own machinery over a router-without-outlet floor stays
  <= <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB
  (measured <!-- vc:outletOwnArm -->4.21<!-- /vc:outletOwnArm --> KB). The
  subpath's own cost is <!-- vc:sizeRouterVapor -->0.4<!-- /vc:sizeRouterVapor --> KB brotli.
- **Route components must be `defineVaporComponent` output** (Vapor-compiled
  SFCs are). This is a real constraint, not a convention: with no interop
  installed, `createDynamicComponent` would otherwise create a vDOM component
  in Vapor mode with no error of its own. The outlet therefore checks the
  `__vapor` marker itself and throws a coded `mode_mismatch` - a loud failure
  in place of wrong-mode rendering, and deliberately not a silent fallback to
  interop, which would restore the whole ~20 KB brotli the subpath exists to
  avoid.
- **Blade rows still require the vDOM outlet.** `makeBladeComponent` is
  `defineComponent`/`h`, so a blade row reaching the Vapor outlet is the same
  `mode_mismatch` throw, with its own message pointing here. An app that mixes
  blade rows and Vapor pages renders through `vapor-chamber/router/vdom` and
  pays for interop; that is unchanged and is the single most likely way to get
  a disappointing result from this subpath.
- **Parity with the vDOM outlet on everything else**: keyless, so the same
  record at a depth keeps its instance across param and query changes; nested
  depth over the same `Symbol.for` key, so the two outlets share one depth
  contract and can coexist; no `<Transition>`/`<KeepAlive>` integration; no
  SSR/hydration.

Both outlets reuse on **resolved-component identity** - "record identity implies
reuse" is shorthand, not the mechanism. Two different records resolving to the
same component reuse the instance, by design, in both.

Two constraints worth knowing before writing your own Vapor test or app:

- Vapor ships as a **physically separate dist file**
  (`vue/dist/vue.runtime-with-vapor.esm-*.js`). A bare `import 'vue'` never
  resolves to it outside a bundler's per-app alias - see `chamber.ts` §probeVue
  and whitepaper §11.6.
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

- **KeepAlive** - the roadmap box is checked and, as of **rc.3**, the two
  correctness issues this section used to list as open are closed:
  [#15228](https://github.com/vuejs/core/issues/15228) (a cached child renders
  against a nullish prop) by
  [#15251](https://github.com/vuejs/core/pull/15251), which isolates cached
  component props and dynamic slots behind a commit boundary, and
  [#15237](https://github.com/vuejs/core/issues/15237) (KeepAlive scopes not
  paused while deactivated), which now propagates paused state through
  `EffectScope`/`ReactiveEffect`. Nothing caches an inactive route's state
  here yet, so neither reaches this router today.

  **A correction to what this section previously told you.** It said that
  `tryKeepAliveHooks` in `chamber.ts` "hand-solves what #15237 proposes doing
  natively, so if that lands the manual pause/resume becomes double-suppression
  and should be removed in the same release." #15237 has landed, and that
  instruction is wrong - following it would delete a working guard.
  `tests/keepalive-pause-fixture.test.ts` measures why: Vue's pausing
  suppresses reactive effects owned by the deactivated scope (verified - a
  watcher in a paused scope does not run), while `tryKeepAliveHooks` guards a
  `bus.onAfter` hook, a plain callback the bus invokes synchronously from
  `dispatch`, owned by no scope and scheduled by no scheduler. It still fires
  under a paused scope (also verified). The two also answer different
  questions: Vue's is "should this cached component re-render while
  off-screen?", ours is "should a command dispatched while this component is
  deactivated be recorded into its undo history?" - a domain decision upstream
  has no view on. The guard stays.

  **A second correction, from the rc.4 read.** The paragraph above is right
  that the guard should stay - but for most of its life it was not running.
  `tryKeepAliveHooks` gated itself on `getCurrentInstance()`, which reads
  VDOM's `currentInstance`; a Vapor component is not stored there. Measured on
  3.6.0-rc.4: inside `defineVaporComponent({ setup() })` that accessor returns
  null, while an `onDeactivated()` registered at the same point works and
  fires. So in Vapor - the platform this library is named for - the guard
  returned early and `useCommandHistory` / `useCommandError` went on recording
  commands dispatched into a deactivated view. It worked in VDOM, which is why
  the whole suite stayed green. It is now gated on `hasInjectionContext()`
  (true in both modes, false in a bare `effectScope()`), with
  `getCurrentInstance()` kept only as a fallback for a partially-supplied Vue
  namespace. `tests/keepalive-input-scope-fixture.test.ts` drives a real
  `VaporKeepAlive` and pins it; the older stand-in fixture could not, which is
  the transferable lesson - a fixture that substitutes for the integration it
  is reasoning about can only ever check the half you already understood.

  **A third pass, from the rc.5 cycle: upstream has now stated this is by
  design.** The rc.4 note above rested on measurement alone, which left open
  whether the null was a Vapor gap that would eventually be "fixed" - in which
  case the new gate would be temporary scaffolding. It is not. On the Vapor
  roadmap ([#13687](https://github.com/vuejs/core/issues/13687), Jul 20) a Vue
  core maintainer confirmed that `getCurrentInstance()` returning `null` inside
  Vapor components **is intentional**, noting an internal `useInstanceOption`
  API exists but is deliberately not public; and again in August, that Vapor
  "does not expose a general-purpose component instance tree to userland"
  because user code should not depend on internal instances. So
  `hasInjectionContext()` is the permanent gate, not a workaround pending an
  upstream change, and no future release should reintroduce an
  instance-accessor probe expecting it to start answering.

  The same statement settles two roadmap boxes people will ask about. **Vue
  Test Utils** (unchecked): `findComponent`-style instance traversal is the
  thing upstream has ruled out, so this library's testing story -
  `createTestBus`, asserting at the bus boundary - needs no revision whichever
  way VTU lands. **DevTools Integration** (unchecked): `src/devtools.ts` builds
  its inspector tree from buffered `bus.onAfter` entries, never from Vue's
  component tree, so the Commands timeline and inspector panel do not depend on
  the Vapor component-tree bookkeeping upstream has not built yet.
- **Transition** - route transitions; the View Transitions API is the
  DOM-native way around it.
- **SSR/Hydration** for blade rows - no server-side render path exists.
  `fetchBlade` is caller-supplied everywhere (a blade row without one throws
  `blade_unconfigured`, browser or not), and `bladeFetcher()` off-DOM returns
  the document as fetched rather than extracting `bladeRoot` - fetching still
  works, hydrating does not.

Read the roadmap both ways: an unchecked box does not mean missing
(provide/inject, above), and a checked box does not mean working. Still
unchecked, and worth remembering when reading anything that cites the roadmap:
Vue Router, Suspense (VaporSuspense pending), DevTools Integration, Nuxt,
VitePress, Vue Test Utils.

## Navigation as a command (optional)

A handler that calls `router.push()` puts navigation on the same timeline as
every other transition, which is occasionally what you want and never required:

```ts
bus.register('routeGo', (cmd) => router.push(cmd.target));
bus.dispatch('routeGo', '/orders/42');
```

The payoff is uniformity, not capability: the navigation now appears in the
devtools timeline, `onBefore` can cancel it alongside everything else, and
`history` treats it like any other command. Nothing in the router or the store
depends on this - it is sugar, and skipping it costs nothing.

## Status

Experimental, covered by the router node specs (`npm test`). The Vapor-native
outlet that used to sit on this list **shipped** - see the Vapor interop section
above. Next: a reference route generator + generated modules (E2E proof),
browser playground, and a Vapor blade path (the one caveat the Vapor outlet
does not close).

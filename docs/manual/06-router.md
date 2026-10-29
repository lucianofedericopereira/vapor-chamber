# 6. Routing

This chapter sets up `vapor-chamber/router` over a server catch-all. The full guide, with the
loader SPI, Blade migration and Vapor interop, is [router.md](../router.md). In Laravel, the
catch-all and the shell are in [chapter 11](./11-laravel.md).

## Set up the router

`vapor-chamber/router` is a router for Vue 3.6 over **one thin server catch-all**
(`/admin/{any?}` -> shell -> one island). **Path is navigation, query is state.** Route tables
and data loaders arrive as *data*, not as a hand-written config module. **The bus owns writes
(commands), and the router owns reads (URL-addressed data).**

```ts
import { createRouter } from 'vapor-chamber/router';
import { fetchLoaders } from 'vapor-chamber/router-fetch';
import { RouterOutlet } from 'vapor-chamber/router/vdom';

const router = createRouter({
  base: '/admin',
  routes: adminRoutes,                    // generated module, or { inline }; { url } also needs `http`
  loaders: fetchLoaders(),                // or your own LoaderHandlers preset
  components: {
    'Catalog/ListPage': () => import('./pages/CatalogList.vue'),
  },
});

app.use(router);   // register RouterOutlet locally where you render it
```

## Write a route row

A route table is a list of rows, usually generated on the server:

```ts
const adminRoutes = [
  { name: 'products', path: '/products', component: 'Catalog/ListPage', load: '/api/vc/products' },
  { name: 'product', path: '/products/:id', params: { id: 'int' },
    component: 'Catalog/ItemPage', load: '/api/vc/products/{id}' },
  { name: 'notFound', path: '/*', component: 'NotFound' },
];
```

- **Path segments.** `:name`, `:name(regex)`, `:name?` (optional) and a trailing `/*` splat,
  which lands in `params.pathMatch`. Matching ignores case. Any other segment that opens with `:`
  throws `router:invalid:path` in development: as written it would never match.
- **Typed params.** `params: { id: 'int' }` matches only digits and casts the value to a number.
  `'bool'` matches `1`, `0`, `true` and `false`. A URL that does not fit falls through to the next
  row.
- **The 404 row.** A `path: '/*'` row lets the client render its own not-found page. Without one,
  an unmatched URL goes back to the server. The URL already on screen is the exception: behind a
  catch-all it would reload forever, so development logs it instead.
- **`load`** is the data URL, its `{placeholders}` filled from the path params, then the typed
  query params.

## Guard a navigation

A guard runs before a path navigation commits. It returns nothing to go on, `false` to refuse,
or a location to redirect:

```ts
const off = router.beforeEach((to, from) => {
  if (to.path.startsWith('/billing') && !user.value) return { name: 'login' };   // redirect
  if (draft.dirty) return false;                                                 // refuse
});
router.afterEach((to) => analytics.page(to.fullPath));   // after each commit
off();   // each returns its unregister function
```

- **A refusal** answers `router:refused:guard` to the caller of `push()`, and the URL stays. On
  Back or Forward the URL is put back. It is not sent to `onError`.
- **A redirect** during a Back or Forward replaces the entry instead of pushing one. A chain of
  redirects stops after 10 hops as `router:exceeded:redirects`.
- **A guard that throws** is `router:failed:guard`, and does not hard-navigate.
- **`onBeforeLeave(guard)`** is the component's own guard, removed with its scope. Its `false`
  refuses.
- A query or hash change runs no guard.

## Use the router composables

**Composables:** `useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`,
`useMenu`, `useBreadcrumbs`, `usePagination`, `onBeforeLeave`. All dispose with their scope.

## Change a query without a remount

| change | what happens |
|---|---|
| **path** | resolve -> guards -> components + loaders in parallel (aborted on supersede) -> **one atomic frozen snapshot commit**. A page never renders with the previous page's data. |
| **query / hash** | fast path: the location commits at once, with **no matching, no guards, no remount**. Only loaders that depend on a changed key refetch, patching `snapshot.data` when they land. |

So `page.value = 3` on a typed query param repaginates a list without unmounting it.

## Pick an outlet

`RouterOutlet` is a `defineComponent` + `h()` component, so anything that reaches it statically
pins Vue's virtual-DOM runtime into the bundle. So it lives behind its own subpath, and
`app.use(router)` does **not** register it globally. Measured on the built `dist/`:

| entry | bindings retained from `vue` | brotli |
|---|---|--:|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` | <!-- vc:sizeRouter -->11.3<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` | <!-- vc:sizeRouterVdom -->0.7<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | `createDynamicComponent createIf createSlot defineVaporComponent inject provide` | <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB |

A Vapor app that never renders an outlet pays nothing for the vDOM runtime. Blade rows take a
`fetchBlade` from you, and `bladeFetcher()` from `vapor-chamber/router/remote` is the in-box one.
The blade *component* needs no import: the router loads `makeBladeComponent` as its own chunk the
first time it renders one.

**A pure-Vapor app can skip the vDOM renderer entirely** (experimental, v1.x).
`vapor-chamber/router/vapor` exports the same `RouterOutlet` name, built from Vapor's own
helpers, so rendering a route needs no `vaporInteropPlugin`. The startup chunk of a Vite
production build comes out **<!-- vc:outletSaving -->17.97<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->57.0<!-- /vc:outletSavingRaw --> KB raw** smaller than the
same app through the vDOM outlet plus interop.[^outlet-size]

[^outlet-size]: The same harness derives that baseline (`tests/vapor/vapor-outlet-size.test.ts`).

Route components on it must be `defineVaporComponent` output. Anything else throws a coded
`router:invalid:component` rather than quietly re-installing interop. **Blade rows still need the
vDOM outlet**, since `makeBladeComponent` is itself `defineComponent`/`h`.

`provide`/`inject` works in Vapor at both levels: app-level backs every composable, and
component-level backs nested outlet depth.[^rc4]

[^rc4]: Measured on Vue rc.4, not inferred from the roadmap.

The full guide, the loader SPI and the Blade migration path: **[docs/router.md](../router.md)**.

Next: [7. State](./07-state.md).

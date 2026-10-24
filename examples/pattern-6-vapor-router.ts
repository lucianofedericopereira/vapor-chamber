/**
 * Pattern 6: Laravel Blade + vapor-chamber/router - the family stack.
 * =====================================================================
 * The clean CQRS split across the two subpaths of one package:
 *
 *   READS  -> vapor-chamber/router: URL-addressed data. Route rows declare a
 *            `load` source; loaders run on navigation with abort-on-supersede
 *            and commit atomically with the page. `?page=2` is state, not
 *            navigation - no guards, no remount, loader refetches.
 *
 *   WRITES -> vapor-chamber: bus commands to POST /api/vc (validation, undo,
 *            optimistic updates, outbox). Exactly what pattern-2 shows.
 *
 *   ONE CLIENT -> the bus and the router send through one http client, so a
 *            write that names the groups it changed (`Cache-Group-Invalidation`,
 *            RFC 9875) refreshes the reads on screen whose answer named the
 *            same group (`Cache-Groups`). No refetch call in the page.
 *
 * Laravel side: ONE catch-all for the admin island...
 *
 *   Route::view('/admin/{any?}', 'admin.shell')->where('any', '.*');
 *
 * ...and the Blade shell inlines the per-user route table:
 *
 *   <script type="application/json" id="vcr-routes">{!! $routesJson !!}</script>
 *   <div id="admin"></div>
 */

import { createAsyncCommandBus, createHttpClient, httpTransport, setCommandBus } from 'vapor-chamber/vue';
import { createRouter, useQueryParam, useRouter } from 'vapor-chamber/router';
import { routerHttp } from 'vapor-chamber/router/remote';
// Loader preset for plain JSON backends.
import { fetchLoaders } from 'vapor-chamber/router-fetch';

// ---- writes: the bus ----------------------------------------------------------

// The app's one client: the transport and the router both send through it.
const http = createHttpClient({ csrf: true });
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient: http }) });
setCommandBus(bus);

// ---- reads: the router ---------------------------------------------------------

const router = createRouter({
  base: '/admin',
  routes: { inline: '#vcr-routes' }, // Blade-rendered, permission-filtered server-side
  // The router marks the app's client as router traffic and shares its cache. A read is
  // kept a minute, and a write that names its group ends that early.
  http: routerHttp({ http }),
  loaders: fetchLoaders({ cache: { ttl: 60_000 } }),
  components: {
    'Catalog/ListPage': () => import('./pages/CatalogList.vue'),
    'Catalog/EditPage': () => import('./pages/CatalogEdit.vue'),
  },
});

// ---- one island ----------------------------------------------------------------
//
// TWO render surfaces over the same router. The subpath is the namespace, so
// both export the name `RouterOutlet` and moving between them is an
// import-path change, not a rename. Pick by what the island is compiled as:

// VAPOR (this pattern's stack - Vapor-compiled SFCs, no vDOM runtime):
//
//   import { createVaporApp } from 'vue';
//   import { RouterOutlet } from 'vapor-chamber/router/vapor';
//   const app = createVaporApp(AdminShell);
//   app.use(router);
//   app.mount('#admin');
//
// Costs nothing extra and drops a lot: rendering a route through the vDOM
// outlet in a Vapor app requires `vaporInteropPlugin`, i.e. Vue's whole
// virtual-DOM renderer. Building the outlet from Vapor's own helpers removes
// it - see the measured row in docs/BUNDLE-SIZES.md.
//
// Two constraints come with it. Route components must be
// `defineVaporComponent` output (a Vapor-compiled SFC is); anything else is a
// loud `router:invalid:component`, never a silent wrong-mode render. And blade rows are
// vDOM by construction, so a table with `blade: true` rows needs the outlet
// below for those.

// vDOM (a conventional Vue app, or any table carrying blade rows):
//
//   import { createApp } from 'vue';
//   import { RouterOutlet } from 'vapor-chamber/router/vdom';
//   const app = createApp(AdminShell);    // AdminShell registers RouterOutlet
//   app.use(router);                      //   locally and renders <RouterOutlet/>
//   app.mount('#admin');
//
// RouterOutlet is NOT registered globally by app.use(router) on either path: a
// global registration pins Vue's vDOM runtime into every bundle, Vapor ones
// included.

// Inside a list page component:
//   const page = useQueryParam<number>('page');   // typed by the route row
//   page.value = 3;   // pushState, loader refetch (abortable), NO remount
//
// Inside a form component (composables in setup, never after an await):
//   const router = useRouter();                                    // in setup
//   const result = await dispatch('productUpdate', { id }, form);  // bus write
//   if (result.ok) router.push({ name: 'catalog.products' });      // router read

//
// What the server says, per answer:
//   GET  /api/products?page=1  ->  Cache-Groups: products        (the list belongs to "products")
//   POST /api/vc productUpdate ->  Cache-Group-Invalidation: products   (the write changed them)
// The list on screen is read again, past both caches, with `router.isRevalidating` true meanwhile.

export { bus, http, router };

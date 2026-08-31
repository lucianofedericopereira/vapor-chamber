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
 * Laravel side: ONE catch-all for the admin island...
 *
 *   Route::view('/admin/{any?}', 'admin.shell')->where('any', '.*');
 *
 * ...and the Blade shell inlines the per-user route table:
 *
 *   <script type="application/json" id="vcr-routes">{!! $routesJson !!}</script>
 *   <div id="admin"></div>
 */

import { createAsyncCommandBus, createHttpBridge, setCommandBus } from 'vapor-chamber';
import { createRouter, useQueryParam, useRouter } from 'vapor-chamber/router';
// Loader preset for plain JSON backends: 'vapor-chamber/router-fetch'.

// ---- writes: the bus, unchanged ------------------------------------------------

// ASYNC bus - createHttpBridge is an async plugin (same reasoning as pattern-2).
const bus = createAsyncCommandBus();
setCommandBus(bus);
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));

// ---- reads: the router ---------------------------------------------------------

const router = createRouter({
  base: '/admin',
  routes: { inline: '#vcr-routes' }, // Blade-rendered, permission-filtered server-side
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
// loud `mode_mismatch`, never a silent wrong-mode render. And blade rows are
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
// Inside a form component:
//   const result = await dispatch('productUpdate', { id }, form);  // bus write
//   if (result.ok) useRouter().push({ name: 'catalog.products' }); // router read

export { bus, router };

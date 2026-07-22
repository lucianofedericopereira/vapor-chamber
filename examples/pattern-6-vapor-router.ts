/**
 * Pattern 6: Laravel Blade + vapor-chamber/router — the family stack.
 * =====================================================================
 * The clean CQRS split across the two subpaths of one package:
 *
 *   READS  → vapor-chamber/router: URL-addressed data. Route rows declare a
 *            `load` source; loaders run on navigation with abort-on-supersede
 *            and commit atomically with the page. `?page=2` is state, not
 *            navigation — no guards, no remount, loader refetches.
 *
 *   WRITES → vapor-chamber: bus commands to POST /api/vc (validation, undo,
 *            optimistic updates, outbox). Exactly what pattern-2 shows.
 *
 * Laravel side: ONE catch-all for the admin island…
 *
 *   Route::view('/admin/{any?}', 'admin.shell')->where('any', '.*');
 *
 * …and the Blade shell inlines the per-user route table:
 *
 *   <script type="application/json" id="vcr-routes">{!! $routesJson !!}</script>
 *   <div id="admin"></div>
 */

import { createCommandBus, createHttpBridge, setCommandBus } from 'vapor-chamber';
import { createRouter, useQueryParam, useRouter } from 'vapor-chamber/router';
// Loader preset for plain JSON backends: 'vapor-chamber/router-fetch'.

// ---- writes: the bus, unchanged ------------------------------------------------

const bus = createCommandBus();
setCommandBus(bus);
createHttpBridge({ bus, endpoint: '/api/vc', csrf: true });

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

// import { createApp } from 'vue';
// const app = createApp(AdminShell);
// app.use(router);           // <RouterOutlet/> renders the matched page
// app.mount('#admin');

// Inside a list page component:
//   const page = useQueryParam<number>('page');   // typed by the route row
//   page.value = 3;   // pushState, loader refetch (abortable), NO remount
//
// Inside a form component:
//   const result = await dispatch('productUpdate', { id }, form);  // bus write
//   if (result.ok) useRouter().push({ name: 'catalog.products' }); // router read

export { bus, router };

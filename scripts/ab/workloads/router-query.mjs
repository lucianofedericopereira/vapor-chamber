// Workload for scripts/ab/ab.mjs (log 36.F57): `setQuery` on one of five query keys, as a search box
// writes per keystroke, on a page with no loader. Rows: set_query; resolve_links, `router.resolve` of
// links with a query, and stringify, `stringifyQuery` alone. nav_row, a path navigation, is the control.
import { createMemoryHistory, createRouter, stringifyQuery } from '__DIST__/router/index.js';

export const ASYNC = true;
const made = (async () => {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'list', path: '/', parent: 'shell', component: 'P', query: { q: {}, a: {}, b: {}, c: {}, d: {} } },
      { name: 'other', path: '/other', parent: 'shell', component: 'P' },
    ],
    components: { P: { name: 'P' } },
    links: false,
    scroll: false,
    announce: false,
  });
  await router.isReady();
  router.setQuery({ a: '1', b: 'two', c: 'three', d: 'four' });
  return router;
})();
const WORDS = ['s', 'se', 'sea', 'sear', 'searc', 'search'];
const QUERY = { q: 'wireless mouse', page: 3, sort: 'price', tag: ['a', 'b'], on: '' };
export const N = { set_query: 50_000, resolve_links: 100_000, stringify: 200_000, nav_row: 2_000 };
export const set_query = async (n) => { const r = await made; for (let i = 0; i < n; i++) r.setQuery({ q: WORDS[i % 6] }); return r.currentRoute.value.location.fullPath.length; };
export const resolve_links = async (n) => { const r = await made; let s = 0; for (let i = 0; i < n; i++) s += r.resolve({ name: 'list', query: { q: WORDS[i % 6], page: i & 7 } }).length; return s; };
export const stringify = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += stringifyQuery(QUERY).length; return s; };
export const nav_row = async (n) => { const r = await made; let s = 0; for (let i = 0; i < n; i++) { await r.push(i & 1 ? '/' : '/other'); s += 1; } return s; };
export const check = async () => [await set_query(4), await resolve_links(4), await stringify(4), await nav_row(2)];

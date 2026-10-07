// Workload for scripts/ab/ab.mjs (log s35.210): a navigation through two guards
// and two after-hooks, distinct functions (V8-RULES 11), once the router's
// lists mark a removed entry instead of splicing it. A router with none is
// the control (an untouched path). Each call alternates two pages.
import { createMemoryHistory, createRouter } from '__DIST__/router/index.js';

export const ASYNC = true;

const make = async (hooked) => {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'P' },
      { name: 'list', path: '/list', parent: 'shell', component: 'P' },
    ],
    components: { P: { name: 'P' } },
    links: false,
    scroll: false,
    announce: false,
  });
  if (hooked) {
    let seen = 0;
    router.beforeEach((to) => { seen += to.path.length; });
    router.beforeEach((to, from) => (to.path === from.path ? false : true));
    router.afterEach((to) => { seen ^= to.path.length; });
    router.afterEach(() => { seen++; });
  }
  await router.isReady();
  return router;
};

// Promises, not top-level await: the tool bundles a workload as CommonJS.
const plain = make(false);
const hooked = make(true);

const run = async (ready, n) => {
  const router = await ready;
  let s = 0;
  for (let i = 0; i < n; i++) s += (await router.push(i & 1 ? '/' : '/list')) === null ? 1 : 0;
  return s;
};
export const N = { nav_no_guards: 20_000, nav_guards2_hooks2: 20_000 };
export const nav_no_guards = (n) => run(plain, n);
export const nav_guards2_hooks2 = (n) => run(hooked, n);
export const check = async () => [await run(plain, 4), await run(hooked, 4)];

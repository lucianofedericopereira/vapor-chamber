// Workload for scripts/ab/ab.mjs (log 36.F58, probe #12): a navigation whose loader serves stale
// data and reports a background refresh (`ctx.revalidate`), the path router.dispose() now ends:
// `trackRevalidation` reads its cancelled flag on entry, in the refresh's `then` and in its
// `finally`. nav_swr awaits each refresh as well, so the patch and the flag clearing are timed.
// nav_plain, the same navigation with a loader that reports none, is the control.
// The refresh resolves after push() returns, as a network read lands after the commit: one
// resolved before the commit is dropped as "navigated away" (engine.ts trackRevalidation),
// which the first version of this workload did, and its self-check caught.
import { createMemoryHistory, createRouter } from '__DIST__/router/index.js';

export const ASYNC = true;

const make = async (swr) => {
  let pending = null;
  let land = null;
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'P', load: 'rows:home' },
      { name: 'list', path: '/list', parent: 'shell', component: 'P', load: 'rows:list' },
    ],
    components: { P: { name: 'P' } },
    loaders: {
      prefixes: {
        'rows:': (ref, _loc, _rec, _signal, ctx) => {
          if (swr) {
            pending = new Promise((resolve) => { land = () => resolve({ ref, v: 'fresh' }); });
            ctx.revalidate(pending);
          }
          return { ref, v: 'stale' };
        },
      },
    },
    links: false,
    scroll: false,
    announce: false,
  });
  await router.isReady();
  return { router, last: () => pending, land: () => land?.() };
};

// Promises, not top-level await: the tool bundles a workload as CommonJS.
const plain = make(false);
const swr = make(true);

const run = async (ready, n) => {
  const { router, last, land } = await ready;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (await router.push(i & 1 ? '/' : '/list')) === null ? 1 : 0;
    const refresh = last();
    if (refresh) {
      land();
      await refresh;
    }
  }
  return s;
};
export const N = { nav_plain: 20_000, nav_swr: 20_000 };
export const nav_plain = (n) => run(plain, n);
export const nav_swr = (n) => run(swr, n);
export const check = async () => {
  // Self-check (TESTING_PROCEDURE 4): the swr arm revalidates, and its refresh lands.
  const { router, land } = await swr;
  await router.push('/list');
  land();
  await new Promise((r) => setTimeout(r, 0));
  const data = router.currentRoute.value.data.get('list');
  if (data?.v !== 'fresh') throw new Error('the refresh did not land');
  return [await nav_plain(4), await nav_swr(4)];
};

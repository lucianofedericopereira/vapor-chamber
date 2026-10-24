// Workload for scripts/ab/ab.mjs (.probes/fixup-1-7-pickup.md, 3b): a navigation with routerFacts
// on a bus, the shape examples/router-demo/index.html wires for its shell (the router's loading
// as a fact a `data-vc-router` element follows). Rows: nav_facts, a path navigation whose page
// has a loader, routerFacts installed; nav_bare, the same router without it (the control: no
// code of the change runs). Each call alternates two pages.
import { createCommandBus } from '__DIST__/index.js';
import { createMemoryHistory, createRouter, routerFacts } from '__DIST__/router/index.js';

export const ASYNC = true;

const make = async (withFacts) => {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'P', load: 'rows:home' },
      { name: 'list', path: '/list', parent: 'shell', component: 'P', load: 'rows:list' },
    ],
    components: { P: { name: 'P' } },
    loaders: { prefixes: { 'rows:': (ref) => ({ ref }) } },
    links: false,
    scroll: false,
    announce: false,
  });
  let heard = 0;
  if (withFacts) {
    const bus = createCommandBus();
    bus.on('routerLoading', () => { heard++; });
    routerFacts(router, bus);
  }
  await router.isReady();
  return { router, heard: () => heard };
};
// Promises: the tool bundles a workload as CommonJS, which has no top-level await.
const facts = make(true);
const bare = make(false);

const walk = async (made, n) => {
  const { router } = await made;
  let s = 0;
  for (let i = 0; i < n; i++) {
    await router.push(i & 1 ? '/' : '/list');
    s += router.currentRoute.value.location.path.length;
  }
  return s;
};

export const N = { nav_facts: 2_000, nav_bare: 2_000 };
export const nav_facts = (n) => walk(facts, n);
export const nav_bare = (n) => walk(bare, n);

/** Self-check: both routers navigate (the base arm's routerFacts emits no loading fact, so it is not asserted). */
export const check = async () => {
  const a = await nav_facts(2);
  const b = await nav_bare(2);
  if (a !== b) throw new Error(`facts walked ${a}, bare ${b}`);
  return [a, b];
};

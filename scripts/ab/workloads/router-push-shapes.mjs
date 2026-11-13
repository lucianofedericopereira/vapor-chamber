// Workload for scripts/ab/ab.mjs (log 36.F58, probe #13): `push()` with the location shapes an app
// passes, now that navigate() reads a location's own `replace`. The read sits on `raw`, which is a
// string or one of several object shapes, so the question is what that load site costs at the
// shapes apps use (V8-RULES 11): `{ path }`, `{ name }`, `{ path, query }`, `{ name, params }`,
// rotated in one row. nav_string, a string push, never reaches the read past its `typeof`: the
// control. Each call alternates two pages, as router-guards does.
import { createMemoryHistory, createRouter } from '__DIST__/router/index.js';

export const ASYNC = true;
const made = (async () => {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [
      { name: 'shell', path: '/', parent: null },
      { name: 'home', path: '/', parent: 'shell', component: 'P' },
      { name: 'list', path: '/list', parent: 'shell', component: 'P' },
      { name: 'item', path: '/item/:id', parent: 'shell', component: 'P' },
    ],
    components: { P: { name: 'P' } },
    links: false,
    scroll: false,
    announce: false,
  });
  await router.isReady();
  return router;
})();

// Built per call, as an app writes the literal at the call site; four shapes in turn.
const shaped = (i) => {
  switch (i & 3) {
    case 0: return { path: '/list' };
    case 1: return { name: 'home' };
    case 2: return { path: '/list', query: { page: String(i & 7) } };
    default: return { name: 'item', params: { id: String(i & 7) } };
  }
};

export const N = { nav_string: 20_000, nav_objects: 20_000 };
export const nav_string = async (n) => {
  const r = await made;
  let s = 0;
  for (let i = 0; i < n; i++) s += (await r.push(i & 1 ? '/' : '/list')) === null ? 1 : 0;
  return s;
};
export const nav_objects = async (n) => {
  const r = await made;
  let s = 0;
  for (let i = 0; i < n; i++) s += (await r.push(i & 1 ? '/' : shaped(i >> 1))) === null ? 1 : 0;
  return s;
};
export const check = async () => {
  const r = await made;
  // Self-check (TESTING_PROCEDURE 4): each shape lands where it says.
  for (let i = 0; i < 4; i++) {
    await r.push('/');
    await r.push(shaped(i));
    const at = r.currentRoute.value.location.path;
    if (at === '/' && i !== 1) throw new Error(`shape ${i} did not navigate`);
  }
  return [await nav_string(4), await nav_objects(4)];
};

// Workload for scripts/ab/ab.mjs (log 36.F59): the menu projection on a path
// commit. The table half (filter, sort, parent map) depends only on the routes
// array, but useMenu rebuilt it per path until it kept the projection between
// commits. `nav_plain` is the same push without reading the menu: the control
// for what a push costs on its own.
import { createApp } from 'vue';
import { createMemoryHistory, createRouter, useMenu } from '__DIST__/router/index.js';

export const ASYNC = true;

const ROUTES = [{ name: 'shell', path: '/', parent: null }];
for (let i = 0; i < 300; i++) {
  const parent = i < 6 ? 'shell' : `r${i % 6}`;
  ROUTES.push({
    name: `r${i}`,
    path: i < 6 ? `/s${i}` : `/s${i % 6}/p${i}`,
    parent,
    component: 'P',
    meta: { menu: i + 1, title: `nav.${i}` },
  });
}
ROUTES.push({ name: 'home', path: '/home', parent: 'shell', component: 'P' });

const made = (async () => {
  const router = createRouter({
    history: createMemoryHistory('/home'),
    routes: ROUTES,
    components: { P: { name: 'P' } },
    links: false,
    scroll: false,
    announce: false,
  });
  const app = createApp({});
  app.use(router);
  await router.isReady();
  const menu = app.runWithContext(() => useMenu());
  return { router, menu };
})();

const seq = async (n, read) => {
  const { router, menu } = await made;
  let s = 0;
  for (let i = 0; i < n; i++) {
    await router.push(i & 1 ? '/home' : '/s0');
    if (read) s += menu.value.length;
  }
  return read ? s : 0;
};

export const N = { menu_read: 2_000, nav_plain: 2_000 };
export const menu_read = (n) => seq(n, true);
export const nav_plain = (n) => seq(n, false);

/** Self-check: the table projects a menu, and the control still navigates. */
export const check = async () => {
  const { menu } = await made;
  const len = menu.value.length;
  if (len < 6) throw new Error(`menu has ${len} roots, want at least 6`);
  return [await seq(4, true), len];
};

/**
 * Back and Forward during a held navigation, on the real History API: its pops are asynchronous, the memory history's are not.
 * The long note is at the end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createWebHistory } from '@router/history';
import { createRouter } from '@router/index';
import { ROWS } from '../router/fixture';

// The test page's own path is the base, so the router owns everything under it.
const base = window.location.pathname.replace(/\/$/, '');
const start = window.location.href;

afterEach(() => {
  window.history.replaceState(null, '', start);
});

const popped = () => new Promise<void>((r) => window.addEventListener('popstate', () => r(), { once: true }));
const settle = () => new Promise((r) => setTimeout(r, 100));

async function threePages() {
  const router = createRouter({
    history: createWebHistory(base),
    routes: [...ROWS, { name: 'other', path: '/other', parent: 'shell', component: 'Other' }],
    components: { Home: { name: 'Home' }, List: { name: 'List' }, Other: { name: 'Other' } },
    scroll: false,
    links: false,
    announce: false,
  });
  await router.isReady();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holdNext = () => {
    let first = true;
    router.beforeEach(async () => {
      if (first) {
        first = false;
        await held;
      }
    });
  };
  return { router, holdNext, release: () => release() };
}

describe('router history (real Chromium)', () => {
  it('two quick Backs during a held navigation land on the second one', async () => {
    const { router, holdNext, release } = await threePages();
    await router.push('/list');
    await router.push('/other');
    holdNext();
    let pop = popped();
    window.history.back(); // to /list, held
    await pop;
    pop = popped();
    window.history.back(); // to /
    await pop;
    release();
    await settle();
    expect(router.currentRoute.value.location.path).toBe('/');
    expect(window.location.pathname).toBe(`${base}/`);
    router.destroy();
  });

  it('Forward back to the page during a held Back keeps the page and the address bar together', async () => {
    const { router, holdNext, release } = await threePages();
    await router.push('/list');
    holdNext();
    let pop = popped();
    window.history.back(); // to /, held
    await pop;
    pop = popped();
    window.history.forward(); // to /list, the page on screen
    await pop;
    release();
    await settle();
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(window.location.pathname).toBe(`${base}/list`);
    router.destroy();
  });

  it('control: a guard that refuses a Back walks the address bar back to the page', async () => {
    const { router } = await threePages();
    await router.push('/list');
    router.beforeEach(() => false);
    const pop = popped();
    window.history.back();
    await pop;
    await settle();
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect(window.location.pathname).toBe(`${base}/list`);
    router.destroy();
  });
});

/*
 * Router re-review, 1.26 (log 35.90 and 35.91). The node tests of the same
 * cases (tests/router/superseded-navigation-history.test.ts,
 * tests/router/navigation-to-current-page.test.ts) run on the memory history,
 * whose go() calls its listeners synchronously, inside the navigation that
 * walks it. A browser queues the traversal and fires popstate later, after
 * the walking navigation has settled, which is the order the engine's
 * compensating step and its supersession rules have to survive. Each case
 * waits for the user's own popstate before the next step, because two
 * history.back() calls in one task are one traversal to Chromium.
 */

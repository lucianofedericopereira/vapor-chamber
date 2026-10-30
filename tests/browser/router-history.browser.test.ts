/**
 * Back and Forward during a held navigation, on the real History API: its pops are asynchronous, the memory history's are not.
 * Why: a browser fires popstate after the walking navigation settles, the order the engine's compensating step and supersession must survive.
 * Shows: two quick Backs land on the second; a Forward during a held Back keeps page and address bar together; a refused Back walks the bar back.
 * See: log 35.90, log 35.91, tests/router/superseded-navigation-history.test.ts, tests/router/navigation-to-current-page.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebHistory } from '@router/history';
import { createRouter } from '@router/index';
import { ROWS } from '../router/fixture';

// The test page's own path is the base, so the router owns everything under it.
const base = window.location.pathname.replace(/\/$/, '');
const start = window.location.href;

afterEach(() => {
  window.history.replaceState(null, '', start);
});

// Each step waits for its popstate: two history.back() calls in one task are one traversal to Chromium.
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
    router.dispose();
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
    router.dispose();
  });

  it('control: a guard that refuses a Back walks the address bar back to the page', async () => {
    const { router } = await threePages();
    await router.push('/list');
    router.beforeEach(() => false);
    const pop = popped();
    window.history.back();
    await pop;
    await settle();
    // The walk back is a second traversal with no event to await, and a busy machine can take over the fixed wait.
    await vi.waitFor(() => expect(window.location.pathname).toBe(`${base}/list`), { timeout: 5000 });
    expect(router.currentRoute.value.location.path).toBe('/list');
    router.dispose();
  });
});

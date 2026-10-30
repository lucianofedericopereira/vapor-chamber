// @vitest-environment happy-dom
/**
 * A guard chain that never settles is bounded and reported as `router:exceeded:redirects`, in dev and in production.
 * Why: handlers switch on the code, so it must survive production; only the hop-count explanation is dev-only, to keep it out of every consumer's bundle.
 * Shows: in dev the message names the redirect loop and its hops; in production the code and the "redirect loop navigating to" message remain and the hops text is gone.
 * See: tests/router/hard-nav-production.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ROWS = [
  { name: 'home', path: '/', component: 'Home' },
  { name: 'a', path: '/a', component: 'Home' },
  { name: 'b', path: '/b', component: 'Home' },
];

/** A router whose guards redirect at each other; both targets differ from the start, since a redirect onto the committed location is a duplicate and ends the chain. */
async function bootLoopingRouter() {
  const { createRouter } = await import('@router/index');
  const { createMemoryHistory } = await import('@router/history');

  const router = createRouter({
    history: createMemoryHistory(''),
    routes: ROWS as never,
    components: { Home: { name: 'Home' } },
    links: false,
    scroll: false,
    onError: () => {},
  });
  await router.isReady();
  router.beforeEach((to) => (to.path === '/a' ? '/b' : true));
  router.beforeEach((to) => (to.path === '/b' ? '/a' : true));
  return router;
}

describe('router:exceeded:redirects diagnostic', () => {
  it('names the hop count and the likely cause in dev', async () => {
    vi.resetModules();
    const router = await bootLoopingRouter();

    const result = (await router.push('/a')) as { code?: string; message?: string };

    expect(result?.code).toBe('router:exceeded:redirects');
    expect(result?.message).toContain('redirect loop navigating to');
    expect(result?.message).toContain('hops');
    router.dispose();
  });

  it('drops the explanation in production, and still reports the code', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const router = await bootLoopingRouter();

    const result = (await router.push('/a')) as { code?: string; message?: string };

    // The code is the contract; only the human-facing tail is dropped.
    expect(result?.code).toBe('router:exceeded:redirects');
    expect(result?.message).toContain('redirect loop navigating to');
    expect(result?.message).not.toContain('hops');
    router.dispose();
  });
});

// @vitest-environment happy-dom
/**
 * The production half of the redirect-loop diagnostic (router/engine.ts `DEV`).
 *
 * A guard chain that never settles is bounded and reported as `redirect_loop`.
 * The CODE is unconditional - handlers switch on it, so it cannot be dev-only -
 * but the explanatory tail naming the hop count and the likely cause is gated,
 * because this module sits on the shared side of the Vapor outlet size guard
 * and prose that only helps a human reading a console is not worth shipping to
 * every consumer.
 *
 * Both arms refuse the navigation identically; they differ only in message
 * length. Only the dev one is reachable under vitest unless a test re-imports
 * the module with NODE_ENV stubbed, which is the same shape
 * hard-nav-production.test.ts uses for the other DEV branch in this router.
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

/** A router whose guards redirect at each other. Both targets are away from
 *  the start, since a redirect onto the committed location is a duplicate and
 *  would end the chain before it could loop. */
async function bootLoopingRouter() {
  const { createRouter } = await import('../../src/router/index');
  const { createMemoryHistory } = await import('../../src/router/history');

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

describe('redirect_loop diagnostic', () => {
  it('names the hop count and the likely cause in dev', async () => {
    vi.resetModules();
    const router = await bootLoopingRouter();

    const result = (await router.push('/a')) as { code?: string; message?: string };

    expect(result?.code).toBe('redirect_loop');
    expect(result?.message).toContain('redirect loop navigating to');
    expect(result?.message).toContain('hops');
    router.destroy();
  });

  it('drops the explanation in production, and still reports the code', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const router = await bootLoopingRouter();

    const result = (await router.push('/a')) as { code?: string; message?: string };

    // The bound and the code are the contract and are unchanged; only the
    // human-facing tail is gone.
    expect(result?.code).toBe('redirect_loop');
    expect(result?.message).toContain('redirect loop navigating to');
    expect(result?.message).not.toContain('hops');
    router.destroy();
  });
});

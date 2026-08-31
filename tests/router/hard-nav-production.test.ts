// @vitest-environment happy-dom
/**
 * The production half of the hard-navigation refusal (router/index.ts `if (DEV)`).
 *
 * When an `unmatched` (or other HARD_NAV_CODE) error names a URL that is ALREADY
 * the current one, handing it back to the server would reload forever behind a
 * catch-all - so the router refuses. In dev it explains why and returns; in
 * production it falls through to the generic `console.error(error)`. Both arms
 * refuse the navigation; they differ only in what gets logged, and only the dev
 * one was ever exercised because DEV is true under vitest unless a test
 * re-imports the module with NODE_ENV stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

const ROWS = [{ name: 'home', path: '/', component: 'Home' }];

async function bootRouter(): Promise<{ router: any; errors: unknown[][]; assign: any }> {
  const { createRouter } = await import('../../src/router/index');
  const { createWebHistory } = await import('../../src/router/history');

  const errors: unknown[][] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });

  // Sit on a URL the table cannot match, so navigating to it is `unmatched`
  // AND `href === here` - the refusal case. Set the URL BEFORE spying, so the
  // router reads the live location rather than a snapshot taken too early.
  window.history.replaceState({ __vr: 0 }, '', '/nowhere');
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});

  const router = createRouter({
    history: createWebHistory(''),
    routes: ROWS,
    components: { Home: { name: 'Home' } },
  });
  return { router, errors, assign };
}

describe('hard-navigation refusal', () => {
  it('explains itself in dev and does not hard-navigate', async () => {
    vi.resetModules();
    const { router, errors, assign } = await bootRouter();
    await router.isReady().catch(() => {});

    expect(assign).not.toHaveBeenCalled(); // refused - no reload storm
    const messages = errors.map((e) => String(e[0]));
    expect(messages.some((m) => m.includes('refusing to hard-navigate'))).toBe(true);
    router.destroy();
  });

  it('stays quiet about the reason in production, and still refuses', async () => {
    // The `if (DEV)` FALSE arm: no explanatory message, falls through to the
    // generic console.error(error). The refusal itself is unchanged.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { router, errors, assign } = await bootRouter();
    await router.isReady().catch(() => {});

    expect(assign).not.toHaveBeenCalled(); // still refuses - that is the point
    const messages = errors.map((e) => String(e[0]));
    expect(messages.some((m) => m.includes('refusing to hard-navigate'))).toBe(false);
    expect(errors.length).toBeGreaterThan(0); // but the error is still surfaced
    router.destroy();
  });
});

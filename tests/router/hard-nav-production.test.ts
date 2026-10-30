// @vitest-environment happy-dom
/**
 * The hard-navigation refusal in src/router/index.ts, in dev and with NODE_ENV stubbed to production.
 * Why: a HARD_NAV_CODE error (router:missing:route) naming the URL already shown would, if handed to the server behind a
 * catch-all, reload forever; both builds must refuse, dev explaining why and production reporting the error only.
 * Shows: location.assign is not called in either build; dev logs the "does not hard-navigate" explanation,
 * production does not and still logs the error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const ROWS = [{ name: 'home', path: '/', component: 'Home' }];

async function bootRouter(): Promise<{ router: any; errors: unknown[][]; assign: any }> {
  const { createRouter } = await import('@router/index');
  const { createWebHistory } = await import('@router/history');

  const errors: unknown[][] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });

  // Sit on a URL the table cannot match, so navigating to it is `router:missing:route` with `href === here`.
  // The URL is set before the router is created so it reads the live location.
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

    expect(assign).not.toHaveBeenCalled();
    const messages = errors.map((e) => String(e[0]));
    expect(messages.some((m) => m.includes('so the router does not hard-navigate'))).toBe(true);
    router.dispose();
  });

  it('stays quiet about the reason in production, and still refuses', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { router, errors, assign } = await bootRouter();
    await router.isReady().catch(() => {});

    expect(assign).not.toHaveBeenCalled();
    const messages = errors.map((e) => String(e[0]));
    expect(messages.some((m) => m.includes('so the router does not hard-navigate'))).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    router.dispose();
  });
});

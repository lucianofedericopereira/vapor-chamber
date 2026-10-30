// @vitest-environment happy-dom
/**
 * The router's default onError reports a navigation failure under its own code, or router:failed:navigation for a throw that is not a router error.
 * Why: a non-router throw (such as a TypeError from an unreadable location) would go unreported or lose its code, and a router error would be recoded.
 * Shows: pushing null reports one router:failed:navigation whose error is a TypeError; an unknown route name reports router:missing:record.
 * See: log s36.120
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRouter } from '@router/index';
import { createWebHistory } from '@router/history';
import { configureReport, type Report } from '../../src/report';

afterEach(() => { configureReport(null); });

async function started() {
  const got: Report[] = [];
  configureReport({ sinks: [(r) => { got.push(r); }] });
  window.history.replaceState({ __vr: 0 }, '', '/');
  const router = createRouter({ history: createWebHistory(''), routes: [{ name: 'home', path: '/', component: 'Home' }], components: { Home: { name: 'Home' } } });
  await router.start();
  return { router, got };
}

describe('the default onError', () => {
  it('a location the router cannot read is router:failed:navigation, with the throw as its error', async () => {
    const { router, got } = await started();
    await router.push(null as never);
    expect(got.map((r) => [r.code, (r.error as Error).name])).toEqual([['router:failed:navigation', 'TypeError']]);
    router.dispose();
  });

  it('control: a router error keeps its own code', async () => {
    const { router, got } = await started();
    await router.push({ name: 'nowhere' } as never);
    expect(got.map((r) => r.code)).toEqual(['router:missing:record']);
    router.dispose();
  });
});

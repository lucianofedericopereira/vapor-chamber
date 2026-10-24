// @vitest-environment happy-dom
/** The default onError reports a navigation's failure under its own code, or router:failed:navigation for a throw that is not a router error. The long note is at the end. */
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

// `router.push(null)` reaches the location reader with no location, which throws a
// TypeError, not a router error: the default onError reports it as
// router:failed:navigation (log 36.120), where a router error reports under
// its own code. Found unreached at step 8's close.

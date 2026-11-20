/**
 * A synchronous router guard costs no microtask turn.
 * Why: every guard was awaited, so a beforeEach returning undefined still added a turn per path navigation (V8-RULES rule 20). A navigation with no guard is the control; a promise-returning guard is the contact that must still cost a turn.
 * Shows: 0, 1 and 3 synchronous guards settle a push in the same turns; an async guard costs more.
 * See: docs/V8-RULES.md rule 20, log 36.F59
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

const ROWS = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'P' },
  { name: 'list', path: '/list', parent: 'shell', component: 'P' },
];

/** A push after both pages are warm, counted. */
async function warmPush(setup?: (router: ReturnType<typeof createRouter>) => void): Promise<number> {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: ROWS,
    components: { P: { name: 'P' } },
    links: false,
    scroll: false,
    announce: false,
  });
  setup?.(router);
  await router.isReady();
  await router.push('/list');
  return turns(router.push('/'));
}

describe('router guards - microtask turns', () => {
  it('0, 1 and 3 synchronous guards settle in the same turns', async () => {
    const none = await warmPush();
    const one = await warmPush((r) => {
      r.beforeEach(() => undefined);
    });
    const three = await warmPush((r) => {
      r.beforeEach(() => undefined);
      r.beforeEach((to) => to.path !== '/never');
      r.beforeEach(() => true);
    });
    expect(one).toBe(none);
    expect(three).toBe(none);
  });

  it('control: a promise-returning guard costs a turn', async () => {
    const syncGuard = await warmPush((r) => {
      r.beforeEach(() => undefined);
    });
    const asyncGuard = await warmPush((r) => {
      r.beforeEach(async () => undefined);
    });
    expect(asyncGuard).toBeGreaterThan(syncGuard);
  });
});

/**
 * loadComponent: a component key from the routes payload is never answered by Object.prototype.
 * Why: the key arrives in a fetched or inlined routes payload, not from the app; if an inherited name such as `constructor` resolved, it would be called as a lazy import and a blank component rendered with no error.
 * Shows: each prototype key gives router:missing:component and the navigation is refused (path stays '/'); a registered key resolves with no error; an ordinary unregistered key gives router:missing:component.
 * See: src/dict.ts, tests/router/query-prototype.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isRouterError } from '@router/errors';
import { createMemoryHistory } from '@router/history';
import type { RouteRecord } from '@router/types';
import { makeRouter as fixtureRouter } from './fixture';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

/** A real root row, so the boot navigation commits and the only errors are the ones a test provokes. */
const HOME: RouteRecord = { name: 'home', path: '/', component: 'Real' };

function makeRouter(rows: readonly RouteRecord[]) {
  const errors: unknown[] = [];
  const router = fixtureRouter({
    history: createMemoryHistory(''),
    routes: [HOME, ...rows],
    // A plain object literal, as a consumer writes it.
    components: { Real: { render: () => null } } as never,
    links: false,
    onError: (error) => errors.push(error),
  });
  return { router, errors };
}

describe('loadComponent - a payload component key is not looked up on Object.prototype', () => {
  it.each(POLLUTING_KEYS)('reports router:missing:component for a row naming %s', async (key) => {
    const { router, errors } = makeRouter([{ name: 'row', path: '/row', component: key }]);
    await router.isReady();
    await router.push('/row');

    const missing = errors.find((error) => isRouterError(error, 'router:missing:component'));
    expect(missing).toBeDefined();
    // The navigation is refused, not committed with a blank component.
    expect(router.currentRoute.value.location.path).toBe('/');
  });

  it('still resolves a genuinely registered component', async () => {
    const { router, errors } = makeRouter([{ name: 'row', path: '/row', component: 'Real' }]);
    await router.isReady();
    await router.push('/row');

    expect(errors).toHaveLength(0);
    expect(router.currentRoute.value.location.path).toBe('/row');
    expect(router.currentRoute.value.render).toHaveLength(1);
  });

  it('still reports router:missing:component for an ordinary unregistered key', async () => {
    const { router, errors } = makeRouter([{ name: 'row', path: '/row', component: 'Nope' }]);
    await router.isReady();
    await router.push('/row');

    expect(errors.some((error) => isRouterError(error, 'router:missing:component'))).toBe(true);
  });
});

/**
 * A component key from the routes payload must never be answered by
 * Object.prototype.
 *
 * `loadComponent` resolved a row's `component` against the app's component map
 * with `options.components?.[key]`. That key is NOT authored in the app: it
 * arrives in the ROUTES PAYLOAD, which is fetched over HTTP (`{ url }`) or
 * inlined into the page by the server (`{ inline }`). A plain-object lookup
 * therefore answered for keys nobody registered.
 *
 * The failure is quiet, which is what makes it worth pinning. A row naming
 * `constructor` resolved to `Object`, survived the `component_missing` check,
 * failed `isComponentLike` (no render/setup/__vccOpts), was called as if it
 * were a lazy import - `await Object()` returns `{}` - and that `{}` was cached
 * and RENDERED. A coded error the default handler hard-navigates on degraded
 * into a blank outlet with nothing in the console.
 *
 * Same class as the query keys pinned in query-prototype.test.ts; the rule and
 * the full site list live in src/dict.ts.
 */

import { describe, expect, it } from 'vitest';
import { isRouterError } from '../../src/router/errors';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const POLLUTING_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

/** A real root row, so the boot navigation to '/' commits and the only errors
 *  a test sees are the ones it provoked. */
const HOME: RouteRecord = { name: 'home', path: '/', component: 'Real' };

function makeRouter(rows: readonly RouteRecord[]) {
  const errors: unknown[] = [];
  const router = createRouter({
    history: createMemoryHistory(''),
    routes: [HOME, ...rows],
    // A real app map: a plain object literal, exactly what a consumer writes.
    components: { Real: { render: () => null } } as never,
    links: false,
    scroll: false,
    onError: (error) => errors.push(error),
  });
  return { router, errors };
}

describe('loadComponent - a payload component key is not looked up on Object.prototype', () => {
  it.each(POLLUTING_KEYS)('reports component_missing for a row naming %s', async (key) => {
    const { router, errors } = makeRouter([{ name: 'row', path: '/row', component: key }]);
    await router.isReady();
    await router.push('/row');

    const missing = errors.find((error) => isRouterError(error, 'component_missing'));
    expect(missing).toBeDefined();
    // The whole point: the navigation was REFUSED, not committed with a blank
    // component. Pre-fix it committed, rendering the `{}` that calling the
    // inherited constructor as a lazy import returned.
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

  it('still reports component_missing for an ordinary unregistered key', async () => {
    const { router, errors } = makeRouter([{ name: 'row', path: '/row', component: 'Nope' }]);
    await router.isReady();
    await router.push('/row');

    expect(errors.some((error) => isRouterError(error, 'component_missing'))).toBe(true);
  });
});

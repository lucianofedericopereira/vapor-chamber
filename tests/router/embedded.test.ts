import { afterEach, describe, expect, it, vi } from 'vitest';
import { canUseWebHistory, createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';

/**
 * Embedded/opaque-origin contexts (sandboxed or srcdoc iframes, data:
 * documents, freshly-created browsing contexts — whatwg/html#6836) throw
 * SecurityError on replaceState. The guard is a PROBE, not attribute
 * sniffing, and createRouter degrades to a seeded memory history instead of
 * crashing at boot.
 */
describe('embedded-context history guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no window → not usable (SSR/node)', () => {
    expect(canUseWebHistory()).toBe(false);
  });

  it('healthy window → usable', () => {
    vi.stubGlobal('window', {
      history: { state: null, replaceState: () => {} },
    });
    expect(canUseWebHistory()).toBe(true);
  });

  it('replaceState throwing (opaque origin) → not usable', () => {
    vi.stubGlobal('window', {
      history: {
        state: null,
        replaceState: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      },
    });
    expect(canUseWebHistory()).toBe(false);
  });

  it('createRouter in an embedded context boots on a seeded memory history instead of crashing', async () => {
    vi.stubGlobal('window', {
      history: {
        state: null,
        replaceState: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      },
      location: { pathname: '/admin/products', search: '?page=2', hash: '' },
      // start() installs listeners only when links !== false; keep it off
      // — this stub has no document.
    });

    const router = createRouter({
      base: '/admin',
      links: false,
      scroll: false,
      routes: [
        { name: 'home', path: '/', component: 'Home' },
        { name: 'products', path: '/products', component: 'P', query: { page: { type: 'int', default: 1 } } },
      ],
      components: { Home: { name: 'Home' }, P: { name: 'P' } },
    });
    await router.isReady();
    expect(router.currentRoute.value.location.name).toBe('products');
    expect(router.currentRoute.value.location.query.page).toBe('2'); // seeded from location
  });

  it('explicit history option always wins over the probe', () => {
    const memory = createMemoryHistory('/x', '/seeded');
    expect(memory.location()).toBe('/seeded');
  });
});

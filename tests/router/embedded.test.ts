/**
 * canUseWebHistory probe and createRouter's fallback in an embedded (opaque-origin) context.
 * Why: sandboxed or srcdoc iframes and data: documents throw SecurityError on replaceState, so a router
 * that assumed web history would crash at boot; it must fall back to a memory history seeded from location.
 * Shows: no window and a throwing replaceState are not usable, a healthy window is; createRouter boots on
 * the seeded location (route and query) with a throwing replaceState; createMemoryHistory seeds its location.
 * See: whatwg/html#6836
 */
import { describe, expect, it, vi } from 'vitest';
import { canUseWebHistory, createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';

describe('embedded-context history guard', () => {

  it('no window -> not usable (SSR/node)', () => {
    expect(canUseWebHistory()).toBe(false);
  });

  it('healthy window -> usable', () => {
    vi.stubGlobal('window', {
      history: { state: null, replaceState: () => {} },
    });
    expect(canUseWebHistory()).toBe(true);
  });

  it('replaceState throwing (opaque origin) -> not usable', () => {
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
      // `links: false` below because this stub has no document.
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
    expect(router.currentRoute.value.location.query.page).toBe('2');
  });

  it('explicit history option always wins over the probe', () => {
    const memory = createMemoryHistory('/x', '/seeded');
    expect(memory.location()).toBe('/seeded');
  });
});

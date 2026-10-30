/**
 * Typed `int` params beyond Number.MAX_SAFE_INTEGER, in the route matcher and decodeQueryParam.
 * Why: an id past 2^53 (64-bit ids) cast with Number would round to a different record, so the loader and resolve() would
 * address the wrong one; an integer the cast cannot hold exactly does not fit `int`. Declare such a param `string` to receive it whole.
 * Shows: a path param past 2^53 falls through to the next row and arrives as a string while 2^53-1 stays an int;
 * a query param past 2^53 reads its default, or undefined without one.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, decodeQueryParam } from '../../src/router';

describe('int params past 2^53', () => {
  it('a path param that does not fit int falls through to the next row', async () => {
    const seen: unknown[] = [];
    const routes = [
      { name: 'orderInt', path: '/orders/:id', params: { id: 'int' as const }, component: 'U', load: 'x:int' },
      { name: 'orderText', path: '/orders/:id', component: 'U', load: 'x:text' },
      { name: 'home', path: '/', component: 'U' },
    ];
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes,
      components: { U: {} },
      loaders: { prefixes: { 'x:': (_ref, loc) => { seen.push(loc.params.id); return null; } } },
    });
    await router.start();

    await router.push('/orders/9007199254740991');
    expect(router.currentRoute.value.location.name).toBe('orderInt');
    expect(router.currentRoute.value.location.params.id).toBe(9007199254740991);

    await router.push('/orders/9007199254740993');
    expect(router.currentRoute.value.location.name).toBe('orderText');
    expect(router.currentRoute.value.location.params.id).toBe('9007199254740993');
    expect(seen).toEqual([9007199254740991, '9007199254740993']);
    router.dispose();
  });

  it('a typed query param that does not fit int reads its default', () => {
    expect(decodeQueryParam('42', { type: 'int', default: 1 })).toBe(42);
    expect(decodeQueryParam('9007199254740993', { type: 'int', default: 1 })).toBe(1);
    expect(decodeQueryParam('-9007199254740993', { type: 'int' })).toBeUndefined();
  });
});

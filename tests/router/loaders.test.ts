import { describe, expect, it, vi } from 'vitest';
import { defaultAffects, interpolateLoad, runLoaders } from '../../src/router/loaders';
import { createRouteTable } from '../../src/router/table';
import type { RouteLocation } from '../../src/router/types';

function locationWith(
  query: Record<string, string | string[]>,
  params: Record<string, string | number> = {},
): RouteLocation {
  return { name: 'x', path: '/x', fullPath: '/x', params, query, hash: '', matched: [], meta: {} };
}

const table = createRouteTable([
  { name: 'shell', path: '/', load: '/api/vc/nav' },
  {
    name: 'products',
    path: '/products',
    parent: 'shell',
    component: 'P',
    load: 'rows:products',
    query: { page: { type: 'int', default: 1 }, name: {} },
  },
  { name: 'orders', path: '/orders', component: 'O', load: '/api/vc/orders?page={page}' },
]);

const products = table.getRecord('products');
const orders = table.getRecord('orders');
const shell = table.getRecord('shell');
if (!products || !orders || !shell) throw new Error('table setup broken');

describe('interpolateLoad', () => {
  it('fills placeholders from path params first, then typed query params', () => {
    const url = interpolateLoad(
      '/api/vc/products/{id}?page={page}&sort={sort}',
      locationWith({ sort: 'price' }, { id: 7 }),
      { page: { type: 'int', default: 1 }, sort: {} },
    );
    expect(url).toBe('/api/vc/products/7?page=1&sort=price');
  });

  it('encodes values and blanks unknown keys', () => {
    const url = interpolateLoad('/api?q={q}&x={nope}', locationWith({ q: 'caffè latte' }), {});
    expect(url).toBe('/api?q=caff%C3%A8%20latte&x=');
  });
});

describe('runLoaders — the SPI', () => {
  it('dispatches by registered prefix, ref stripped', async () => {
    const handler = vi.fn((ref: string) => ({ from: ref }));
    const results = await runLoaders(
      { prefixes: { 'rows:': handler } },
      [products],
      locationWith({}),
      new AbortController().signal,
    );
    expect(handler).toHaveBeenCalledWith('products', expect.anything(), products, expect.anything());
    expect(results.get('products')).toEqual({ from: 'products' });
  });

  it('falls through to the url handler for plain templates', async () => {
    const url = vi.fn(async (template: string) => ({ hit: template }));
    const results = await runLoaders({ url }, [orders], locationWith({}), new AbortController().signal);
    expect(results.get('orders')).toEqual({ hit: '/api/vc/orders?page={page}' });
  });

  it('no matching handler → coded load_failed', async () => {
    await expect(runLoaders({}, [orders], locationWith({}), new AbortController().signal)).rejects.toMatchObject({
      code: 'load_failed',
    });
  });

  it('handler failure wraps with cause; aborted signal becomes "cancelled"', async () => {
    const boom = new Error('boom');
    await expect(
      runLoaders({ url: async () => Promise.reject(boom) }, [orders], locationWith({}), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'load_failed', cause: boom });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runLoaders({ url: async () => Promise.reject(new Error('x')) }, [orders], locationWith({}), aborted.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('defaultAffects', () => {
  const handlers = { prefixes: { 'rows:': () => null }, url: async () => null };

  it('prefix sources react to declared params and pagination keys', () => {
    expect(defaultAffects(products, ['name'], handlers)).toBe(true);
    expect(defaultAffects(products, ['page'], handlers)).toBe(true);
    expect(defaultAffects(products, ['unrelated'], handlers)).toBe(false);
  });

  it('url templates react only to mentioned placeholders', () => {
    expect(defaultAffects(orders, ['page'], handlers)).toBe(true);
    expect(defaultAffects(orders, ['sort'], handlers)).toBe(false);
  });
});

describe('loadChain precompute', () => {
  it('records with load templates land on the loadChain', () => {
    expect(products.loadChain.map((r) => r.name)).toEqual(['shell', 'products']);
  });
});

describe('interpolateLoad — array query values', () => {
  it('joins an array param with commas, each part encoded', () => {
    // type 'array' is what makes a repeated key decode to a list; the template
    // then gets one comma-joined value rather than the last occurrence.
    const url = interpolateLoad(
      '/api/items?tags={tag}',
      { params: {}, query: { tag: ['a b', 'c&d'] } } as never,
      { tag: { type: 'array' } } as never,
    );
    expect(url).toBe('/api/items?tags=a%20b,c%26d');
  });

  it('falls back to the declared default array when the key is absent', () => {
    const url = interpolateLoad(
      '/api/items?tags={tag}',
      { params: {}, query: {} } as never,
      { tag: { type: 'array', default: ['x', 'y'] } } as never,
    );
    expect(url).toBe('/api/items?tags=x,y');
  });
});

/**
 * Four defects found by reading the router cluster, none of which announces
 * itself: each degrades quietly rather than failing.
 *
 *  - a route record's `meta` was the table's own object, handed to every
 *    consumer for the router's life (fourth site of ../freeze's contract)
 *  - `usePagination` propagated NaN from a backend response straight into the
 *    pager UI, because neither `Math.max` nor `||` contains one
 *  - `revalidateRoutes` shared one AbortController, so any refresh cancelled
 *    every other one whatever it was refreshing
 *  - `matchPrefix` returned the first registered prefix, making overlapping
 *    prefixes resolve by object key order
 */

import { describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { usePagination } from '../../src/router/composables';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { ROUTER_KEY } from '../../src/router/keys';
import { createRouteTable } from '../../src/router/table';
import { defaultAffects, runLoaders, type LoaderHandlers } from '../../src/router/loaders';
import type { RouteRecord } from '../../src/router/types';

describe('route meta is the table declaration, not the caller to keep', () => {
  // Fresh objects per test on purpose: the freeze lands on the ROW's own meta,
  // in place, so a shared fixture would carry the dev run's freeze into the
  // production one. That is the behaviour, not a test artifact - rows come from
  // a generated module and are not the caller's to mutate afterwards either.
  const rows = (): RouteRecord[] => [
    { name: 'p', path: '/p', component: 'P', meta: { title: 'shop.products', nested: { a: 1 } } },
  ];

  it('refuses a write through location.meta in dev', () => {
    const table = createRouteTable(rows());
    // Asserted, not optional-chained: a `?.` here would let the test pass on a
    // TypeError from `undefined` rather than on the frozen-write it is about.
    const record = table.getRecord('p');
    if (!record) throw new Error('fixture: record "p" missing');

    expect(Object.isFrozen(record.meta)).toBe(true);
    expect(() => {
      (record.meta as Record<string, unknown>).title = 'rewritten';
    }).toThrow();
    // Deep, because a nested object is shared just as thoroughly as the top one.
    expect(() => {
      (record.meta as { nested: Record<string, unknown> }).nested.a = 2;
    }).toThrow();
    expect(record.meta.title).toBe('shop.products');
  });

  it('leaves production alone, like every other freeze site', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const prod = await import('../../src/router/table');
    const record = prod.createRouteTable(rows()).getRecord('p');
    expect(Object.isFrozen(record?.meta)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('matchPrefix - the longest prefix wins, not the first registered', () => {
  const record = createRouteTable([
    { name: 'r', path: '/r', component: 'R', load: 'rows:archived:orders' },
  ] as RouteRecord[]).getRecord('r')!;

  const both = (order: 'general-first' | 'specific-first'): LoaderHandlers => {
    const general = () => 'general';
    const specific = () => 'specific';
    return {
      prefixes:
        order === 'general-first'
          ? { 'rows:': general, 'rows:archived:': specific }
          : { 'rows:archived:': specific, 'rows:': general },
    };
  };

  it('resolves the specific handler whichever way the map was written', async () => {
    for (const order of ['general-first', 'specific-first'] as const) {
      const result = await runLoaders(both(order), [record], {} as never, new AbortController().signal);
      expect(result.get('r'), order).toBe('specific');
    }
  });

  it('hands the handler the ref with the LONGER prefix stripped', async () => {
    const seen: string[] = [];
    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': (ref) => { seen.push(`general:${ref}`); return null; },
        'rows:archived:': (ref) => { seen.push(`specific:${ref}`); return null; },
      },
    };
    await runLoaders(handlers, [record], {} as never, new AbortController().signal);
    expect(seen).toEqual(['specific:orders']);
  });

  it('still reports a prefix loader to defaultAffects', () => {
    // defaultAffects shares matchPrefix, so the two cannot drift on which
    // handler a template belongs to.
    expect(defaultAffects(record, ['page'], both('general-first'))).toBe(true);
  });
});

describe('usePagination - a backend number is not a number', () => {
  /** Same shape as composables.test.ts: an app context so inject resolves. */
  function withRouter<T>(router: unknown, fn: () => T): T {
    const app = createApp({});
    app.provide(ROUTER_KEY, router);
    return app.runWithContext(fn);
  }

  async function paginated(payload: unknown) {
    const router = createRouter({
      history: createMemoryHistory('', '/list'),
      routes: [{ name: 'list', path: '/list', component: 'L', load: '/api/list' }],
      components: { L: { name: 'L' } },
      loaders: { url: async () => payload },
      links: false,
      scroll: false,
    });
    await router.isReady();
    return router;
  }

  it('keeps NaN out of the pager when the response is not numeric', async () => {
    // `total: "many"` was enough: total was never coerced, so it reached
    // Math.ceil as a string, lastPage became NaN, pageRange rendered a literal
    // "NaN" page link, and hasNext was permanently false.
    const router = await paginated({ items: [1, 2, 3], total: 'many' });
    const p = withRouter(router, () => usePagination());

    expect(Number.isFinite(p.total.value)).toBe(true);
    expect(Number.isFinite(p.lastPage.value)).toBe(true);
    expect(Number.isFinite(p.perPage.value)).toBe(true);
    expect(p.pageRange.value.every((n) => Number.isFinite(n))).toBe(true);
    router.destroy();
  });

  it('survives a per_page of zero and a negative last_page', async () => {
    const router = await paginated({ items: [1, 2], total: 10, per_page: 0, last_page: -3 });
    const p = withRouter(router, () => usePagination());
    expect(p.perPage.value).toBeGreaterThan(0);
    expect(p.lastPage.value).toBeGreaterThan(0);
    router.destroy();
  });

  it('falls back to the default window rather than collapsing the range', async () => {
    const router = await paginated({ items: [1], total: 100, per_page: 10, last_page: 10 });
    for (const window of [Number.NaN, 0, -5]) {
      const p = withRouter(router, () => usePagination({ window }));
      // `Math.max(1, Math.floor(NaN))` is NaN, so the run between first and
      // last used to vanish and the range collapsed to [1, last].
      expect(p.pageRange.value.length, String(window)).toBeGreaterThan(2);
      expect(p.pageRange.value.every((n) => Number.isFinite(n))).toBe(true);
    }
    router.destroy();
  });

  it('clamps a degenerate go() instead of writing NaN to the URL', async () => {
    const router = await paginated({ items: [1], total: 100, per_page: 10, last_page: 10 });
    const p = withRouter(router, () => usePagination());
    p.go(Number.NaN);
    expect(router.currentRoute.value.location.fullPath).not.toContain('NaN');
    router.destroy();
  });
});

/**
 * Shared and degenerate inputs to the router: frozen route meta, longest-prefix loader matching, and usePagination with non-numeric backend numbers.
 * Why: a route's `meta` handed out as the table's own object could be mutated by any consumer; overlapping loader prefixes would resolve by object key order; a NaN from a backend response would reach the pager UI as a "NaN" page link with hasNext stuck false.
 * Shows: route meta is deeply frozen in dev and left alone in production; the longest matching prefix wins in either map order, receives the ref with that prefix stripped, and is reported to defaultAffects; usePagination keeps total, lastPage, perPage and pageRange finite, falls back for a bad window, and go(NaN) writes no NaN to the URL.
 * See: freeze.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { usePagination } from '@router/composables';
import { createMemoryHistory } from '@router/history';
import { ROUTER_KEY } from '@router/keys';
import { createRouteTable } from '@router/table';
import { defaultAffects, runLoaders, type LoaderHandlers } from '@router/loaders';
import type { RouteRecord } from '@router/types';
import { makeRouter } from './fixture';

describe('route meta is the table declaration, not the caller to keep', () => {
  // Fresh rows per test: the freeze lands on the row's own meta in place, so a shared row would carry the dev freeze into the production run.
  const rows = (): RouteRecord[] => [
    { name: 'p', path: '/p', component: 'P', meta: { title: 'shop.products', nested: { a: 1 } } },
  ];

  it('refuses a write through location.meta in dev', () => {
    const table = createRouteTable(rows());
    // No `?.`: a TypeError from `undefined` must not pass for the frozen-write throw.
    const record = table.getRecord('p');
    if (!record) throw new Error('fixture: record "p" missing');

    expect(Object.isFrozen(record.meta)).toBe(true);
    expect(() => {
      (record.meta as Record<string, unknown>).title = 'rewritten';
    }).toThrow();
    // The freeze is deep: nested objects are shared too.
    expect(() => {
      (record.meta as { nested: Record<string, unknown> }).nested.a = 2;
    }).toThrow();
    expect(record.meta.title).toBe('shop.products');
  });

  it('leaves production alone, like every other freeze site', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const prod = await import('@router/table');
    const record = prod.createRouteTable(rows()).getRecord('p');
    expect(Object.isFrozen(record?.meta)).toBe(false);
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
    // defaultAffects shares matchPrefix, so both pick the same handler.
    expect(defaultAffects(record, ['page'], both('general-first'))).toBe(true);
  });
});

describe('usePagination - a backend number is not a number', () => {
  /** An app context so inject resolves, as in composables.test.ts. */
  function withRouter<T>(router: unknown, fn: () => T): T {
    const app = createApp({});
    app.provide(ROUTER_KEY, router);
    return app.runWithContext(fn);
  }

  async function paginated(payload: unknown) {
    const router = makeRouter({
      history: createMemoryHistory('', '/list'),
      routes: [{ name: 'list', path: '/list', component: 'L', load: '/api/list' }],
      components: { L: { name: 'L' } },
      loaders: { url: async () => payload },
      links: false,
    });
    await router.isReady();
    return router;
  }

  it('keeps NaN out of the pager when the response is not numeric', async () => {
    // A string total must be coerced: uncoerced it makes lastPage NaN.
    const router = await paginated({ items: [1, 2, 3], total: 'many' });
    const p = withRouter(router, () => usePagination());

    expect(Number.isFinite(p.total.value)).toBe(true);
    expect(Number.isFinite(p.lastPage.value)).toBe(true);
    expect(Number.isFinite(p.perPage.value)).toBe(true);
    expect(p.pageRange.value.every((n) => Number.isFinite(n))).toBe(true);
    router.dispose();
  });

  it('survives a per_page of zero and a negative last_page', async () => {
    const router = await paginated({ items: [1, 2], total: 10, per_page: 0, last_page: -3 });
    const p = withRouter(router, () => usePagination());
    expect(p.perPage.value).toBeGreaterThan(0);
    expect(p.lastPage.value).toBeGreaterThan(0);
    router.dispose();
  });

  it('falls back to the default window rather than collapsing the range', async () => {
    const router = await paginated({ items: [1], total: 100, per_page: 10, last_page: 10 });
    for (const window of [Number.NaN, 0, -5]) {
      const p = withRouter(router, () => usePagination({ window }));
      // `Math.max(1, Math.floor(NaN))` is NaN: the window would vanish and the range collapse to [1, last].
      expect(p.pageRange.value.length, String(window)).toBeGreaterThan(2);
      expect(p.pageRange.value.every((n) => Number.isFinite(n))).toBe(true);
    }
    router.dispose();
  });

  it('clamps a degenerate go() instead of writing NaN to the URL', async () => {
    const router = await paginated({ items: [1], total: 100, per_page: 10, last_page: 10 });
    const p = withRouter(router, () => usePagination());
    p.go(Number.NaN);
    expect(router.currentRoute.value.location.fullPath).not.toContain('NaN');
    router.dispose();
  });
});

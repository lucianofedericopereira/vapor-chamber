/** A route row whose `params` is `null` (a nullable column, a JSON table) compiles as a row with none. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createRouteTable } from '@router/table';
import type { RouteRecord } from '@router/types';
import { makeRouter } from './fixture';

const rows = (params: unknown): RouteRecord[] => [
  { name: 'o', path: '/orders/:id', component: 'C', params: params as RouteRecord['params'] },
];

describe('a route row with params: null', () => {
  it('compiles, and its param matches as a string', () => {
    const table = createRouteTable(rows(null));
    expect(table.resolve('/orders/7')?.params).toEqual({ id: '7' });
  });

  it('createRouter() takes the table', () => {
    const router = makeRouter({ routes: rows(null), components: { C: { name: 'C' } } });
    router.dispose();
  });

  it('control: typed params still type the match', () => {
    expect(createRouteTable(rows({ id: 'int' })).resolve('/orders/7')?.params).toEqual({ id: 7 });
  });
});

/*
 * A route table from a database, a JSON file or a Blade-inlined table carries
 * `null` where a field is absent. The row already read `params ?? {}` for its
 * param types, but compiled its path with the raw value, so `null` threw a
 * TypeError inside the path compiler. One value now serves both.
 */

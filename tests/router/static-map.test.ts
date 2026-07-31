import { describe, expect, it } from 'vitest';
import { createRouteTable } from '../../src/router/table';
import type { RouteRecord } from '../../src/router/types';

describe('static fast path — correctness', () => {
  it('does not let a static row jump ahead of an earlier parameterised row', () => {
    const table = createRouteTable([
      { name: 'shell', path: '/', parent: null },
      { name: 'product', path: '/products/:id', parent: 'shell', component: 'P' },
      { name: 'new', path: '/products/new', parent: 'shell', component: 'N' }, // later, shadowed
    ]);
    // server priority says :id wins — the map must not change that
    expect(table.resolve('/products/new')?.record.name).toBe('product');
    expect(table.resolve('/products/new')?.record.params ?? {}).toBeTruthy();
    expect(table.resolve('/products/7')?.record.name).toBe('product');
  });

  it('uses the static row when it comes first', () => {
    const table = createRouteTable([
      { name: 'shell', path: '/', parent: null },
      { name: 'new', path: '/products/new', parent: 'shell', component: 'N' },
      { name: 'product', path: '/products/:id', parent: 'shell', component: 'P' },
    ]);
    expect(table.resolve('/products/new')?.record.name).toBe('new');
    expect(table.resolve('/products/7')?.record.name).toBe('product');
  });

  it('keeps the scan rules: case-insensitive, optional trailing slash, groups skipped', () => {
    const table = createRouteTable([
      { name: 'shell', path: '/', parent: null }, // group — never matches
      { name: 'dash', path: '/Dashboard', parent: 'shell', component: 'D' },
    ]);
    expect(table.resolve('/dashboard')?.record.name).toBe('dash');
    expect(table.resolve('/DASHBOARD')?.record.name).toBe('dash');
    expect(table.resolve('/dashboard/')?.record.name).toBe('dash');
    expect(table.resolve('/nope')).toBeNull();
  });

  it('static hit carries empty params, like the scan', () => {
    const table = createRouteTable([{ name: 'a', path: '/a/b', parent: null, component: 'A' }]);
    expect(table.resolve('/a/b')).toEqual({ record: expect.objectContaining({ name: 'a' }), params: {} });
  });
});

describe('static fast path — cost', () => {
  it('measures build and resolve', () => {
    const rows: RouteRecord[] = [{ name: 'shell', path: '/', parent: null }];
    for (let i = 0; i < 300; i++) {
      rows.push({ name: `r${i}`, path: `/section${i}/page`, parent: 'shell', component: 'C' });
    }
    rows.push({ name: 'p', path: '/thing/:id', parent: 'shell', component: 'P' });

    const B = 200;
    const t0 = performance.now();
    for (let i = 0; i < B; i++) createRouteTable(rows);
    const build = (performance.now() - t0) / B;

    const table = createRouteTable(rows);
    const N = 20000;
    const timeIt = (path: string) => {
      for (let i = 0; i < N; i++) table.resolve(path);
      const t = performance.now();
      for (let i = 0; i < N; i++) table.resolve(path);
      return performance.now() - t;
    };

    console.log(
      `[301 rows] build ${build.toFixed(2)}ms | ${N} resolves — first ${timeIt('/section0/page').toFixed(1)}ms, last ${timeIt('/section299/page').toFixed(1)}ms, param ${timeIt('/thing/9').toFixed(1)}ms, miss ${timeIt('/nope/nope').toFixed(1)}ms`,
    );
    expect(true).toBe(true);
  });
});

/**
 * The route table's static-path fast path resolves the same row the linear scan would, and a timing run reports its cost.
 * Why: if a static row jumped ahead of an earlier parameterised row, or the map changed the scan's rules, a URL would open a different route than the server's priority gives.
 * Shows: an earlier `:id` row wins over a later static row, a static row wins when first; matching is case-insensitive with an optional trailing slash, and groups never match; a static hit carries empty params. The opt-in timing test also asserts the rows it measures resolve correctly.
 */
import { describe, expect, it } from 'vitest';
import { createRouteTable } from '@router/table';
import type { RouteRecord } from '@router/types';
import { runTiming } from '../under-coverage';

describe('static fast path - correctness', () => {
  it('does not let a static row jump ahead of an earlier parameterised row', () => {
    const table = createRouteTable([
      { name: 'shell', path: '/', parent: null },
      { name: 'product', path: '/products/:id', parent: 'shell', component: 'P' },
      { name: 'new', path: '/products/new', parent: 'shell', component: 'N' }, // later, shadowed
    ]);
    // Server priority: the earlier :id row wins.
    expect(table.resolve('/products/new')?.record.name).toBe('product');
    expect(table.resolve('/products/new')?.record.paramTypes).toEqual({});
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
      { name: 'shell', path: '/', parent: null }, // group - never matches
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

describe('static fast path - cost', () => {
  // Opt-in (VC_TIMING=1) and never under coverage: instrumented code gives no real timings.
  it.skipIf(!runTiming)('measures build and resolve', () => {
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
      `[301 rows] build ${build.toFixed(2)}ms | ${N} resolves - first ${timeIt('/section0/page').toFixed(1)}ms, last ${timeIt('/section299/page').toFixed(1)}ms, param ${timeIt('/thing/9').toFixed(1)}ms, miss ${timeIt('/nope/nope').toFixed(1)}ms`,
    );
    // The measured table must also be correct, so the reporter can fail.
    expect(table.resolve('/section0/page')?.record.name).toBe('r0');
    expect(table.resolve('/section299/page')?.record.name).toBe('r299');
    expect(table.resolve('/thing/9')?.record.name).toBe('p');
    // '9', not 9: the row declares no `params: { id: 'int' }`, so nothing casts it.
    expect(table.resolve('/thing/9')?.params.id).toBe('9');
    expect(table.resolve('/nope/nope')).toBeNull();
  });
});

// @vitest-environment happy-dom
/**
 * Engine paths engine-edges.test.ts leaves open — the async lanes that only
 * appear when a background operation outlives, or loses to, the navigation
 * that started it.
 *
 *  - trackRevalidation (119-137): a loader's background refresh (reported via
 *    LoaderContext.revalidate) landing after the user navigated away (125),
 *    and one that REJECTS — which must leave the stale data in place and
 *    never reach onError (128-133).
 *  - refetchAffected's async arms (376-395): a query-only refetch that
 *    rejects reaching onError (386-388), and one superseded by a later
 *    navigation (381).
 *  - cleanQueryPatch dropping null/undefined values (195).
 *  - resolveLocation: a string target carrying BOTH query and hash (170).
 *  - setRouteData's dev warning for an unknown record name (438-445).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  {
    name: 'list',
    path: '/list',
    parent: 'shell',
    component: 'List',
    load: 'rows:list',
    query: { page: { type: 'int', default: 1 }, tag: {} },
  },
  // A third destination, distinct from the committed location: superseding a
  // parked navigation needs a target that is not the CURRENT location, or the
  // engine's duplicate check short-circuits it before pendingId advances.
  { name: 'other', path: '/other', parent: 'shell', component: 'Home' },
];

/** Router wired to a single `rows:` prefix handler — the loader under test. */
function makeRouter(handler: (...args: any[]) => unknown, opts: Record<string, unknown> = {}) {
  return createRouter({
    history: createMemoryHistory('/'),
    routes: ROWS,
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    loaders: { prefixes: { 'rows:': handler as any } },
    ...opts,
  });
}

/** Settle timers + microtasks so background .then/.catch chains run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// trackRevalidation — background refresh outcomes (119-137)
// ---------------------------------------------------------------------------

describe('stale-while-revalidate background refresh', () => {
  it('patches fresh data into the snapshot when still on the same route', async () => {
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      return 'stale-value';
    });
    await router.isReady();
    await router.push('/list');
    expect(router.currentRoute.value.data.get('list')).toBe('stale-value');

    report(Promise.resolve('fresh-value'));
    expect(router.isRevalidating.value).toBe(true);
    await flush();

    expect(router.currentRoute.value.data.get('list')).toBe('fresh-value');
    expect(router.isRevalidating.value).toBe(false);
    router.destroy();
  });

  it('drops a refresh that lands after the user navigated away (125)', async () => {
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      return 'stale-value';
    });
    await router.isReady();
    await router.push('/list');

    let land!: (v: unknown) => void;
    report(new Promise((resolve) => { land = resolve; }));
    await router.push('/'); // navigate away while the refresh is in flight
    land('fresh-value');
    await flush();

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(router.currentRoute.value.data.get('list')).toBeUndefined();
    expect(router.isRevalidating.value).toBe(false);
    router.destroy();
  });

  it('keeps stale data and never reports an error when the refresh rejects (128-133)', async () => {
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      return 'stale-value';
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();
    await router.push('/list');

    const failing = Promise.reject(new Error('refresh failed'));
    failing.catch(() => {}); // the engine attaches its own catch; keep the test copy quiet
    report(failing);
    await flush();

    expect(router.currentRoute.value.data.get('list')).toBe('stale-value');
    expect(onError).not.toHaveBeenCalled();
    expect(router.lastError.value).toBeNull();
    expect(router.isRevalidating.value).toBe(false);
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// refetchAffected — query-only change re-running loaders (371-395)
// ---------------------------------------------------------------------------

describe('query-only refetch', () => {
  it('patches refetched data without a full navigation (229-232, 378-384)', async () => {
    let calls = 0;
    const router = makeRouter(() => `data-${++calls}`);
    await router.isReady();
    await router.push('/list?page=1');
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');

    await router.push('/list?page=2'); // query-only → fast path, not a re-navigation
    await flush();

    // location.query holds RAW strings — typed decoding (int, defaults) is a
    // read-time concern (decodeQueryParam / useRouteQuery), not stored here.
    expect(router.currentRoute.value.location.query.page).toBe('2');
    expect(router.currentRoute.value.data.get('list')).toBe('data-2');
    router.destroy();
  });

  it('reports a rejecting refetch through onError while keeping stale data (386-388)', async () => {
    let calls = 0;
    const router = makeRouter(() => {
      calls++;
      if (calls > 1) throw new Error('refetch exploded');
      return 'data-1';
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();
    await router.push('/list?page=1');

    await router.push('/list?page=2');
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]![0] as Error).message)).toMatch(/loader failed/i);
    // The page keeps what it had rather than blanking.
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');
    router.destroy();
  });

  it('drops a refetch superseded by a later navigation (381)', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const router = makeRouter(() => {
      calls++;
      if (calls === 1) return 'data-1';
      return new Promise<string>((resolve) => { release = resolve; });
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();
    await router.push('/list?page=1');

    await router.push('/list?page=2'); // starts the slow refetch
    await router.push('/'); // navigate away before it lands
    release('too-late');
    await flush();

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(onError).not.toHaveBeenCalled();
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// resolveLocation / cleanQueryPatch (161-199)
// ---------------------------------------------------------------------------

describe('location resolution', () => {
  it('splits a string target carrying both query and hash (170)', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push('/list?tag=blue#section-2');
    const loc = router.currentRoute.value.location;
    expect(loc.path).toBe('/list');
    expect(loc.query.tag).toBe('blue');
    expect(loc.hash).toBe('#section-2');
    router.destroy();
  });

  it('drops null and undefined values from a query patch (195)', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push({ path: '/list', query: { tag: 'red', page: null, missing: undefined } as any });
    const { query } = router.currentRoute.value.location;
    expect(query.tag).toBe('red');
    expect(query.missing).toBeUndefined();
    // Both null and undefined are dropped outright — a declared default is
    // applied when the value is READ, so nothing is stored for `page`.
    expect(query.page).toBeUndefined();
    expect(Object.keys(query)).toEqual(['tag']);
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// setRouteData dev guard (432-447)
// ---------------------------------------------------------------------------

describe('setRouteData', () => {
  it('warns in dev when the record name is not in the table (438-445)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = makeRouter(() => 'x');
    await router.isReady();
    await router.push('/list');

    router.setRouteData('lsit', { typo: true }); // transposed name
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('no route record by that name');
    // The value still lands — lenient, just loud.
    expect(router.currentRoute.value.data.get('lsit')).toEqual({ typo: true });
    router.destroy();
  });

  it('does not warn for a real record name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = makeRouter(() => 'x');
    await router.isReady();
    await router.push('/list');

    router.setRouteData('list', 'pushed');
    expect(warn).not.toHaveBeenCalled();
    expect(router.currentRoute.value.data.get('list')).toBe('pushed');
    router.destroy();
  });
});

// ---------------------------------------------------------------------------
// Supersession mid-navigation (259-275) and hook unsubscribe (466-476)
// ---------------------------------------------------------------------------

describe('supersession', () => {
  it('abandons a navigation superseded while a guard was awaiting (263)', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    let releaseGuard!: () => void;
    let guardRuns = 0;
    router.beforeEach(async () => {
      guardRuns++;
      if (guardRuns === 1) await new Promise<void>((resolve) => { releaseGuard = resolve; });
      return true;
    });

    const first = router.push('/list'); // parks inside the guard
    await flush();
    const second = router.push('/other'); // supersedes it
    releaseGuard();

    const firstError = await first;
    await second;
    expect(firstError?.code).toBe('cancelled');
    expect(router.currentRoute.value.location.path).toBe('/other');
    router.destroy();
  });

  it('abandons a navigation superseded while its loaders ran (275)', async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const router = makeRouter(() => {
      calls++;
      if (calls === 1) return new Promise<string>((resolve) => { release = resolve; });
      return 'fast';
    });
    await router.isReady();

    const first = router.push('/list'); // parks inside the loader
    await flush();
    const second = router.push('/other'); // supersedes it
    release('too-late');

    const firstError = await first;
    await second;
    expect(firstError?.code).toBe('cancelled');
    expect(router.currentRoute.value.location.path).toBe('/other');
    // The superseded navigation's data never commits.
    expect(router.currentRoute.value.data.get('list')).toBeUndefined();
    router.destroy();
  });
});

describe('hook unsubscribe', () => {
  it('is idempotent for beforeEach and afterEach (468, 475)', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    const guard = vi.fn(() => true);
    const hook = vi.fn();
    const offGuard = router.beforeEach(guard);
    const offHook = router.afterEach(hook);

    offGuard();
    offGuard(); // second call finds nothing to splice
    offHook();
    offHook();

    await router.push('/list');
    expect(guard).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    router.destroy();
  });
});

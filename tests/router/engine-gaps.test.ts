// @vitest-environment happy-dom
/**
 * Async and edge lanes of the router engine: background revalidation, query-only refetch, location resolution, supersession.
 * Why: a background refresh or refetch that outlives or loses to a navigation would patch stale data into the new page
 * or report a spurious error, and a superseded navigation would commit. Also the only file reaching the query-only
 * refetch's failure and supersede arms, null query values and setRouteData's dev warning, so the 100% floor needs it.
 * Shows: a refresh patches only while on the same route and a rejected one keeps stale data and never reaches onError;
 * a query-only refetch patches, reports a failure through onError, and is dropped when superseded or cancelled;
 * query and hash are split, array values stringified, null and undefined dropped; setRouteData warns in dev only;
 * a superseded navigation returns router:aborted:navigation; non-router throws are coded.
 * See: log s35.108, s35.118
 */
import { describe, expect, it, vi } from 'vitest';
import type { RouteRecord } from '@router/types';
import { routerError } from '@router/errors';
import { createMemoryHistory } from '@router/history';
import { createEngine } from '@router/engine';
import { createRouteTable } from '@router/table';
import { stubEnv } from '../../src/vitest-pure';
import { makeRouter as fixtureRouter } from './fixture';

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
  // A third destination: superseding a parked navigation needs a target other than the current location, or the duplicate check short-circuits.
  { name: 'other', path: '/other', parent: 'shell', component: 'Home' },
];

/** Router wired to a single `rows:` prefix handler - the loader under test. */
function makeRouter(handler: (...args: any[]) => unknown, opts: Record<string, unknown> = {}) {
  return fixtureRouter({
    routes: ROWS,
    loaders: { prefixes: { 'rows:': handler as any } },
    ...opts,
  });
}

/** Settle timers + microtasks so background .then/.catch chains run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

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
    router.dispose();
  });

  it('drops a refresh that lands after the user navigated away', async () => {
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      return 'stale-value';
    });
    await router.isReady();
    await router.push('/list');

    let land!: (v: unknown) => void;
    report(new Promise((resolve) => { land = resolve; }));
    await router.push('/');
    land('fresh-value');
    await flush();

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(router.currentRoute.value.data.get('list')).toBeUndefined();
    expect(router.isRevalidating.value).toBe(false);
    router.dispose();
  });

  it('keeps stale data and never reports an error when the refresh rejects', async () => {
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
    failing.catch(() => {}); // keeps the test's own copy from an unhandled rejection
    report(failing);
    await flush();

    expect(router.currentRoute.value.data.get('list')).toBe('stale-value');
    expect(onError).not.toHaveBeenCalled();
    expect(router.lastError.value).toBeNull();
    expect(router.isRevalidating.value).toBe(false);
    router.dispose();
  });
});

describe('query-only refetch', () => {
  it('patches refetched data without a full navigation', async () => {
    let calls = 0;
    const router = makeRouter(() => `data-${++calls}`);
    await router.isReady();
    await router.push('/list?page=1');
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');

    await router.push('/list?page=2');
    await flush();

    // location.query holds raw strings; typed decoding happens at read time.
    expect(router.currentRoute.value.location.query.page).toBe('2');
    expect(router.currentRoute.value.data.get('list')).toBe('data-2');
    router.dispose();
  });

  it('reports a rejecting refetch through onError while keeping stale data', async () => {
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
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');
    router.dispose();
  });

  it('drops a refetch superseded by a later navigation', async () => {
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
    await router.push('/');
    release('too-late');
    await flush();

    expect(router.currentRoute.value.location.path).toBe('/');
    expect(onError).not.toHaveBeenCalled();
    router.dispose();
  });
});

describe('location resolution', () => {
  it('splits a string target carrying both query and hash', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push('/list?tag=blue#section-2');
    const loc = router.currentRoute.value.location;
    expect(loc.path).toBe('/list');
    expect(loc.query.tag).toBe('blue');
    expect(loc.hash).toBe('#section-2');
    router.dispose();
  });

  it('treats a query-only string target as the ROOT path, not an empty one', async () => {
    // A bare '?x=y' has an empty path, which would match nothing.
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push('?tag=blue');
    const loc = router.currentRoute.value.location;
    expect(loc.path).toBe('/');
    expect(loc.name).toBe('home');
    expect(loc.query.tag).toBe('blue');
    router.dispose();
  });

  it('stringifies each element of an ARRAY query value', async () => {
    // Repeated query keys (?tag=a&tag=b) are the shape parseQuery produces, so a patch must round-trip one.
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push({ path: '/list', query: { tag: ['red', 'blue', 7] } as any });
    const { query } = router.currentRoute.value.location;
    expect(query.tag).toEqual(['red', 'blue', '7']);
    router.dispose();
  });

  it('drops null and undefined values from a query patch', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    await router.push({ path: '/list', query: { tag: 'red', page: null, missing: undefined } as any });
    const { query } = router.currentRoute.value.location;
    expect(query.tag).toBe('red');
    expect(query.missing).toBeUndefined();
    // A declared default is applied when the value is read, so nothing is stored for `page`.
    expect(query.page).toBeUndefined();
    expect(Object.keys(query)).toEqual(['tag']);
    router.dispose();
  });
});

describe('setRouteData', () => {
  it('warns in dev when the record name is not in the table', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = makeRouter(() => 'x');
    await router.isReady();
    await router.push('/list');

    router.setRouteData('lsit', { typo: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('no route record by that name');
    expect(router.currentRoute.value.data.get('lsit')).toEqual({ typo: true });
    router.dispose();
  });

  it('does not warn for a real record name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = makeRouter(() => 'x');
    await router.isReady();
    await router.push('/list');

    router.setRouteData('list', 'pushed');
    expect(warn).not.toHaveBeenCalled();
    expect(router.currentRoute.value.data.get('list')).toBe('pushed');
    router.dispose();
  });

  it('skips the table lookup entirely in production (DEV=false)', async () => {
    // In production an unknown name warns nothing and still stores the value.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { createRouter: prodCreateRouter } = await import('@router/index');
    const { createMemoryHistory: prodMemoryHistory } = await import('@router/history');

    const router = prodCreateRouter({
      history: prodMemoryHistory('/'),
      routes: ROWS,
      components: { Home: { name: 'Home' }, List: { name: 'List' } },
      loaders: { prefixes: { 'rows:': (() => 'x') as any } },
    });
    await router.isReady();
    await router.push('/list');

    router.setRouteData('lsit', { typo: true });
    expect(warn).not.toHaveBeenCalled();
    expect(router.currentRoute.value.data.get('lsit')).toEqual({ typo: true });

    router.dispose();
    vi.resetModules();
  });
});

describe('query-only navigation', () => {
  it('honours replace vs push on a query-only change', async () => {
    // The difference shows only in history depth, not in the location.
    const router = makeRouter(() => 'x');
    await router.isReady();
    await router.push('/list');

    await router.push({ path: '/list', query: { tag: 'red' } });
    expect(router.currentRoute.value.location.query.tag).toBe('red');

    await router.replace({ path: '/list', query: { tag: 'blue' } });
    expect(router.currentRoute.value.location.query.tag).toBe('blue');

    // 'blue' overwrote 'red', so Back lands on the entry before 'red'.
    router.back();
    await flush();
    expect(router.currentRoute.value.location.query.tag).toBeUndefined();

    router.dispose();
  });
});

describe('supersession', () => {
  it('abandons a navigation superseded while a guard was awaiting', async () => {
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
    const second = router.push('/other');
    releaseGuard();

    const firstError = await first;
    await second;
    expect(firstError?.code).toBe('router:aborted:navigation');
    expect(router.currentRoute.value.location.path).toBe('/other');
    router.dispose();
  });

  it('abandons a navigation superseded while its loaders ran', async () => {
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
    const second = router.push('/other');
    release('too-late');

    const firstError = await first;
    await second;
    expect(firstError?.code).toBe('router:aborted:navigation');
    expect(router.currentRoute.value.location.path).toBe('/other');
    expect(router.currentRoute.value.data.get('list')).toBeUndefined();
    router.dispose();
  });
});

describe('hook unsubscribe', () => {
  it('is idempotent for beforeEach and afterEach', async () => {
    const router = makeRouter(() => 'x');
    await router.isReady();

    const guard = vi.fn(() => true);
    const hook = vi.fn();
    const offGuard = router.beforeEach(guard);
    const offHook = router.afterEach(hook);

    offGuard();
    offGuard();
    offHook();
    offHook();

    await router.push('/list');
    expect(guard).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    router.dispose();
  });
});

describe('refetchAffected - stale guards', () => {
  // A navigation aborts the refetch, which returns at the aborted check. Reaching the fullPath check needs the location to
  // move without aborting: a second query-only change whose keys affect no loader returns before the abort.
  it('discards a refetch whose location moved on beneath it', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const router = fixtureRouter({
      routes: ROWS,
      loaders: {
        prefixes: {
          'rows:': () => {
            calls++;
            if (calls === 1) return 'data-1';
            return new Promise<string>((resolve) => { release = resolve; });
          },
        },
        // Only `page` drives a refetch; `tag` affects nothing.
        affects: (_record: any, keys: readonly string[]) => keys.includes('page'),
      } as any,
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();

    await router.push('/list?page=1');
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');

    await router.push('/list?page=2'); // starts the slow refetch
    await router.push('/list?page=2&tag=x'); // affects no loader, so the refetch is not aborted

    release('too-late');
    await flush();

    // Still on the newer URL, and the stale payload never patched in.
    expect(router.currentRoute.value.location.fullPath).toBe('/list?page=2&tag=x');
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');
    expect(onError).not.toHaveBeenCalled();
    router.dispose();
  });

  it('stays silent when a refetch rejects as cancelled', async () => {
    // A cancelled loader is an expected outcome of superseding; reporting it would surface a spurious useRouteError.
    let calls = 0;
    const router = makeRouter(() => {
      calls++;
      if (calls === 1) return 'data-1';
      throw routerError('aborted:navigation', 'superseded by a newer refetch');
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();

    await router.push('/list?page=1');
    await router.push('/list?page=2');
    await flush();

    expect(calls).toBeGreaterThan(1);
    expect(onError).not.toHaveBeenCalled();
    expect(router.currentRoute.value.data.get('list')).toBe('data-1');
    router.dispose();
  });
});

describe('navigation error wrapping', () => {
  it('wraps a NON-router error as router:failed:component', async () => {
    // A plain Error from a component chunk is wrapped; coded router errors pass through untouched.
    const router = fixtureRouter({
      routes: ROWS,
      components: {
        Home: { name: 'Home' },
        List: async () => { throw new Error('Failed to fetch dynamically imported module'); },
      },
      loaders: { prefixes: { 'rows:': () => 'x' } },
    });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();

    await router.push('/list').catch(() => {});

    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls[0]![0] as { code?: string; cause?: unknown };
    expect(err.code).toBe('router:failed:component');
    expect(String((err.cause as Error)?.message)).toMatch(/dynamically imported module/);
    router.dispose();
  });
});

describe('navigation error wrapping - uncoded errors', () => {
  it('codes a plain Error thrown by a beforeEach guard as router:failed:guard', async () => {
    // A guard throw is an app bug, not a hard-navigation code: coding it failed:component would reload the page.
    const router = makeRouter(() => 'x');
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();

    router.beforeEach(() => {
      throw new Error('auth service unreachable');
    });

    await router.push('/list').catch(() => {});

    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls[0]![0] as { code?: string; cause?: unknown };
    expect(err.code).toBe('router:failed:guard');
    expect(String((err.cause as Error)?.message)).toBe('auth service unreachable');
    expect(router.currentRoute.value.location.path).toBe('/');

    router.dispose();
  });
  it('a context that breaks its contract (a plain throw from resolveRender) is still coded, as failed:component', async () => {
    // EngineContext.resolveRender should throw coded RouterErrors; the catch-all codes a context that does not.
    const table = createRouteTable(ROWS);
    const onError = vi.fn();
    const engine = createEngine({
      getTable: () => table,
      history: createMemoryHistory('/'),
      resolveRender: async () => { throw new Error('render bug'); },
      runLoaders: async () => new Map(),
      loadAffectedBy: () => [],
      onError,
    });
    const result = await engine.navigate('/list');
    expect(result?.code).toBe('router:failed:component');
    expect(((result as Error).cause as Error).message).toBe('render bug');
    expect(onError).toHaveBeenCalledWith(result, expect.anything());
  });

  it('a throw from a supplied history is router:failed:history, its throw the cause (log s35.118)', async () => {
    // The browser history catches its own throws, so only a supplied history throws here.
    const history = createMemoryHistory('/');
    const router = makeRouter(() => 'x', { history: { ...history, push: () => { throw new Error('history full'); } } });
    const onError = vi.fn();
    router.onError(onError);
    await router.isReady();

    await router.push('/list');

    const err = onError.mock.calls[0]![0] as { code?: string; cause?: unknown };
    expect(err.code).toBe('router:failed:history');
    expect((err.cause as Error).message).toBe('history full');
    router.dispose();
  });
});

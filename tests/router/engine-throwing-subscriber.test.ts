// @vitest-environment happy-dom
/**
 * FIXTURE - a synchronous subscriber that THROWS on one of the router's three
 * signals must not turn a committed navigation into a failed one, or leave
 * `isLoading` / `isRevalidating` stuck on true. Real Vue `effect`s on a real
 * router. The long note is at the end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effect, isRef } from 'vue';
import type { RouteRecord } from '@router/types';
import { makeRouter as fixtureRouter } from './fixture';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List', load: 'rows:list', query: { page: { type: 'int', default: 1 } } },
];

function makeRouter(handler: (...args: any[]) => unknown) {
  return fixtureRouter({ routes: ROWS, loaders: { prefixes: { 'rows:': handler as any } } });
}

const boom = new Error('subscriber threw');
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Run something that may throw or reject; keep what it gave and what escaped. */
async function attempt(run: () => unknown): Promise<{ value: unknown; escaped: unknown }> {
  try {
    return { value: await run(), escaped: undefined };
  } catch (e) {
    return { value: undefined, escaped: e };
  }
}

describe('router engine: a throwing sync subscriber', () => {
  afterEach(() => vi.restoreAllMocks());

  it('on `currentRoute`: a committed push resolves null, afterEach runs, nothing reaches onError', async () => {
    const router = makeRouter(() => 'rows');
    await router.isReady();
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(router.currentRoute)).toBe(true);
    const errors: unknown[] = [];
    router.onError((e) => errors.push(e));
    let after = 0;
    router.afterEach(() => {
      after++;
    });
    let threw = 0;
    const runner = effect(() => {
      if (router.currentRoute.value.location.path === '/list') {
        threw++;
        throw boom;
      }
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { value, escaped } = await attempt(() => router.push('/list'));

    // Control: the subscriber ran on the commit and threw.
    expect(threw).toBe(1);
    expect({ value, escaped }).toEqual({ value: null, escaped: undefined });
    expect(router.currentRoute.value.location.path).toBe('/list');
    expect({ after, errors, lastError: router.lastError.value }).toEqual({ after: 1, errors: [], lastError: null });
    // The subscriber's error is not swallowed: it is logged once.
    expect(logged.mock.calls.map((c) => c[1])).toEqual([boom]);
    runner.effect.stop();
    router.dispose();
  });

  it('on `isLoading`, query-only refetch: the loaders still run and the flag ends false', async () => {
    let calls = 0;
    const router = makeRouter(() => `data-${++calls}`);
    await router.isReady();
    await router.push('/list?page=1');
    let threw = 0;
    let armed = false;
    const runner = effect(() => {
      if (router.isLoading.value && armed) {
        threw++;
        throw boom;
      }
    });
    armed = true;

    const { escaped } = await attempt(() => router.push('/list?page=2'));
    await flush();

    expect(threw).toBe(1);
    // Unchanged: the caller of the query-only push still gets the subscriber's error.
    expect(escaped).toBe(boom);
    expect(router.currentRoute.value.location.query.page).toBe('2');
    expect({ isLoading: router.isLoading.value, calls, data: router.currentRoute.value.data.get('list') }).toEqual({
      isLoading: false,
      calls: 2,
      data: 'data-2',
    });
    runner.effect.stop();
    router.dispose();
  });

  it('on `isRevalidating`: the refresh still lands and the flag ends false', async () => {
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      return 'stale-value';
    });
    await router.isReady();
    await router.push('/list');
    let threw = 0;
    const runner = effect(() => {
      if (router.isRevalidating.value) {
        threw++;
        throw boom;
      }
    });

    const { escaped } = await attempt(() => report(Promise.resolve('fresh-value')));
    await flush();

    expect(threw).toBe(1);
    // Unchanged: whoever reports the refresh still gets the subscriber's error.
    expect(escaped).toBe(boom);
    expect({ isRevalidating: router.isRevalidating.value, data: router.currentRoute.value.data.get('list') }).toEqual({
      isRevalidating: false,
      data: 'fresh-value',
    });
    runner.effect.stop();
    router.dispose();
  });

  it('control, no throwing subscriber: what subscribers, hooks and loaders see, in order, is unchanged', async () => {
    const events: string[] = [];
    let calls = 0;
    let report!: (fresh: Promise<unknown>) => void;
    const router = makeRouter((_ref, _loc, _rec, _sig, ctx) => {
      report = ctx.revalidate;
      events.push('loader');
      return `data-${++calls}`;
    });
    await router.isReady();
    router.afterEach((to) => void events.push(`afterEach:${to.fullPath}`));
    const runners = [
      effect(() => {
        const s = router.currentRoute.value;
        events.push(`route:${s.location.fullPath}:${String(s.data.get('list'))}`);
      }),
      effect(() => void events.push(`isLoading:${router.isLoading.value}`)),
      effect(() => void events.push(`isRevalidating:${router.isRevalidating.value}`)),
    ];
    events.length = 0;

    expect(await router.push('/list')).toBeNull();
    await flush();
    expect(events).toEqual(['isLoading:true', 'loader', 'route:/list:data-1', 'afterEach:/list', 'isLoading:false']);
    events.length = 0;

    expect(await router.push('/list?page=2')).toBeNull();
    await flush();
    expect(events).toEqual(['route:/list?page=2:data-1', 'isLoading:true', 'loader', 'route:/list?page=2:data-2', 'isLoading:false']);
    events.length = 0;

    report(Promise.resolve('fresh'));
    await flush();
    expect(events).toEqual(['isRevalidating:true', 'route:/list?page=2:fresh', 'isRevalidating:false']);
    for (const r of runners) r.effect.stop();
    router.dispose();
  });
});

/*
 * Why this file exists. Found by reading `router/engine.ts` against Vue
 * `ef5ff106` (log s35.18), run and fixed in s35.23: the shape `runDispatch`
 * had. A Vue effect runs inside the write that triggers it, so a subscriber
 * that throws there throws out of the write and skips what follows it.
 *
 * The commit. `snapshot.value = next` stood one line above `committed = true`.
 * The subscriber's throw was therefore caught as a PRE-commit failure: the
 * push resolved `component_load_failed`, `onError` fired, `afterEach` did not
 * run, and yet the URL had moved and the snapshot was the new page. The flag
 * is now set before the write, and the write sits in a `try` whose `finally`
 * runs `onCommit` and the after-hooks; the error then reaches the engine's
 * own post-commit branch, which logs it and resolves null.
 *
 * The two background lanes. `refetchAffected` and `trackRevalidation` each
 * raised their flag and wrote the signal BEFORE starting the promise chain
 * whose `finally` lowers it. A throw on that write meant the chain was never
 * built: the flag stayed true for the life of the router, the refetch never
 * ran, the fresh value never landed. Each write is now in a `try` whose
 * `finally` builds the chain. The caller still gets the subscriber's error,
 * as before; the second and third tests pin that too.
 *
 * The last test is the control for all three moves: the order of subscriber
 * runs, loader calls and `afterEach` over a path navigation, a query-only
 * change and a reported refresh. The lists are the ones this test produced
 * before the move.
 */

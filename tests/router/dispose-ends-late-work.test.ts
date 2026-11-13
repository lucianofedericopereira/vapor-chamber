/**
 * router.dispose() ends what the router was still waiting on: a background refresh does not land, and a late failure reaches no one.
 * Why: a refresh a loader reported through `ctx.revalidate` and resolved after dispose() patched `currentRoute` and left `isRevalidating` true for good; a remote route table rejecting after dispose() called the app's `onError` subscribers (and could hard-navigate the page) for a router nobody holds.
 * Shows: after dispose(), the late refresh writes no snapshot and `isRevalidating` is false at once; a refresh reported after dispose() is dropped and its rejection handled; a late table failure reaches no `onError` subscriber, no `options.onError` and no `lastError`; controls: without dispose() the refresh lands and the failure is reported.
 * See: log 36.F58 (probe #12), dispose-cancels-navigation.test.ts, dispose-during-start.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { watch } from 'vue';
import { createMemoryHistory } from '@router/history';
import { createRouter, type LoaderHandlers } from '@router/index';
import type { RouteRecord } from '@router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home', load: 'rows:home' },
];
const COMPONENTS = { Home: { name: 'Home' } };
const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A loader that serves stale data and reports `fresh` as its background refresh. */
function swrRouter(fresh: () => Promise<unknown>) {
  const loaders: LoaderHandlers = {
    prefixes: {
      'rows:': (_ref, _loc, _rec, _signal, ctx) => {
        ctx.revalidate(fresh());
        return { v: 'stale' };
      },
    },
  };
  return createRouter({
    history: createMemoryHistory('/'),
    routes: ROWS,
    components: COMPONENTS,
    loaders,
    links: false,
    scroll: false,
    announce: false,
  });
}

/** A router whose table comes from `get`, the app's own client (`http`). */
function remoteRouter(get: () => Promise<unknown>, onError?: (e: unknown) => void) {
  return createRouter({
    history: createMemoryHistory('/'),
    routes: { url: '/routes' },
    components: COMPONENTS,
    http: { get, onInvalidateGroup: () => () => {} } as never,
    links: false,
    scroll: false,
    announce: false,
    onError,
  });
}

describe('a background refresh after dispose()', () => {
  it('control: not disposed, the refresh lands and isRevalidating clears', async () => {
    const d = deferred<unknown>();
    const router = swrRouter(() => d.promise);
    await router.start();
    expect(router.isRevalidating.value).toBe(true);
    d.resolve({ v: 'fresh' });
    await settle();
    expect(router.currentRoute.value.data.get('home')).toEqual({ v: 'fresh' });
    expect(router.isRevalidating.value).toBe(false);
    router.dispose();
  });

  it('does not patch currentRoute, and isRevalidating is false at dispose()', async () => {
    const d = deferred<unknown>();
    const router = swrRouter(() => d.promise);
    await router.start();
    const before = router.currentRoute.value;
    let writes = 0;
    watch(router.currentRoute, () => { writes++; }, { flush: 'sync' });
    router.dispose();
    expect(router.isRevalidating.value).toBe(false);
    d.resolve({ v: 'fresh' });
    await settle();
    expect(writes).toBe(0);
    expect(router.currentRoute.value).toBe(before);
    expect(router.isRevalidating.value).toBe(false);
  });

  it('a refresh that rejects after dispose() is handled and changes nothing', async () => {
    const d = deferred<unknown>();
    const router = swrRouter(() => d.promise);
    await router.start();
    const before = router.currentRoute.value;
    router.dispose();
    d.reject(new Error('offline'));
    await settle();
    expect(router.currentRoute.value).toBe(before);
    expect(router.isRevalidating.value).toBe(false);
  });

  it('a refresh reported after dispose() is dropped, its rejection handled', async () => {
    // The loader runs again on a navigation started before dispose(); one that
    // ignores its signal reports a refresh after it.
    let report!: (p: Promise<unknown>) => void;
    const loaders: LoaderHandlers = {
      prefixes: {
        'rows:': (_ref, _loc, _rec, _signal, ctx) => {
          report = (p) => ctx.revalidate(p);
          return { v: 'stale' };
        },
      },
    };
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: ROWS,
      components: COMPONENTS,
      loaders,
      links: false,
      scroll: false,
      announce: false,
    });
    await router.start();
    const before = router.currentRoute.value;
    router.dispose();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      report(Promise.reject(new Error('late')));
      report(Promise.resolve({ v: 'fresh' }));
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(router.currentRoute.value).toBe(before);
    expect(router.isRevalidating.value).toBe(false);
  });
});

describe('a failure after dispose()', () => {
  it('control: not disposed, a rejected remote table reaches subscribers, options.onError and lastError', async () => {
    const d = deferred<unknown>();
    const own = vi.fn();
    const router = remoteRouter(() => d.promise, own);
    const calls: unknown[] = [];
    router.onError((e) => calls.push(e));
    const starting = router.start().catch(() => {});
    d.reject(new Error('network down'));
    await starting;
    await settle();
    expect(calls.length).toBe(1);
    expect(own).toHaveBeenCalledTimes(1);
    expect(router.lastError.value).toBe(calls[0]);
    router.dispose();
  });

  it('a remote table rejecting after dispose() reaches no one', async () => {
    const d = deferred<unknown>();
    const own = vi.fn();
    const router = remoteRouter(() => d.promise, own);
    const calls: unknown[] = [];
    router.onError((e) => calls.push(e));
    const starting = router.start().catch(() => {});
    router.dispose();
    d.reject(new Error('network down'));
    await starting;
    await settle();
    expect(calls).toEqual([]);
    expect(own).not.toHaveBeenCalled();
    expect(router.lastError.value).toBeNull();
  });
});

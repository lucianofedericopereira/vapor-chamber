/**
 * vapor-chamber-router - navigation facts on a bus.
 *
 * Structural on both sides: the router entry imports no bus, and the bus
 * knows no router. An app that never calls `routerFacts` ships none of it.
 */

import { getCurrentScope, onScopeDispose, watch } from 'vue';
import type { Router } from './router-type';
import type { RouteLocation } from './types';

/** What `routerFacts` emits to: a command bus, or anything with its `emit`. */
export type FactSink = { emit(event: string, data?: unknown): void };

/** The data of `routerNavigated`. */
export type RouterNavigatedFact = { to: RouteLocation; from: RouteLocation };
/** The data of `routerFailed`: the error the router's `onError` received. */
export type RouterFailedFact = { error: unknown; to: RouteLocation };
/** The data of `routerLoading` and `routerRevalidating`: the router's flag, as it changed. */
export type RouterFlagFact = { value: boolean };

/**
 * routerFacts - emit a fact on `bus` after each navigation commits or fails,
 * and each time the router starts or stops loading or revalidating.
 *
 * `routerNavigated` ({@link RouterNavigatedFact}) follows a committed path
 * navigation, as `afterEach` does: a query-only change emits nothing.
 * `routerFailed` ({@link RouterFailedFact}) follows a failure the router
 * reports to `onError`. A guard refusal and a superseded navigation are
 * answers, not failures, so they emit nothing.
 * `routerLoading` and `routerRevalidating` ({@link RouterFlagFact}) follow
 * `router.isLoading` and `router.isRevalidating` as they change: a page
 * outside the router's island shows the navigation loading from the bus,
 * with no router import (`bindDisplay`'s `data-vc-router`).
 *
 * It emits, never dispatches: a navigation's gate stays the router's guards,
 * and no plugin runs. Bus listeners hear the facts (`bus.on('router*')`),
 * and so does DevTools given `facts: ['router*']`.
 *
 * @returns Stops every subscription. Inside a Vue scope they also stop with it.
 *
 * @example
 * const stop = routerFacts(router, bus);
 * bus.on('routerNavigated', (cmd) => track(cmd.target.to.fullPath));
 */
export function routerFacts(router: Pick<Router, 'afterEach' | 'onError' | 'isLoading' | 'isRevalidating'>, bus: FactSink): () => void {
  const offNavigated = router.afterEach((to, from) => bus.emit('routerNavigated', { to, from } satisfies RouterNavigatedFact));
  const offFailed = router.onError((error, to) => bus.emit('routerFailed', { error, to } satisfies RouterFailedFact));
  // Synchronous, so a fact goes out as the flag moves, in order.
  const offLoading = watch(router.isLoading, (value) => bus.emit('routerLoading', { value } satisfies RouterFlagFact), { flush: 'sync' });
  const offRevalidating = watch(router.isRevalidating, (value) => bus.emit('routerRevalidating', { value } satisfies RouterFlagFact), { flush: 'sync' });
  const stop = (): void => {
    offNavigated();
    offFailed();
    offLoading();
    offRevalidating();
  };
  // All four, after they are made: Vue 3.6.0-rc.15 runs a cleanup armed in a
  // stopped scope at once (#16108), while a watch created there stays live, so
  // without this an async setup resumed after its unmount kept the loading
  // facts going. Each off is idempotent. tests/router/router-facts.test.ts.
  if (getCurrentScope()) onScopeDispose(stop);
  return stop;
}

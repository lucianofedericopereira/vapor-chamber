/**
 * vapor-chamber-router - navigation facts on a bus.
 *
 * Structural on both sides: the router entry imports no bus, and the bus
 * knows no router. An app that never calls `routerFacts` ships none of it.
 */

import type { Router } from './router-type';
import type { RouteLocation } from './types';

/** What `routerFacts` emits to: a command bus, or anything with its `emit`. */
export type FactSink = { emit(event: string, data?: unknown): void };

/** The data of `routerNavigated`. */
export type RouterNavigatedFact = { to: RouteLocation; from: RouteLocation };
/** The data of `routerFailed`: the error the router's `onError` received. */
export type RouterFailedFact = { error: unknown; to: RouteLocation };

/**
 * routerFacts - emit a fact on `bus` after each navigation commits or fails.
 *
 * `routerNavigated` ({@link RouterNavigatedFact}) follows a committed path
 * navigation, as `afterEach` does: a query-only change emits nothing.
 * `routerFailed` ({@link RouterFailedFact}) follows a failure the router
 * reports to `onError`. A guard refusal and a superseded navigation are
 * answers, not failures, so they emit nothing.
 *
 * It emits, never dispatches: a navigation's gate stays the router's guards,
 * and no plugin runs. Bus listeners hear the facts (`bus.on('router*')`),
 * and so does DevTools given `facts: ['router*']`.
 *
 * @returns Stops both subscriptions. Inside a Vue scope they also stop with it.
 *
 * @example
 * const stop = routerFacts(router, bus);
 * bus.on('routerNavigated', (cmd) => track(cmd.target.to.fullPath));
 */
export function routerFacts(router: Pick<Router, 'afterEach' | 'onError'>, bus: FactSink): () => void {
  const offNavigated = router.afterEach((to, from) => bus.emit('routerNavigated', { to, from } satisfies RouterNavigatedFact));
  const offFailed = router.onError((error, to) => bus.emit('routerFailed', { error, to } satisfies RouterFailedFact));
  return () => {
    offNavigated();
    offFailed();
  };
}

/**
 * vapor-chamber - Observable adapter.
 *
 * Bridges `bus.on(pattern)` and `bus.dispatch()` into the Observable
 * protocol so RxJS / consumers using `Symbol.observable` can pipe bus
 * events through their own operator chains. Zero RxJS dependency - uses
 * the interop RxJS's `from()` reads: `Symbol.observable`, or the
 * `'@@observable'` key on a runtime without it.
 *
 * @example RxJS interop
 * import { from } from 'rxjs';
 * import { filter, debounceTime } from 'rxjs/operators';
 * import { observe } from 'vapor-chamber/observable';
 *
 * const bus = createCommandBus();
 *
 * from(observe(bus, 'cart*'))
 *   .pipe(
 *     filter(({ cmd, result }) => result.ok),
 *     debounceTime(200),
 *   )
 *   .subscribe(({ cmd }) => console.log('debounced cart event:', cmd.action));
 */

import type { BaseBus, Command, CommandResult } from './command-bus';

/**
 * The shape an observable produces - matches the listener signature of
 * `bus.on(pattern, (cmd, result) => ...)` packed into a single value so
 * RxJS-shaped operators can `.pipe(filter(...))` etc.
 */
export type BusObservation = { cmd: Command; result: CommandResult };

/**
 * Minimal observer / observable protocol - matches TC39 Observable proposal
 * + `Symbol.observable` interop used by RxJS, xstream, callbag, kefir.
 */
export interface Observer<T> {
  next?(value: T): void;
  error?(err: any): void;
  complete?(): void;
}

export interface Subscription {
  unsubscribe(): void;
  readonly closed: boolean;
}

export interface Observable<T> {
  subscribe(observer: Observer<T> | ((value: T) => void)): Subscription;
  /** Symbol.observable interop - RxJS's `from()` calls this if present. */
  [Symbol.observable]?: () => Observable<T>;
  /** The same, under the key RxJS and Redux read when the runtime has no `Symbol.observable`. */
  '@@observable'?: () => Observable<T>;
}

/**
 * What `observe()` returns: both interop members present, so
 * `from(observe(...))` type-checks against RxJS (tests/observable.test.ts
 * runs under tsconfig.tests.json). `Observable` keeps them optional: RxJS's
 * own Observable has the method at runtime but not in its d.ts, and
 * `dispatchFrom()` takes it.
 */
type InteropObservable<T> = Observable<T> & {
  [Symbol.observable](): Observable<T>;
  '@@observable'(): Observable<T>;
};

// `Symbol.observable` is in stage-1; not on every runtime's lib.dom.d.ts.
// Use the well-known polyfill pattern.
declare global {
  interface SymbolConstructor {
    readonly observable: symbol;
  }
}
// Typed as the symbol it stands in for, so a literal keyed on it has
// `[Symbol.observable]` (InteropObservable).
const observableSymbol: typeof Symbol.observable =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (typeof Symbol === 'function' && (Symbol as any).observable) ||
  Symbol.for('@@observable');

/**
 * Observe bus events matching a pattern. Returns an Observable of
 * `{ cmd, result }`. Each subscribe creates an independent listener.
 *
 * @example
 * const obs = observe(bus, 'cartAdd');
 * const sub = obs.subscribe(({ cmd, result }) => {
 *   if (result.ok) console.log('added', cmd.target);
 * });
 * // later
 * sub.unsubscribe();
 */
export function observe(bus: BaseBus, pattern: string): InteropObservable<BusObservation> {
  const obs: InteropObservable<BusObservation> = {
    subscribe(observer): Subscription {
      const next = typeof observer === 'function' ? observer : observer.next?.bind(observer);
      const off = bus.on(pattern, (cmd, result) => {
        next?.({ cmd, result });
      });
      let closed = false;
      return {
        unsubscribe() {
          if (closed) return;
          closed = true;
          off();
        },
        get closed() { return closed; },
      };
    },
    [observableSymbol](): Observable<BusObservation> { return obs; },
    // No runtime ships `Symbol.observable` (Node, browsers), and RxJS then
    // reads the string key, not the registered symbol above
    // (tests/observable.test.ts, real RxJS).
    '@@observable'(): Observable<BusObservation> { return obs; },
  };
  return obs;
}

/**
 * Inverse direction: convert an Observable into a bus dispatch stream.
 * Each value emitted by the source is dispatched as the given action.
 * Useful for piping RxJS operator output back into the bus.
 *
 * Returns the Subscription so you can unsubscribe; the bus dispatch is
 * fire-and-forget per emitted value.
 *
 * "Fire-and-forget" means the RESULT is not awaited, not that a failure is
 * dropped on the floor. On an async bus `dispatch` returns a promise, and
 * discarding it would leave a rejection with no handler - an unhandled
 * rejection, which Node terminates the process over by default (one emitted
 * value into a bus with `onMissing: 'throw'` does exactly that). A rejected
 * dispatch is reported on the same `<action>:error` channel the source's
 * own errors use, so it is observable rather than either fatal or silent.
 *
 * @example
 * import { interval } from 'rxjs';
 * import { dispatchFrom } from 'vapor-chamber/observable';
 *
 * dispatchFrom(bus, 'tick', interval(1000)); // tick every 1s
 * bus.on('tick:error', (cmd) => console.error('tick failed', cmd.target));
 */
export function dispatchFrom<T>(
  bus: BaseBus,
  action: string,
  source: Observable<T>,
): Subscription {
  return source.subscribe({
    next(value) {
      const result = bus.dispatch(action, value as any);
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        (result as Promise<unknown>).catch((err) => { bus.emit(`${action}:error`, err); });
      }
    },
    error(err) { bus.emit(`${action}:error`, err); },
    complete() { bus.emit(`${action}:complete`, undefined); },
  });
}

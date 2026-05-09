/**
 * vapor-chamber — Observable adapter.
 *
 * Bridges `bus.on(pattern)` and `bus.dispatch()` into the Observable
 * protocol so RxJS / consumers using `Symbol.observable` can pipe bus
 * events through their own operator chains. Zero RxJS dependency — uses
 * `Symbol.observable` interop, which RxJS reads natively via `from()`.
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
 * The shape an observable produces — matches the listener signature of
 * `bus.on(pattern, (cmd, result) => ...)` packed into a single value so
 * RxJS-shaped operators can `.pipe(filter(...))` etc.
 */
export type BusObservation = { cmd: Command; result: CommandResult };

/**
 * Minimal observer / observable protocol — matches TC39 Observable proposal
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
  /** Symbol.observable interop — RxJS's `from()` calls this if present. */
  [Symbol.observable]?: () => Observable<T>;
}

// `Symbol.observable` is in stage-1; not on every runtime's lib.dom.d.ts.
// Use the well-known polyfill pattern.
declare global {
  interface SymbolConstructor {
    readonly observable: symbol;
  }
}
const observableSymbol: symbol =
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
export function observe(bus: BaseBus, pattern: string): Observable<BusObservation> {
  const obs: Observable<BusObservation> = {
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
 * @example
 * import { interval } from 'rxjs';
 * import { dispatchFrom } from 'vapor-chamber/observable';
 *
 * dispatchFrom(bus, 'tick', interval(1000));   // tick every 1s
 */
export function dispatchFrom<T>(
  bus: BaseBus,
  action: string,
  source: Observable<T>,
): Subscription {
  return source.subscribe({
    next(value) { bus.dispatch(action, value as any); },
    error(err) { bus.emit(`${action}:error`, err); },
    complete() { bus.emit(`${action}:complete`, undefined); },
  });
}

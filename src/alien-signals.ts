/**
 * vapor-chamber — alien-signals connector.
 *
 * Bridges [alien-signals](https://github.com/stackblitz/alien-signals)'
 * function-call API to vapor-chamber's `.value`-style `Signal` interface.
 *
 * ## Why this exists
 *
 * Vue 3.6's `ref()` is itself a port of alien-signals' algorithm
 * ([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)) — so when
 * vapor-chamber auto-detects `vue.ref`, you're already on alien-signals
 * under the hood. This connector is for **non-Vue consumers** who want
 * the same fine-grained reactivity:
 *
 *   • SSR / Node services that don't import Vue
 *   • Web Workers / service workers
 *   • Embedded widgets shipping without Vue
 *   • Any context where you want push-pull reactivity but Vue's full
 *     runtime is overkill
 *
 * ## No runtime dep
 *
 * The connector takes alien-signals' `signal` function as an argument
 * rather than importing it. Consumers install `alien-signals` themselves;
 * vapor-chamber stays Vue-agnostic on the runtime side.
 *
 * @example
 * import { signal as alienSignal } from 'alien-signals';
 * import { configureAlienSignals } from 'vapor-chamber/alien-signals';
 *
 * configureAlienSignals(alienSignal);
 *
 * // From this point on, every vapor-chamber signal() call wraps an
 * // alien-signal under the hood. useCommand, useSharedCommandState, the
 * // FormBus signals — all backed by alien-signals' propagation algorithm.
 */

import { configureSignal, type Signal, type CreateSignal } from './signal';

/**
 * The shape alien-signals' `signal` function exposes. Both reading
 * (`s()`) and writing (`s(value)`) go through the same callable.
 *
 * Defined locally so the connector has no `import 'alien-signals'`
 * dependency — consumers feed in the function from their own install.
 */
export type AlienSignalFn = <T>(initial?: T) => {
  /** Read */ (): T;
  /** Write */ (next: T): T;
};

/**
 * Build a `CreateSignal` adapter from alien-signals' `signal` function.
 * The returned function is what `configureSignal()` expects — it produces
 * vapor-chamber-style `{ value }` objects backed by an alien-signal.
 *
 * Use this when you want manual control. For the typical case, prefer
 * {@link configureAlienSignals} which installs the adapter directly.
 *
 * @example
 * import { signal as alienSignal } from 'alien-signals';
 * import { configureSignal } from 'vapor-chamber';
 * import { alienSignalAdapter } from 'vapor-chamber/alien-signals';
 *
 * configureSignal(alienSignalAdapter(alienSignal));
 */
/** Class wrapper gives V8 a stable hidden class across all adapter instances. */
class AlienSignalWrapper<T> {
  private readonly _s: { (): T; (next: T): T };
  constructor(s: { (): T; (next: T): T }) { this._s = s; }
  get value(): T { return this._s(); }
  set value(next: T) { this._s(next); }
}

export function alienSignalAdapter(alienSignal: AlienSignalFn): CreateSignal {
  return <T>(initial: T): Signal<T> => new AlienSignalWrapper<T>(alienSignal<T>(initial));
}

/**
 * Install alien-signals as the underlying reactive primitive for every
 * vapor-chamber signal. Call once at app startup, before any `signal()`,
 * `useCommand()`, `useSharedCommandState()`, or `createFormBus()` call.
 *
 * @example
 * import { signal as alienSignal } from 'alien-signals';
 * import { configureAlienSignals } from 'vapor-chamber/alien-signals';
 *
 * configureAlienSignals(alienSignal);
 *
 * // Now use vapor-chamber composables / signal() normally — they're
 * // backed by alien-signals' push-pull propagation.
 */
export function configureAlienSignals(alienSignal: AlienSignalFn): void {
  configureSignal(alienSignalAdapter(alienSignal));
}

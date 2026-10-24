/**
 * vapor-chamber/reactive - opt-in DEEP reactivity companion.
 *
 * The core wires `signal()` to Vue's `shallowRef()` because the library replaces
 * state values wholesale (`state.value = handler(...)`) and never mutates nested
 * fields in place. Shallow tracking is therefore semantically identical for the
 * command-driven flow while avoiding the deep reactive Proxy (`toReactive()`)
 * that `ref()` wraps around object/array values - measured faster on an array
 * state written per dispatch (tests/signal-shallow-ab; the dated figure is in
 * docs/performance.md).
 *
 * Import THIS module only when you genuinely need nested reactivity - e.g. a
 * state object two-way bound with `v-model` whose fields you mutate in place
 * (`state.value.name = 'x'`) rather than through dispatched commands. That path
 * bypasses the command bus, so reach for it deliberately; for the normal
 * command-driven flow the shallow default is both correct and faster. A store
 * whose nested fields are mutated in place takes `deep: true` on
 * `defineChamberStore` (`vapor-chamber/store`) instead.
 *
 * Nothing here is pulled into the core bundle - it lives behind the
 * `vapor-chamber/reactive` subpath so the default install stays lean.
 *
 * @example
 * import { deepSignal } from 'vapor-chamber/reactive';
 * const form = deepSignal({ email: '', address: { city: '' } });
 * form.value.address.city = 'Lisbon'; // triggers reactivity (deep)
 */

import type { Signal } from './signal';
import { signal as shallowSignal } from './signal';
import { getVueDeepRefFn } from './chamber';

/**
 * deepSignal - a deeply-reactive `Signal<T>` backed by Vue's `ref()`.
 *
 * Unlike the core `signal()` (shallow), nested-property mutation of the value
 * triggers reactivity. Requires Vue to be present and detected; if Vue is not
 * yet available it falls back to the core `signal()` (call
 * `await waitForVueDetection()` first if you need a hard guarantee). In a
 * component `setup()` Vue is always detected by the time this runs.
 */
export function deepSignal<T>(initial: T): Signal<T> {
  const ref = getVueDeepRefFn();
  return ref ? (ref(initial) as Signal<T>) : shallowSignal(initial);
}

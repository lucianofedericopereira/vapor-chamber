/**
 * vapor-chamber/reactive — opt-in DEEP reactivity companion.
 *
 * The core wires `signal()` to Vue's `shallowRef()` because the library replaces
 * state values wholesale (`state.value = handler(...)`) and never mutates nested
 * fields in place. Shallow tracking is therefore semantically identical for the
 * command-driven flow while avoiding the deep reactive Proxy (`toReactive()`)
 * that `ref()` wraps around object/array values — measured ~3.4× faster on the
 * `useCommandState` array path (see docs/performance.md, tests/signal-shallow-ab).
 *
 * Import THIS module only when you genuinely need nested reactivity — e.g. a
 * state object two-way bound with `v-model` whose fields you mutate in place
 * (`state.value.name = 'x'`) rather than through dispatched commands. That path
 * bypasses the command bus, so reach for it deliberately; for the normal
 * command-driven flow the shallow default is both correct and faster.
 *
 * Nothing here is pulled into the core bundle — it lives behind the
 * `vapor-chamber/reactive` subpath so the default install stays lean.
 *
 * @example
 * import { useDeepCommandState } from 'vapor-chamber/reactive';
 * // state.value.profile.name is deeply reactive — direct mutation triggers Vue:
 * const { state } = useDeepCommandState(
 *   { profile: { name: '' } },
 *   { rename: (s, cmd) => ({ ...s, profile: { ...s.profile, name: cmd.target } }) },
 * );
 *
 * @example
 * import { deepSignal } from 'vapor-chamber/reactive';
 * const form = deepSignal({ email: '', address: { city: '' } });
 * form.value.address.city = 'Lisbon'; // triggers reactivity (deep)
 */

import type { Command } from './command-bus';
import type { Signal } from './signal';
import { signal as shallowSignal } from './signal';
import {
  _createCommandState,
  getVueDeepRefFn,
  type UseCommandStateOptions,
} from './chamber';

/**
 * deepSignal — a deeply-reactive `Signal<T>` backed by Vue's `ref()`.
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

export type { UseCommandStateOptions };

/**
 * useDeepCommandState — `useCommandState` with deep (Proxy-backed) reactivity.
 *
 * Identical dispatch/coalesce/cleanup semantics to `useCommandState`; the only
 * difference is the returned `state` is a deep `ref()`, so BOTH command-driven
 * whole-value replacement AND direct nested mutation
 * (`state.value.a.b = c`) trigger reactivity. Use it for hybrid models that mix
 * command dispatch with two-way bound fields. For pure command-driven state,
 * prefer the faster `useCommandState` from the core.
 *
 * @example
 * const { state, dispose } = useDeepCommandState(
 *   { items: [] as number[] },
 *   { add: (s, cmd) => ({ ...s, items: [...s.items, cmd.target as number] }) },
 *   { coalesce: true },
 * );
 */
export function useDeepCommandState<T>(
  initial: T,
  handlers: {
    [action: string]: (state: T, cmd: Command) => T;
  },
  options: UseCommandStateOptions = {},
): { state: Signal<T>; dispose: () => void } {
  return _createCommandState(initial, handlers, options, deepSignal);
}

/**
 * vapor-chamber — minimal signal abstraction.
 *
 * Standalone module with NO module-load side effects. Imported by transports,
 * plugins, form — modules that need a `signal` API but should not drag the
 * full Vue feature-detection registry from `chamber.ts` into ESM consumer
 * bundles.
 *
 * Detection strategy:
 *   1. Lazy sync probe of `globalThis.__VUE__` on first `signal()` call —
 *      catches the MPA / server-rendered-page case where Vue is loaded as a
 *      global via `<script>` tag before vapor-chamber initializes.
 *   2. Plain getter/setter fallback otherwise.
 *   3. `configureSignal(fn)` lets `chamber.ts` push Vue's `ref()` here once
 *      its async dynamic import resolves, so SPA consumers eventually use
 *      the alien-signals-backed `ref` for real reactivity.
 *
 * Consumers needing full Vue auto-detection (async probe, Vapor detection,
 * lifecycle hooks) import from `chamber.ts`, which calls into this module.
 */

export type Signal<T> = { value: T };
export type CreateSignal = <T>(initial: T) => Signal<T>;

let _vueRef: ((initial: any) => any) | null = null;
let _syncProbed = false;

/** One-shot synchronous probe — looks for a Vue global. No async, no side effect on import. */
function syncProbe(): void {
  if (_syncProbed) return;
  _syncProbed = true;
  if (typeof globalThis !== 'undefined') {
    const vue = (globalThis as any).__VUE__;
    if (vue && typeof vue.ref === 'function') {
      _vueRef = vue.ref;
    }
  }
}

const fallbackSignal: CreateSignal = <T>(initial: T): Signal<T> => {
  syncProbe();
  if (_vueRef) return _vueRef(initial) as Signal<T>;

  let _value = initial;
  return {
    get value() { return _value; },
    set value(v: T) { _value = v; },
  };
};

let _signalFn: CreateSignal = fallbackSignal;

/**
 * Configure the signal factory. Called once by `chamber.ts` after its async
 * Vue probe completes; also available to consumers who want a custom signal
 * implementation.
 *
 * @example
 * import { ref } from 'vue';
 * import { configureSignal } from 'vapor-chamber';
 * configureSignal(ref);
 */
export function configureSignal(fn: CreateSignal): void {
  _signalFn = fn;
}

export const signal: CreateSignal = <T>(initial: T) => _signalFn(initial);

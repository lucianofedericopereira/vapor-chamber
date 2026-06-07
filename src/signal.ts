/**
 * vapor-chamber — minimal signal abstraction.
 *
 * Standalone module with NO module-load side effects. Imported by transports,
 * plugins, form — modules that need a `signal` API but should not drag the
 * full Vue feature-detection registry from `chamber.ts` into ESM consumer
 * bundles.
 *
 * Detection / fallback chain (first match wins on each `signal()` call):
 *   1. `configureSignal(fn)` — explicit override; `chamber.ts` pushes Vue's
 *      `shallowRef()` here once its async dynamic import resolves (shallow because
 *      the library replaces signal values wholesale and never mutates nested
 *      fields — skipping ref()'s deep-Proxy wrap on object/array values).
 *   2. Lazy sync probe of `globalThis.__VUE__` — catches the MPA /
 *      server-rendered-page case where Vue is a `<script>` global.
 *   3. Plain `{ value }` object — zero-overhead fallback for non-Vue, non-reactive
 *      contexts. For push-pull reactivity without Vue, call
 *      `configureAlienSignals` from `vapor-chamber/alien-signals` once at boot.
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
    // Prefer shallowRef — the library replaces signal values wholesale, so the
    // deep-Proxy wrap ref() applies to objects/arrays is pure overhead here.
    if (vue && typeof vue.shallowRef === 'function') {
      _vueRef = vue.shallowRef;
    } else if (vue && typeof vue.ref === 'function') {
      _vueRef = vue.ref;
    }
  }
}

const fallbackSignal: CreateSignal = <T>(initial: T): Signal<T> => {
  syncProbe();
  if (_vueRef) return _vueRef(initial) as Signal<T>;
  return { value: initial };
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

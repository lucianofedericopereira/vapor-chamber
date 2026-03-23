/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * v0.4.4 — Added: v-vc:command, v-vc:optimistic directives.
 *
 * Provides a Vue plugin that installs two directives for declarative command
 * dispatch directly in templates, combining dispatch + loading + error
 * handling without any <script setup> wiring.
 *
 * @example
 * // main.ts
 * import { createApp } from 'vue'
 * import { createDirectivePlugin } from 'vapor-chamber/directives'
 * createApp(App).use(createDirectivePlugin()).mount('#app')
 *
 * @example Template usage
 * <!-- dispatch 'cartAdd' on click -->
 * <button v-vc:command="'cartAdd'" :v-vc:payload="{ id: product.id }">
 *   Add to cart
 * </button>
 *
 * <!-- optimistic: immediately apply state before server confirms -->
 * <button v-vc:command="'orderCancel'"
 *         v-vc:optimistic="onOptimisticCancel">
 *   Cancel order
 * </button>
 */

import { getCommandBus, isVaporAvailable } from './chamber';
import type { Command } from './command-bus';

// ---------------------------------------------------------------------------
// Internal state per element (stored via WeakMap)
// ---------------------------------------------------------------------------

/** Default timeout for async dispatch in ms. Prevents infinite loading states. */
const DEFAULT_DISPATCH_TIMEOUT = 30_000;

type DirectiveState = {
  action: string;
  payload?: any;
  target?: any;
  optimisticFn?: (cmd: Command) => (() => void) | null;
  loading: boolean;
  error: Error | null;
  handler: (event: Event) => void;
  rollback?: (() => void) | null;
  /** Timeout in ms for async dispatch. Default: 30_000 */
  timeout: number;
};

const stateMap = new WeakMap<Element, DirectiveState>();

// ---------------------------------------------------------------------------
// v-vc:command
// ---------------------------------------------------------------------------
//
// Binding value: action name string (e.g. 'cartAdd')
// Modifiers: none
// arg: 'command' (used as the directive name)
//
// Additional data attributes read from the element:
//   data-vc-payload — JSON-encoded payload (optional)
//   data-vc-target  — JSON-encoded target (optional, defaults to {})
//
// CSS classes added to the element:
//   vc-loading  — while the dispatch is in flight
//   vc-error    — when the last dispatch failed
//   vc-success  — briefly added on success (removed after 1 tick)

const LOADING_CLASS = 'vc-loading';
const ERROR_CLASS = 'vc-error';

function parseJson(s: string | null | undefined): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function buildHandler(el: Element, state: DirectiveState): (event: Event) => void {
  return async (_event: Event) => {
    const bus = getCommandBus();

    state.loading = true;
    state.error = null;
    el.classList.add(LOADING_CLASS);
    el.classList.remove(ERROR_CLASS);
    if (el instanceof HTMLButtonElement) el.disabled = true;

    const payload = state.payload ?? parseJson((el as HTMLElement).dataset?.vcPayload);
    const target = state.target ?? parseJson((el as HTMLElement).dataset?.vcTarget) ?? {};

    // Apply optimistic update if provided
    let rollback: (() => void) | null = null;
    if (state.optimisticFn) {
      const cmd: Command = { action: state.action, target, payload };
      rollback = state.optimisticFn(cmd) ?? null;
    }

    let resolved: { ok: boolean; error?: Error; value?: any };
    try {
      let result;
      try {
        result = bus.dispatch(state.action, target, payload);
      } catch (e) {
        result = { ok: false, error: e as Error };
      }

      // Handle result (may be a Promise if using async bus shim)
      if (result && typeof (result as any).then === 'function') {
        // Race against timeout to prevent infinite loading states
        const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
          setTimeout(
            () => resolve({ ok: false, error: new Error(`Directive dispatch "${state.action}" timed out after ${state.timeout}ms`) }),
            state.timeout
          );
        });
        resolved = await Promise.race([(result as unknown as Promise<any>), timeoutPromise]);
      } else {
        resolved = result;
      }
    } catch (e) {
      resolved = { ok: false, error: e as Error };
    } finally {
      // Always reset loading state — prevents stuck buttons
      state.loading = false;
      el.classList.remove(LOADING_CLASS);
      if (el instanceof HTMLButtonElement) el.disabled = false;
    }

    if (!resolved.ok) {
      state.error = resolved.error ?? null;
      el.classList.add(ERROR_CLASS);
      if (rollback) {
        try { rollback(); } catch { /* ignore */ }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Vue plugin
// ---------------------------------------------------------------------------

/**
 * createDirectivePlugin — installs v-vc:command and v-vc:optimistic directives.
 *
 * Opt-in: import and use this plugin only when you need template directives.
 * Zero cost when not imported.
 */
export function createDirectivePlugin(): { install(app: any): void } {
  return {
    install(app: any) {
      // Vue 3.6+ Vapor components don't support custom directives (no VDOM
      // lifecycle hooks). Warn developers to use useVaporCommand() instead.
      if (isVaporAvailable()) {
        console.warn(
          '[vapor-chamber] Directives (v-vc:command) are VDOM-only and will not ' +
          'work inside <script setup vapor> components. Use useVaporCommand() or ' +
          'defineVaporCommand() for Vapor components. Directives still work in ' +
          'VDOM components within the same app.'
        );
      }

      /**
       * v-vc:command="'actionName'"
       *
       * Attaches a click handler that dispatches the named command.
       * Adds/removes .vc-loading and .vc-error CSS classes automatically.
       */
      app.directive('vc', {
        mounted(el: Element, binding: { arg?: string; value: any; modifiers: Record<string, boolean> }) {
          if (binding.arg !== 'command') return;

          const timeout = typeof binding.modifiers === 'object' && binding.modifiers
            ? parseInt(Object.keys(binding.modifiers).find(k => /^\d+$/.test(k)) ?? '', 10) || DEFAULT_DISPATCH_TIMEOUT
            : DEFAULT_DISPATCH_TIMEOUT;

          const state: DirectiveState = {
            action: binding.value as string,
            loading: false,
            error: null,
            handler: () => {},
            timeout,
          };

          state.handler = buildHandler(el, state);
          stateMap.set(el, state);
          el.addEventListener('click', state.handler);
        },

        updated(el: Element, binding: { arg?: string; value: any }) {
          if (binding.arg !== 'command') return;
          const state = stateMap.get(el);
          if (state) {
            state.action = binding.value as string;
          }
        },

        beforeUnmount(el: Element, binding: { arg?: string }) {
          if (binding.arg !== 'command') return;
          const state = stateMap.get(el);
          if (state) {
            el.removeEventListener('click', state.handler);
            stateMap.delete(el);
          }
        },
      });

      /**
       * v-vc:payload="{ ... }"
       *
       * Sets the payload for the v-vc:command on the same element.
       * Must be used alongside v-vc:command.
       */
      app.directive('vc-payload', {
        mounted(el: Element, binding: { value: any }) {
          const state = stateMap.get(el);
          if (state) state.payload = binding.value;
        },
        updated(el: Element, binding: { value: any }) {
          const state = stateMap.get(el);
          if (state) state.payload = binding.value;
        },
      });

      /**
       * v-vc:optimistic="fn"
       *
       * Registers an optimistic update function alongside v-vc:command.
       * `fn` receives the Command and returns a rollback function (or null).
       */
      app.directive('vc-optimistic', {
        mounted(el: Element, binding: { value: (cmd: Command) => (() => void) | null }) {
          const state = stateMap.get(el);
          if (state) state.optimisticFn = binding.value;
        },
        updated(el: Element, binding: { value: (cmd: Command) => (() => void) | null }) {
          const state = stateMap.get(el);
          if (state) state.optimisticFn = binding.value;
        },
      });
    },
  };
}

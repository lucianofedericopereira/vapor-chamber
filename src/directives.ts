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

import { getCommandBus } from './chamber';
import type { Command } from './command-bus';

// ---------------------------------------------------------------------------
// Internal state per element (stored via WeakMap)
// ---------------------------------------------------------------------------

type DirectiveState = {
  action: string;
  payload?: any;
  target?: any;
  optimisticFn?: (cmd: Command) => (() => void) | null;
  loading: boolean;
  error: Error | null;
  handler: (event: Event) => void;
  rollback?: (() => void) | null;
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

    let result;
    try {
      result = bus.dispatch(state.action, target, payload);
    } catch (e) {
      result = { ok: false, error: e as Error };
    }

    // Handle result (may be a Promise if using async bus shim)
    const resolved = result && typeof (result as any).then === 'function'
      ? await (result as any)
      : result;

    state.loading = false;
    el.classList.remove(LOADING_CLASS);
    if (el instanceof HTMLButtonElement) el.disabled = false;

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
      /**
       * v-vc:command="'actionName'"
       *
       * Attaches a click handler that dispatches the named command.
       * Adds/removes .vc-loading and .vc-error CSS classes automatically.
       */
      app.directive('vc', {
        mounted(el: Element, binding: { arg?: string; value: any; modifiers: Record<string, boolean> }) {
          if (binding.arg !== 'command') return;

          const state: DirectiveState = {
            action: binding.value as string,
            loading: false,
            error: null,
            handler: () => {},
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

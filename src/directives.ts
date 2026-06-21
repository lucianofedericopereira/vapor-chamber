/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table):
 *   vNext / beta.16 — Vue alignment is pass-through (Vue's "parse dynamic v-bind
 *            event options like VDOM" — Once/Passive/Capture — touches the COMPILED
 *            dynamic-event path only; v-vc:command attaches a DIRECT addEventListener,
 *            so the beta.15 disabled/in-flight mirror below is unaffected). LIB-SIDE
 *            this cycle (surfaced by the beta.9–16 retrospective): v-vc:command now
 *            honors event modifiers .stop/.prevent/.self/.left/.middle/.right/.capture/
 *            .once/.passive — the direct listener never received Vue's compiled
 *            withModifiers, so every modifier except the numeric .timeout was being
 *            silently dropped.
 *   v1.6.0 / beta.15 — code change: buildHandler() skips dispatch on disabled /
 *            aria-disabled / in-flight elements, mirroring Vue's "skip disabled
 *            delegated handlers" (#14948) for the DIRECT listener this directive
 *            attaches (the runtime fix only covers delegated handlers; the
 *            platform only guards disabled <button>/<input>, not <a>/<div>).
 *            Delegation opt-out (#14924) and click-modifier normalization are
 *            pass-through.
 *   v1.4.0 / beta.13 — pass-through (shared event invoker wrapping).
 *   v0.4.4 — Added: v-vc:command, v-vc:optimistic directives.
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
  /** `.stop` — call event.stopPropagation() before dispatch. */
  stop?: boolean;
  /** `.prevent` — call event.preventDefault() before dispatch. */
  prevent?: boolean;
  /** `.self` — only dispatch when event.target is the bound element. */
  self?: boolean;
  /** Allowed mouse buttons from `.left`/`.middle`/`.right` (0/1/2). Empty = any. */
  buttons?: number[];
  /** `.capture` — capture-phase listener. Also matched on removeEventListener. */
  capture?: boolean;
};

const stateMap = new WeakMap<Element, DirectiveState>();

// ---------------------------------------------------------------------------
// v-vc:command
// ---------------------------------------------------------------------------
//
// Binding value: action name string (e.g. 'cartAdd')
// arg: 'command' (used as the directive name)
// Modifiers (the directive attaches a DIRECT listener, so Vue's compiled
// withModifiers never reaches it — they are applied here by hand):
//   .stop .prevent .self        — DOM-event guards/actions, like v-on
//   .left .middle .right        — only dispatch for that mouse button
//   .capture .once .passive     — addEventListener options
//   .<number> (e.g. .5000)      — async dispatch timeout in ms (default 30000)
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
  return async (event: Event) => {
    // Event modifiers — mirror Vue's compiled withModifiers, which never reaches a
    // DIRECT addEventListener: .self and mouse-button modifiers abort the dispatch;
    // .stop / .prevent act on the DOM event. (.capture/.once/.passive are applied as
    // addEventListener options in mounted().)
    if (state.self && event.target !== el) return;
    if (state.buttons && state.buttons.length > 0 &&
        'button' in event && !state.buttons.includes((event as MouseEvent).button)) return;
    if (state.stop) event.stopPropagation();
    if (state.prevent) event.preventDefault();

    // Vue 3.6.0-beta.15 (runtime-vapor: skip disabled delegated direct handlers):
    // mirror Vue's "don't run a handler on a disabled element" rule for the direct
    // listener this directive attaches. Bail out on re-entrant clicks while a
    // dispatch is in flight, or when the element is disabled via the DOM property
    // or aria-disabled (the platform only suppresses clicks on disabled
    // <button>/<input>, not on <a>/<div>/aria-disabled).
    if (state.loading) return;
    if ((el as Partial<HTMLButtonElement>).disabled === true) return;
    if (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true') return;

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
      // lifecycle hooks). Since beta.10, VDOM/Vapor interop is much improved —
      // VDOM components can invoke Vapor slots and vice versa — but directives
      // remain a VDOM-only feature tied to the VDOM patch lifecycle.
      if (isVaporAvailable()) {
        console.warn(
          '[vapor-chamber] Directives (v-vc:command) are VDOM-only and will not ' +
          'work inside <script setup vapor> components. Use useCommand() or ' +
          'defineVaporCommand() for Vapor components. For async operations under ' +
          'Suspense, use useVaporAsyncCommand(). Directives still work in VDOM ' +
          'components within mixed Vapor/VDOM trees (interop plugin required).'
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

          const mods: Record<string, boolean> =
            (binding.modifiers && typeof binding.modifiers === 'object') ? binding.modifiers : {};

          const timeout = parseInt(Object.keys(mods).find(k => /^\d+$/.test(k)) ?? '', 10) || DEFAULT_DISPATCH_TIMEOUT;

          const buttons: number[] = [];
          if (mods.left) buttons.push(0);
          if (mods.middle) buttons.push(1);
          if (mods.right) buttons.push(2);

          const state: DirectiveState = {
            action: binding.value as string,
            loading: false,
            error: null,
            handler: () => {},
            timeout,
            stop: !!mods.stop,
            prevent: !!mods.prevent,
            self: !!mods.self,
            buttons,
            capture: !!mods.capture,
          };

          state.handler = buildHandler(el, state);
          stateMap.set(el, state);

          const listenerOpts: AddEventListenerOptions = {};
          if (mods.capture) listenerOpts.capture = true;
          if (mods.once) listenerOpts.once = true;
          if (mods.passive) listenerOpts.passive = true;
          el.addEventListener('click', state.handler, listenerOpts);
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
            el.removeEventListener('click', state.handler, state.capture ? { capture: true } : undefined);
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

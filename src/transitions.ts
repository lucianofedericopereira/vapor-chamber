/**
 * vapor-chamber — Transition integration
 *
 * v1.5.0 — Vue 3.6.0-beta.14 alignment:
 *           • onMove is no longer called for v-show-hidden TransitionGroup
 *             children (transition: avoid move transition for hidden v-show group
 *             children). Before beta.14, Vue called onMove for elements with
 *             display:none set by v-show, causing invisible move animations to
 *             be triggered. After beta.14, Vue's runtime skips the onMove call
 *             for those elements — the `*Move` command is never dispatched for
 *             hidden children. No code change needed here; the fix is in Vue's
 *             runtime. Workarounds that guarded against spurious move dispatches
 *             by checking element visibility can be removed.
 *           All changes are in Vue's runtime — wrappers here are pass-through.
 * v1.4.0 — Vue 3.6.0-beta.13 alignment:
 *           • onMove now correctly fires for Vapor component moves in a Vapor
 *             TransitionGroup (runtime-vapor: animate vapor component moves in
 *             TransitionGroup — was silently skipped before beta.13).
 *           • onMove now correctly fires for VDOM component moves inside a Vapor
 *             TransitionGroup (runtime-vapor: animate vdom component moves in
 *             vapor TransitionGroup — same class of bug, separate fix).
 *           • Moves are deferred until all child updates flush before onMove is
 *             called — el is in its final pre-move position when the command
 *             dispatches (runtime-vapor: defer TransitionGroup moves until child
 *             updates flush).
 *           • Transition hooks now apply to slot fallback children inside Vapor
 *             components (runtime-vapor: apply transition hooks to slot fallbacks).
 *           • v-for item keys are preserved through TransitionGroup reorders
 *             (runtime-vapor: preserve v-for item keys in transition group).
 *           Performance (pass-through):
 *           • TransitionGroup no longer resolves its own props twice per render
 *             (runtime-vapor: avoid duplicate TransitionGroup props resolution).
 *           • <Transition v-bind="t"> / <TransitionGroup v-bind="t"> — object
 *             literal v-bind spreads are now expanded inline by the compiler
 *             instead of being spread at runtime (compiler-vapor: expand object
 *             literal v-bind and v-on). The useTransitionCommand() return value
 *             bound via v-bind generates cheaper compiled output in beta.13.
 *           All other changes are in Vue's runtime — wrappers here are pass-through.
 * v1.1.0 — Dispatches bus commands from Vue <Transition> / <TransitionGroup>
 *           lifecycle hooks. Enables animation coordination through the command bus
 *           without direct DOM coupling.
 *
 * Two entry points:
 *   createTransitionBridge — framework-agnostic factory (accepts BaseBus)
 *   useTransitionCommand   — Vue composable (uses shared bus + auto-cleanup)
 *
 * @example
 * // Factory (any JS context):
 * const t = createTransitionBridge({ bus, namespace: 'modal' });
 * // t.onEnter dispatches 'modalEnter', t.onLeave dispatches 'modalLeave', etc.
 *
 * @example
 * // Vue composable:
 * const t = useTransitionCommand({ namespace: 'drawer' });
 * // <Transition v-bind="t"> — all hooks wired automatically
 */

import type { BaseBus } from './command-bus';
import { signal as chamberSignal, getCommandBus, tryAutoCleanup } from './chamber';
import type { Signal } from './chamber';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitionPhase = 'idle' | 'entering' | 'leaving';

export type TransitionBridgeOptions = {
  /** Namespace prefix for dispatched actions (e.g. 'modal' → 'modalEnter'). */
  namespace?: string;
  /** Bus to dispatch on. Required for createTransitionBridge. */
  bus?: BaseBus;
};

export type TransitionHooks = {
  onBeforeEnter: (el: Element) => void;
  onEnter: (el: Element, done: () => void) => void;
  onAfterEnter: (el: Element) => void;
  onEnterCancelled: (el: Element) => void;
  onBeforeLeave: (el: Element) => void;
  onLeave: (el: Element, done: () => void) => void;
  onAfterLeave: (el: Element) => void;
  onLeaveCancelled: (el: Element) => void;
  /**
   * TransitionGroup-only: called when an element moves due to reorder.
   *
   * Vue 3.6.0-beta.14: NOT called for elements hidden by v-show (display:none).
   * Vue's runtime skips the hook for v-show-hidden children, so the `*Move`
   * command is never dispatched for invisible list items. Handlers that were
   * guarding against spurious move events on hidden elements can remove that
   * check.
   *
   * Vue 3.6.0-beta.13: fires correctly for both Vapor and VDOM component moves
   * inside a Vapor TransitionGroup. Guaranteed to be called after all child
   * updates have flushed — `el` is in its pre-move position, ready for the CSS
   * move class to be applied. No `done()` callback; moves are CSS-only.
   */
  onMove: (el: Element) => void;
};

export type TransitionBridge = TransitionHooks & {
  /** Reactive signal: current transition phase. */
  phase: Signal<TransitionPhase>;
  /** Cleanup function (no-op for bridge, meaningful for composable). */
  dispose: () => void;
};

// ---------------------------------------------------------------------------
// Internal: action name prefixing (same convention as useCommandGroup)
// ---------------------------------------------------------------------------

function prefixed(namespace: string | undefined, hook: string): string {
  if (!namespace) return hook;
  return namespace + hook.charAt(0).toUpperCase() + hook.slice(1);
}

// ---------------------------------------------------------------------------
// Internal: shared hook builder
// ---------------------------------------------------------------------------

function buildHooks(
  bus: BaseBus,
  namespace: string | undefined,
  phase: Signal<TransitionPhase>,
): TransitionHooks {
  /** Dispatch and ignore missing handlers — transitions should never break the app. */
  function dispatchSafe(hook: string, el: Element): any {
    const action = prefixed(namespace, hook);
    try {
      return bus.dispatch(action, el);
    } catch {
      // No handler registered — safe to ignore for transition hooks.
      return undefined;
    }
  }

  /** Dispatch with done() callback — awaits async results before calling done(). */
  function dispatchWithDone(hook: string, el: Element, done: () => void): void {
    let result: any;
    try {
      result = dispatchSafe(hook, el);
    } catch {
      done();
      return;
    }
    if (result && typeof result.then === 'function') {
      (result as Promise<any>).then(() => done(), () => done());
    } else {
      done();
    }
  }

  return {
    onBeforeEnter(el: Element) {
      phase.value = 'entering';
      dispatchSafe('beforeEnter', el);
    },

    onEnter(el: Element, done: () => void) {
      dispatchWithDone('enter', el, done);
    },

    onAfterEnter(el: Element) {
      phase.value = 'idle';
      dispatchSafe('afterEnter', el);
    },

    onEnterCancelled(el: Element) {
      phase.value = 'idle';
      dispatchSafe('enterCancelled', el);
    },

    onBeforeLeave(el: Element) {
      phase.value = 'leaving';
      dispatchSafe('beforeLeave', el);
    },

    onLeave(el: Element, done: () => void) {
      dispatchWithDone('leave', el, done);
    },

    onAfterLeave(el: Element) {
      phase.value = 'idle';
      dispatchSafe('afterLeave', el);
    },

    onLeaveCancelled(el: Element) {
      phase.value = 'idle';
      dispatchSafe('leaveCancelled', el);
    },

    onMove(el: Element) {
      dispatchSafe('move', el);
    },
  };
}

// ---------------------------------------------------------------------------
// createTransitionBridge — framework-agnostic factory
// ---------------------------------------------------------------------------

/**
 * createTransitionBridge — wire Vue transition hooks to bus commands.
 *
 * Framework-agnostic: accepts any BaseBus (sync or async). Use this in
 * non-Vue contexts or when you need explicit lifecycle control.
 *
 * @example
 * const bus = createCommandBus();
 * bus.register('modalEnter', (cmd) => {
 *   cmd.target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
 * });
 *
 * const t = createTransitionBridge({ bus, namespace: 'modal' });
 * // Pass t.onEnter, t.onLeave, etc. to <Transition> or call them manually
 */
export function createTransitionBridge(
  options: TransitionBridgeOptions & { bus: BaseBus },
): TransitionBridge {
  const { bus, namespace } = options;

  // Plain signal — no Vue dependency in the factory path
  let _phase: TransitionPhase = 'idle';
  const phase: Signal<TransitionPhase> = {
    get value() { return _phase; },
    set value(v: TransitionPhase) { _phase = v; },
  };

  const hooks = buildHooks(bus, namespace, phase);

  return { ...hooks, phase, dispose: () => {} };
}

// ---------------------------------------------------------------------------
// useTransitionCommand — Vue composable
// ---------------------------------------------------------------------------

/**
 * useTransitionCommand — Vue composable that wires transition hooks to the
 * shared command bus with reactive phase signal and auto-cleanup.
 *
 * Bind directly to `<Transition>` via `v-bind`:
 *
 * @example
 * <script setup>
 * import { useTransitionCommand } from 'vapor-chamber';
 * const modal = useTransitionCommand({ namespace: 'modal' });
 * </script>
 *
 * <template>
 *   <Transition v-bind="modal">
 *     <div v-if="showModal" class="modal">...</div>
 *   </Transition>
 *   <p v-if="modal.phase.value === 'entering'">Opening...</p>
 * </template>
 */
export function useTransitionCommand(
  options: TransitionBridgeOptions = {},
): TransitionBridge {
  const bus = options.bus ?? getCommandBus();
  const phase = chamberSignal<TransitionPhase>('idle');
  const hooks = buildHooks(bus, options.namespace, phase);

  function dispose() {
    phase.value = 'idle';
  }

  tryAutoCleanup(dispose);

  return { ...hooks, phase, dispose };
}

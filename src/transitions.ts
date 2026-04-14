/**
 * vapor-chamber — Transition integration
 *
 * v1.1.0 — Dispatches bus commands from Vue <Transition> / <TransitionGroup>
 * lifecycle hooks. Enables animation coordination through the command bus
 * without direct DOM coupling.
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
  /** TransitionGroup-only: called when an element moves due to reorder. */
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

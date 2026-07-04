/**
 * vapor-chamber — Transition integration
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table, the single
 * source of per-beta detail; this header only records changes to THIS file):
 *   vNext / beta.17 — pass-through. No <Transition>/<TransitionGroup> change in beta.17 (its
 *            fixes are slot compilation, interop slot ownership, and hydration); the bridge forwards
 *            whatever hooks Vue fires, unchanged. No code change.
 *   vNext / beta.16 — pass-through. Inherited correctness: onLeave now fires for a
 *            non-v-show root removed after a v-show branch (Vue stopped `persisted`
 *            leaking onto non-v-show roots — the *Leave dispatch was being dropped).
 *            onLeave() JSDoc updated below. Five other transition fixes (re-resolve
 *            hooks on prop change, type-bucketed leaving cache, raw-key compare,
 *            out-in branch-key sync) are internal DOM correctness — hooks unchanged.
 *   v1.6.0 / beta.15 — pass-through (transition-group hook restore after skipped
 *            move, key inheritance/stability, v-if comments, v-show timing).
 *            onMove() JSDoc updated below — behavior notes live on the API.
 *   v1.5.0 / beta.14 — pass-through (onMove suppressed for v-show-hidden children;
 *            see onMove() JSDoc).
 *   v1.4.0 / beta.13 — pass-through (onMove fires for Vapor+VDOM component moves,
 *            deferred until child updates flush; see onMove() JSDoc).
 *   v1.1.0 — module added: dispatches bus commands from <Transition> /
 *            <TransitionGroup> lifecycle hooks, enabling animation coordination
 *            through the command bus without direct DOM coupling.
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

import type { BaseBus, CommandMap } from './command-bus';
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
  /**
   * Dispatches `<namespace>Leave` and awaits an async handler before `done()`.
   *
   * Vue 3.6.0-beta.16: now fires when a **non-v-show root is structurally removed
   * after a v-show branch was shown**. Previously a latched `persisted` flag leaked
   * onto the non-v-show root, so Vapor skipped the leave and this hook (and its
   * `*Leave` command) never ran. The runtime now gates the carry-forward on an
   * actual v-show marker, so the dispatch is no longer dropped in that sequence.
   */
  onLeave: (el: Element, done: () => void) => void;
  onAfterLeave: (el: Element) => void;
  onLeaveCancelled: (el: Element) => void;
  /**
   * TransitionGroup-only: called when an element moves due to reorder.
   *
   * Vue 3.6.0-beta.15: a move that was skipped (e.g. for a v-show-hidden child)
   * no longer permanently drops the element's move hooks — they are restored, so
   * a later genuine reorder of that same child dispatches `*Move` as normal. You
   * do not need to re-register the `*Move` handler after a hidden item reappears.
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

// camelCase namespace join ('modal' + 'enter' → 'modalEnter'). Inlined, NOT a
// shared helper — DO NOT consolidate, settled, do not re-evaluate. This is the
// per-hook dispatch hot path; a same-process A/B (interleaved, 11 trials ×2)
// measured a shared-call indirection ~0.6–1.3% slower here. The convention is
// mirrored inline at all three sites (useCommandGroup / createChamber / here).
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
  const bus = options.bus ?? getCommandBus<CommandMap>();
  const phase = chamberSignal<TransitionPhase>('idle');
  const hooks = buildHooks(bus, options.namespace, phase);

  function dispose() {
    phase.value = 'idle';
  }

  tryAutoCleanup(dispose);

  return { ...hooks, phase, dispose };
}

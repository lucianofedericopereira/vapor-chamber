/**
 * vapor-chamber — Transition integration
 *
 * Vue alignment history (one line per version — full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table, the single
 * source of per-beta detail; this header only records changes to THIS file):
 *   vNext / rc.2 — pass-through, but unblocks a real prior failure mode. #15133 and
 *            #15140 fix the vdom-interop layer losing a vapor block's `vnode.transition`
 *            across mount/unmount/move — concretely, a vdom `<Transition mode="out-in">`
 *            wrapped around a vapor page (the Nuxt `NuxtPage` + page-transition shape)
 *            could deadlock entirely: the leaving page never resolved and the incoming
 *            one never mounted, because `afterLeave` — the hook this bridge's onLeave
 *            forwards to your handler — was never invoked. This module only supplies the
 *            hook bodies Vue calls into; it never reads or writes `vnode.transition`
 *            itself, so there was no workaround available at this layer and none needed
 *            now. If `useTransitionCommand`'s onLeave previously seemed to "hang" around
 *            a vapor page under an out-in transition, that was this bug, not a dispatch
 *            issue — no code change here, but worth knowing the class of report is closed
 *            upstream, not something to keep working around in app code.
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

// camelCase namespace join ('modal' + 'enter' → 'modalEnter').
//
// This carried a "DO NOT consolidate, settled, do not re-evaluate" note, on the
// grounds that it sat on the per-hook dispatch hot path where a shared call
// measured ~0.6–1.3% slower. That reasoning was sound but the premise no longer
// holds, because the premise itself was the bug: the call did not need to be on
// the dispatch path at all. `buildHooks` now resolves all nine names once at
// construction (see there), so this runs 9 times per bridge instead of once per
// hook fired.
//
// Consequence worth stating plainly, since the old note forbade exactly this:
// the ~1% indirection argument no longer applies HERE, because a setup-time
// call cannot cost a per-dispatch percentage. The right way to retire a
// "don't merge, it costs 1%" constraint is to remove the hot path, not to pay
// the 1%. The other two sites (useCommandGroup / createChamber) keep their own
// copies until each is shown to be off its hot path the same way — createChamber
// is already setup-only, useCommandGroup is not yet checked.
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
  // Action names are built ONCE per bridge, not once per hook dispatch. Both
  // inputs are fixed here: `namespace` is captured at construction and every
  // `hook` below is a string literal, so the concatenation could never produce a
  // different answer on a later call — it was pure repeated work on the hot
  // path. Isolating that segment (120k hook calls, interleaved A/B): building
  // per dispatch 3.668ms vs precomputed 0.237ms, i.e. the string work is gone
  // (~15x on the segment; far less end-to-end, where bus.dispatch dominates —
  // see the transition-bridge rows in tests/perf.bench.ts).
  //
  // This is also what makes `prefixed` safe to share: it is now a setup-time
  // call, so the indirection that measured ~1% on the old per-dispatch path
  // cannot appear here at all.
  const aBeforeEnter = prefixed(namespace, 'beforeEnter');
  const aEnter = prefixed(namespace, 'enter');
  const aAfterEnter = prefixed(namespace, 'afterEnter');
  const aEnterCancelled = prefixed(namespace, 'enterCancelled');
  const aBeforeLeave = prefixed(namespace, 'beforeLeave');
  const aLeave = prefixed(namespace, 'leave');
  const aAfterLeave = prefixed(namespace, 'afterLeave');
  const aLeaveCancelled = prefixed(namespace, 'leaveCancelled');
  const aMove = prefixed(namespace, 'move');

  /** Dispatch and ignore missing handlers — transitions should never break the app. */
  function dispatchSafe(action: string, el: Element): any {
    try {
      return bus.dispatch(action, el);
    } catch {
      // No handler registered — safe to ignore for transition hooks.
      return undefined;
    }
  }

  /** Dispatch with done() callback — awaits async results before calling done(). */
  function dispatchWithDone(action: string, el: Element, done: () => void): void {
    const result = dispatchSafe(action, el); // dispatchSafe never throws (own try/catch)
    if (result && typeof result.then === 'function') {
      (result as Promise<any>).then(() => done(), () => done());
    } else {
      done();
    }
  }

  return {
    onBeforeEnter(el: Element) {
      phase.value = 'entering';
      dispatchSafe(aBeforeEnter, el);
    },

    onEnter(el: Element, done: () => void) {
      dispatchWithDone(aEnter, el, done);
    },

    onAfterEnter(el: Element) {
      phase.value = 'idle';
      dispatchSafe(aAfterEnter, el);
    },

    onEnterCancelled(el: Element) {
      phase.value = 'idle';
      dispatchSafe(aEnterCancelled, el);
    },

    onBeforeLeave(el: Element) {
      phase.value = 'leaving';
      dispatchSafe(aBeforeLeave, el);
    },

    onLeave(el: Element, done: () => void) {
      dispatchWithDone(aLeave, el, done);
    },

    onAfterLeave(el: Element) {
      phase.value = 'idle';
      dispatchSafe(aAfterLeave, el);
    },

    onLeaveCancelled(el: Element) {
      phase.value = 'idle';
      dispatchSafe(aLeaveCancelled, el);
    },

    onMove(el: Element) {
      dispatchSafe(aMove, el);
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

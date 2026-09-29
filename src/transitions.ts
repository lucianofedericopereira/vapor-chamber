/**
 * vapor-chamber - Transition integration
 *
 * `VaporTransition` merges its declared `on*` props across sources, so
 * `<Transition v-bind="t" @enter="mine">` runs both hooks
 * (tests/transition-bind-merge-fixture.test.ts). The hooks are idempotent by
 * construction (see `buildHooks`); onMove's behaviour notes are on its JSDoc.
 * The history is in CHANGELOG.md and the whitepaper's section 9.2.
 *
 * Two entry points:
 *   createTransitionBridge - framework-agnostic factory (accepts BaseBus)
 *   useTransitionCommand   - Vue composable (uses shared bus + auto-cleanup)
 *
 * @example
 * // Factory (any JS context):
 * const t = createTransitionBridge({ bus, namespace: 'modal' });
 * // t.onEnter dispatches 'modalEnter', t.onLeave dispatches 'modalLeave', etc.
 *
 * @example
 * // Vue composable:
 * const t = useTransitionCommand({ namespace: 'drawer' });
 * // <Transition v-bind="t"> - all hooks wired automatically
 */

import type { BaseBus, CommandMap } from './command-bus';
import { MAX_TIMEOUT_MS, countOption } from './bounds';
import { signal as chamberSignal, getCommandBus, tryAutoCleanup } from './chamber';
import type { Signal } from './chamber';
import { DEV } from './dev';

/**
 * `| 0` folds NaN and Infinity to 0, which the floor of 1 then lifts, so a
 * bad option degrades to "call done() almost immediately" rather than to the
 * stuck element this timeout exists to prevent. Same treatment the other
 * numeric options in this library get - see `serveMcpStdio`.
 */
function resolveTimeout(value: number | undefined): number {
  return countOption(value, 30_000, 1, MAX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitionPhase = 'idle' | 'entering' | 'leaving';

export type TransitionBridgeOptions = {
  /** Namespace prefix for dispatched actions (e.g. 'modal' -> 'modalEnter'). */
  namespace?: string;
  /** Bus to dispatch on. Required for createTransitionBridge. */
  bus?: BaseBus;
  /**
   * Milliseconds to wait for an async `*Enter` / `*Leave` handler before
   * calling `done()` anyway. Default: 30_000, the same cap `directives.ts`
   * applies to its own dispatches.
   *
   * Vue waits for `done()` indefinitely, so a handler that never settles
   * leaves the element stuck mid-transition for the life of the page - see the
   * note in `dispatchWithDone`. Clamped to at least 1ms.
   */
  timeout?: number;
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
   * Fires when a **non-v-show root is structurally removed after a v-show
   * branch was shown** too (Vue gates its `persisted` carry-forward on an
   * actual v-show marker, beta.16).
   */
  onLeave: (el: Element, done: () => void) => void;
  onAfterLeave: (el: Element) => void;
  onLeaveCancelled: (el: Element) => void;
  /**
   * TransitionGroup-only: called when an element moves due to reorder.
   *
   * NOT called for elements hidden by v-show (display:none): the `*Move`
   * command is never dispatched for invisible list items. A skipped move does
   * not drop the element's move hooks, so a later genuine reorder of that child
   * dispatches `*Move` as normal.
   *
   * Fires for both Vapor and vDOM component moves inside a Vapor
   * TransitionGroup, after all child updates have flushed - `el` is in its pre-move position, ready for the CSS
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

// camelCase namespace join ('modal' + 'enter' -> 'modalEnter'). Off the
// dispatch path: `buildHooks` resolves all nine names once at construction
// (see there). useCommandGroup / createChamber keep their own copies until each
// is shown to be off its hot path the same way (createChamber is setup-only;
// useCommandGroup is not yet checked).
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
  timeout: number,
): TransitionHooks {
  // Action names are built ONCE per bridge, not once per hook dispatch. Both
  // inputs are fixed here: `namespace` is captured at construction and every
  // `hook` below is a string literal, so the concatenation could never produce a
  // different answer on a later call - it was pure repeated work on the hot
  // path. Isolating that segment (120k hook calls, interleaved A/B): building
  // per dispatch 3.668ms vs precomputed 0.237ms, i.e. the string work is gone
  // (~15x on the segment; far less end-to-end, where bus.dispatch dominates -
  // see the transition-bridge rows in tests/perf.bench.ts).
  //
  // This is also what makes `prefixed` safe to share: it is now a setup-time
  // call, so the indirection that measured ~1% on a per-dispatch path cannot
  // appear here at all.
  const aBeforeEnter = prefixed(namespace, 'beforeEnter');
  const aEnter = prefixed(namespace, 'enter');
  const aAfterEnter = prefixed(namespace, 'afterEnter');
  const aEnterCancelled = prefixed(namespace, 'enterCancelled');
  const aBeforeLeave = prefixed(namespace, 'beforeLeave');
  const aLeave = prefixed(namespace, 'leave');
  const aAfterLeave = prefixed(namespace, 'afterLeave');
  const aLeaveCancelled = prefixed(namespace, 'leaveCancelled');
  const aMove = prefixed(namespace, 'move');

  /** Dispatch and ignore missing handlers - transitions should never break the app. */
  function dispatchSafe(action: string, el: Element): any {
    try {
      return bus.dispatch(action, el);
    } catch {
      // No handler registered - safe to ignore for transition hooks.
      return undefined;
    }
  }

  /**
   * Dispatch with done() callback - awaits async results before calling done().
   *
   * Raced against a timeout, because Vue waits for `done()` INDEFINITELY. A
   * handler that never settles - an await on a request that never returns, a
   * promise nobody resolves - left the element stuck in its transitioning
   * state for the life of the page, with no error anywhere. Measured before
   * this guard: `done()` was never called and the phase never left
   * 'entering'/'leaving'.
   *
   * `directives.ts` already caps its own dispatches for the same reason and
   * with the same default; this module simply did not, which made a hung
   * handler a stuck animation in one place and a recovered button in the
   * other.
   *
   * The timer is cleared when the dispatch wins, and `settled` makes `done()`
   * exactly-once: calling it twice would let Vue finish a transition it had
   * already finished.
   */
  function dispatchWithDone(action: string, el: Element, done: () => void): void {
    const result = dispatchSafe(action, el); // dispatchSafe never throws (own try/catch)
    if (!result || typeof result.then !== 'function') {
      done();
      return;
    }
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut && DEV) {
        console.warn(
          `[vapor-chamber] transition "${action}" did not settle within ${timeout}ms; ` +
            'calling done() so the element is not stuck mid-transition. Raise `timeout` ' +
            'if the handler is legitimately slow.',
        );
      }
      done();
    };
    const timer = setTimeout(() => finish(true), timeout);
    (result as Promise<any>).then(() => finish(false), () => finish(false));
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
// Internal: assemble the returned bridge
// ---------------------------------------------------------------------------

/**
 * Return the nine hooks as ENUMERABLE own keys, and `phase` / `dispose` as
 * NON-ENUMERABLE ones.
 *
 * This exists because of the usage this module documents and the README
 * repeats: `<Transition v-bind="t">`. `v-bind="obj"` spreads an object's own
 * ENUMERABLE keys into the component's props. Vue matches the nine `on*` hooks
 * to `<Transition>`'s declared props and passes the rest through as
 * fallthrough ATTRIBUTES, which are stringified onto the transitioned element.
 * `phase` (a signal object) and `dispose` (a function) match no declared prop,
 * so enumerable, both would land in the DOM (on a real mounted
 * `<Transition v-bind="bridge">`):
 *
 *     <div class="panel" phase="[object Object]" dispose="() => {}">hi</div>
 *
 * The regression test is a REAL mount: a direct call on a mock element never
 * renders the bridge.
 *
 * Non-enumerability is the minimal fix: it changes what SPREADING the bridge
 * yields, and nothing else. `t.phase.value`, `t.dispose()` and
 * `const { phase } = t` all read the property directly and are unaffected -
 * destructuring does not require enumerability. The one intentional casualty is
 * `{ ...bridge }`, which does not carry `phase`/`dispose`; that is precisely
 * the operation that would put them in the DOM.
 *
 * Not solved by renaming or by a `hooks` sub-object: both would break the
 * documented `v-bind="t"` call site, and the point is to make the documented
 * call site correct rather than to document around it.
 */
function assembleBridge(
  hooks: TransitionHooks,
  phase: Signal<TransitionPhase>,
  dispose: () => void,
): TransitionBridge {
  const bridge = { ...hooks } as TransitionBridge;
  // writable/configurable stay true: this hides them from spreads, it does not
  // freeze the object. Callers that reassign or re-define keep working.
  Object.defineProperty(bridge, 'phase', {
    value: phase, enumerable: false, writable: true, configurable: true,
  });
  Object.defineProperty(bridge, 'dispose', {
    value: dispose, enumerable: false, writable: true, configurable: true,
  });
  return bridge;
}

// ---------------------------------------------------------------------------
// createTransitionBridge - framework-agnostic factory
// ---------------------------------------------------------------------------

/**
 * createTransitionBridge - wire Vue transition hooks to bus commands.
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

  // Plain signal - no Vue dependency in the factory path
  let _phase: TransitionPhase = 'idle';
  const phase: Signal<TransitionPhase> = {
    get value() { return _phase; },
    set value(v: TransitionPhase) { _phase = v; },
  };

  const hooks = buildHooks(bus, namespace, phase, resolveTimeout(options.timeout));

  return assembleBridge(hooks, phase, () => {});
}

// ---------------------------------------------------------------------------
// useTransitionCommand - Vue composable
// ---------------------------------------------------------------------------

/**
 * useTransitionCommand - Vue composable that wires transition hooks to the
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
 *
 * Your own hooks compose with the spread: `<Transition v-bind="modal"
 * @enter="mine">` runs both, in Vapor from Vue 3.6.0-rc.8 and in vDOM always.
 * Vue still waits for `done` when any merged handler takes two arguments, and
 * the bridge's `onEnter` / `onLeave` do.
 */
export function useTransitionCommand(
  options: TransitionBridgeOptions = {},
): TransitionBridge {
  const bus = options.bus ?? getCommandBus<CommandMap>();
  const phase = chamberSignal<TransitionPhase>('idle');
  const hooks = buildHooks(bus, options.namespace, phase, resolveTimeout(options.timeout));

  function dispose() {
    phase.value = 'idle';
  }

  tryAutoCleanup(dispose);

  return assembleBridge(hooks, phase, dispose);
}

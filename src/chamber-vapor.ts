/**
 * vapor-chamber - Vue 3.6+ Vapor-specific API
 *
 * This file renders nothing: it forwards Vue's own define* functions, so
 * rendering-side work (attrs fallthrough, interop, hydration) lands below it.
 * The wrappers take an opt-in return generic (`<T = any>`) and `object`-typed
 * options, and createVaporChamberApp answers `unknown`: importing Vue's Vapor types here
 * would put a hard `vue` type dependency on the main barrel and break Vue-less
 * command-bus consumers, so callers opt in: `defineVaporComponent<MyComp>(opts)`.
 *
 * Separated from chamber.ts to keep the core composable module smaller.
 */

import {
  tryAutoCleanup,
  tryKeepAliveHooks,
  untracked,
  getVaporAppFn,
  getVaporInteropRef,
  getDefineVaporCustomElementFn,
  getDefineVaporComponentFn,
  getDefineVaporAsyncComponentFn,
  vueDetectionHint,
} from './chamber';
import { _report } from './report';
import type { BaseBus, CommandBus, Handler, RegisterOptions, CommandResult } from './command-bus';
import { _errResult } from './command-bus';
import { commandState, type CommandState } from './command-state';
import type { Signal } from './signal';
import { DEV } from './dev';
import { resolveBus, type BusOption, } from './shared-bus';
import { _paceOf, pace, type Paced, type PaceOption, type PacedOn } from './pace';

/**
 * Why the `defineVapor*` wrappers warn instead of just returning null.
 *
 * Each returns `null` when the Vapor runtime is absent, and callers are
 * documented to check. But a bare `null` is a silent negative, and silent
 * negatives are how detection bugs survive (an accessor that silently answers
 * "no" left a feature inert with nothing to see: see
 * tests/keepalive-input-scope-fixture.test.ts).
 *
 * So the null stays - throwing would break the documented contract - but it
 * is not quiet. The call sites gate on
 * `DEV`, so the whole call (and every byte of message text) folds out of the
 * production IIFE builds; this helper is then unreferenced and tree-shaken.
 */
function devWarnNoVapor(api: string): void {
  _report('warn', 'vue:missing:vapor',
    `${api}() returned null: Vue 3.6+ with Vapor mode was not detected, ` +
      `so the component was NOT created. ${vueDetectionHint()} ` +
      'For VDOM mode use the matching define* helper from vue instead.',
  );
}

/**
 * Create a Vapor app instance with vapor-chamber ready.
 * Requires Vue 3.6+. Throws if Vapor is not available.
 *
 * Pass-through over Vue's createVaporApp - scope-ID handling, HMR app-instance
 * refresh, and setup() error recovery are Vue runtime behavior (per-beta detail:
 * CHANGELOG / whitepaper alignment log).
 *
 * `rootProps` are Vue's raw props, passed through unchanged: a plain value is
 * the value, and a FUNCTION is a getter that Vue calls for the value. So a
 * callback is wrapped, `{ onSave: () => onSave }`; passed bare it is called
 * and the component receives what it returned. (A function set on a
 * `defineWidget` element property is the opposite: it arrives as itself.)
 * Pinned by tests/vapor/vapor-subpath-wiring.test.ts.
 *
 * Typed in src/vapor.ts as a `VaporChamberApp`, where Vue's types may be
 * named: here it answers `unknown`, and the root does not export it.
 *
 * @example
 * import { createVaporChamberApp } from 'vapor-chamber/vapor';
 * import App from './App.vue';
 * createVaporChamberApp(App).mount('#app');
 *
 * @example Root props
 * createVaporChamberApp(App, { title: 'Cart', onSave: () => onSave }).mount('#app');
 */
export function createVaporChamberApp(
  rootComponent: object,
  rootProps?: Record<string, unknown>,
): unknown {
  const fn = getVaporAppFn();
  if (!fn) {
    // Vue absent, present without Vapor, and present but unreachable are three
    // problems with three fixes; vueDetectionHint() names which.
    throw new Error(
      // The diagnosis ships (vueDetectionHint says why); the advice is DEV's.
      `[vapor-chamber] Vue 3.6+ with Vapor mode required. ${vueDetectionHint()}` +
      (DEV ? ' For VDOM mode, use createApp() from vue instead.' : '')
    );
  }
  return fn(rootComponent, rootProps);
}

/**
 * Returns the vaporInteropPlugin if available (Vue 3.6+).
 * Use this to enable mixed Vapor/VDOM component trees.
 *
 * Pass-through over Vue's plugin. The returned reference is safe to hold
 * across HMR cycles (Vue does not mutate the bridge).
 *
 * @example
 * import { createApp } from 'vue';
 * import { getVaporInteropPlugin } from 'vapor-chamber';
 * const plugin = getVaporInteropPlugin();
 * if (plugin) createApp(App).use(plugin).mount('#app');
 */
export function getVaporInteropPlugin(): any | null {
  return getVaporInteropRef();
}

// ---------------------------------------------------------------------------
// Vapor Custom Elements (Vue 3.6)
// ---------------------------------------------------------------------------

/**
 * defineVaporCustomElement - create a custom element backed by Vapor rendering.
 *
 * Wraps Vue's `defineVaporCustomElement()`. The generated custom
 * element uses Vapor's compiler-optimized rendering instead of the VDOM, giving
 * zero-overhead DOM updates inside shadow DOM. Safe to call with a reused
 * options object, and children re-render on reactive prop changes (Vue 3.6.0-beta.14+).
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected - check before calling
 * `customElements.define()`.
 *
 * @example
 * import { defineVaporCustomElement } from 'vapor-chamber';
 * const MyEl = defineVaporCustomElement({
 *   props: { label: String },
 *   // A Vapor setup() returns a BLOCK - real DOM nodes - not a render
 *   // function or h() output. An SFC's compiler builds this from its template.
 *   setup(props) {
 *     const span = document.createElement('span');
 *     span.textContent = String(props.label);
 *     return span;
 *   }
 * });
 * if (MyEl) customElements.define('vc-greeting', MyEl);
 */
export function defineVaporCustomElement<T = any>(options: object, extraOptions?: object): T | null {
  const fn = getDefineVaporCustomElementFn();
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporCustomElement");
    return null;
  }
  return (extraOptions !== undefined ? fn(options, extraOptions) : fn(options)) as T;
}

/**
 * defineVaporComponent - define a Vapor component with proper type inference.
 *
 * Wraps Vue's `defineVaporComponent()`. Use this to get full
 * TypeScript inference for props, emits, and slots in Vapor components.
 * Pass-through - emits/$attrs routing, v-once interop, scope IDs, and the
 * compiler optimizations are Vue behavior (per-beta detail: CHANGELOG /
 * whitepaper alignment log).
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected.
 *
 * @example
 * import { defineVaporComponent } from 'vapor-chamber';
 * const Comp = defineVaporComponent({
 *   props: { count: Number },
 *   emits: ['change'],
 *   // Returns DOM nodes (a block), not h(): see defineVaporCustomElement above.
 *   setup(props) {
 *     const div = document.createElement('div');
 *     div.textContent = `Count: ${props.count}`;
 *     return div;
 *   }
 * });
 */
export function defineVaporComponent<T = any>(options: object): T | null {
  const fn = getDefineVaporComponentFn();
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporComponent");
    return null;
  }
  return fn(options) as T;
}

/**
 * defineVaporAsyncComponent - define an async Vapor component for lazy loading.
 *
 * Wraps Vue's `defineVaporAsyncComponent()`. Async Vapor
 * components are cached by VaporKeepAlive and hydrate under VDOM Suspense.
 * The loading placeholder receives the deferred component's props and slots
 * (beta.14+) - render a skeleton matching the final shape. Per-beta detail:
 * CHANGELOG / whitepaper alignment log.
 *
 * Returns null if the Vapor runtime (Vue 3.6+) is not detected.
 *
 * @example
 * import { defineVaporAsyncComponent } from 'vapor-chamber';
 * const AsyncPanel = defineVaporAsyncComponent(() => import('./Panel.vue'));
 */
export function defineVaporAsyncComponent<T = any>(
  loader: (() => Promise<unknown>) | object,
): T | null {
  const fn = getDefineVaporAsyncComponentFn();
  if (!fn) {
    if (DEV) devWarnNoVapor("defineVaporAsyncComponent");
    return null;
  }
  return fn(loader) as T;
}

// ---------------------------------------------------------------------------
// defineVaporCommand
// ---------------------------------------------------------------------------

/** `defineVaporCommand`'s options: how the handler registers, and on which bus. */
export type VaporCommandOptions<B extends BaseBus = BaseBus, D extends number | undefined = undefined, T extends number | undefined = undefined> = RegisterOptions & BusOption<B> & PaceOption<D, T>;

/**
 * defineVaporCommand - a command for hot paths in Vapor mode: one action, its
 * handler registered with the composable, and a dispatch that writes no state.
 *
 * Ideal for high-frequency, fire-and-forget patterns where no busy or error
 * state is shown: scroll-position tracking, mousemove
 * sampling, telemetry / metrics events, debounced search, autosave.
 * `{ debounce: ms }` or `{ throttle: ms }` paces the dispatch at the sender
 * (`pace`): a paced dispatch returns a promise.
 *
 * One handler per action, the newest registration still live: two pages
 * that define one action each answer while on screen, the older one again
 * once the newer unmounts, and a page cached by KeepAlive releases its
 * handler until it returns. tests/register-live-owner-fixture.test.ts.
 *
 * @example
 * const { dispatch } = defineVaporCommand('telemetryEvent', (cmd) => {
 *   // forward to whatever metrics / analytics SDK you use
 *   sendMetric(cmd.target.name, cmd.target.params);
 * });
 * dispatch({ name: 'page_view', params: { page: '/landing' } });
 */
export function defineVaporCommand<B extends BaseBus = CommandBus, D extends number | undefined = undefined, T extends number | undefined = undefined>(
  action: string,
  handler: Handler,
  options?: VaporCommandOptions<B, D, T>
) {
  const bus = resolveBus(options?.bus);
  // The options go to register() as they are: it reads the register fields,
  // and an undo's stored copy keeps `bus` and the pace, which nothing reads.
  let unregister: (() => void) | null = bus.register(action, handler, options);

  // `untracked`, like every other composable's dispatch: a dispatch is an
  // ACTION, not a read, and a hot-path call is the one most likely made from
  // inside a render effect, where the handler's reads would become that
  // effect's dependencies. Pass-through when Vue is absent.
  function direct(target: any, payload?: any): PacedOn<B, CommandResult, D, T> {
    return untracked(() => bus.dispatch(action, target, payload)) as PacedOn<B, CommandResult, D, T>;
  }

  // Paced at the sender when an option says so, decided here (as useCommand).
  let dispatch = direct;
  let paced: Paced | undefined;
  const pacing = _paceOf(options);
  if (pacing !== undefined) {
    const p = (paced = pace((_action, target, payload, o) => untracked(() => bus.dispatch(action, target, payload, o)), pacing));
    dispatch = ((target: any, payload?: any) => p(action, target, payload)) as typeof direct;
  }

  function dispose() { paced?.dispose(); unregister?.(); unregister = null; }

  // A page cached by KeepAlive releases its handler and takes it back when it
  // returns, so the page on screen answers, as useCommand().register does.
  // tests/register-live-owner-fixture.test.ts.
  tryKeepAliveHooks(
    () => { unregister?.(); unregister = null; },
    () => { unregister ??= bus.register(action, handler, options); },
  );

  tryAutoCleanup(dispose);

  return { dispatch, dispose };
}

// ---------------------------------------------------------------------------
// useVaporAsyncCommand
// ---------------------------------------------------------------------------

/**
 * useVaporAsyncCommand - async-aware command dispatch for Vapor components
 * used inside Suspense boundaries.
 *
 * Vue 3.6.0-beta.10+ hydrates async components under VDOM Suspense. This
 * composable wraps an AsyncCommandBus dispatch, untracked, and
 * gives `pending(action, target?)` (the bus's command state for that key,
 * `commandState`), making it safe for `<script setup vapor>` components that
 * await async operations. Error-boundary rendering and scheduler-flush
 * behavior around async components are Vue runtime concerns (per-beta detail:
 * CHANGELOG / whitepaper alignment log).
 *
 * The dispatch function returns a Promise<CommandResult>, matching the
 * AsyncCommandBus interface. Use this when your commands hit async transports
 * (httpTransport, wsTransport) and you need awaitable results. A dispatch's
 * own failure is its result.
 *
 * Vue 3.6.0-rc.8: an awaiting `<script setup vapor>` compiles to an
 * `async setup()` that uses runtime-core's `withAsyncContext` and returns its
 * template as a render closure, and it registers with the NEAREST `<Suspense>`.
 * Composables called after the `await` - this one, `useCommand()` - arm their
 * cleanup on the restored component scope, including when the app unmounts
 * during the await. Pinned by tests/async-vapor-setup-fixture.test.ts.
 *
 * @example
 * // In a <script setup vapor> component under <Suspense>:
 * import { useVaporAsyncCommand } from 'vapor-chamber';
 * const { dispatch, pending } = useVaporAsyncCommand(asyncBus);
 * const creating = pending('orderCreate');
 * const result = await dispatch('orderCreate', { items: cart });
 */
export function useVaporAsyncCommand(asyncBus?: { dispatch: (action: string, target: any, payload?: any) => Promise<CommandResult> }) {
  const bus: any = resolveBus(asyncBus as BaseBus | undefined);
  // Held from the first pending() call, released with the composable.
  var state: CommandState | undefined;

  // Intentionally hand-rolled, NOT routed through chamber.ts's runCommand. A
  // single async/await is ~1.2x leaner on the dispatch wrapper than a
  // .then-chain (measured); this is the awaited HTTP/WS path, so keep
  // it lean. Do not "consolidate" - the consistency isn't worth the wrapper
  // overhead here.
  async function dispatch(action: string, target: any, payload?: any): Promise<CommandResult> {
    try {
      // Untracked around the SYNCHRONOUS entry only - once the dispatch
      // suspends, the caller's effect has finished and there is no subscriber
      // left to leak into (pinned by the "synchronous entry is the whole
      // exposure" test).
      return await untracked(() => bus.dispatch(action, target, payload));
    } catch (e) {
      return _errResult(e as Error);
    }
  }

  /** In flight for this key, bus-wide (`commandState`'s `pending`). */
  function pending(action: string, target?: unknown): Readonly<Signal<boolean>> {
    return (state ??= commandState(bus)).pending(action, target);
  }

  function dispose() {
    state?.dispose();
    state = undefined;
  }

  tryAutoCleanup(dispose);

  return { dispatch, pending, dispose };
}

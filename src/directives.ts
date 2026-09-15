/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * Vue alignment history (one line per version - full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log" table):
 *   v1.20.0 - LIB-SIDE: `vcCommandVapor`, v-vc:command's Vapor registration -
 *          the function shape `withVaporDirectives` calls, over the same
 *          buildHandler. The install-time "not ported to Vapor" warning is
 *          gone with it.
 *   rc.5 - pass-through. Two upstream commits independently reached rules this
 *          file already applied (direct listeners, per-Document delegation).
 *   rc.2 - pass-through; Vue's compiled `@click` delegation flips to opt-in
 *          (#15127). LIB-SIDE: v-vc:command gains its own `.delegate` opt-in.
 *   beta.17 / beta.16 - pass-through. LIB-SIDE in beta.16: v-vc:command honors
 *          event modifiers (.stop/.prevent/.self/.left/.middle/.right/.capture/
 *          .once/.passive), which the direct listener had been dropping.
 *   v1.6.0 / beta.15 - buildHandler() skips dispatch on disabled /
 *          aria-disabled / in-flight elements, mirroring #14948 for the DIRECT
 *          listener this directive attaches.
 *   v1.4.0 / beta.13 - pass-through (shared event invoker wrapping).
 *   v0.4.4 - Added: v-vc:command, v-vc:optimistic directives.
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

import { DEV } from './dev';
import { getCommandBus } from './chamber';
import type { Command, CommandMap, CommandResult } from './command-bus';
import { _errResult } from './command-bus';

// ---------------------------------------------------------------------------
// Internal state per element (stored via WeakMap)
// ---------------------------------------------------------------------------

/** Default timeout for async dispatch in ms. Prevents infinite loading states. */
const DEFAULT_DISPATCH_TIMEOUT = 30_000;

type DirectiveState = {
  action: string;
  /** Vapor only: the binding's getter, read at dispatch time - see vcCommandVapor. */
  actionOf?: () => unknown;
  payload?: any;
  target?: any;
  optimisticFn?: (cmd: Command) => (() => void) | null;
  loading: boolean;
  error: Error | null;
  handler: (event: Event) => void;
  rollback?: (() => void) | null;
  /** Timeout in ms for async dispatch. Default: 30_000 */
  timeout: number;
  /** `.stop` - call event.stopPropagation() before dispatch. */
  stop?: boolean;
  /** `.prevent` - call event.preventDefault() before dispatch. */
  prevent?: boolean;
  /** `.self` - only dispatch when event.target is the bound element. */
  self?: boolean;
  /** Allowed mouse buttons from `.left`/`.middle`/`.right` (0/1/2). Empty = any. */
  buttons?: number[];
  /** `.capture` - capture-phase listener. Also matched on removeEventListener. */
  capture?: boolean;
  /** `.delegate` - dispatched via the shared document-level listener instead of
   *  a direct one on this element. See "Opt-in delegation" below. */
  delegate?: boolean;
  /** The document this element's delegated listener was counted against.
   *  Recorded at mount so teardown decrements the RIGHT document - an element
   *  can be moved between documents, and `ownerDocument` at unmount time is
   *  not necessarily the one it registered with. */
  delegatedDoc?: Document | null;
};

const stateMap = new WeakMap<Element, DirectiveState>();

// ---------------------------------------------------------------------------
// Opt-in delegation (.delegate modifier) - lib-side, not required by Vue
// ---------------------------------------------------------------------------
//
// MEASURED (tests/perf.bench.ts, 5k elements), because the intuitive reading
// is wrong: mount+unmount is ~1.3x SLOWER in delegate mode, not faster. The
// payoff is the standing LISTENER COUNT while mounted (1 vs N), not attach or
// detach speed. Do not reach for `.delegate` as a mount-cost optimization - it
// is a memory / retained-listener trade for large, mostly-static lists, which
// is Vue's own reasoning for the same default.
//
// Mirrors the trade-off Vue 3.6.0-rc.2 made opt-in for compiled `@click`
// (#15127): one shared listener instead of one per element, at the cost that
// an ancestor's `.stop` can pre-empt a delegated descendant before the event
// ever reaches the shared listener. Same reason it defaults OFF here.
//
// Simplified vs. Vue's own compiler-vapor delegation (which replays every
// matching listener along the DOM path): only the CLOSEST delegated ancestor
// of the click target fires. v-vc:command elements are leaf controls
// (buttons/links) in practice - nesting two dispatching elements isn't a
// supported pattern in delegate mode; use the default (direct) mode for that.
// Delegated elements are counted PER DOCUMENT. A single count + a single
// `delegatedListenerDoc` meant the listener only ever attached to whichever
// document happened to register first: delegated elements in an iframe or a
// `window.open` popup bumped the count and got no listener at all, and
// unmounting the first document's elements while others remained stranded the
// listener on the wrong document. Both failed as SILENT no-dispatch - the
// control renders, clicks do nothing, no error - which is the worst shape for
// an opt-in perf flag, because turning `.delegate` on CONVERTS WORKING
// CONTROLS INTO DEAD ONES.
const delegatedDocs = new Map<Document, number>();

function delegatedClickHandler(event: Event): void {
  // composedPath crosses shadow boundaries; a parentElement walk stops at the
  // shadow root, and at document level `event.target` has been retargeted to
  // the shadow HOST - so the stateMap lookup never found the real element and
  // a delegated control inside a shadow root simply never dispatched.
  // `router/dom.ts` link interception documents this same fix; the delegated
  // handler predates that lesson.
  const path = event.composedPath?.();
  if (path) {
    for (const node of path) {
      const state = stateMap.get(node as Element);
      if (state?.delegate) {
        state.handler(event);
        return;
      }
      // Stop at the document - beyond it the path holds Window, and an
      // ancestor match outside the event's tree is not ours to fire.
      if ((node as Node).nodeType === 9 /* DOCUMENT_NODE */) break;
    }
    return;
  }
  // Fallback for environments without composedPath (same shape as dom.ts).
  let node = event.target as Element | null;
  while (node) {
    const state = stateMap.get(node);
    if (state?.delegate) {
      state.handler(event);
      return;
    }
    node = node.parentElement;
  }
}

function addDelegatedElement(el: Element): Document {
  const doc = el.ownerDocument; // Element.ownerDocument is non-null (lib.dom)
  const count = delegatedDocs.get(doc) ?? 0;
  if (count === 0) doc.addEventListener('click', delegatedClickHandler);
  delegatedDocs.set(doc, count + 1);
  return doc;
}

function removeDelegatedElement(doc: Document | null): void {
  if (!doc) return;
  const count = delegatedDocs.get(doc);
  if (count === undefined) return;
  if (count <= 1) {
    doc.removeEventListener('click', delegatedClickHandler);
    delegatedDocs.delete(doc);
    return;
  }
  delegatedDocs.set(doc, count - 1);
}

// ---------------------------------------------------------------------------
// v-vc:command
// ---------------------------------------------------------------------------
//
// Binding value: action name string (e.g. 'cartAdd')
// arg: 'command' (used as the directive name)
// Modifiers (the directive attaches a DIRECT listener, so Vue's compiled
// withModifiers never reaches it - they are applied here by hand):
//   .stop .prevent .self        - DOM-event guards/actions, like v-on
//   .left .middle .right        - only dispatch for that mouse button
//   .capture .once .passive     - addEventListener options
//   .delegate                   - one shared document listener instead of a
//                                  per-element one (see "Opt-in delegation"
//                                  above); incompatible with .capture/.once/
//                                  .passive, which fall back to a direct
//                                  listener with a dev warning if combined
//   .<number> (e.g. .5000)      - async dispatch timeout in ms (default 30000)
//
// Additional data attributes read from the element:
//   data-vc-payload - JSON-encoded payload (optional)
//   data-vc-target  - JSON-encoded target (optional, defaults to {})
//
// CSS classes added to the element:
//   vc-loading  - while the dispatch is in flight
//   vc-error    - when the last dispatch failed
//   vc-success  - briefly added on success (removed after 1 tick)

const LOADING_CLASS = 'vc-loading';
const ERROR_CLASS = 'vc-error';

function parseJson(s: string | null | undefined): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function buildHandler(el: Element, state: DirectiveState): (event: Event) => void {
  return async (event: Event) => {
    // Event modifiers - mirror Vue's compiled withModifiers, which never reaches a
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

    // Vapor: the binding is a getter and there is no `updated` hook, so the
    // action is read here, at dispatch time - see vcCommandVapor.
    if (state.actionOf) state.action = String(state.actionOf());

    const bus = getCommandBus<CommandMap>();

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
        result = _errResult(e as Error);
      }

      // Handle result (may be a Promise if using async bus shim)
      if (result && typeof (result as any).then === 'function') {
        // Race against timeout to prevent infinite loading states. Clear the
        // timer when the dispatch wins the race - otherwise every click leaves
        // a live timer (default 30s) pinning this closure.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<CommandResult>((resolve) => {
          timeoutId = setTimeout(
            () => resolve(_errResult(new Error(`Directive dispatch "${state.action}" timed out after ${state.timeout}ms`))),
            state.timeout
          );
        });
        try {
          resolved = await Promise.race([(result as unknown as Promise<any>), timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        resolved = result;
      }
    } catch (e) {
      resolved = _errResult(e as Error);
    } finally {
      // Always reset loading state - prevents stuck buttons
      state.loading = false;
      el.classList.remove(LOADING_CLASS);
      if (el instanceof HTMLButtonElement) el.disabled = false;
    }

    if (!resolved.ok) {
      state.error = resolved.error ?? null; // undefined -> null for state.error (Error | null); the branch is type-required
      el.classList.add(ERROR_CLASS);
      if (rollback) {
        try { rollback(); } catch { /* ignore */ }
      }
    }
  };
}

/**
 * Attach v-vc:command to `el` - the part the vDOM and Vapor registrations
 * share. `actionOf` is the Vapor binding's getter (see vcCommandVapor); the
 * vDOM path passes the action itself and keeps it current from `updated`.
 */
function mountCommand(
  el: Element,
  action: string,
  modifiers: Record<string, boolean> | undefined,
  actionOf?: () => unknown,
): void {
  // One v-vc:command per element: the state is keyed by element. A render
  // function can list the directive twice (a template cannot), and a second
  // mount used to overwrite the first's state and strand its listener - so
  // detach whatever the element carries first, and the last binding wins.
  unmountCommand(el);

  const mods: Record<string, boolean> =
    (modifiers && typeof modifiers === 'object') ? modifiers : {};

  const timeout = parseInt(Object.keys(mods).find(k => /^\d+$/.test(k)) ?? '', 10) || DEFAULT_DISPATCH_TIMEOUT;

  const buttons: number[] = [];
  if (mods.left) buttons.push(0);
  if (mods.middle) buttons.push(1);
  if (mods.right) buttons.push(2);

  // .delegate shares one document-level listener, so it has nowhere to
  // hang per-element addEventListener options. Mirrors Vue's own
  // compiler-vapor warning for the same incompatible combo (#15127):
  // "delegate modifier is not supported... the listener will be
  // attached directly."
  let delegate = !!mods.delegate;
  if (delegate && (mods.capture || mods.once || mods.passive)) {
    if (DEV) {
      console.warn(
        '[vapor-chamber] v-vc:command.delegate is incompatible with ' +
        '.capture/.once/.passive (delegation shares one document-level ' +
        'listener with no per-element options). Attaching a direct ' +
        'listener instead.'
      );
    }
    delegate = false;
  }

  const state: DirectiveState = {
    action,
    actionOf,
    loading: false,
    error: null,
    handler: () => {},
    timeout,
    stop: !!mods.stop,
    prevent: !!mods.prevent,
    self: !!mods.self,
    buttons,
    capture: !!mods.capture,
    delegate,
  };

  state.handler = buildHandler(el, state);
  stateMap.set(el, state);

  if (delegate) {
    state.delegatedDoc = addDelegatedElement(el);
    return;
  }

  const listenerOpts: AddEventListenerOptions = {};
  if (mods.capture) listenerOpts.capture = true;
  if (mods.once) listenerOpts.once = true;
  if (mods.passive) listenerOpts.passive = true;
  el.addEventListener('click', state.handler, listenerOpts);
}

/** Detach what mountCommand attached: the listener (or the delegated count) and the state. */
function unmountCommand(el: Element): void {
  const state = stateMap.get(el);
  if (!state) return;
  if (state.delegate) {
    removeDelegatedElement(state.delegatedDoc ?? null);
  } else {
    el.removeEventListener('click', state.handler, state.capture ? { capture: true } : undefined);
  }
  stateMap.delete(el);
}

// ---------------------------------------------------------------------------
// Vapor registration
// ---------------------------------------------------------------------------

/**
 * vcCommandVapor - v-vc:command for Vapor components.
 *
 * The same directive as the vDOM plugin's - same `buildHandler`, modifiers,
 * CSS classes, `data-vc-payload` / `data-vc-target`, `.delegate` - in the
 * shape Vapor's `withVaporDirectives` calls: `(el, value, argument, modifiers)
 * => cleanup`, run once per element inside a detached scope that runs the
 * returned cleanup on unmount.
 *
 * Vapor has no `updated` hook and hands the binding over as a GETTER, so the
 * action is read from it at dispatch time: a changed binding re-targets the
 * next click without the directive re-running
 * (tests/vapor-directives-fixture.test.ts pins that it does not). The getter is
 * read rather than tracked with an effect on purpose: tracking needs
 * `renderEffect`, which exists only in Vue's Vapor build, and a static import
 * of it would break this subpath for every Vue 3.5 consumer of the vDOM
 * plugin.
 *
 * `v-vc:payload` and `v-vc:optimistic` remain vDOM registrations; in Vapor the
 * payload travels as `data-vc-payload`.
 *
 * @example
 * <script setup vapor>
 * import { vcCommandVapor as vVc } from 'vapor-chamber/directives';
 * </script>
 * <template>
 *   <button v-vc:command.stop="'cartAdd'" data-vc-payload='{"id":1}'>Add</button>
 * </template>
 *
 * // or app-wide: createVaporApp(App).directive('vc', vcCommandVapor)
 */
export function vcCommandVapor(
  el: Element,
  value: () => unknown,
  argument?: string,
  modifiers?: Record<string, boolean>,
): (() => void) | undefined {
  if (argument !== 'command') return;
  mountCommand(el, String(value()), modifiers, value);
  return () => unmountCommand(el);
}

// ---------------------------------------------------------------------------
// Vue plugin
// ---------------------------------------------------------------------------

/**
 * createDirectivePlugin - installs v-vc:command and v-vc:optimistic directives.
 *
 * Opt-in: import and use this plugin only when you need template directives.
 * Zero cost when not imported. In Vapor components use {@link vcCommandVapor}.
 */
export function createDirectivePlugin(): { install(app: any): void } {
  return {
    install(app: any) {
      // The vDOM registration. One `app.directive('vc', ...)` cannot serve
      // both renderers - Vapor wants a plain function and has no `updated`
      // hook - so Vapor has its own export, `vcCommandVapor`, over the same
      // handler. The install-time warning that stood here (the port did not
      // exist) is gone with it.

      /**
       * v-vc:command="'actionName'"
       *
       * Attaches a click handler that dispatches the named command.
       * Adds/removes .vc-loading and .vc-error CSS classes automatically.
       */
      app.directive('vc', {
        mounted(el: Element, binding: { arg?: string; value: any; modifiers: Record<string, boolean> }) {
          if (binding.arg !== 'command') return;
          mountCommand(el, binding.value as string, binding.modifiers);
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
          unmountCommand(el);
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

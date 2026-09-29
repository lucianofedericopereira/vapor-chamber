/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * The rules this file keeps (the history is in CHANGELOG.md and the
 * whitepaper's Vue 3.6 alignment log, section 9.2):
 *   - THE NAME CARRIES THE SELECTOR: `vc-command`, `vc-payload`,
 *     `vc-optimistic`. Vue's directive argument is a parameter slot (a getter
 *     in compiled Vapor, #15490), so nothing here reads it - see
 *     {@link vcCommandVapor}.
 *   - `vcCommandVapor` is the function shape `withVaporDirectives` calls, over
 *     the same `buildHandler` as the vDOM hooks.
 *   - Direct listeners, one per element, per Document; `.delegate` opts in to
 *     delegation, as Vue's compiled `@click` does (#15127).
 *   - Event modifiers are honoured (.stop/.prevent/.self/.left/.middle/.right/
 *     .capture/.once/.passive).
 *   - `buildHandler()` skips dispatch on a disabled, aria-disabled or
 *     in-flight element, as Vue does for its own listeners (#14948).
 *   - TEARDOWN IS KEYED TO WHAT WAS MOUNTED, never to the current binding. See
 *     the `beforeUnmount` note in the plugin below.
 *
 * Provides a Vue plugin that installs three directives for declarative command
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
 * <button v-vc-command="'cartAdd'" v-vc-payload="{ id: product.id }">
 *   Add to cart
 * </button>
 *
 * <!-- optimistic: immediately apply state before server confirms -->
 * <button v-vc-command="'orderCancel'"
 *         v-vc-optimistic="onOptimisticCancel">
 *   Cancel order
 * </button>
 *
 * THE SPELLING HAS ONE FORM: `v-vc-payload`, never `:v-vc-payload` (a bound
 * attribute of that name, not a directive) nor a colon form. The name carries
 * the selector, so a wrong name fails to resolve loudly.
 */

import { DEV } from './dev';
import { announce } from './a11y';
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
  /** Vapor only: the `v-vc-payload` binding's getter, read at dispatch time.
   *  Vapor has no `updated` hook, so the same rule `actionOf` follows applies -
   *  read the getter when the click happens and a changed binding re-targets
   *  the next dispatch without the directive re-running. */
  payloadOf?: () => unknown;
  /** Vapor only: the `v-vc-optimistic` binding's getter, read at dispatch. */
  optimisticOf?: () => unknown;
  loading: boolean;
  error: Error | null;
  handler: (event: Event) => void;
  /** Keyboard activation added to a non-native `role="button"` element; see wireKeyboard. */
  keys?: { down: (event: KeyboardEvent) => void; up: (event: KeyboardEvent) => void };
  /** The directive made the element focusable, so teardown takes it back. */
  addedTabindex?: boolean;
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
  /** The exact options object `addEventListener` was called with, kept so
   *  `removeEventListener` is handed THE SAME ONE: two shapes built apart
   *  drift the moment one side gains an option, and removal then silently
   *  stops matching and the listener stays attached. */
  listenerOpts?: AddEventListenerOptions;
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

/**
 * Payload / optimistic bindings that ran BEFORE `v-vc-command` on the same
 * element, held until the command mounts and claims them. BOTH RENDERERS.
 *
 * WHY IT EXISTS, and it is not defensive programming. A compiled template
 * applies an element's directives in SOURCE ORDER, and `mountCommand()` opens
 * by calling `unmountCommand()`, which DELETES whatever state the element
 * carries. So without this slot,
 *
 *     <button v-vc-payload="p" v-vc-command="a">
 *
 * writes the payload into state that the command then throws away: the button
 * dispatches, with no payload, silently. That is the same dead-control shape
 * #15490 produced (tests/directives-vapor-fixture.test.ts measures both
 * orders).
 *
 * IT COVERS vDOM TOO. The vDOM `updated` hook re-applies the binding after a
 * re-render, but that answers for the SECOND click: measured on the first
 * click with no re-render since mount, `v-vc-payload` before `v-vc-command`
 * dropped the payload and `v-vc-optimistic` before it never ran. On a page
 * with no reactive state (the Blade/sprinkled shape) there is no next patch at
 * all, so an `updated` hook is not a substitute for arriving in order.
 *
 * Keyed by element and weak, so an element that never gets a command takes its
 * unclaimed slot with it when it is collected.
 */
type PendingSlot = Partial<Pick<DirectiveState, 'payloadOf' | 'optimisticOf' | 'payload' | 'optimisticFn'>>;
const pending = new WeakMap<Element, PendingSlot>();

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
// of the click target fires. v-vc-command elements are leaf controls
// (buttons/links) in practice - nesting two dispatching elements isn't a
// supported pattern in delegate mode; use the default (direct) mode for that.
// Delegated elements are counted PER DOCUMENT. Counting them globally instead
// strands the listener on whichever document registered first: delegated
// elements in an iframe or a `window.open` popup get no listener at all, and
// clicks do nothing with no error - turning `.delegate` on must never CONVERT
// WORKING CONTROLS INTO DEAD ONES.
//
// A DELEGATED CONTROL DOES NOT SURVIVE BEING MOVED TO ANOTHER DOCUMENT. The
// listener is on the document the element was mounted in; adopt the element
// into a second document and its clicks reach nothing, silently. MEASURED with
// `document.adoptNode` (tests/directives-vapor-fixture.test.ts). A direct
// listener travels with the element and is unaffected, so this is a limit of
// `.delegate` alone. It is declared rather than fixed: detecting adoption
// would mean watching every delegated element for a document change, which is
// a standing cost on every consumer to rescue a case none of them has. Move a
// control between documents and use the default mode for it.
//
// Teardown, unlike dispatch, DOES survive the move: the document is recorded
// in `delegatedDoc` at mount, so unmounting after an adoption decrements the
// document the listener was counted against rather than the one the element
// ended up in.
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
// v-vc-command
// ---------------------------------------------------------------------------
//
// Binding value: action name string (e.g. 'cartAdd')
// No argument. The selector is the NAME - `vc-command` - so there is nothing
// here to read from Vue's argument slot and nothing for a dynamic argument to
// switch. That slot is a PARAMETER in Vue's design (`v-bind:href`,
// `v-on:click`), reactive since #15490; using it to say WHICH directive this
// is was the category error that made `v-vc:command` a dead control on rc.9.
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
// Both are for styling only; a screen reader cannot see a class. What they
// mean is also said semantically: in flight, `aria-disabled` on a button (see
// markBusy); on failure, the failure's message announced through the
// document's shared live region (src/a11y.ts), focus left where it is.
//
// DO NOT put `:class` or `v-bind:class` on an element carrying this directive,
// and do not bind `:aria-disabled` on it either. The directive writes them
// directly: `classList.add`/`remove` for the two classes above, and
// `aria-disabled` on a button while it is in flight (never `disabled`, which
// sends keyboard focus to <body>; see markBusy).
// Vue diffs a binding against ITS OWN previous value, not against the
// DOM, so the next update of that binding overwrites what the directive wrote
// and the control silently stops showing that it is working. Nothing throws.
// A STATIC `class="..."` attribute is fine and was measured so: it is applied
// at mount and never re-patched, so it competes with nothing.
//
// A dispatch with NO target does not match `isLoading(action)`. The directive
// substitutes `{}` when no target is present (see `data-vc-target` above),
// while `isLoading(action)` asks for the key with no target at all, and those
// are two different keys. The `vc-loading` CLASS still lands, so anything
// styled off the class works while anything rendered off `isLoading` does not
// - which is why this reads as a styling quirk rather than a mismatch. Give
// the element a target, or drive the spinner off the class.

const LOADING_CLASS = 'vc-loading';
const ERROR_CLASS = 'vc-error';

function parseJson(s: string | null | undefined): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Swallows every press while a dispatch is in flight: no listener, no default action. */
function inFlightGuard(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Mark a button busy for the length of one dispatch and return the undo.
 *
 * Not `disabled`: HTML's focus fixup rule answers it by moving a keyboard
 * user's focus to <body>, for good (tests/browser/command-focus.browser.test.ts,
 * real Chromium). What `disabled` would do is kept by hand, pinned by the same
 * file: `preventDefault` stops
 * the press that started the dispatch from submitting a form, and a capture
 * listener lets no further press reach any listener until the dispatch lands.
 * The listener exists only while in flight, so `.delegate` still attaches
 * nothing per element at rest. `aria-disabled` is restored to exactly what it
 * was, so a value the app set survives the dispatch.
 *
 * NOT `aria-busy`: it tells assistive technology to
 * hold off on the element's CONTENT, and a button's content is its accessible
 * name, so a screen reader can stop reading the label of the button the user
 * is on - while it announces nothing at the press. Saying "saving" in words is
 * the app's to do (a live region, in its own language); styling uses
 * `vc-loading`.
 */
function markBusy(el: HTMLElement, event: Event): () => void {
  event.preventDefault();
  const ariaDisabled = el.getAttribute('aria-disabled');
  el.setAttribute('aria-disabled', 'true');
  el.addEventListener('click', inFlightGuard, true);
  return () => {
    el.removeEventListener('click', inFlightGuard, true);
    if (ariaDisabled === null) el.removeAttribute('aria-disabled');
    else el.setAttribute('aria-disabled', ariaDisabled);
  };
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

    // Vapor: the bindings are getters and there is no `updated` hook, so they
    // are read here, at dispatch time - see vcCommandVapor. Writing them onto
    // the same fields the vDOM hooks write means everything below this point
    // is renderer-agnostic, and the payload precedence (binding over
    // `data-vc-payload`) is identical on both by construction rather than by
    // being implemented twice.
    if (state.actionOf) state.action = String(state.actionOf());
    if (state.payloadOf) state.payload = state.payloadOf();
    if (state.optimisticOf) state.optimisticFn = state.optimisticOf() as DirectiveState['optimisticFn'];

    const bus = getCommandBus<CommandMap>();

    state.loading = true;
    state.error = null;
    el.classList.add(LOADING_CLASS);
    el.classList.remove(ERROR_CLASS);
    // A button to assistive technology: native, or by role. A link is not -
    // its press is navigation - and keeps its own behaviour.
    const busy = el instanceof HTMLButtonElement ||
      (typeof el.getAttribute === 'function' && el.getAttribute('role') === 'button')
      ? markBusy(el as HTMLElement, event)
      : null;

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
      busy?.();
    }

    if (!resolved.ok) {
      state.error = resolved.error ?? null; // undefined -> null for state.error (Error | null); the branch is type-required
      el.classList.add(ERROR_CLASS);
      // `vc-error` is for styling; a screen reader cannot see a class. A failed
      // command is a status message (WCAG 4.1.3): announced through the
      // document's shared live region, focus left where it is, in the failure's
      // own words (a backend problem's `detail`, localized). An app
      // that wants other words takes the announcing over (a11y.ts, setAnnouncer).
      if (state.error?.message) announce(state.error.message, { assertive: true });
      if (rollback) {
        try { rollback(); } catch { /* ignore */ }
      }
    }
  };
}

/**
 * True for an element that says it is a button but gets none of a button's
 * keyboard behaviour from the platform: `role="button"` on anything that is not
 * natively activatable (a <button>, an <input>, a link with href, <summary>).
 */
function needsKeyboard(el: Element): el is HTMLElement {
  if (typeof el.getAttribute !== 'function' || el.getAttribute('role') !== 'button') return false;
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) return false;
  if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) return false;
  return el.tagName !== 'SUMMARY';
}

/**
 * Give a non-native `role="button"` element what a <button> has (WCAG 2.1.1,
 * ARIA Authoring Practices, button pattern): focusable, Enter activates on key
 * down, Space on key up with its page scroll prevented. Activation is
 * `el.click()`, so it takes exactly the path a pointer press takes (modifiers,
 * the in-flight state, the app's own click listeners). A key the app already
 * handled (`defaultPrevented`) is left alone, and so is a key from a focusable
 * element inside this one. tests/browser/command-keyboard.browser.test.ts.
 */
function wireKeyboard(el: HTMLElement, state: DirectiveState): void {
  if (!el.hasAttribute('tabindex')) {
    el.tabIndex = 0;
    state.addedTabindex = true;
  }
  let spaceDown = false;
  const down = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.target !== el) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) el.click();
    } else if (event.key === ' ') {
      event.preventDefault();
      spaceDown = true;
    }
  };
  const up = (event: KeyboardEvent): void => {
    if (event.key !== ' ' || !spaceDown) return;
    spaceDown = false;
    if (!event.defaultPrevented) el.click();
  };
  el.addEventListener('keydown', down);
  el.addEventListener('keyup', up);
  state.keys = { down, up };
}

/**
 * Attach v-vc-command to `el` - the part the vDOM and Vapor registrations
 * share. `actionOf` is the Vapor binding's getter (see vcCommandVapor); the
 * vDOM path passes the action itself and keeps it current from `updated`.
 */
function mountCommand(
  el: Element,
  action: string,
  modifiers: Record<string, boolean | undefined> | undefined,
  actionOf?: () => unknown,
): void {
  // One v-vc-command per element: the state is keyed by element. A render
  // function can list the directive twice (a template cannot), and a second
  // mount would overwrite the first's state and strand its listener - so
  // detach whatever the element carries first, and the last binding wins.
  unmountCommand(el);

  // Claimed BEFORE the state literal, not written after it, so the carried
  // slots are part of the one shape every DirectiveState leaves this function
  // with - see the note on `delegatedDoc` / `listenerOpts` in the literal.
  const carried = pending.get(el);
  if (carried) pending.delete(el);

  const mods: Record<string, boolean | undefined> =
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
        '[vapor-chamber] v-vc-command.delegate is incompatible with ' +
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
    delegate,
    // BOTH SLOTS ARE IN THE LITERAL so every DirectiveState leaves this
    // function with one shape. They are written later - `delegatedDoc` on the
    // delegated path, `listenerOpts` on the direct one - and a property added
    // after the literal transitions V8's hidden class, once per mount, on
    // whichever path the element took. Declaring them here costs the literal
    // two `undefined` slots and gives both paths the same map.
    delegatedDoc: undefined,
    listenerOpts: undefined,
    // Same rule, same reason: all four in the literal - the Vapor getters AND
    // the vDOM values - so the hidden class does not depend on the renderer,
    // nor on whether a payload binding ran before the command.
    payloadOf: carried?.payloadOf,
    optimisticOf: carried?.optimisticOf,
    payload: carried?.payload,
    optimisticFn: carried?.optimisticFn,
  };

  state.handler = buildHandler(el, state);
  stateMap.set(el, state);
  if (needsKeyboard(el)) wireKeyboard(el, state);

  if (delegate) {
    state.delegatedDoc = addDelegatedElement(el);
    return;
  }

  const listenerOpts: AddEventListenerOptions = {};
  state.listenerOpts = listenerOpts;
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
    el.removeEventListener('click', state.handler, state.listenerOpts);
  }
  if (state.keys) {
    el.removeEventListener('keydown', state.keys.down as EventListener);
    el.removeEventListener('keyup', state.keys.up as EventListener);
  }
  if (state.addedTabindex) el.removeAttribute('tabindex');
  stateMap.delete(el);
}

// ---------------------------------------------------------------------------
// Vapor registration
// ---------------------------------------------------------------------------

/**
 * vcCommandVapor - v-vc-command for Vapor components.
 *
 * The same directive as the vDOM plugin's - same `buildHandler`, modifiers,
 * CSS classes, `data-vc-payload` / `data-vc-target`, `.delegate` - in the
 * shape Vapor's `withVaporDirectives` calls: `(el, value, argument, modifiers)
 * => cleanup`, run once per element, with the returned cleanup registered
 * through `onScopeDispose` and run on unmount. The third parameter is declared
 * because Vue's call shape has four and the fourth is `modifiers`; it is named
 * `_argument` and never read.
 *
 * WHICH SCOPE, because the two answers behave differently. `withVaporDirectives` opens with
 * `if (node instanceof Element)` and applies synchronously in the CURRENT
 * scope - so for an element target, which is what a compiled
 * `<button v-vc-command>` produces and the only shape documented here, the
 * cleanup lands on the calling component's setup scope. Only a non-element
 * target (a component root, a fragment) gets the detached `EffectScope` that
 * `withVaporDirectives` creates so the root element can be replaced without
 * disposing the owner. Both run `unmountCommand`; they differ in what stops
 * them, which is why `tests/vapor-keepalive-fixture.test.ts` measures the
 * element path rather than reasoning about it.
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
 * `v-vc-payload` and `v-vc-optimistic` WORK ON BOTH RENDERERS - see
 * {@link vcPayloadVapor} and {@link vcOptimisticVapor}.
 *
 * THE ARGUMENT IS NOT READ. Vue's argument is a PARAMETER slot, and #15490
 * made it a getter so a DYNAMIC argument can be reactive (Vue's own test
 * compiles `v-custom:[data.arg]` and expects the attribute to follow
 * `data.arg`). A selector must not move, so it lives in the NAME, where a name
 * cannot be dynamic; a selector in the argument was a dead control in every
 * compiled Vapor template on rc.9, with the whole suite green.
 *
 * (Teardown does not follow the binding either - see the `beforeUnmount` note
 * in the plugin below.)
 *
 * Ordering against a template `@click`, and what each of `buildHandler`'s
 * three guards reads: see the measured note at the end of this file.
 *
 * THE LOCAL BINDING IS NAMED FOR THE WHOLE DIRECTIVE. Vue resolves an SFC
 * directive by camelCasing the full name, so `v-vc-command` looks for
 * `vVcCommand`; an import aliased to anything else (`vVc`) compiles,
 * type-checks and mounts NOTHING - a dead control, the same silent shape
 * #15490 produced. `npm run check:example` catches it.
 *
 * @example
 * <script setup vapor>
 * import { vcCommandVapor as vVcCommand } from 'vapor-chamber/directives';
 * </script>
 * <template>
 *   <button v-vc-command.stop="'cartAdd'" data-vc-payload='{"id":1}'>Add</button>
 * </template>
 *
 * // or app-wide: createVaporApp(App).directive('vc-command', vcCommandVapor)
 */
export function vcCommandVapor(
  el: Element,
  value?: () => unknown,
  _argument?: () => unknown,
  modifiers?: Record<string, boolean | undefined>,
): (() => void) | undefined {
  // `value` IS OPTIONAL, because `<button v-vc-command>` is valid template
  // syntax - it compiles with no errors - and Vue then passes `undefined`
  // here (Vue's own `VaporDirective` declares `value?: () => Value`). Calling
  // it unguarded throws `TypeError: value is not a function` at mount.
  if (value === undefined) {
    if (DEV) {
      console.warn(
        '[vapor-chamber] v-vc-command needs an action to dispatch, e.g. ' +
        'v-vc-command="\'cartAdd\'". Nothing was mounted on this element.'
      );
    }
    return;
  }
  mountCommand(el, String(value()), modifiers, value);
  return () => unmountCommand(el);
}

/**
 * Put a value on the element's command state, or hold it until the command
 * mounts. The one write path for every payload / optimistic binding on either
 * renderer - Vapor stores getters (`payloadOf` / `optimisticOf`, read at
 * dispatch), vDOM stores the bound value itself (`payload` / `optimisticFn`).
 *
 * Order-independent on purpose. See `pending` for what the ordered version
 * costs, which is a silently dead payload.
 *
 * It returns nothing: the vDOM hooks have no teardown to register, and handing
 * them a closure they drop would allocate one per mount for nothing.
 * `vaporSlot` builds the teardown Vapor needs on top of this.
 */
function put(el: Element, key: keyof PendingSlot, value: unknown): void {
  const state = stateMap.get(el);
  if (state) {
    (state as Record<string, unknown>)[key] = value;
    return;
  }
  const slot = pending.get(el) ?? {};
  (slot as Record<string, unknown>)[key] = value;
  pending.set(el, slot);
}

/**
 * The shared half of `vcPayloadVapor` and `vcOptimisticVapor`: `put`, plus the
 * cleanup `withVaporDirectives` registers through `onScopeDispose`.
 */
function vaporSlot(
  el: Element,
  key: 'payloadOf' | 'optimisticOf',
  value?: () => unknown,
): () => void {
  put(el, key, value);
  // Teardown clears whichever place it landed in. Keyed to the element, not to
  // where it went, because the command may have mounted in between.
  return () => {
    const s = stateMap.get(el);
    if (s) s[key] = undefined;
    const p = pending.get(el);
    if (p) p[key] = undefined;
  };
}

/**
 * vcPayloadVapor - `v-vc-payload` for Vapor components.
 *
 * The Vapor port of the vDOM `vc-payload` registration, in the function shape
 * `withVaporDirectives` calls. Sets the payload for the `v-vc-command` on the
 * SAME element, and like the vDOM half it is inert on an element that has no
 * command.
 *
 * The binding is read at DISPATCH time rather than stored at mount, because
 * Vapor has no `updated` hook - so a changed payload reaches the next click
 * without the directive re-running, which is the same rule `vcCommandVapor`
 * follows for the action. A binding beats `data-vc-payload` on both renderers.
 *
 * WHY THIS EXISTS AT ALL, since `data-vc-payload` already worked on both
 * renderers: JSON is lossy and the binding is not. MEASURED on one payload
 * through both paths - a `Date` arrives as a string, a `Map` as `{}`, a class
 * instance as a plain object, a function is dropped and an `undefined` key
 * disappears. A handler that calls `cmd.payload.when.getTime()` works through
 * the binding and throws through the attribute.
 *
 * THE BINDING NAME IS `vVcPayload`, because Vue camelCases the whole directive
 * name. An import aliased to anything shorter compiles, type-checks and mounts
 * nothing - see the note on {@link vcCommandVapor}.
 *
 * @example
 * <script setup vapor>
 * import { vcCommandVapor as vVcCommand, vcPayloadVapor as vVcPayload } from 'vapor-chamber/directives';
 * </script>
 * <template>
 *   <button v-vc-command="'cartAdd'" v-vc-payload="{ id, qty }">Add</button>
 * </template>
 */
export function vcPayloadVapor(el: Element, value?: () => unknown): () => void {
  return vaporSlot(el, 'payloadOf', value);
}

/**
 * vcOptimisticVapor - `v-vc-optimistic` for Vapor components.
 *
 * The Vapor port of the vDOM `vc-optimistic` registration. The bound function
 * receives the `Command` and returns a rollback function (or null); the
 * rollback runs if the dispatch fails.
 *
 * Without it a Vapor template has no optimistic update with rollback: the
 * alternative is to abandon `v-vc-command` for that button and hand-roll the
 * dispatch, which forfeits `vc-loading` / `vc-error`, disable-while-busy, the
 * re-entrancy guard, the timeout and the modifiers - and an `@click` beside
 * the directive cannot do it, because since Vue 3.6.0-rc.9 `80b3a046` that
 * handler registers FIRST and `buildHandler`'s guards let it veto the dispatch.
 *
 * Read at dispatch time, for the same reason as the payload.
 *
 * THE BINDING NAME IS `vVcOptimistic`.
 *
 * @example
 * <script setup vapor>
 * import { vcCommandVapor as vVcCommand, vcOptimisticVapor as vVcOptimistic } from 'vapor-chamber/directives';
 * const bump = (cmd) => { count.value++; return () => { count.value--; }; };
 * </script>
 * <template>
 *   <button v-vc-command="'cartAdd'" v-vc-optimistic="bump">Add</button>
 * </template>
 */
export function vcOptimisticVapor(el: Element, value?: () => unknown): () => void {
  return vaporSlot(el, 'optimisticOf', value);
}

// ---------------------------------------------------------------------------
// Vue plugin
// ---------------------------------------------------------------------------

/**
 * createDirectivePlugin - installs v-vc-command, v-vc-payload and
 * v-vc-optimistic.
 *
 * Opt-in: import and use this plugin only when you need template directives.
 * Zero cost when not imported. In Vapor components use {@link vcCommandVapor}.
 *
 * INSTALLED ON A VAPOR APP IT DOES NOTHING, and says so in DEV. The three
 * registrations below are vDOM OBJECT directives; from Vue 3.6.0-rc.9 a Vapor
 * template skips a non-function directive with a warning of its own (#15489),
 * and before that it called the object and threw. Vue names the symptom
 * ("Received a VDOM object directive"); this names the fix. The check is one
 * own-property read - a Vapor app carries `vapor`, a vDOM app does not - and
 * the whole branch folds out of a production build.
 */
export function createDirectivePlugin(): { install(app: any): void } {
  return {
    install(app: any) {
      if (DEV && app.vapor) {
        console.warn(
          '[vapor-chamber] On a Vapor app use vcCommandVapor.'
        );
      }
      // The vDOM registration. One `app.directive('vc-command', ...)` cannot
      // serve both renderers - Vapor wants a plain function and has no
      // `updated` hook - so Vapor has its own export, `vcCommandVapor`, over
      // the same handler.
      //
      // THE NAME CARRIES THE SELECTOR: all three registrations are spelled the
      // same way. What the split cost is in the header's note on the colon
      // form, which is where someone about to write `v-vc:payload` will be.

      /**
       * v-vc-command="'actionName'"
       *
       * Attaches a click handler that dispatches the named command.
       * Adds/removes .vc-loading and .vc-error CSS classes automatically.
       *
       * A template `@click` on the SAME element runs FIRST and can veto the
       * dispatch through `buildHandler`'s three guards - see the ordering note
       * at the end of this file.
       */
      app.directive('vc-command', {
        mounted(el: Element, binding: { value: any; modifiers: Record<string, boolean> }) {
          mountCommand(el, binding.value as string, binding.modifiers);
        },

        updated(el: Element, binding: { value: any }) {
          const state = stateMap.get(el);
          if (state) {
            state.action = binding.value as string;
          }
        },

        // NO GUARD OF ANY KIND. Teardown is keyed to what was MOUNTED on the
        // element, never to the current binding: Vue passes the LATEST
        // binding here, so a guard on anything the binding says can return
        // early after it changed, and the listener then outlives
        // `app.unmount()` (measured in both modes: `.delegate` strands the
        // shared document listener, a direct one survives on any element that
        // outlives its component). `unmountCommand` already no-ops when the
        // element carries no state.
        beforeUnmount(el: Element) {
          unmountCommand(el);
        },
      });

      /**
       * v-vc-payload="{ ... }"
       *
       * Sets the payload for the v-vc-command on the same element.
       * Must be used alongside v-vc-command.
       */
      app.directive('vc-payload', {
        // `put`, not a direct write, so a payload authored BEFORE the command
        // on the same element is held and claimed rather than dropped. It used
        // to be `if (state) state.payload = ...`, which is a silent no-op in
        // exactly that order - see `pending` for the measurement.
        mounted(el: Element, binding: { value: any }) {
          put(el, 'payload', binding.value);
        },
        updated(el: Element, binding: { value: any }) {
          put(el, 'payload', binding.value);
        },
      });

      /**
       * v-vc-optimistic="fn"
       *
       * Registers an optimistic update function alongside v-vc-command.
       * `fn` receives the Command and returns a rollback function (or null).
       */
      app.directive('vc-optimistic', {
        // Same rule as `vc-payload` above, and the cost of getting it wrong is
        // larger: an optimistic update that never runs takes its rollback with
        // it, so the element shows nothing and rolls back nothing.
        mounted(el: Element, binding: { value: (cmd: Command) => (() => void) | null }) {
          put(el, 'optimisticFn', binding.value);
        },
        updated(el: Element, binding: { value: (cmd: Command) => (() => void) | null }) {
          put(el, 'optimisticFn', binding.value);
        },
      });
    },
  };
}

/*
 * ORDERING AND GUARDS, measured. The long-form rationale for
 * {@link vcCommandVapor}, kept at the end of the file per the house rule for
 * a docblock past roughly fifteen lines. Moved here verbatim; nothing below
 * this line was reworded.
 *
 * WHO RUNS FIRST, when the element also carries a template `@click`. Vue
 * 3.6.0-rc.9 registers the template's listener BEFORE this directive's;
 * rc.8 did the reverse. Upstream `80b3a046` moved compiled custom directives
 * to the END of a block, after props, children and `v-model` - measured on
 * one template with both compilers: rc.8 emitted `_withVaporDirectives` then
 * `_on`, rc.9 emits `_on` then `_withVaporDirectives`. So a template handler
 * now gets to veto the dispatch, and `buildHandler`'s three guards are what
 * read its verdict. They are deliberate, mirroring Vue's #14948
 * for the DIRECT listener this directive attaches, and they stay.
 *
 * WHAT EACH GUARD READS, measured per element type rather than restated:
 *   - `state.loading` is internal; no binding and no handler can reach it, so
 *     re-entrancy stays blocked whatever a template handler does.
 *   - `.disabled === true` reads the DOM PROPERTY. It is a real boolean on
 *     form controls (button, input, select, textarea) and `undefined` on
 *     `<a>` / `<div>` / `<span>` until something assigns it - but an
 *     assignment there is an expando that reads `true` just the same, so
 *     this line fires on EVERY tag, not only on form controls.
 *     WHERE IT DOES THE WORK, which is not where it looks: a form control
 *     disabled BEFORE the click reaches no listener at all, so this read
 *     never runs for it. It earns its place on the two channels the
 *     platform leaves open - a tag the platform never suppresses, and a
 *     control disabled DURING the dispatch, where the event is already in
 *     flight and is not retracted (measured: a listener after the one that
 *     disabled the element still runs). The second is exactly the rc.9
 *     ordering above, so this is the line that reads a template handler's
 *     veto.
 *   - `aria-disabled="true"` reads the ATTRIBUTE: the disable signal every
 *     tag has, and the only one the platform never acts on itself. It is the
 *     line that does real work on `<a>` / `<div>` / `<span>`, which keep
 *     firing clicks while a disabled form control does not.
 *
 * MEASURED, one element carrying both a template `@click` and this directive:
 *
 *     the @click handler does     vDOM      direct    .delegate
 *     nothing                     dispatch  dispatch  dispatch
 *     el.disabled = true          skip      skip      skip
 *     stopImmediatePropagation()  skip      skip      skip
 *     stopPropagation()           dispatch  dispatch  SKIP
 *
 * Two things that table says. rc.9 makes Vapor MATCH vDOM rather than depart
 * from it - Vue patches an element's props before running a directive's
 * `mounted`, so the vDOM registration has run second all along. And
 * `.delegate` is untouched by the move: its listener is on the DOCUMENT and
 * fires during bubbling, after every element-level listener whatever order
 * they registered in, which is also why it is the one mode plain
 * `stopPropagation()` vetoes.
 */

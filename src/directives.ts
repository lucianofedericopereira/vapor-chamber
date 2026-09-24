/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * Vue alignment history (one line per version - full per-item detail lives in
 * CHANGELOG.md and the whitepaper's "Vue 3.6 alignment log", section 9.2):
 *   v1.22.0 - LIB-SIDE: THE SELECTOR MOVED OUT OF THE ARGUMENT AND INTO THE
 *          NAME. `v-vc:command` is now `v-vc-command`, matching
 *          `v-vc-payload` and `v-vc-optimistic`, which were always spelled
 *          that way. The three registered names are `vc-command`,
 *          `vc-payload`, `vc-optimistic`; nothing here reads the argument at
 *          all. Vue's argument is a PARAMETER slot, so using it as a SELECTOR
 *          was a category error - see {@link vcCommandVapor}.
 *   rc.9 - BREAKING upstream, adopted: the directive ARGUMENT became a getter
 *          (#15490), so compiler-vapor emitted `() => ("command")` where rc.8
 *          emitted `"command"`. The old string comparison had made
 *          v-vc:command a dead control in every compiled Vapor template.
 *          Resolved by the v1.22.0 reshape above.
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
 * TEARDOWN IS KEYED TO WHAT WAS MOUNTED, never to the current binding. A
 * standing rule, not history: the argument that exposed it is gone and the
 * rule is not. See the `beforeUnmount` note in the plugin below, which
 * records what it cost to learn.
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
 * THE SPELLING HAS ONE FORM, and the second line of the first example is why
 * it is worth saying. It used to read `:v-vc:payload`, a bound attribute
 * literally named `v-vc:payload` - which is not a directive at all, and would
 * have rendered as an attribute. The colon form resolved `v-vc:payload` to the
 * directive named `vc` with the argument `payload`, whose `mounted` returned
 * early, so it was inert wherever it was written. There is no colon form now:
 * the name carries the selector and a wrong name fails to resolve loudly.
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
   *  `removeEventListener` is handed THE SAME ONE. Only `capture` is matched
   *  by the platform, so the pair used to get away with being different
   *  shapes - mount passed an options object, teardown rebuilt
   *  `{ capture: true }` or `undefined` - and a test comparing the two calls
   *  had to compare capture flags rather than arguments. That works until
   *  someone adds an option on the mount side and not the other, at which
   *  point removal silently stops matching and the listener stays attached
   *  with no error. One object, both calls, nothing to keep in sync. */
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
 * #15490 produced and v1.22.0 removed, and an attribute order a consumer has
 * no reason to think matters is a bad place to reintroduce it. MEASURED both
 * ways before this existed - see the note at the end of
 * tests/directives-vapor-fixture.test.ts.
 *
 * IT COVERS vDOM TOO AS OF THIS CHANGE, and the paragraph that stood here said
 * the opposite: that the vDOM half "needs nothing equivalent", because its
 * `updated` hook re-applies the binding after any re-render, so a payload
 * registered against absent state lands on the next patch. Every word of that
 * is true and it is not the whole question, because it answers for the SECOND
 * click and the element is clickable before the first. MEASURED on vDOM, first
 * click, no re-render since mount:
 *
 *     <button v-vc-command  v-vc-payload>     payload {qty:3}   delivered
 *     <button v-vc-payload  v-vc-command>     payload undefined DROPPED
 *     <button v-vc-optimistic v-vc-command>   optimistic never ran
 *
 * and after one unrelated re-render both start working. So the cost was a
 * silently wrong first dispatch, and on a page with no reactive state - the
 * Blade/sprinkled shape this library exists to serve - there is no next patch
 * and it never works at all. Worse, it made one public spelling mean two
 * things: `v-vc-payload` before `v-vc-command` is order-independent on Vapor
 * and was dead on vDOM, which is the exact asymmetry v1.22.0 section 4a set
 * out to close, reopened from the other side.
 *
 * The claim was the reason nobody looked, which is why it is recorded here
 * rather than deleted: an `updated` hook is not a substitute for arriving in
 * the right order, and the next person to reason from "the patch will fix it"
 * should meet the measurement instead.
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
//
// DO NOT put `:class` or `v-bind:class` on an element carrying this directive,
// and do not bind `:disabled` on it either. The directive writes both directly:
// `classList.add`/`remove` for the two classes above, and `el.disabled` on a
// button. Vue diffs a binding against ITS OWN previous value, not against the
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
  // mount used to overwrite the first's state and strand its listener - so
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
    // two `undefined` slots and gives both paths the same map. The direct path
    // used to be transition-free (it carried `capture` in the literal and
    // wrote nothing afterwards); when `capture` became `listenerOpts` the
    // transition moved onto it, which is what this restores.
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
 * WHICH SCOPE, because the two answers behave differently and this docblock
 * said only the second one until v1.22.0. `withVaporDirectives` opens with
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
 * `v-vc-payload` and `v-vc-optimistic` WORK ON BOTH RENDERERS as of v1.22.0 -
 * see {@link vcPayloadVapor} and {@link vcOptimisticVapor}, which record what
 * the vDOM-only versions cost.
 *
 * THE ARGUMENT IS NOT READ. Until v1.22.0 the argument carried the SELECTOR -
 * it said which of `command` / `payload` / `optimistic` a binding was - and
 * this function opened by comparing it to `'command'`. Vue's argument is a
 * PARAMETER slot, and #15490 made it a getter precisely so a DYNAMIC argument
 * can be reactive: Vue's own test compiles `v-custom:[data.arg]`, reads
 * `arg()` inside a `watchEffect`, and expects the attribute to follow
 * `data.arg`. A selector must not move, so the two requirements were in
 * direct conflict - and the conflict cost a dead control in every compiled
 * Vapor template on rc.9 with the whole suite green. The selector now lives
 * in the NAME, where a name cannot be dynamic, and this function reads
 * nothing from the slot at all.
 *
 * (Teardown never followed the selector rule and still must not - see the
 * `beforeUnmount` note in the plugin below.)
 *
 * Ordering against a template `@click`, and what each of `buildHandler`'s
 * three guards reads: see the measured note at the end of this file.
 *
 * THE LOCAL BINDING IS NAMED FOR THE WHOLE DIRECTIVE, which the rename moved.
 * Vue resolves an SFC directive by camelCasing the full name, so `v-vc-command`
 * looks for `vVcCommand`. Under the old spelling the directive was named `vc`
 * and `command` was its argument, so the binding was `vVc`. An import still
 * aliased to `vVc` compiles, type-checks and mounts NOTHING - a dead control,
 * the same silent shape #15490 produced. `npm run check:example` catches it;
 * it caught it here.
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
  // here. This used to be declared required and went straight to `value()`,
  // so that template threw `TypeError: value is not a function` at mount.
  //
  // The type said it could not happen: Vue's own `VaporDirective` declares
  // `value?: () => Value`, and a required parameter here is not assignable to
  // it. There is a test asserting exactly that assignment - and `tests/` was
  // never typechecked, so it had never once been checked. Widening the
  // parameter is what makes the declaration true and the crash impossible.
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
 * THIS CLOSES A CAPABILITY GAP RATHER THAN ADDING A SPELLING. Until v1.22.0
 * optimistic updates with rollback were UNAVAILABLE in a Vapor template:
 * `state.optimisticFn` was set only by the vDOM registration, so a Vapor
 * consumer who wrote `v-vc-optimistic` got Vue's "Failed to resolve directive"
 * warning and no optimistic update. The alternative was to abandon
 * `v-vc-command` for that button and hand-roll the dispatch, which also
 * forfeits `vc-loading` / `vc-error`, disable-while-busy, the re-entrancy
 * guard, the timeout and the modifiers - and cannot be done by adding an
 * `@click` beside the directive, because since Vue 3.6.0-rc.9 `80b3a046` that
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

        // NO GUARD OF ANY KIND, and the rule outlived the thing that exposed
        // it. Teardown is keyed to what was MOUNTED on the element, never to
        // the current binding.
        //
        // WHAT IT COST TO LEARN, kept because the rule is easier to
        // reintroduce than to rediscover. `mounted` and `updated` used to
        // guard on `binding.arg !== 'command'` and this hook did too. Vue
        // passes the LATEST binding here, so with a dynamic argument
        // (`v-vc:[kind]`) that had moved off `command` since mount, the guard
        // returned and the listener was never detached: a click on the element
        // after `app.unmount()` still dispatched, for the life of the page.
        // Measured in both modes - `.delegate` stranded the shared document
        // listener, and a direct listener survived on any element that
        // outlived its component.
        //
        // The route is UNREACHABLE as of v1.22.0: the selector is in the name,
        // there is no argument, and nothing can move off `command`. The rule
        // still stands and must not be softened into an equivalent guard on
        // anything else the current binding happens to say - teardown answers
        // to the mount, not to the present. `unmountCommand` already no-ops
        // when the element carries no state, so having no guard remains both
        // the fix and the smaller code.
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
 * read its verdict. They are deliberate since v1.6.0, mirroring Vue's #14948
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

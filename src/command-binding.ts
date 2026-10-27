/**
 * vapor-chamber - the command binding: a control that dispatches a command,
 * with no Vue in it.
 *
 * One interaction, two ways to attach it. The Vue and Vapor directives
 * (`v-vc-command`, src/directives.ts) mount it per element; `bindCommands`
 * mounts it on every `[data-vc-command]` of plain HTML, the bus passed in.
 * The rules are the directive's (busy, error, announce, optimistic, the
 * keyboard, the in-flight guard), written once here. This module imports
 * nothing of chamber.ts, so a page's bundle carries no Vue probe.
 */

import { type Delay, delayOption } from './bounds';
import { _report } from './report';
import { DEV } from './dev';
import { announce } from './a11y';
import type { BaseBus, Command, CommandResult } from './command-bus';
import { _errResult, _failures, conditionOf, ownerOf } from './command-bus';
import { isThenable } from './settled';
import { pace, type Paced } from './pace';

const directiveFail = _failures('directive');

/**
 * @internal The failure of a dispatch that did not settle within the
 * directive's timeout: `directive:timeout:dispatch`, a transient condition.
 * A function of its own so a test can read the code (the element's state is
 * private); tests/errors-match-catalogue.test.ts.
 */
export function _timedOut(action: string, timeout: number): CommandResult {
  return _errResult(directiveFail('timeout:dispatch', `Directive dispatch "${action}" timed out after ${timeout}ms`, { action, context: { timeout } }));
}

// ---------------------------------------------------------------------------
// Internal state per element (stored via WeakMap)
// ---------------------------------------------------------------------------

/** Default timeout for async dispatch in ms. Prevents infinite loading states. */
const DEFAULT_DISPATCH_TIMEOUT = 30_000;

type DirectiveState = {
  action: string;
  /** The bus, read at press time: the shared one for the Vue directives, the given one for `bindCommands`. */
  busOf: () => BaseBus;
  /** What the element listens to: `click`, or `input` / `change` on a form control (`v-model`'s choice). */
  event: 'click' | 'input' | 'change';
  /** The sender's pace from `data-vc-debounce` / `data-vc-throttle`, or null. */
  pace: Paced | null;
  /** The latest send: only its settle clears `vc-loading` on a form control, whose sends overlap. */
  seq: number;
  /** Inside an IME composition (`v-model`'s rule): a text control sends at its end, not before. */
  composing: boolean;
  /** The composition listeners on a text control, kept for teardown. */
  ime?: { start: () => void; end: (event: Event) => void };
  /** Vapor only: the binding's getter, read at dispatch time - see vcCommandVapor. */
  actionOf?: () => unknown;
  payload?: any;
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
  /** Timeout in ms for async dispatch. Default: 30_000 */
  timeout: Delay;
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
  delegatedDoc?: Document;
};

/**  The element's command state; directives.ts reads it for the Vapor slots. */
export const _stateMap = new WeakMap<Element, DirectiveState>();

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
export type PendingSlot = Partial<Pick<DirectiveState, 'payloadOf' | 'optimisticOf' | 'payload' | 'optimisticFn'>>;
/** Payload / optimistic bindings held for an element until its command mounts. */
export const _pending = new WeakMap<Element, PendingSlot>();

// ---------------------------------------------------------------------------
// Opt-in delegation (.delegate modifier) - lib-side, not required by Vue
// ---------------------------------------------------------------------------
//
// MEASURED (tests/perf.bench.ts, 5k elements, v1.10.0), because the intuitive reading
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
  // the shadow HOST - so the _stateMap lookup never found the real element and
  // a delegated control inside a shadow root simply never dispatched.
  // `router/dom.ts` link interception documents this same fix. Every build
  // target has composedPath.
  for (const node of event.composedPath()) {
    const state = _stateMap.get(node as Element);
    if (state?.delegate) {
      state.handler(event);
      return;
    }
    // Stop at the document - beyond it the path holds Window, and an
    // ancestor match outside the event's tree is not ours to fire.
    if ((node as Node).nodeType === 9 /* DOCUMENT_NODE */) break;
  }
}

function addDelegatedElement(el: Element): Document {
  const doc = el.ownerDocument; // Element.ownerDocument is non-null (lib.dom)
  const count = delegatedDocs.get(doc) ?? 0;
  if (count === 0) doc.addEventListener('click', delegatedClickHandler);
  delegatedDocs.set(doc, count + 1);
  return doc;
}

function removeDelegatedElement(doc: Document): void {
  // Counted at the element's mount (addDelegatedElement), and its state goes
  // at its first unmount, so the count is here and at least 1.
  const count = delegatedDocs.get(doc) as number;
  if (count === 1) {
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
// Binding value: action name string (e.g. 'cartAdd'). A press while the value
// is empty (undefined, null, '', false) dispatches nothing, and DEV warns once
// per element - see buildHandler.
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
// A dispatch with NO target does not match `pending(action)`. The directive
// substitutes `{}` when no target is present (see `data-vc-target` above),
// while `pending(action)` asks for the key with no target at all, and those
// are two different keys. The `vc-loading` CLASS still lands, so anything
// styled off the class works while anything rendered off `pending` does not
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

/** DEV only: elements already warned about, so a repeated press warns once. */
let warnedNoAction: WeakSet<Element> | undefined;

/** DEV only: name the element whose press had no action to dispatch. */
function warnNoAction(el: Element): void {
  if ((warnedNoAction ||= new WeakSet()).has(el)) return;
  warnedNoAction.add(el);
  _report('warn', 'directive:missing:action',
    `v-vc-command on <${el.tagName.toLowerCase()}> has no action, so this press ` +
    'dispatched nothing. Bind an action name, e.g. v-vc-command="\'cartAdd\'" or data-vc-command="cartAdd".'
  );
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
    // Vue's delegated handler skips a node whose `disabled` is set (rc.11
    // runtime-vapor, delegatedEventHandler); its direct `on()` does not. This
    // directive applies the rule to both of its listeners, and goes further:
    // it bails out on re-entrant clicks while a dispatch is in flight, and on
    // aria-disabled (the platform only suppresses clicks on disabled
    // <button>/<input>, not on <a>/<div>/aria-disabled).
    const press = state.event === 'click';
    if (press && state.loading) return;
    if (state.composing) return;
    if ((el as Partial<HTMLButtonElement>).disabled === true) return;
    if (attr(el, 'aria-disabled') === 'true') return;

    // Vapor: the bindings are getters and there is no `updated` hook, so they
    // are read here, at dispatch time - see vcCommandVapor. Writing them onto
    // the same fields the vDOM hooks write means everything below this point
    // is renderer-agnostic, and the payload precedence (binding over
    // `data-vc-payload`) is identical on both by construction rather than by
    // being implemented twice.
    if (state.actionOf) {
      const action = state.actionOf();
      state.action = action ? String(action) : '';
    }
    // A press with no action does nothing, the shape Vue's own `@click=""`
    // has. Checked here, at press time, because that is when the action is
    // decided on both renderers: one set after mount then works, which a
    // mount-time refusal would lose on Vapor (no `updated` hook).
    // tests/directive-empty-action.test.ts.
    if (!state.action) {
      if (DEV) warnNoAction(el);
      return;
    }
    if (state.payloadOf) state.payload = state.payloadOf();
    if (state.optimisticOf) state.optimisticFn = state.optimisticOf() as DirectiveState['optimisticFn'];

    const bus = state.busOf();
    const mine = ++state.seq;

    if (press) state.loading = true;
    state.error = null;
    el.classList.add(LOADING_CLASS);
    el.classList.remove(ERROR_CLASS);
    // A button to assistive technology: native, or by role. A link is not -
    // its press is navigation - and keeps its own behaviour.
    const busy = press && (el instanceof HTMLButtonElement || attr(el, 'role') === 'button')
      ? markBusy(el as HTMLElement, event)
      : null;

    // A form control's value is its payload unless one is given: what changes on each
    // send stays out of the target, so a debounced burst shares one key (`pace`).
    const payload = state.payload ?? parseJson((el as HTMLElement).dataset?.vcPayload) ?? (press ? undefined : controlValue(el));
    const target = parseJson((el as HTMLElement).dataset?.vcTarget) ?? {};

    let rollback: (() => void) | null = null;
    let resolved: CommandResult;
    let result: unknown;
    // The directive's own timeout result, when it won the race: a give-up,
    // not the dispatch failing.
    let gaveUp: CommandResult | undefined;
    try {
      // Apply optimistic update if provided. Inside the `try`: one that throws
      // is this press's failure, and the `finally` below still releases the
      // control. Thrown before it, the control would stay busy for good
      // (`vc-loading`, `aria-disabled`, every later press swallowed).
      if (state.optimisticFn) {
        const cmd: Command = { action: state.action, target, payload };
        rollback = state.optimisticFn(cmd) ?? null;
      }

      try {
        result = state.pace !== null ? state.pace(state.action, target, payload) : bus.dispatch(state.action, target, payload);
      } catch (e) {
        result = _errResult(e as Error);
      }

      // Handle result (may be a Promise if using async bus shim)
      if (isThenable(result)) {
        // Race against timeout to prevent infinite loading states. Clear the
        // timer when the dispatch wins the race - otherwise every click leaves
        // a live timer (default 30s) pinning this closure.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<CommandResult>((resolve) => {
          timeoutId = setTimeout(
            () => resolve(gaveUp = _timedOut(state.action, state.timeout)),
            state.timeout
          );
        });
        try {
          resolved = await Promise.race([(result as unknown as Promise<any>), timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        resolved = result as CommandResult;
      }
    } catch (e) {
      resolved = _errResult(e as Error);
    } finally {
      // Always reset loading state - prevents stuck buttons. A form control's
      // older send leaves the class to the newer one still in flight.
      state.loading = false;
      if (mine === state.seq) el.classList.remove(LOADING_CLASS);
      busy?.();
    }

    if (!resolved.ok && (ownerOf(resolved.error) === 'pace' || (state.pace !== null && conditionOf(resolved.error) === 'aborted'))) {
      // The sender refused it (superseded, or inside a throttle's wait), or a
      // newer run of its pace aborted it (latest wins): nothing failed. Silent,
      // as a press in flight is; an optimistic change it made is taken back.
      if (rollback) undo(rollback);
      return;
    }
    if (!resolved.ok) {
      state.error = resolved.error;
      el.classList.add(ERROR_CLASS);
      // `vc-error` is for styling; a screen reader cannot see a class. A failed
      // command is a status message (WCAG 4.1.3): announced through the
      // document's shared live region, focus left where it is, in the failure's
      // own words (a backend problem's `detail`, localized). An app
      // that wants other words takes the announcing over (a11y.ts, setAnnouncer).
      if (resolved.error.message) announce(resolved.error.message, { assertive: true });
      if (rollback) {
        if (resolved !== gaveUp) undo(rollback);
        else {
          // The directive gave up, and the dispatch may still land: its late
          // result decides. A failure or a rejection rolls back once, a
          // success keeps. It touches no element, so after an unmount the
          // rollback (the app's own state) still runs
          // (tests/directive-timeout-optimistic.test.ts).
          const late = rollback;
          (result as PromiseLike<CommandResult>).then((r) => { if (!r.ok) undo(late); }, () => undo(late));
        }
      }
    }
  };
}

/** An attribute of the bound element, or null for an `el` with no getAttribute (not an Element). */
function attr(el: Element, name: string): string | null {
  return typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
}

/** Run an optimistic rollback. One that throws stays inside the directive. */
function undo(rollback: () => void): void {
  try { rollback(); } catch { /* ignore */ }
}

/**
 * True for an element that says it is a button but gets none of a button's
 * keyboard behaviour from the platform: `role="button"` on anything that is not
 * natively activatable (a <button>, an <input>, a link with href, <summary>).
 */
function needsKeyboard(el: Element): el is HTMLElement {
  if (attr(el, 'role') !== 'button') return false;
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
export function _mountCommand(
  el: Element,
  action: string,
  modifiers: Record<string, boolean | undefined> | undefined,
  actionOf: (() => unknown) | undefined,
  busOf: () => BaseBus,
): void {
  // One v-vc-command per element: the state is keyed by element. A render
  // function can list the directive twice (a template cannot), and a second
  // mount would overwrite the first's state and strand its listener - so
  // detach whatever the element carries first, and the last binding wins.
  _unmountCommand(el);

  // Claimed BEFORE the state literal, not written after it, so the carried
  // slots are part of the one shape every DirectiveState leaves this function
  // with - see the note on `delegatedDoc` / `listenerOpts` in the literal.
  const carried = _pending.get(el);
  if (carried) _pending.delete(el);

  const mods: Record<string, boolean | undefined> =
    (modifiers && typeof modifiers === 'object') ? modifiers : {};

  // `.0` and no digits are the default; 10 or more digits are capped.
  const timeout = delayOption(parseInt(Object.keys(mods).find(k => /^\d+$/.test(k)) ?? '', 10) || DEFAULT_DISPATCH_TIMEOUT, DEFAULT_DISPATCH_TIMEOUT);

  const buttons: number[] = [];
  if (mods.left) buttons.push(0);
  if (mods.middle) buttons.push(1);
  if (mods.right) buttons.push(2);

  // .delegate shares one document-level listener, so it has nowhere to
  // hang per-element addEventListener options. Vue's compiler-vapor attaches
  // the same combo (`@click.delegate.once`) directly too, but silently: it
  // warns only for a dynamic event name, an event it does not delegate, or a
  // component (rc.11 compiler-vapor, warnDelegate). This one warns in DEV.
  const event = eventOf(el);
  // Delegation shares one document `click` listener, so a form control listens directly.
  let delegate = !!mods.delegate && event === 'click';
  if (delegate && (mods.capture || mods.once || mods.passive)) {
    if (DEV) {
      _report('warn', 'directive:invalid:modifier',
        'v-vc-command.delegate is incompatible with ' +
        '.capture/.once/.passive (delegation shares one document-level ' +
        'listener with no per-element options). Attaching a direct ' +
        'listener instead.'
      );
    }
    delegate = false;
  }

  const state: DirectiveState = {
    action,
    busOf,
    event,
    pace: paceOf(el, busOf),
    seq: 0,
    composing: false,
    ime: undefined,
    actionOf,
    loading: false,
    error: null,
    // Overwritten below, before any listener is attached: a function from the
    // literal on, so the field keeps one representation.
    handler: inFlightGuard,
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
  _stateMap.set(el, state);
  if (needsKeyboard(el)) wireKeyboard(el, state);
  if (event === 'input') wireComposition(el, state);

  if (delegate) {
    state.delegatedDoc = addDelegatedElement(el);
    return;
  }

  // false is each option's default, so one literal: the same object goes to
  // add and to remove (see `listenerOpts` in the type).
  const listenerOpts: AddEventListenerOptions = { capture: !!mods.capture, once: !!mods.once, passive: !!mods.passive };
  state.listenerOpts = listenerOpts;
  el.addEventListener(event, state.handler, listenerOpts);
}

/** Detach what mountCommand attached: the listener (or the delegated count) and the state. */
export function _unmountCommand(el: Element): void {
  const state = _stateMap.get(el);
  if (!state) return;
  // Set at mount exactly when the element is delegated.
  if (state.delegatedDoc) {
    removeDelegatedElement(state.delegatedDoc);
  } else {
    el.removeEventListener(state.event, state.handler, state.listenerOpts);
  }
  state.pace?.dispose();
  if (state.ime) {
    el.removeEventListener('compositionstart', state.ime.start);
    el.removeEventListener('compositionend', state.ime.end);
  }
  if (state.keys) {
    el.removeEventListener('keydown', state.keys.down as EventListener);
    el.removeEventListener('keyup', state.keys.up as EventListener);
  }
  if (state.addedTabindex) el.removeAttribute('tabindex');
  _stateMap.delete(el);
}

/**
 * `v-model`'s IME rule on a text control: no send between `compositionstart`
 * and `compositionend`; the end sends the composed value, paced as any input.
 * tests/bind-commands.test.ts.
 */
function wireComposition(el: Element, state: DirectiveState): void {
  const start = (): void => { state.composing = true; };
  const end = (event: Event): void => {
    if (!state.composing) return;
    state.composing = false;
    state.handler(event);
  };
  el.addEventListener('compositionstart', start);
  el.addEventListener('compositionend', end);
  state.ime = { start, end };
}

/**
 * What an element listens to, as `v-model` chooses: `change` for a select, a
 * checkbox and a radio, `input` for any other input and a textarea, `click`
 * for everything else.
 */
function eventOf(el: Element): DirectiveState['event'] {
  // By tag name, not `instanceof`: a `typeof` guard of an absent global per
  // mount is V8-RULES rule 6's measured cost.
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type === 'checkbox' || type === 'radio' ? 'change' : 'input';
  }
  return tag === 'SELECT' ? 'change' : tag === 'TEXTAREA' ? 'input' : 'click';
}

/** A form control's value: `checked` for a checkbox, else `value`. */
function controlValue(el: Element): unknown {
  return (el as HTMLInputElement).type === 'checkbox' ? (el as HTMLInputElement).checked : (el as HTMLInputElement).value;
}

/**
 * The element's pace, from `data-vc-debounce` or `data-vc-throttle` (ms), read
 * once at mount. Null for neither, so an unpaced press reads one null. The
 * send resolves the bus at press time, as an unpaced press does.
 */
function paceOf(el: Element, busOf: () => BaseBus): Paced | null {
  const debounce = attr(el, 'data-vc-debounce');
  const throttle = attr(el, 'data-vc-throttle');
  if (debounce === null && throttle === null) return null;
  const send = (action: string, target?: unknown, payload?: unknown, options?: { signal?: AbortSignal }) => busOf().dispatch(action, target, payload, options);
  return debounce !== null ? pace(send, { debounce: Number(debounce) }) : pace(send, { throttle: Number(throttle) });
}

/**
 * @internal Mount the binding on an element that names its action in
 * `data-vc-command`, read at press time. `bindCommands` and a
 * `data-vc-each` row (src/page-bindings.ts) mount this way.
 */
export function _mountAttribute(el: Element, busOf: () => BaseBus): void {
  // The action is read at press time (`actionOf`), so the mount passes none.
  _mountCommand(el, '', undefined, () => attr(el, 'data-vc-command'), busOf);
}

/**
 * bindCommands - the command binding on plain HTML: every `[data-vc-command]`
 * under `root` (and `root` itself) dispatches its action on `bus`.
 *
 * The action is the attribute's value, read at press time. `data-vc-target`
 * and `data-vc-payload` hold JSON. `data-vc-debounce` or `data-vc-throttle`
 * (ms) pace it at the sender. A form control sends on `input`, or `change`
 * for a select, a checkbox and a radio, with its value as the payload. A
 * button is `aria-disabled` and ignores presses while in flight; `vc-loading`
 * and `vc-error` style it; a failure is announced. Returns `unbind()`.
 * Elements added later are bound by calling it on them. The display
 * bindings are `bindDisplay` (src/page-bindings.ts), so a page that only
 * dispatches carries none of them.
 *
 * @example
 * <button data-vc-command="cartAdd" data-vc-target='{"id":1}'>Add</button>
 * <input data-vc-command="searchQuery" data-vc-debounce="300">
 * <script>
 *   const { bus } = VaporChamber.connect({ endpoint: '/api/vc' });
 *   VaporChamber.bindCommands(document.body, { bus });
 * </script>
 */
export function bindCommands(root: Element | Document, options: { bus: BaseBus }): () => void {
  const busOf = (): BaseBus => options.bus;
  const bound: Element[] = [];
  const bind = (el: Element): void => {
    _mountAttribute(el, busOf);
    bound.push(el);
  };
  if ((root as Element).nodeType === 1 && (root as Element).hasAttribute('data-vc-command')) bind(root as Element);
  for (const el of root.querySelectorAll('[data-vc-command]')) bind(el);
  return () => {
    // Only what this call mounted: a later mount on the same element is another owner's.
    for (const el of bound) if (_stateMap.get(el)?.busOf === busOf) _unmountCommand(el);
    bound.length = 0;
  };
}

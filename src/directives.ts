/**
 * vapor-chamber - Directive plugin (opt-in, 0KB when not imported)
 *
 * The rules this file keeps (the history is in CHANGELOG.md and the
 * whitepaper's Vue 3.6 alignment log, appendix B):
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
 *     in-flight element. Vue skips only a `disabled` node, and only in its
 *     delegated handler (#14948). The other two are this directive's rule.
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
import { _report } from './report';
import { getCommandBus } from './chamber';
import type { Command } from './command-bus';
import { _mountCommand, _pending, _stateMap, _unmountCommand, type PendingSlot } from './command-binding';

// The interaction (busy, error, announce, optimistic, the keyboard, the
// delegation, the in-flight guard) is src/command-binding.ts, shared with
// `bindCommands`. This module registers it with Vue and resolves the shared
// bus at press time.
export { _timedOut } from './command-binding';

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
 * read rather than tracked, on purpose. Tracking is possible - Vue's own Vapor
 * directive tests use the public `watchEffect` - but it costs one effect per
 * mounted control, literal actions included, and this subpath imports no Vue.
 * Reading at press time needs none: an action set after mount is picked up,
 * and a press with no action does nothing (see buildHandler).
 *
 * `v-vc-payload` and `v-vc-optimistic` WORK ON BOTH RENDERERS - see
 * {@link vcPayloadVapor} and {@link vcOptimisticVapor}.
 *
 * THE ARGUMENT IS NOT READ. Vue's argument is a PARAMETER slot, and #15490
 * made it a getter so a DYNAMIC argument can be reactive (Vue's own test
 * compiles `v-custom:[data.arg]` and expects the attribute to follow
 * `data.arg`). A selector must not move, so it lives in the NAME, where a name
 * cannot be dynamic; a selector in the argument is a dead control in every
 * compiled Vapor template, with no error.
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
 * // or app-wide, on the typed app from 'vapor-chamber/vapor':
 * // createVaporChamberApp(App).directive('vc-command', vcCommandVapor)
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
      _report('warn', 'directive:missing:action',
        'v-vc-command needs an action to dispatch, e.g. ' +
        'v-vc-command="\'cartAdd\'". Nothing was mounted on this element.'
      );
    }
    return;
  }
  _mountCommand(el, String(value()), modifiers, value, getCommandBus);
  return () => _unmountCommand(el);
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
  const state = _stateMap.get(el);
  if (state) {
    (state as Record<string, unknown>)[key] = value;
    return;
  }
  const slot = _pending.get(el) ?? {};
  (slot as Record<string, unknown>)[key] = value;
  _pending.set(el, slot);
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
    const s = _stateMap.get(el);
    if (s) s[key] = undefined;
    const p = _pending.get(el);
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
 * rollback runs if the dispatch fails. A dispatch still running when the
 * timeout modifier gives up is reported as `directive:timeout:dispatch` and
 * the button released, and its late result decides: a failure rolls back, a
 * success keeps.
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
        _report('warn', 'directive:invalid:app', 'On a Vapor app use vcCommandVapor.');
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
          _mountCommand(el, binding.value as string, binding.modifiers, undefined, getCommandBus);
        },

        // Vue calls it between `mounted`, which sets the state, and `unmounted`.
        updated(el: Element, binding: { value: any }) {
          _stateMap.get(el)!.action = binding.value as string;
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
          _unmountCommand(el);
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
        // on the same element is held and claimed rather than dropped (a plain
        // write is a silent no-op in that order - see `pending` for the measurement).
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
       * `fn` receives the Command and returns a rollback function (or null),
       * run if the dispatch fails. After the timeout gives up, the late
       * result decides (see vcOptimisticVapor).
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
 * a docblock past roughly fifteen lines.
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
 *
 * A BOUND `:onClick="fn"` on the same element behaves as the `@click` of that
 * table does in the `direct` column: it runs first, and `el.disabled = true`
 * or `stopImmediatePropagation()` skips the dispatch. Vue 3.6.0-rc.10
 * (`86d44991`) compiles it on Vapor to a listener; rc.9 compiled it to a
 * property write that never ran, so it could veto nothing. Pinned by
 * tests/directives-vapor-fixture.test.ts.
 */

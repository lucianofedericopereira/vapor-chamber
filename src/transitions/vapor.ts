/**
 * vapor-chamber/transitions/vapor - `VcTransition`, a transition for Vapor
 * that is driven by the command bus and imports nothing of Vue's transition.
 *
 * Sibling to `vapor-chamber/transitions`, whose bridge drives Vue's own
 * `<Transition>`. Like `vapor-chamber/router/vapor`, this module imports Vapor
 * helpers statically from bare `vue` and so needs Vue >= 3.6.
 * `tests/vapor/vc-transition-helpers.test.ts` enumerates what it takes from
 * Vue; `tests/vapor/vc-transition.test.ts` runs every behaviour described on
 * the export below, on the dev build and on an executed production bundle.
 */

import { createIf, defineVaporComponent, nextTick, onScopeDispose, shallowRef, watch } from 'vue';
import type { PropType } from 'vue';
import { MAX_TIMEOUT_MS, countOption } from '../bounds';
import { resolveBus } from '../shared-bus';
import type { BaseBus } from '../command-bus';
import { DEV } from '../dev';

/**
 * The first element of a Vapor block, or null.
 *
 * A block is what a slot function returns: a node, an array of blocks, a
 * fragment (its blocks are on `nodes`) or a component instance (its block is
 * on `block`). Those two property reads are not public API;
 * `tests/vapor/vc-transition-helpers.test.ts` pins them on the installed Vue.
 * Content with no element yields null, and the commands then carry no target.
 */
function elementOf(block: any): Element | null {
  if (!block) return null;
  if (block.nodeType) return block.nodeType === 1 ? block : null;
  if (Array.isArray(block)) {
    for (const inner of block) {
      const el = elementOf(inner);
      if (el) return el;
    }
    return null;
  }
  return elementOf(block.nodes ?? block.block);
}

/**
 * VcTransition - show and hide content, with the enter and the leave run as
 * bus commands. Vapor only.
 *
 * The component owns the condition. The content is rendered while `show` is
 * true, and when `show` turns false it STAYS in the DOM until the
 * `<namespace>Leave` command has answered. The look comes from the command
 * handlers; there are no CSS classes.
 *
 * It dispatches the six actions `createTransitionBridge` dispatches, under
 * the same names: `<namespace>BeforeEnter`, `Enter`, `AfterEnter`,
 * `BeforeLeave`, `Leave`, `AfterLeave` (`beforeEnter` and so on with no
 * namespace). The target of each is the first element of the content, or
 * nothing when the content has no element. `AfterLeave` is dispatched once
 * the element is out of the document. Mounting dispatches nothing, unless
 * `appear` is set: then content that is there at mount gets the enter
 * commands.
 *
 * What is awaited is the DISPATCH, as in the bridge. An async bus returns a
 * promise, and the transition waits for it for at most `timeout`
 * milliseconds: after that it goes on, so a handler that never settles cannot
 * strand the element. A handler that rejects, or a missing one, does not stop
 * it either. A sync bus answers at once, whatever its handler returned, so
 * there the element leaves at once. The shared bus is a sync bus: for a leave
 * that must be waited for, pass an async bus as `:bus`.
 *
 * Turning `show` back on while a leave is still waiting cancels that leave:
 * `<namespace>LeaveCancelled` is dispatched, the same element enters again,
 * and the older answer is ignored. Turning it off while an enter is still
 * waiting dispatches `<namespace>EnterCancelled` and then the leave commands.
 * Those are the bridge's two cancelled actions, in the order Vue calls them
 * for a `v-show`.
 *
 * @example
 * <script setup vapor>
 * import { createAsyncCommandBus } from 'vapor-chamber';
 * import { VcTransition } from 'vapor-chamber/transitions/vapor';
 *
 * const bus = createAsyncCommandBus();
 * bus.register('modalEnter', (cmd) =>
 *   cmd.target.animate([{ opacity: 0 }, { opacity: 1 }], 200).finished);
 * bus.register('modalLeave', (cmd) =>
 *   cmd.target.animate([{ opacity: 1 }, { opacity: 0 }], 200).finished);
 * </script>
 *
 * <template>
 *   <VcTransition :show="open" namespace="modal" :bus="bus">
 *     <Panel />
 *   </VcTransition>
 * </template>
 */
export const VcTransition = defineVaporComponent({
  name: 'VcTransition',
  props: {
    /** The content is rendered while this is true. */
    show: Boolean,
    /** Run the enter commands for content that is there at mount. */
    appear: Boolean,
    /** Prefix of the dispatched actions: 'modal' gives 'modalEnter'. */
    namespace: String,
    /** Bus to dispatch on. Default: the shared bus. */
    bus: Object as PropType<BaseBus>,
    /** Milliseconds to wait for an async Enter / Leave handler. Default: 30_000. */
    timeout: Number,
  },
  setup(props, { slots }) {
    const bus = resolveBus(props.bus);
    const ns = props.namespace;
    const timeout = countOption(props.timeout, 30_000, 1, MAX_TIMEOUT_MS);
    const name = (hook: string) => (ns ? ns + hook : hook[0].toLowerCase() + hook.slice(1));
    const aBeforeEnter = name('BeforeEnter');
    const aEnter = name('Enter');
    const aAfterEnter = name('AfterEnter');
    const aBeforeLeave = name('BeforeLeave');
    const aLeave = name('Leave');
    const aAfterLeave = name('AfterLeave');

    const present = shallowRef(props.show);
    let content: unknown;
    let token = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting: () => void;

    const send = (action: string, el: Element | null): any => {
      try {
        return bus.dispatch(action, el);
      } catch {
        return undefined;
      }
    };

    // Dispatch, then go on: at once for a plain result; for a promise, when it
    // settles or when the timeout fires, whichever is first. `timer` is the
    // latch: a newer toggle or the unmount clears it, and an answer that
    // arrives afterwards finds a different `timer` and does nothing. While it
    // is set, `waiting` holds what a newer toggle has to cancel.
    const step = (action: string, cancelled: string, el: Element | null, then: () => void): void => {
      const result = send(action, el);
      if (!result || typeof result.then !== 'function') {
        then();
        return;
      }
      waiting = () => send(name(cancelled), el);
      const finish = (): void => {
        if (timer !== mine) return;
        stop();
        then();
      };
      const mine = (timer = setTimeout(() => {
        if (DEV) {
          console.warn(
            `[vapor-chamber] transition "${action}" did not settle within ${timeout}ms; ` +
              'going on so the element is not stuck mid-transition. Raise `timeout` ' +
              'if the handler is legitimately slow.',
          );
        }
        finish();
      }, timeout));
      result.then(finish, finish);
    };

    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };

    // After the flush that inserts the content, so the handlers get the element.
    const enter = (mine: number) =>
      nextTick(() => {
        if (mine !== token) return;
        const el = elementOf(content);
        send(aBeforeEnter, el);
        step(aEnter, 'EnterCancelled', el, () => send(aAfterEnter, el));
      });

    if (props.appear && props.show) enter(token);

    watch(
      () => props.show,
      (on) => {
        if (timer) waiting();
        stop();
        const mine = ++token;
        if (on) {
          present.value = true;
          enter(mine);
        } else {
          const el = elementOf(content);
          send(aBeforeLeave, el);
          step(aLeave, 'LeaveCancelled', el, () => {
            present.value = false;
            // After the flush that removes it.
            nextTick(() => mine === token && send(aAfterLeave, el));
          });
        }
      },
    );

    onScopeDispose(() => {
      stop();
      token++;
    });

    return createIf(
      () => present.value,
      () => (content = slots.default?.()) as never,
    );
  },
});

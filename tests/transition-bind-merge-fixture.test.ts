// @vitest-environment happy-dom
/**
 * FIXTURE - the transition bridge spread onto a REAL `VaporTransition` next to
 * the consumer's own `@enter`, vue@3.6.0-rc.8 (2d2d130 "merge event handlers
 * across prop sources" and fbc7692 "merge declared class, style and event
 * props across sources", #15454; commits 02 and 10 of the rc.8 range).
 *
 * WHY THIS FILE EXISTS. `VaporTransition` DECLARES its nine `on*` hooks as
 * props. A declared prop fed by two sources - `v-bind="t"` and a written
 * `@enter` - was resolved before rc.8 by returning the FIRST match in a
 * search that ran over the dynamic sources from the last one backwards and
 * then over the static props. So exactly one handler survived and the other
 * was dropped, silently. Which one depended on the order the attributes were
 * written in, because that is the order compiler-vapor lays the sources out
 * (both shapes below are verbatim compiler-vapor 3.6.0-rc.8 output):
 *
 *   <Transition v-bind="t" @enter="mine">   { $: [() => t, { onEnter: () => mine }] }
 *       rc.7: `mine` runs, the BRIDGE's onEnter is dropped - so no
 *       `<ns>Enter` dispatch, and no `done` handling from the bridge. This is
 *       the order this module's docs write the binding in.
 *   <Transition @enter="mine" v-bind="t">   { onEnter: () => mine, $: [() => t] }
 *       rc.7: the bridge runs, `mine` is dropped.
 *
 * rc.8 merges declared `on*` props across sources in raw-key order, as vDOM's
 * `mergeProps` always did, so both run in both orders. No change on our side:
 * the bridge was always nine plain enumerable hooks (transition-bind-fixture
 * pins that `phase`/`dispose` stay out of a spread); rc.8 changed what Vue
 * does when a user composes with them. `done` stays correct under the merge:
 * the bridge's onEnter takes (el, done), and Vue waits for `done` when ANY
 * merged handler declares a second argument.
 *
 * Everything comes from the single with-vapor browser build, with the chamber
 * pointed at it through `configureVue()`.
 *
 * VERIFIED AGAINST THE PRE-FIX RUNTIME: on vue@3.6.0-rc.7 both cases fail,
 * each on the handler its order drops.
 */

import { describe, expect, it } from 'vitest';
import { configureVue, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { useTransitionCommand } from '../src/transitions';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  return v;
}

type Order = 'v-bind first' | '@enter first';

async function enterOnce(order: Order) {
  const v = await vapor();
  const bus = createCommandBus({ onMissing: 'ignore' });
  const dispatched: string[] = [];
  bus.onAfter((cmd) => dispatched.push(cmd.action));

  const mine: Element[] = [];
  const onEnterMine = (el: Element) => {
    mine.push(el);
  };
  const show = v.shallowRef(false);
  const t0 = v.template('<div class=panel>hi', 3);

  const Root = v.defineVaporComponent({
    setup() {
      const t = useTransitionCommand({ bus, namespace: 'modal' });
      // Verbatim compiler-vapor output for the two attribute orders.
      const rawProps =
        order === 'v-bind first'
          ? { $: [() => t, { onEnter: () => onEnterMine }] }
          : { onEnter: () => onEnterMine, $: [() => t] };
      return v.createComponent(
        v.VaporTransition,
        rawProps,
        v.extend(
          () => v.createIf(() => show.value, () => t0(), null, 129 /* TRUE_SINGLE_ROOT, SLOT_ROOT */),
          { _: 1 /* NON_STABLE */ },
        ),
        true,
      );
    },
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(Root);
  app.mount(host);

  // Showing the child drives the enter hooks through Vue's own machinery.
  show.value = true;
  await v.nextTick();
  await new Promise((r) => setTimeout(r, 0));

  const panel = host.querySelector('.panel');
  app.unmount();
  host.remove();
  return { panel, mine, dispatched };
}

describe('bridge spread next to an own @enter on a real VaporTransition (rc.8)', () => {
  it('runs both handlers when v-bind comes first (the documented order)', async () => {
    const { panel, mine, dispatched } = await enterOnce('v-bind first');
    expect(panel).not.toBeNull();
    // The bridge's hook reached Vue: rc.7 dropped it in this order.
    expect(dispatched).toContain('modalEnter');
    // Once, on the element that entered (identity, not class: Vue has added
    // its v-enter-* classes by the time the hook runs).
    expect(mine).toHaveLength(1);
    expect(mine[0]).toBe(panel);
  });

  it('runs both handlers when @enter comes first', async () => {
    const { panel, mine, dispatched } = await enterOnce('@enter first');
    expect(panel).not.toBeNull();
    expect(dispatched).toContain('modalEnter');
    // The consumer's own hook ran too: rc.7 dropped it in this order.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toBe(panel);
  });
});

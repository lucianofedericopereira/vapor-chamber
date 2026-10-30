// @vitest-environment happy-dom
/**
 * The transition bridge spread onto a real VaporTransition next to the consumer's own @enter.
 * Why: VaporTransition declares its on* hooks as props, so a declared prop fed by two sources (v-bind="t"
 * and @enter) must run both handlers in either attribute order, or the bridge's dispatch or the consumer's hook is dropped.
 * Shows: with v-bind first and with @enter first, the bridge dispatches modalEnter and the consumer's
 * handler runs once, on the element that entered.
 * See: vuejs/core#15454, tests/transition-bind-fixture.test.ts
 */

import { describe, expect, it } from 'vitest';
import { configureVue, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { useTransitionCommand } from '../src/transitions';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  return v;
}

type Order = 'v-bind first' | '@enter first';

const TEMPLATES: Record<Order, string> = {
  'v-bind first': '<Transition v-bind="t" @enter="onEnterMine"><div v-if="s.show" class="panel">hi</div></Transition>',
  '@enter first': '<Transition @enter="onEnterMine" v-bind="t"><div v-if="s.show" class="panel">hi</div></Transition>',
};

async function enterOnce(order: Order) {
  const v = await vapor();
  const bus = createCommandBus({ onMissing: 'ignore' });
  const dispatched: string[] = [];
  bus.onAfter((cmd) => dispatched.push(cmd.action));

  const mine: Element[] = [];
  const onEnterMine = (el: Element) => {
    mine.push(el);
  };
  const s = v.reactive({ show: false });
  const { render, code } = await compileVapor(v, TEMPLATES[order]);
  // A template that stopped reaching the merge would pass with only one source.
  expect(code).toContain('_VaporTransition');
  expect(code).toContain('onEnter:');
  expect(code).toContain('$: [');

  const Root = v.defineVaporComponent({
    setup() {
      const t = useTransitionCommand({ bus, namespace: 'modal' });
      return render({ t, s, onEnterMine });
    },
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(Root);
  app.mount(host);

  s.show = true;
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
    expect(dispatched).toContain('modalEnter');
    // Compare by identity, not class: Vue has added its v-enter-* classes by the time the hook runs.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toBe(panel);
  });

  it('runs both handlers when @enter comes first', async () => {
    const { panel, mine, dispatched } = await enterOnce('@enter first');
    expect(panel).not.toBeNull();
    expect(dispatched).toContain('modalEnter');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toBe(panel);
  });
});

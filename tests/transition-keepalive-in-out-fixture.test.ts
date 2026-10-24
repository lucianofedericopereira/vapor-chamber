// @vitest-environment happy-dom
// FIXTURE - the transition bridge on a Vapor <Transition> around <KeepAlive>: the leave runs in every mode. The long note is at the end.

import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createTransitionBridge } from '../src/transitions';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const macrotask = () => new Promise((r) => setTimeout(r, 20));

/** One switch from A to B. Returns the bridge's commands and the elements left in the DOM. */
async function switchOnce(mode: string, bus: 'sync' | 'async') {
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  const commands = bus === 'sync' ? createCommandBus({ onMissing: 'ignore' }) : createAsyncCommandBus({ onMissing: 'ignore' });
  const t = createTransitionBridge({ bus: commands, namespace: 'm' });
  const A = v.defineVaporComponent({ name: 'A', setup: () => v.template('<div class="p">A</div>', 1)() });
  const B = v.defineVaporComponent({ name: 'B', setup: () => v.template('<div class="p">B</div>', 1)() });
  const s = v.reactive({ c: A });
  const tpl = await compileVapor(v, `<Transition v-bind="t" mode="${mode}"><KeepAlive><component :is="s.c" /></KeepAlive></Transition>`);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const errors: string[] = [];
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render({ s, t }) }));
  app.config.errorHandler = (e: unknown) => {
    errors.push(String(e));
  };
  app.mount(host);
  await macrotask();

  const order: string[] = [];
  commands.onAfter((cmd: { action: string; target?: Element }) => {
    order.push(`${cmd.action.slice(1)}:${cmd.target?.textContent}`);
  });
  s.c = B;
  await v.nextTick();
  await macrotask();
  const result = { order, left: [...host.querySelectorAll('.p')].map((el) => el.textContent), phase: t.phase.value, errors };
  app.unmount();
  host.remove();
  return result;
}

describe('transition bridge on a Vapor <Transition> around <KeepAlive>', () => {
  for (const bus of ['sync', 'async'] as const) {
    it(`in-out, ${bus} bus: B enters, then A leaves and is gone`, async () => {
      const r = await switchOnce('in-out', bus);
      expect(r.order).toEqual(['BeforeEnter:B', 'Enter:B', 'AfterEnter:B', 'BeforeLeave:A', 'Leave:A', 'AfterLeave:A']);
      expect(r.left).toEqual(['B']);
      expect(r.phase).toBe('idle');
      expect(r.errors).toEqual([]);
    });

    it(`out-in, ${bus} bus (control): A leaves, then B enters`, async () => {
      const r = await switchOnce('out-in', bus);
      expect(r.order.filter((c) => c.endsWith(':A'))).toEqual(['BeforeLeave:A', 'Leave:A', 'AfterLeave:A']);
      expect(r.order.filter((c) => c.endsWith(':B'))).toEqual(['BeforeEnter:B', 'Enter:B', 'AfterEnter:B']);
      expect(r.left).toEqual(['B']);
      expect(r.errors).toEqual([]);
    });
  }
});

/*
 * WHY THIS FILE EXISTS. On Vue 3.6.0-rc.11 a Vapor `<Transition mode="in-out">`
 * around `<KeepAlive>` never ran the leave of the branch it switched away
 * from. The bridge dispatched B's three enter commands and nothing for A, and
 * A stayed in the DOM beside B, on a sync bus and an async one alike. Vue
 * 3.6.0-rc.12 (#15895, "start the in-out leave of a kept-alive branch after
 * the incoming enter") runs it. The in-out cases fail on rc.11 and pass on
 * rc.12 (docs/rc-alignment-log.md, the rc.12 section). out-in is the control:
 * it is right on both.
 *
 * The bridge only supplies hook bodies, so the fix is Vue's. This file pins
 * what an app using `v-bind="t"` observes: the `*Leave` commands it waits on,
 * and the element gone after them.
 *
 * Every template goes through tests/compile-vapor.ts on the installed Vue.
 */

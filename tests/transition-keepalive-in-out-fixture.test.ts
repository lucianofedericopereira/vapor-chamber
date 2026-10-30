// @vitest-environment happy-dom
/**
 * The transition bridge on a Vapor <Transition> around <KeepAlive>, in in-out and out-in modes.
 * Why: the bridge only supplies hook bodies, so an app using v-bind="t" waits on the *Leave commands
 * and expects the old element gone after them; the kept-alive branch's leave must run in every mode.
 * Shows: on a sync and an async bus, in-out dispatches B's enter then A's leave and leaves only B in the DOM
 * with phase idle, and out-in (control) dispatches A's leave and B's enter, with no errors.
 * See: vuejs/core#15895, docs/rc-alignment-log.md s36.46, tests/compile-vapor.ts
 */

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

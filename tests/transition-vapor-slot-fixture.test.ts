// @vitest-environment happy-dom
/**
 * The transition bridge on a vDOM <Transition> whose child is Vapor slot content.
 * Why: in a mixed tree the bound <Transition> can be a vDOM component wrapping its default slot, filled by
 * a Vapor parent; the bridge's leave and enter commands must still arrive, and v-bind="t" must not
 * pass an onMove listener that makes Vue warn about extraneous non-emits listeners on the slot fragment.
 * Shows: slot content dispatches BeforeLeave Leave AfterLeave then BeforeEnter Enter AfterEnter with no
 * errors and no console warning; a Vapor component child (control) dispatches the same.
 * See: docs/rc-alignment-log.md s36.1, s36.6
 */

import { describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createTransitionBridge } from '../src/transitions';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const macrotask = () => new Promise((r) => setTimeout(r, 20));

/** Mount, toggle off, toggle on; the bridge's dispatches and the DOM after each. */
async function run(shape: 'vapor slot' | 'vapor component') {
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  const bus = createCommandBus({ onMissing: 'ignore' });
  const t = createTransitionBridge({ bus, namespace: 'm' });
  const order: string[] = [];
  bus.onAfter((cmd: { action: string }) => {
    order.push(cmd.action.slice(1));
  });
  const s = v.reactive({ on: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const errors: string[] = [];

  let app: VaporApi;
  if (shape === 'vapor slot') {
    // A vDOM component wrapping its default slot in <Transition>, filled by a Vapor parent.
    const wrap = await compileVdom(v, '<Transition v-bind="t"><slot /></Transition>');
    const parent = await compileVapor(v, '<TransWrap :t="t"><div v-if="s.on" class="p">X</div></TransWrap>');
    app = v.createVaporApp(v.defineVaporComponent({ setup: () => parent.render({ s, t }) }));
    app.use(v.vaporInteropPlugin);
    app.component('TransWrap', { props: ['t'], render: wrap.render });
  } else {
    const child = await compileVapor(v, '<div class="p">X</div>');
    const parent = await compileVdom(v, '<Transition v-bind="t"><VChild v-if="s.on" /></Transition>');
    app = v.createApp({ render: () => parent.render({ s, t }, []) });
    app.use(v.vaporInteropPlugin);
    app.component('VChild', v.defineVaporComponent({ setup: () => child.render({}) }));
  }
  app.config.errorHandler = (e: unknown) => {
    errors.push(String(e));
  };
  app.mount(host);
  await macrotask();

  const step = async (on: boolean) => {
    order.length = 0;
    s.on = on;
    await v.nextTick();
    await macrotask();
    return `${order.join(' ')} | ${host.querySelectorAll('.p').length} node, ${t.phase.value}`;
  };
  const off = await step(false);
  const on = await step(true);
  app.unmount();
  host.remove();
  return { off, on, errors };
}

describe('transition bridge on a vDOM <Transition> around Vapor content', () => {
  it('Vapor slot content: the leave and the enter are dispatched', async () => {
    // The bridge spreads no onMove, so nothing falls through to the slot fragment for Vue to warn about.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await run('vapor slot')).toEqual({
      off: 'BeforeLeave Leave AfterLeave | 0 node, idle',
      on: 'BeforeEnter Enter AfterEnter | 1 node, idle',
      errors: [],
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([]);
    warn.mockRestore();
  });

  it('a Vapor component child (control, worked before rc.11): the same dispatches', async () => {
    expect(await run('vapor component')).toEqual({
      off: 'BeforeLeave Leave AfterLeave | 0 node, idle',
      on: 'BeforeEnter Enter AfterEnter | 1 node, idle',
      errors: [],
    });
  });
});

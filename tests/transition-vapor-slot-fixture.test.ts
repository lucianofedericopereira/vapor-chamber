// @vitest-environment happy-dom
/**
 * FIXTURE - the transition bridge on a vDOM `<Transition>` whose child is
 * Vapor SLOT content. Fails on Vue 3.6.0-rc.10, passes from rc.11. The long
 * note is at the end of this file.
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
    // The bridge spreads no onMove, so nothing falls through to the slot
    // fragment for Vue to warn about. See the note at the end.
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

/*
 * WHY THIS FILE EXISTS. `createTransitionBridge` is bound with
 * `<Transition v-bind="t">`. In a mixed tree that `<Transition>` can be a vDOM
 * component's, wrapping its default slot, with the slot filled by a Vapor
 * parent: the transitioned child is then Vapor SLOT content, not a vnode.
 *
 * Measured on Vue 3.6.0-rc.10 (docs/rc-alignment-log.md, the rc.11 cycle):
 * the content left and entered, and the bridge dispatched nothing at all,
 * because vDOM BaseTransition had no hooks to hand a Vapor slot. Vue
 * 3.6.0-rc.11 `e656425e` ("transition vapor slot content inside a vdom
 * Transition") resolves the hooks for the slot's blocks, and the six commands
 * now arrive. A Vapor COMPONENT child already worked on rc.10, so it is the
 * control: it shows the harness dispatches when Vue calls the hooks.
 *
 * NO WARNING. Vue has no `onMove` hook. While the bridge spread `onMove`,
 * `v-bind="t"` passed it on as a fallthrough listener, and on a fragment child
 * (this slot) Vue warned "Extraneous non-emits event listeners (move)". The
 * bridge now keeps `onMove` out of a spread (docs/rc-alignment-log.md, 36.6
 * R2), and the assertion pins that no warning is printed.
 */

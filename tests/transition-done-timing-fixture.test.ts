// @vitest-environment happy-dom
/**
 * When the transition bridge's phase settles on a sync bus, as shipped and with done deferred to a microtask.
 * Why: on a sync bus the bridge calls done() inside the hook's own stack, and on a vDOM mode="out-in"
 * Transition that makes Vue throw; deferring done avoids the throw but changes what a consumer observes
 * at a post-flush watcher, after nextTick and on a later macrotask.
 * Shows: for vapor and vdom, the order of dispatches and the phase, node count and text at the three
 * markers for each variant, plus the vdom out-in throw and that done runs inline versus a microtask later.
 * See: docs/rc-alignment-log.md s35.16, tests/compile-vapor.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { type TransitionBridge, createTransitionBridge } from '../src/transitions';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const macrotask = () => new Promise((r) => setTimeout(r, 20));

const BODY = '<div v-if="s.a" key="a" class="p">A</div><div v-else key="b" class="p">B</div>';
const DEFAULT_MODE = `<Transition v-bind="t">${BODY}</Transition>`;
const OUT_IN = `<Transition mode="out-in" v-bind="t">${BODY}</Transition>`;

/** The bridge as shipped. */
const today = (t: TransitionBridge): object => t;

/** The bridge with `done` never called inside the hook's own stack; emulated here, not in src. */
const deferred = (t: TransitionBridge): object => ({
  ...t,
  onEnter: (el: Element, done: () => void) => t.onEnter(el, () => queueMicrotask(done)),
  onLeave: (el: Element, done: () => void) => t.onLeave(el, () => queueMicrotask(done)),
});

type Variant = (t: TransitionBridge) => object;

/**
 * One toggle of `s.a`. Returns the order of the bridge's dispatches around
 * three markers a consumer can stand on - a `flush: 'post'` watcher in the
 * same flush, the line after `await nextTick()`, a later macrotask - and what
 * `phase` and the DOM read at each.
 */
async function toggle(renderer: 'vapor' | 'vdom', source: string, variant: Variant) {
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  const bus = createCommandBus({ onMissing: 'ignore' });
  const bridge = createTransitionBridge({ bus, namespace: 'm' });
  const t = variant(bridge);
  const s = v.reactive({ a: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const errors: string[] = [];

  let app: VaporApi;
  if (renderer === 'vapor') {
    const tpl = await compileVapor(v, source);
    app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render({ s, t }) }));
  } else {
    const tpl = await compileVdom(v, source);
    app = v.createApp({ render: () => tpl.render({ s, t }, []) });
  }
  app.config.errorHandler = (e: unknown) => {
    errors.push(String(e));
  };
  app.mount(host);
  await macrotask();

  const order: string[] = [];
  const at: Record<string, string> = {};
  const mark = (name: string) => {
    order.push(`[${name}]`);
    at[name] = `${bridge.phase.value}, ${host.querySelectorAll('.p').length} node, text ${host.textContent}`;
  };
  bus.onAfter((cmd: { action: string }) => {
    order.push(cmd.action.slice(1));
  });
  const stop = v.watch(() => s.a, () => mark('post'), { flush: 'post' });

  s.a = false;
  await v.nextTick();
  mark('tick');
  await macrotask();
  mark('later');

  stop();
  try {
    app.unmount();
  } catch (e) {
    errors.push(`unmount: ${String(e)}`);
  }
  host.remove();
  return { order: order.join(' '), at, errors: errors.map((e) => e.slice(0, 60)) };
}

describe('transition bridge on a sync bus: when `phase` settles', () => {
  const SETTLED = 'idle, 1 node, text B';

  for (const renderer of ['vapor', 'vdom'] as const) {
    it(`${renderer}, default mode, today: the leave ends inside the patch, so a post-flush reader sees one node`, async () => {
      expect(await toggle(renderer, DEFAULT_MODE, today)).toEqual({
        order: 'BeforeLeave Leave AfterLeave BeforeEnter [post] Enter AfterEnter [tick] [later]',
        at: { post: 'entering, 1 node, text B', tick: SETTLED, later: SETTLED },
        errors: [],
      });
    });

    it(`${renderer}, default mode, deferred: a post-flush reader sees both nodes, and AfterLeave follows Enter`, async () => {
      expect(await toggle(renderer, DEFAULT_MODE, deferred)).toEqual({
        order: 'BeforeLeave Leave BeforeEnter [post] Enter AfterLeave AfterEnter [tick] [later]',
        at: { post: 'entering, 2 node, text AB', tick: SETTLED, later: SETTLED },
        errors: [],
      });
    });

    it(`${renderer}, out-in, deferred: the swap is still pending at post-flush and the enter lands after nextTick`, async () => {
      expect(await toggle(renderer, OUT_IN, deferred)).toEqual({
        order: 'BeforeLeave Leave [post] BeforeEnter AfterLeave [tick] Enter AfterEnter [later]',
        at: { post: 'leaving, 1 node, text A', tick: SETTLED, later: SETTLED },
        errors: [],
      });
    });
  }

  it('vapor, out-in, today: settled by post-flush', async () => {
    expect(await toggle('vapor', OUT_IN, today)).toEqual({
      order: 'BeforeLeave Leave BeforeEnter AfterLeave [post] Enter AfterEnter [tick] [later]',
      at: { post: SETTLED, tick: SETTLED, later: SETTLED },
      errors: [],
    });
  });

  it('vdom, out-in, today: Vue throws on the synchronous done(), the view is empty and `phase` stays leaving', async () => {
    const measured = await toggle('vdom', OUT_IN, today);
    expect(measured.order).toBe('BeforeLeave Leave [post] [tick] [later]');
    const STUCK = 'leaving, 0 node, text ';
    expect(measured.at).toEqual({ post: STUCK, tick: STUCK, later: STUCK });
    expect(measured.errors[0]).toContain("Cannot read properties of null (reading 'parentNo");
  });

  it('called by hand: `done` runs inside the hook today, a microtask later when deferred', async () => {
    const el = document.createElement('div');
    const bus = createCommandBus({ onMissing: 'ignore' });
    const bridge = createTransitionBridge({ bus, namespace: 'm' });

    const now = vi.fn();
    (today(bridge) as TransitionBridge).onLeave(el, now);
    expect(now).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    (deferred(bridge) as TransitionBridge).onLeave(el, later);
    expect(later).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

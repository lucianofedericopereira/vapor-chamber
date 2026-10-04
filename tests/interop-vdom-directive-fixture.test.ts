// @vitest-environment happy-dom
/**
 * FIXTURE - the vDOM directive plugin on a VAPOR child of a vDOM parent, under
 * `vaporInteropPlugin`. Fails on Vue 3.6.0-rc.9, passes from rc.10. The long
 * note is at the end of this file.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin } from '../src/directives';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A Vapor child whose ROOT is a `v-if` / `v-else`: the element the directive sits on is replaced. */
const SWITCHING_ROOT = '<button v-if="s.a" id="a">A</button><a v-else id="b" role="link">B</a>';

describe('vDOM directive plugin on a Vapor child (vaporInteropPlugin)', () => {
  const seen: unknown[] = [];

  beforeAll(async () => {
    await vapor();
  });

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd: { action: string; payload?: unknown }) => {
      seen.push(cmd.payload === undefined ? cmd.action : [cmd.action, cmd.payload]);
    });
  });

  /** Click listeners on elements (the direct mode) and on the document (`.delegate`), added minus removed. */
  function listenerSpies() {
    const add = vi.spyOn(Element.prototype, 'addEventListener');
    const remove = vi.spyOn(Element.prototype, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: { mock: { calls: unknown[][] } }) => s.mock.calls.filter((c) => c[0] === 'click').length;
    const on = (s: { mock: { calls: unknown[][]; contexts: unknown[] } }, el: Element) =>
      s.mock.calls.filter((c, i) => c[0] === 'click' && s.mock.contexts[i] === el).length;
    return {
      live: () => clicks(add) - clicks(remove),
      liveOn: (el: Element) => on(add, el) - on(remove, el),
      addsOn: (el: Element) => on(add, el),
      removesOn: (el: Element) => on(remove, el),
      liveOnDocument: () => clicks(docAdd) - clicks(docRemove),
    };
  }

  async function mount(parent: string, child: string, extra: Record<string, unknown> = {}) {
    const v = await vapor();
    const s = v.reactive({ a: true });
    const ctx = v.reactive({ act: 'cartAdd', show: true, ...extra });
    const childTpl = await compileVapor(v, child);
    const Child = v.defineVaporComponent({ setup: () => childTpl.render({ s }) });
    const parentTpl = await compileVdom(v, parent);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createApp({ render: () => parentTpl.render(ctx, []) });
    app.use(v.vaporInteropPlugin).use(createDirectivePlugin());
    app.component('Child', Child);
    app.mount(host);
    const q = (sel: string) => host.querySelector(sel) as HTMLElement;
    const click = async (el: HTMLElement) => {
      seen.length = 0;
      el.click();
      await settle();
      return [...seen];
    };
    return { v, s, ctx, app, host, q, click };
  }

  it('direct: the listener follows the root through a branch switch and a binding update', async () => {
    const spies = listenerSpies();
    const { v, s, ctx, app, host, q, click } = await mount('<Child v-vc-command="act" />', SWITCHING_ROOT);

    const first = q('#a');
    // Positive control for the spy: it counts the mount on the first root.
    expect(spies.liveOn(first)).toBe(1);
    expect(await click(first)).toEqual(['cartAdd']);

    s.a = false;
    await v.nextTick();
    const second = q('#b');
    expect(second).toBeTruthy();
    expect(spies.liveOn(second)).toBe(1);
    expect(spies.liveOn(first)).toBe(0);
    expect(await click(second)).toEqual(['cartAdd']);
    // The element that left is detached but still clickable through its reference.
    expect(await click(first)).toEqual([]);

    ctx.act = 'cartRemove';
    await v.nextTick();
    expect(await click(second)).toEqual(['cartRemove']);

    app.unmount();
    expect(spies.live()).toBe(0);
    expect(await click(second)).toEqual([]);
    host.remove();
  });

  it('direct: 50 parent re-renders with the binding unchanged add no listener; a click adds and removes one', async () => {
    const spies = listenerSpies();
    const { v, ctx, app, host, q, click } = await mount(
      '<div><span id="n">{{ n }}</span><Child v-vc-command="act" /></div>',
      '<button id="a">A</button>',
      { n: 0 },
    );
    const root = q('#a');
    expect([spies.addsOn(root), spies.removesOn(root)]).toEqual([1, 0]);

    for (let i = 0; i < 50; i++) {
      ctx.n = i + 1;
      await v.nextTick();
    }
    // Control: the parent did render 50 times.
    expect(q('#n').textContent).toBe('50');
    expect([spies.addsOn(root), spies.removesOn(root)]).toEqual([1, 0]);

    // The pair a click adds is the in-flight guard of a button (markBusy), not a re-bind.
    expect(await click(root)).toEqual(['cartAdd']);
    expect([spies.addsOn(root), spies.removesOn(root)]).toEqual([2, 1]);

    app.unmount();
    expect(spies.live()).toBe(0);
    host.remove();
  });

  it('.delegate: the new root dispatches and the document listener is released on unmount', async () => {
    const spies = listenerSpies();
    const { v, s, app, host, q, click } = await mount('<Child v-vc-command.delegate="act" />', SWITCHING_ROOT);

    expect(spies.liveOnDocument()).toBe(1);
    expect(await click(q('#a'))).toEqual(['cartAdd']);

    s.a = false;
    await v.nextTick();
    expect(spies.liveOnDocument()).toBe(1);
    expect(await click(q('#b'))).toEqual(['cartAdd']);

    app.unmount();
    expect(spies.liveOnDocument()).toBe(0);
    host.remove();
  });

  it('v-vc-payload and v-vc-optimistic reach the new root too', async () => {
    let optimistic = 0;
    const { v, s, app, host, q, click } = await mount(
      '<Child v-vc-payload="pay" v-vc-optimistic="opt" v-vc-command="act" />',
      SWITCHING_ROOT,
      {
        pay: { qty: 3 },
        opt: () => {
          optimistic++;
          return null;
        },
      },
    );

    expect(await click(q('#a'))).toEqual([['cartAdd', { qty: 3 }]]);
    const before = optimistic;
    expect(before).toBeGreaterThan(0);

    s.a = false;
    await v.nextTick();
    expect(await click(q('#b'))).toEqual([['cartAdd', { qty: 3 }]]);
    expect(optimistic).toBeGreaterThan(before);

    app.unmount();
    host.remove();
  });

  it('KeepAlive round trip: one element, one listener, before and after', async () => {
    const spies = listenerSpies();
    const { v, ctx, app, host, q, click } = await mount(
      '<KeepAlive><Child v-if="show" v-vc-command="act" /></KeepAlive>',
      '<button id="a">A</button>',
    );

    const first = q('#a');
    expect(spies.liveOn(first)).toBe(1);
    expect(await click(first)).toEqual(['cartAdd']);

    ctx.show = false;
    await v.nextTick();
    expect(q('#a')).toBeNull();
    ctx.show = true;
    await v.nextTick();

    expect(q('#a')).toBe(first);
    expect(spies.liveOn(first)).toBe(1);
    expect(await click(first)).toEqual(['cartAdd']);

    app.unmount();
    expect(spies.live()).toBe(0);
    host.remove();
  });

  it('a text root mounts nothing and throws nothing: Vue warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spies = listenerSpies();
    const { app, host } = await mount('<Child v-vc-command="act" />', 'just text');

    expect(host.textContent).toBe('just text');
    expect(spies.live()).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('non-element root node'))).toBe(true);

    app.unmount();
    host.remove();
  });
});

/*
 * WHY THIS FILE EXISTS. `createDirectivePlugin()` registers `v-vc-command`,
 * `v-vc-payload` and `v-vc-optimistic` as vDOM directives. Put on a COMPONENT,
 * a vDOM directive is applied to the component's root element. When the
 * component is a Vapor one, inside a vDOM parent with `vaporInteropPlugin`,
 * the root is Vapor's to replace: a root `v-if` / `v-else` swaps the element
 * without the vDOM parent rendering again.
 *
 * On Vue 3.6.0-rc.9 the directive stayed on the element that left. Measured
 * with the probe this fixture was promoted from (docs/rc-alignment-log.md,
 * s35.8): after the switch the new root dispatched nothing, the detached
 * element still dispatched, a binding update did not reach the new root, and a
 * `.delegate` registration never released its document listener at unmount.
 * No test of ours installed the plugin together with interop, so the suite was
 * green throughout.
 *
 * Vue 3.6.0-rc.10 (`437abc2a`, `8cf0c49c`, `8d272536`, `19c79908`) moved the
 * directive hooks of a Vapor child into interop, which follows the child's
 * root: `beforeUnmount` on the root that leaves, `mounted` on the one that
 * replaces it, each with the bindings it was mounted with. That is the rule at
 * the top of src/directives.ts (teardown is keyed to what was mounted),
 * implemented on Vue's side of the call. Nothing in `src` changed for it; this
 * file is what keeps it true.
 *
 * Every template here goes through tests/compile-vapor.ts, so the fixture is
 * held to what the installed compiler emits for the notation a consumer types.
 *
 * THE SPY IS ON `Element.prototype`, and on `document` for `.delegate`. A spy
 * on `EventTarget.prototype` counts nothing under happy-dom. The first
 * assertion of the direct test is the positive control: one listener on the
 * first root at mount.
 */

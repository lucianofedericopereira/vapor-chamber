// @vitest-environment happy-dom
/**
 * What KeepAlive does to a custom directive's scope, on vDOM and on Vapor.
 * Why: `vcCommandVapor` returns a cleanup that Vue registers with `onScopeDispose`; if deactivating a kept-alive component disposed that scope, the control would come back dead, and if the directive re-ran without a disposal the delegated refcount would drift upward. Neither prints anything. Real unmounts (include/exclude, `max` eviction, a nested branch torn down) must still run the cleanup exactly once.
 * Shows: deactivation keeps the element, runs no cleanup and leaves the document click listener in place; reactivation reuses the same element without re-running the directive; unmount removes the listener once; each unmount route runs the cleanup exactly once.
 * See: vuejs/core#15525, vuejs/core#15526
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('KeepAlive keeps a custom directive scope (upstream contract)', () => {
  const seen: string[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  /** Count click add/remove on the document, where `.delegate` registers its one shared listener. */
  function listenerSpies() {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: typeof add) => s.mock.calls.filter((c) => c[0] === 'click').length;
    return { add, remove, adds: () => clicks(add), removes: () => clicks(remove) };
  }

  it('vDOM: deactivate and reactivate keep the element, the state and the count', async () => {
    const v = await vapor();
    const { add, remove, adds, removes } = listenerSpies();

    const show = v.ref(true);
    const Inner = {
      render: () =>
        v.withDirectives(v.h('button', null, 'go'), [
          [v.resolveDirective('vc-command'), 'cartAdd', undefined, { delegate: true }],
        ]),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v
      .createApp({ render: () => v.h(v.KeepAlive, null, { default: () => (show.value ? v.h(Inner) : null) }) })
      .use(createDirectivePlugin());
    app.mount(host);

    const first = host.querySelector('button') as HTMLButtonElement;
    expect(adds()).toBe(1);

    show.value = false;
    await v.nextTick();
    // Deactivated: out of the DOM, beforeUnmount did not run, the listener stays.
    expect(host.querySelector('button')).toBeNull();
    expect(removes()).toBe(0);

    show.value = true;
    await v.nextTick();
    const second = host.querySelector('button') as HTMLButtonElement;
    expect(second).toBe(first);
    expect(adds()).toBe(1);

    second.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    app.unmount();
    expect(removes()).toBe(1);

    add.mockRestore();
    remove.mockRestore();
    host.remove();
  });

  it('Vapor: the same, from a compiled template - scope kept, directive run once', async () => {
    const v = await vapor();
    const { add, remove, adds, removes } = listenerSpies();

    let runs = 0;
    const counting: typeof vcCommandVapor = (...args) => {
      runs++;
      return vcCommandVapor(...args);
    };

    const inner = await compileVapor(v, '<button v-vc-command.delegate="a">A</button>');
    const other = await compileVapor(v, '<span>other</span>');
    const shell = await compileVapor(v, '<KeepAlive><component :is="cur" /></KeepAlive>');
    const state = v.reactive({ a: 'cartAdd' });
    const Inner = v.defineVaporComponent({ setup: () => inner.render(state) });
    const Other = v.defineVaporComponent({ setup: () => other.render(state) });
    const outer = v.reactive({ cur: Inner });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => shell.render(outer) }));
    app.directive('vc-command', counting);
    app.mount(host);

    const first = host.querySelector('button') as HTMLButtonElement;
    expect(runs).toBe(1);
    expect(adds()).toBe(1);
    first.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    outer.cur = Other;
    await v.nextTick();
    expect(host.querySelector('button')).toBeNull();
    // The target is an element, so the directive runs in the component's setup scope, which deactivation pauses and does not stop.
    expect(removes()).toBe(0);

    outer.cur = Inner;
    await v.nextTick();
    const second = host.querySelector('button') as HTMLButtonElement;
    expect(second).toBe(first);
    expect(runs).toBe(1);
    expect(adds()).toBe(1);

    second.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartAdd']);

    app.unmount();
    expect(adds()).toBe(1);
    expect(removes()).toBe(1);

    add.mockRestore();
    remove.mockRestore();
    host.remove();
  });

  /**
   * Wraps the directive so both it and its cleanup are counted.
   * The teardown-route tests below count cleanup calls, not listener removals: a second teardown hits `unmountCommand`'s early return and leaves no trace on the listener.
   */
  function counted() {
    const n = { runs: 0, cleanups: 0 };
    const dir: typeof vcCommandVapor = (...args) => {
      n.runs++;
      const cleanup = vcCommandVapor(...args);
      return cleanup
        ? () => {
            n.cleanups++;
            cleanup();
          }
        : cleanup;
    };
    return { n, dir };
  }

  async function mountShell(v: VaporApi, shellSrc: string, extra: Record<string, unknown> = {}) {
    const { n, dir } = counted();
    const child = await compileVapor(v, '<button v-vc-command.delegate="x">child</button>');
    const Child = v.defineVaporComponent({ name: 'Child', setup: () => child.render({ x: 'cartAdd' }) });
    const shell = await compileVapor(v, shellSrc);
    const st = v.reactive({ show: true, view: 'child', y: 'outside', Child, ...extra });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => shell.render(st) }));
    app.directive('vc-command', dir);
    app.mount(host);
    return { n, st, host, app };
  }

  /** A second delegated element outside the KeepAlive keeps the shared document listener installed throughout. */
  const OUTSIDE = '<button v-vc-command.delegate="y">outside</button>';

  it('include/exclude dropping a cached instance runs the cleanup exactly once', async () => {
    const v = await vapor();
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<KeepAlive :include="inc"><component :is="Child" v-if="view === 'child'" /></KeepAlive></div>`,
      { inc: ['Child'] },
    );
    expect(n.cleanups).toBe(0);

    st.view = 'other';
    st.inc = [];
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });

  it('max eviction runs the cleanup exactly once', async () => {
    const v = await vapor();
    const other = await compileVapor(v, '<span>other</span>');
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<KeepAlive :max="1"><component :is="cur" /></KeepAlive></div>`,
      { cur: null },
    );
    st.cur = st.Child;
    await v.nextTick();
    expect(n.cleanups).toBe(0);

    // With max=1 a second current component prunes the cached one: a real unmount.
    st.cur = v.defineVaporComponent({ name: 'Other', setup: () => other.render({}) });
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });

  it('a nested branch torn down after reactivation runs the cleanup exactly once', async () => {
    const v = await vapor();
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<div v-if="show"><KeepAlive>` +
        `<span v-if="view === 'a'">a</span>` +
        `<component v-else-if="view === 'child'" :is="Child" />` +
        `<span v-else>b</span>` +
        `</KeepAlive></div></div>`,
    );
    const mountRuns = n.runs;

    // Deactivated, not unmounted.
    st.view = 'b';
    await v.nextTick();
    expect(n.cleanups).toBe(0);

    // Reactivated from cache: the directive does not run again.
    st.view = 'child';
    await v.nextTick();
    expect(n.runs).toBe(mountRuns);
    expect(n.cleanups).toBe(0);
    const child = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'child');
    expect(child).toBeDefined();
    (child as HTMLButtonElement).click();
    await settle();
    expect(seen).toContain('cartAdd');

    // Unmount ownership passes to the scope that re-entered the cache (vuejs/core#15526); a surviving old registration would tear down twice.
    st.show = false;
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });
});

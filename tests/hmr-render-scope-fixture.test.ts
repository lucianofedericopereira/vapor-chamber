// @vitest-environment happy-dom
/**
 * `useCommand()` in an element-nested child across real Vue HMR rerenders.
 * Why: a hot-reloaded parent that leaves its old child generations running would keep their on() listeners subscribed, so one dispatch fires duplicate side effects that grow with the length of the dev session.
 * Shows: each superseded generation is disposed (not merely detached), one dispatch reaches only the newest generation's listener, a handler stays registered, and unmount disposes the last generation.
 * See: log s35.124, log s35.202, src/chamber.ts (probeVue).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

describe('useCommand across real HMR rerenders (rc.6)', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('disposes each superseded generation of an element-nested child', async () => {
    // Settle the probe's import('vue') first: it loads a second Vue that also writes __VUE_HMR_RUNTIME__, and the with-vapor build must write last.
    await waitForVueDetection();
    const v = await vapor();
    // One Vue instance for chamber and test; two separately imported dists have disconnected reactivity.
    configureVue(v);
    const hmr = (globalThis as any).__VUE_HMR_RUNTIME__;
    expect(hmr).toBeTruthy();

    const bus = getCommandBus();
    bus.register('cartAdd', () => 'done');

    let setups = 0;
    let disposals = 0;
    /** One entry per listener invocation, tagged with the generation that subscribed. */
    const fired: string[] = [];

    const Child = v.defineVaporComponent({
      setup() {
        const generation = ++setups;
        const { on } = useCommand();
        on('cartAdd', () => {
          fired.push(`gen${generation}`);
        });
        v.onScopeDispose(() => {
          disposals++;
        });
        return v.template('<span>child</span>', true)();
      },
    });

    const parentId = 'fixture-hmr-render-scope-parent';
    // The child is inserted INTO the parent's element rather than returned as its block, so it is outside the block graph hmrRerender walks.
    const render = (label: string) => () => {
      const el = v.template(`<div>${label}</div>`)() as ParentNode;
      v.insert(v.createComponent(Child), el);
      return el;
    };

    const Parent = v.defineVaporComponent({ __hmrId: parentId, render: render('v1') });
    hmr.createRecord(parentId, Parent);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Parent);
    app.mount(host);

    expect(host.textContent).toContain('v1');
    expect(setups).toBe(1);
    bus.dispatch('cartAdd', 'a');
    expect(fired).toEqual(['gen1']);

    hmr.rerender(parentId, render('v2'));
    await v.nextTick();
    hmr.rerender(parentId, render('v3'));
    await v.nextTick();

    // Check setups before the text: 1 = neither rerender ran; 3 with stale text = they ran and the DOM did not follow.
    expect(setups).toBe(3);
    expect(host.textContent).toContain('v3');

    // Each superseded generation is disposed, not merely detached.
    expect(disposals).toBe(2);

    // on() listeners are appended to an array, so a leaked generation would make one dispatch fire once per generation.
    fired.length = 0;
    bus.dispatch('cartAdd', 'b');
    expect(fired).toEqual(['gen3']);

    // register() is keyed by action, so only the handler's presence is checked here.
    expect(bus.hasHandler('cartAdd')).toBe(true);

    app.unmount();
    await v.nextTick();

    expect(disposals).toBe(3);
    host.remove();
  });
});

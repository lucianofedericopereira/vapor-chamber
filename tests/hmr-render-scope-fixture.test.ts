// @vitest-environment happy-dom
/**
 * FIXTURE - `useCommand()` in an element-nested child across REAL Vue HMR
 * rerenders, vue@3.6.0-rc.6.
 *
 * WHY THIS FILE EXISTS. rc.6's `9ab65a1` ("own each dev render generation with
 * a render scope for HMR") replaces the `instance.renderEffects` array that
 * `hmrRerender` used to stop one effect at a time with a fresh per-render
 * `EffectScope` owning everything a dev render generation creates. Upstream's
 * own regression for it is titled "rerender should tear down element-nested
 * child components": a child mounted INSIDE an element, rather than returned as
 * the parent's block, is not reachable from the block graph `hmrRerender` walks,
 * so before rc.6 nothing stopped it - it was detached from the DOM and left
 * running.
 *
 * That is not an internal detail here, because a leaked Vapor instance is a
 * leaked `setup()` scope, and `useCommand()` hangs its cleanup on exactly that
 * scope (`tryAutoCleanup` -> `onScopeDispose`). So the question is a library
 * question: after a parent hot-reloads, does the old generation's subscription
 * go away, or does it outlive the component that made it?
 *
 * WHAT MEASURING IT FOUND - and the asymmetry is the point. `useCommand()`
 * hands out two kinds of subscription and the leak reaches only one of them:
 *
 *   register()  keyed. `s.handlers` is a Map and `register` overwrites by action
 *               (command-bus.ts §register), so generation N+1's handler simply
 *               replaces generation N's. Measured identical on rc.5 and rc.6: a
 *               dispatch after the reload runs the NEWEST generation's handler.
 *               Self-healing by data structure, not by teardown.
 *   on()        appended. Listeners live in an array, so nothing overwrites
 *               anything and every leaked generation stays subscribed. Measured
 *               on rc.5: after two hot reloads, ONE dispatch fires the listener
 *               THREE times - once per generation ever rendered. Duplicate side
 *               effects that grow linearly with how long the dev session has
 *               been running, in exactly the composable this library tells
 *               component authors to use.
 *
 * rc.6 disposes each superseded generation, so the fan-out is gone. No change
 * on our side: `tryAutoCleanup` was always registering the right cleanup on the
 * right scope, and Vue simply began stopping that scope. This file exists so
 * that stays true - it is the assertion that breaks first if the ownership
 * regresses.
 *
 * Everything is imported from the single with-vapor browser build and the
 * chamber is pointed at that same module object via `configureVue()`; two
 * separately-imported Vue dists are two disconnected reactivity instances
 * (chamber.ts §probeVue), so skipping that would silently measure nothing.
 *
 * VERIFIED AGAINST THE PRE-FIX CODE, which is the standard this repo holds
 * fixtures to: on vue@3.6.0-rc.5 this file fails - `disposals` stays 0 and the
 * fan-out assertion sees `['gen1','gen2','gen3']` instead of `['gen3']`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand } from '../src/chamber';
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
    const v = await vapor();
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
    // Element-nested child: `createComponent(Child)` is inserted INTO the
    // parent's own element rather than returned as the parent's block, so it is
    // invisible to the block graph `hmrRerender` walks. A child returned as the
    // block was already torn down before rc.6; this shape was not.
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

    // --- two hot reloads ----------------------------------------------------
    hmr.rerender(parentId, render('v2'));
    await v.nextTick();
    hmr.rerender(parentId, render('v3'));
    await v.nextTick();

    expect(host.textContent).toContain('v3');
    expect(setups).toBe(3);

    // FACT 1 - each superseded generation was DISPOSED, not merely detached.
    // Before rc.6 an element-nested child was unreachable from the block graph,
    // so its scope was never stopped and this stayed 0 no matter how many
    // reloads ran.
    expect(disposals).toBe(2);

    // FACT 2 - the consequence that actually reaches a consumer, and the one
    // that breaks first if fact 1 regresses. `on()` listeners are appended to an
    // array, so nothing overwrites a leaked generation's subscription: a single
    // dispatch would fan out once per generation ever rendered. On rc.5 this
    // reads ['gen1','gen2','gen3'].
    fired.length = 0;
    bus.dispatch('cartAdd', 'b');
    expect(fired).toEqual(['gen3']);

    // FACT 3 - the contrast that explains why this went unnoticed. `register()`
    // is keyed by action in a Map, so the newest generation's handler always
    // wins regardless of teardown. That half is self-healing by data structure,
    // which is why only the listener half above is load-bearing here.
    expect(bus.hasHandler('cartAdd')).toBe(true);

    app.unmount();
    await v.nextTick();

    // Teardown symmetry: one disposal per generation, none left over.
    expect(disposals).toBe(3);
    host.remove();
  });
});

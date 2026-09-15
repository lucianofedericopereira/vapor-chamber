// @vitest-environment happy-dom
/**
 * FIXTURE - `useCommand()` in a child that was CREATED but never MOUNTED,
 * vue@3.6.0-rc.8 (efa2eae, "dispose component instances that never mounted",
 * #15457; commit 12 of the rc.8 range).
 *
 * WHY THIS FILE EXISTS. Before rc.8, `unmountComponent` stopped an instance's
 * scope only inside the branch for MOUNTED instances. A render error after a
 * child is created leaves that child owned by its parent without ever
 * reaching mount - so on unmount nothing stopped its setup scope, and every
 * `onScopeDispose` registered in that setup never ran. rc.8 makes disposal
 * unconditional and keeps only the lifecycle hooks (`onBeforeUnmount`,
 * `onUnmounted`) conditional on having mounted.
 *
 * That is a library question here, not an internal detail: every cleanup in
 * this library hangs on exactly that scope (`tryAutoCleanup` ->
 * `onScopeDispose`). A `useCommand().on()` listener from such a child
 * outlived `app.unmount()` and kept firing on the shared bus - the same leak
 * shape `tests/hmr-render-scope-fixture.test.ts` pins for HMR (rc.6), reached
 * by a different road. No change on our side: the cleanup was always on the
 * right scope, and rc.8 began stopping that scope.
 *
 * The parent below is what compiler-vapor emits for
 *   <Child /><span>{{ boom() }}</span>
 * (compiled with @vue/compiler-vapor 3.6.0-rc.8), which is also the shape of
 * upstream's own regression test: the child is created, then the render
 * effect throws, so the root never produces a block and nothing mounts.
 *
 * Everything comes from the single with-vapor browser build, and the chamber
 * is pointed at that same module object via `configureVue()` - two Vue dists
 * are two disconnected reactivity instances (chamber.ts, probeVue). The probe
 * is awaited first so its own bare `import('vue')` cannot land afterwards.
 *
 * VERIFIED AGAINST THE PRE-FIX RUNTIME: on vue@3.6.0-rc.7 this file fails -
 * `disposals` stays 0 after unmount and the listener still fires.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  return v;
}

describe('a child created but never mounted (rc.8 commit 12)', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('removes its useCommand().on() listener when the app unmounts', async () => {
    const v = await vapor();
    const bus = getCommandBus();
    bus.register('cartAdd', () => 'done');

    const fired: string[] = [];
    let setups = 0;
    let disposals = 0;

    const Child = v.defineVaporComponent({
      setup() {
        setups++;
        const { on } = useCommand();
        on('cartAdd', () => {
          fired.push('child');
        });
        v.onScopeDispose(() => {
          disposals++;
        });
        return v.template('<div>child</div>', true)();
      },
    });

    const boom = (): string => {
      throw new Error('boom');
    };
    const Parent = v.defineVaporComponent({
      setup() {
        const n0 = v.createComponent(Child);
        const n1 = v.template('<span> ')();
        const x1 = v.txt(n1);
        v.renderEffect(() => v.setText(x1, v.toDisplayString(boom())));
        return [n0, n1];
      },
    });

    const host = document.createElement('div');
    const app = v.createVaporApp(Parent);
    const errors: unknown[] = [];
    app.config.errorHandler = (e: unknown) => {
      errors.push(e);
    };
    // Vue also warns that the root's setup returned no block; expected here.
    app.config.warnHandler = () => {};
    app.mount(host);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(host.textContent).not.toContain('child');

    // The child WAS created: its setup ran and its listener is live.
    expect(setups).toBe(1);
    bus.dispatch('cartAdd', 'a');
    expect(fired).toEqual(['child']);
    expect(disposals).toBe(0);

    app.unmount();

    // FACT 1 - the never-mounted child's scope was stopped. rc.7: 0.
    expect(disposals).toBe(1);

    // FACT 2 - the consequence that reaches a consumer: the listener is gone.
    // rc.7: ['child'] - a component that never appeared kept reacting to the
    // bus after its app was torn down.
    fired.length = 0;
    bus.dispatch('cartAdd', 'b');
    expect(fired).toEqual([]);
  });
});

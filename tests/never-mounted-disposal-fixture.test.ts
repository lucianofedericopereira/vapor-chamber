// @vitest-environment happy-dom
/**
 * Fixture: `useCommand().on()` in a child that was created but never mounted (a render error after the child is created).
 * Why: every cleanup in the library hangs on the component's setup scope, so if Vue does not stop that scope on unmount, the child's listener would outlive `app.unmount()` and keep firing on the shared bus.
 * Shows: the child's setup ran and its listener fired before unmount; after `app.unmount()` its scope was disposed once and the listener no longer fires.
 * See: vuejs/core#15457, tests/hmr-render-scope-fixture.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

// One Vue dist for the test and the chamber: two dists are two disconnected reactivity instances. The probe is awaited first so its own import('vue') cannot land afterwards.
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
    // Compiled shape of `<Child /><span>{{ boom() }}</span>`: the child is created, then the render effect throws and nothing mounts.
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
    // Vue also warns that the root's setup returned no block.
    app.config.warnHandler = () => {};
    app.mount(host);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(host.textContent).not.toContain('child');

    expect(setups).toBe(1);
    bus.dispatch('cartAdd', 'a');
    expect(fired).toEqual(['child']);
    expect(disposals).toBe(0);

    app.unmount();

    expect(disposals).toBe(1);

    fired.length = 0;
    bus.dispatch('cartAdd', 'b');
    expect(fired).toEqual([]);
  });
});

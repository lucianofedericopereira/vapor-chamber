// @vitest-environment happy-dom
/**
 * A KeepAlive branch mounted after an out-in leave is cached.
 * Why: docs/manual/05-vue.md and the router guide put `<Transition>` and `<KeepAlive>` together in the Vapor outlet's view slot, and this library's docs promise that a cached page's useCommand listeners stay live. rc.16 caches the branch a nested fragment renders after an out-in leave (vuejs/core#16352). Before rc.16, returning to the third branch of a `v-if / v-else-if / v-else` chain mounted it again and never unmounted the old instance.
 * Shows: with a real Vapor <Transition mode="out-in"> around <KeepAlive> and a three-branch chain, 1 -> 2 -> 3 -> 2 -> 3 runs the third branch's setup once, and unmounts none of them on the way.
 * See: vuejs/core#16352, tests/transition-keepalive-in-out-fixture.test.ts, docs/manual/05-vue.md
 */

import { describe, expect, it } from 'vitest';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const macrotask = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

describe('KeepAlive after an out-in leave', () => {
  it('caches the branch a chain fragment renders, so returning to it does not run its setup again', async () => {
    const v = await vapor();
    const setups = { a: 0, b: 0, c: 0 };
    const unmounts = { a: 0, b: 0, c: 0 };
    const make = async (name: 'a' | 'b' | 'c') => {
      const tpl = await compileVapor(v, `<div class="${name}">${name.toUpperCase()}</div>`);
      return v.defineVaporComponent({
        name: name.toUpperCase(),
        setup: () => {
          setups[name]++;
          v.onUnmounted(() => unmounts[name]++);
          return tpl.render({});
        },
      });
    };
    const [A, B, C] = [await make('a'), await make('b'), await make('c')];
    const s = v.reactive({ step: 1 });
    const root = await compileVapor(
      v,
      `<Transition mode="out-in" @leave="leave">
        <KeepAlive>
          <A v-if="s.step === 1" />
          <B v-else-if="s.step === 2" />
          <C v-else />
        </KeepAlive>
      </Transition>`,
    );
    const Root = v.defineVaporComponent({
      setup: () =>
        root.render({
          s,
          leave: (_el: Element, done: () => void) => setTimeout(done, 5),
        }),
    });

    const host = document.createElement('div');
    document.body.append(host);
    const app = v.createVaporApp(Root);
    app.component('A', A);
    app.component('B', B);
    app.component('C', C);
    app.mount(host);
    await macrotask();
    expect(host.textContent).toBe('A');

    for (const step of [2, 3, 2, 3]) {
      s.step = step;
      await v.nextTick();
      await macrotask();
    }
    expect(host.textContent).toBe('C');
    expect(setups).toEqual({ a: 1, b: 1, c: 1 });
    expect(unmounts).toEqual({ a: 0, b: 0, c: 0 });

    app.unmount();
    host.remove();
  });
});

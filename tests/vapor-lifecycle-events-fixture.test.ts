// @vitest-environment happy-dom
/**
 * `@vue:xxx` lifecycle events on a Vapor component.
 * Why: Vue's Vapor compatibility list has always excluded per-ELEMENT `@vue:xxx` hooks, and before rc.16 a hook on a component was ignored too, with no warning at the call site. rc.16 invokes the listeners a component receives (vuejs/core#16254), and warns in development for the element case it still does not support.
 * Shows: on a real compiled Vapor tree, mounted, beforeUpdate, updated, beforeUnmount and unmounted all reach the parent's listeners, and the element form is still the documented no-op.
 * See: vuejs/core#16254, manual 05, whitepaper 15
 */

import { describe, expect, it } from 'vitest';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const macrotask = () => new Promise((r) => setTimeout(r, 20));

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

describe('@vue:xxx lifecycle events on Vapor components', () => {
  it('fires every component hook the template asks for', async () => {
    const v = await vapor();
    const calls: string[] = [];
    const s = v.reactive({ n: 0 });
    const child = await compileVapor(v, '<b>{{ s.n }}</b>');
    const Child = v.defineVaporComponent({ setup: () => child.render({ s }) });
    const root = await compileVapor(
      v,
      `<Child
        @vue:mounted="m"
        @vue:beforeUpdate="bu"
        @vue:updated="u"
        @vue:beforeUnmount="bum"
        @vue:unmounted="um"
      />`,
    );
    const Root = v.defineVaporComponent({
      setup: () =>
        root.render({
          Child,
          m: () => calls.push('mounted'),
          bu: () => calls.push('beforeUpdate'),
          u: () => calls.push('updated'),
          bum: () => calls.push('beforeUnmount'),
          um: () => calls.push('unmounted'),
        }),
    });

    const host = document.createElement('div');
    document.body.append(host);
    const app = v.createVaporApp(Root);
    app.component('Child', Child);
    app.mount(host);
    await v.nextTick();
    expect(calls).toEqual(['mounted']);

    s.n = 1;
    await v.nextTick();
    expect(calls.filter((c) => c === 'beforeUpdate')).toHaveLength(1);
    expect(calls.filter((c) => c === 'updated')).toHaveLength(1);

    app.unmount();
    await macrotask();
    expect(calls).toContain('beforeUnmount');
    expect(calls).toContain('unmounted');
    host.remove();
  });

  it('control: the element form is still ignored', async () => {
    const v = await vapor();
    let fired = 0;
    const root = await compileVapor(v, '<div @vue:mounted="m">plain</div>');
    const Root = v.defineVaporComponent({
      setup: () => root.render({ m: () => fired++ }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = v.createVaporApp(Root);
    app.mount(host);
    await v.nextTick();
    expect(fired).toBe(0);
    app.unmount();
    host.remove();
  });
});

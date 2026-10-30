// @vitest-environment happy-dom
/**
 * A Vapor component held in a deep `ref` and rendered through `<component :is>`.
 * Why: Vue warns when a Vapor component reaches `createComponent` as a reactive proxy, so an app that writes `ref(Comp)` would see a changed message or count. The library holds no component in a ref, so nothing of its own triggers it.
 * Shows: a deep ref logs one "made a reactive object" warning and still renders the component; `shallowRef` and `markRaw` inside a ref log none.
 * See: log s36.F43
 */

import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  v = await import(/* @vite-ignore */ WITH_VAPOR);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function warningsFor(hold: (child: unknown) => unknown): Promise<{ hits: number; text: string | null }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const Child = v.defineVaporComponent({ setup: () => v.template('<span>c</span>', true)() });
  const tpl = await compileVapor(v, '<component :is="current" />');
  const current = hold(Child);
  const root = document.createElement('div');
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render(v.proxyRefs({ current })) }));
  app.mount(root);
  const hits = warn.mock.calls.filter((c) => /made a reactive object/.test(String(c[0]))).length;
  const text = root.textContent;
  app.unmount();
  return { hits, text };
}

it('a deep ref around a component warns once and still renders it', async () => {
  expect(await warningsFor((c) => v.ref(c))).toEqual({ hits: 1, text: 'c' });
});

it('shallowRef is the control: no warning', async () => {
  expect(await warningsFor((c) => v.shallowRef(c))).toEqual({ hits: 0, text: 'c' });
});

it('markRaw inside a ref is the control: no warning', async () => {
  expect(await warningsFor((c) => v.ref(v.markRaw(c as object)))).toEqual({ hits: 0, text: 'c' });
});

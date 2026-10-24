// @vitest-environment happy-dom
// FIXTURE - a Vapor component held in a deep ref warns once in development, and shallowRef or markRaw do not. The note is at the end.

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

/*
 * WHY THIS FILE EXISTS. Vue 3.6.0-rc.13 (0c2ad8952) warns, in development,
 * when a Vapor component reaches createComponent as a reactive proxy, and
 * unwraps it with toRaw. rc.12 said nothing. The library holds no component
 * in a ref (grep of src and examples: the store's `view` reactive wraps
 * state, never a component), so nothing of ours triggers it. The case is
 * the one an app writes with `ref(Comp)` beside a `<component :is>`, which
 * the fixture pins so a change of the message or the count is seen here.
 * The first test fails on rc.12 (hits 0) and passes on rc.13
 * (docs/rc-alignment-log.md, section 36.F43). The two controls pass on both.
 */

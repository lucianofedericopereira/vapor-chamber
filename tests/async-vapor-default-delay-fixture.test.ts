// @vitest-environment happy-dom
/**
 * FIXTURE: defineVaporAsyncComponent with a loadingComponent and no delay waits Vue's default 200 ms.
 * Why: the library passes the options through to Vue, so an app gets Vue's documented default; an upstream change must show here.
 * Shows: the loading component is absent at 0 and 199 ms and present at 200 ms.
 * See: log 36.F43, vuejs/core#15950.
 */

import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { VaporApi } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  v = await import(/* @vite-ignore */ WITH_VAPOR);
});

afterEach(() => {
  vi.useRealTimers();
});

it('the loading component shows at 200 ms, not before', async () => {
  vi.useFakeTimers();
  const Loading = v.defineVaporComponent({ setup: () => v.template('<b>loading</b>', true)() });
  const Foo = v.defineVaporAsyncComponent({ loader: () => new Promise(() => {}), loadingComponent: Loading });
  const root = document.createElement('div');
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => v.createComponent(Foo) }));
  app.mount(root);
  const seen = { t0: root.innerHTML.includes('loading') };
  vi.advanceTimersByTime(199);
  await v.nextTick();
  const t199 = root.innerHTML.includes('loading');
  vi.advanceTimersByTime(1);
  await v.nextTick();
  expect({ ...seen, t199, t200: root.innerHTML.includes('loading') }).toEqual({ t0: false, t199: false, t200: true });
  app.unmount();
});

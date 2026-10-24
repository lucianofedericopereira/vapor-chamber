// @vitest-environment happy-dom
// FIXTURE - defineVaporAsyncComponent with a loadingComponent and no delay option waits the default 200 ms. The note is at the end.

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

/*
 * WHY THIS FILE EXISTS. On Vue 3.6.0-rc.12 `useAsyncComponentState` took
 * `delay` as given, so a Vapor async component with a `loadingComponent` and
 * no `delay` showed the loading component at once (the vDOM one waits 200 ms,
 * the documented default). Vue 3.6.0-rc.13 (#15950) restores the default.
 * The library's defineVaporAsyncComponent passes the options through to
 * Vue's, so an app sees the change as it is. This file fails on rc.12 and
 * passes on rc.13 (docs/rc-alignment-log.md, section 36.F43).
 */

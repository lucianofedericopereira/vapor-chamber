// @vitest-environment happy-dom
/**
 * FIXTURE: `useCommand().on` in a `<KeepAlive>` child that is torn down, with a pending `<Suspense>` branch, before KeepAlive cached it.
 * Why: a listener goes only when its component's scope stops (KeepAlive's pause releases handlers, not listeners); Vue 3.6.0-rc.14 parked such an uncached child as if deactivated, its scope still active, so its listener heard every later dispatch for the life of the page.
 * Shows: the child's listener hears a dispatch while its branch is pending; after the branch is removed before its async dependency resolves, a dispatch reaches no listener of the torn-down child.
 * See: vuejs/core#15981, src/chamber.ts (useCommand, tryAutoCleanup), tests/usecommand-keepalive.test.ts
 */

import { expect, it, vi } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { type VaporApi, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

const ROOT =
  '<Suspense><div v-if="show"><component :is="Dep" /><KeepAlive><component :is="Inner" /></KeepAlive></div>' +
  '<p v-else>off</p></Suspense>';

it('a KeepAlive child removed before it was cached: its listener hears nothing afterwards', async () => {
  using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  setCommandBus(createCommandBus({ onMissing: 'ignore' }));
  const bus = getCommandBus();
  bus.register('ping', () => 'pong');

  const heard = vi.fn();
  // An async dependency that never resolves keeps the branch pending, so KeepAlive never caches Inner.
  const Dep = v.defineComponent({ async setup() { await new Promise(() => {}); return () => null; } });
  const Inner = v.defineComponent({
    name: 'Inner',
    setup() {
      useCommand().on('ping', heard);
      return () => v.h('i', 'inner');
    },
  });

  const show = v.ref(true);
  const root = await compileVdom(v, ROOT);
  const ctx = { get show() { return show.value; }, Dep, Inner };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createApp({ render: () => root.render(ctx, []) });
  app.mount(host);
  await settle();
  // Control: set up in the pending branch, the listener hears.
  bus.dispatch('ping', null);
  expect(heard).toHaveBeenCalledTimes(1);
  heard.mockClear();

  show.value = false;
  await settle();
  expect(host.textContent).toBe('off');

  bus.dispatch('ping', null);
  expect(heard).toHaveBeenCalledTimes(0);

  app.unmount();
  host.remove();
});

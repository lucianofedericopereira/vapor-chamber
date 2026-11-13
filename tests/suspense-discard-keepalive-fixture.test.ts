// @vitest-environment happy-dom
/**
 * FIXTURE: `defineVaporCommand` in a component discarded with a pending `<Suspense>` branch, inside a page cached by `<KeepAlive>`.
 * Why: the composable's KeepAlive hooks are injected into the cached page and removed when the component goes; Vue 3.6.0-rc.14 removed them on an unmount hook that a discarded pending branch never runs, so the next activation of the page ran the disposed component's resume and registered its handler again, answering for a component that no longer exists.
 * Shows: after the branch holding the component is discarded while pending and the page is deactivated and activated again, `save` has no handler and the disposed handler is never called.
 * See: vuejs/core 79b80b7a4, src/chamber-vapor.ts (defineVaporCommand), src/chamber.ts (tryKeepAliveHooks), tests/register-live-owner-fixture.test.ts
 */

import { expect, it, vi } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import { defineVaporCommand } from '../src/chamber-vapor';
import { createCommandBus } from '../src/command-bus';
import { type VaporApi, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

const ROOT = '<KeepAlive><component :is="cur" /></KeepAlive>';
/** The keyed div makes a change of `view` replace the whole pending branch. */
const PAGE =
  '<Suspense><div :key="view"><component :is="Dep" /><component v-if="view === \'a\'" :is="Child" /></div>' +
  '<template #fallback><p>wait</p></template></Suspense>';

it('a pending branch discarded with its component: a later activation does not bring the handler back', async () => {
  using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  setCommandBus(createCommandBus({ onMissing: 'ignore' }));
  const bus = getCommandBus();

  let hits = 0;
  // An async dependency that never resolves keeps the branch pending.
  const Dep = v.defineComponent({ async setup() { await new Promise(() => {}); return () => null; } });
  const Child = v.defineComponent({
    setup() {
      defineVaporCommand('save', () => { hits++; });
      return () => v.h('i', 'child');
    },
  });

  const view = v.ref('a');
  const page = await compileVdom(v, PAGE);
  const pageCtx = { get view() { return view.value; }, Dep, Child };
  const Page = v.defineComponent({ name: 'Page', render: () => page.render(pageCtx, []) });
  const Other = v.defineComponent({ name: 'Other', render: () => v.h('b', 'other') });

  const cur = v.shallowRef(Page);
  const root = await compileVdom(v, ROOT);
  const rootCtx = { get cur() { return cur.value; } };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createApp({ render: () => root.render(rootCtx, []) });
  app.mount(host);
  await settle();
  expect(host.textContent).toBe('wait');
  expect(bus.hasHandler('save')).toBe(true);

  view.value = 'b';
  await settle();
  expect(bus.hasHandler('save')).toBe(false);

  cur.value = Other;
  await settle();
  cur.value = Page;
  await settle();

  bus.dispatch('save', null);
  expect(hits).toBe(0);
  expect(bus.hasHandler('save')).toBe(false);

  app.unmount();
  host.remove();
});

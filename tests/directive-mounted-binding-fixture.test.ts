// @vitest-environment happy-dom
/**
 * FIXTURE: the vDOM `v-vc-command` whose modifiers change while its `<Suspense>` branch is pending, before the directive's `mounted` runs.
 * Why: the directive reads its modifiers once, in `mounted` (`updated` rewrites the action, payload and optimistic value, not the modifiers); Vue 3.6.0-rc.14 called `mounted` with the binding of the first render, so `.once` set while the branch was pending never applied and the button dispatched on every press.
 * Shows: modifiers changed to `{ once: true }` before the async dependency resolves are the ones `mounted` reads: two clicks after the reveal dispatch once.
 * See: vuejs/core#16120, src/directives.ts, src/command-binding.ts
 */

import { expect, it } from 'vitest';
import { configureVue, getCommandBus, resetCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin } from '../src/directives';
import type { VaporApi } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

// Built with a render function: modifiers written in a template are static, so only a render function can change them.
it('modifiers changed while the branch is pending: mounted reads the latest, and .once dispatches once', async () => {
  await waitForVueDetection();
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  configureVue(v);
  resetCommandBus();
  setCommandBus(createCommandBus({ onMissing: 'ignore' }));
  const bus = getCommandBus();
  bus.register('save', () => 'saved');
  const dispatched: string[] = [];
  bus.onAfter((cmd: { action: string }) => {
    dispatched.push(cmd.action);
  });

  let open = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const Dep = v.defineComponent({ async setup() { await gate; return () => v.h('i', 'dep'); } });
  const mods = v.shallowRef({});
  const Root = v.defineComponent({
    render: () =>
      v.h(v.Suspense, null, {
        default: () =>
          v.h('div', [
            v.withDirectives(v.h('button', 'go'), [[v.resolveDirective('vc-command'), 'save', undefined, mods.value]]),
            v.h(Dep),
          ]),
        fallback: () => v.h('p', 'wait'),
      }),
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createApp(Root);
  app.use(createDirectivePlugin());
  app.mount(host);
  await settle();
  expect(host.textContent).toBe('wait');

  mods.value = { once: true };
  await settle();
  open();
  await settle();
  await settle();

  const button = host.querySelector('button') as HTMLButtonElement;
  expect(button).not.toBeNull();
  button.click();
  button.click();
  await settle();
  expect(dispatched).toEqual(['save']);

  app.unmount();
  host.remove();
});

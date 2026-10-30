// @vitest-environment happy-dom
/**
 * Fixture: useCommand() in a vDOM component nested in Vapor components, removed by a vDOM v-if.
 * Why: a listener hangs its unsubscribe on the component scope, so if Vue does not stop the scope when vDOM removes the form, the listener outlives its view and runs its side effects on every later dispatch.
 * Shows: both nested grandchildren are subscribed while mounted, and after the v-if removes the form no listener fires and both scopes are disposed.
 * See: docs/rc-alignment-log.md.
 */

import { beforeAll, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  await waitForVueDetection();
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
});

it('a vDOM v-if removing nested Vapor components stops the vDOM grandchildren\'s listeners', async () => {
  setCommandBus(createCommandBus({ onMissing: 'ignore' }));
  const bus = getCommandBus();
  let fired = 0;
  let disposed = 0;
  const VDomChild = {
    setup() {
      useCommand().on('cartAdd', () => {
        fired++;
      });
      v.onScopeDispose(() => {
        disposed++;
      });
      return () => v.h('p', 'c');
    },
  };
  const button = await compileVapor(v, '<VDomChild />');
  const buttons = await compileVapor(v, '<VaporButton /><VaporButton />');
  const root = await compileVdom(v, '<form v-if="s.show"><VaporButtons /></form>');
  const s = v.reactive({ show: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createApp({ render: () => root.render({ s }, []) });
  app.use(v.vaporInteropPlugin);
  app.component('VDomChild', VDomChild);
  app.component('VaporButton', v.defineVaporComponent({ setup: () => button.render({}) }));
  app.component('VaporButtons', v.defineVaporComponent({ setup: () => buttons.render({}) }));
  app.mount(host);

  // Positive control: without it, "0 fired after removal" could pass on a listener that never subscribed.
  bus.dispatch('cartAdd', 1);
  expect(fired).toBe(2);

  fired = 0;
  s.show = false;
  await v.nextTick();
  expect(host.querySelector('form')).toBeNull();
  bus.dispatch('cartAdd', 2);
  expect({ fired, disposed }).toEqual({ fired: 0, disposed: 2 });

  app.unmount();
  host.remove();
});

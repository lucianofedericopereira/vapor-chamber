// @vitest-environment happy-dom
/**
 * FIXTURE - `useCommand()` in a vDOM component nested in Vapor components,
 * removed by a vDOM `v-if`. Fails on Vue 3.6.0-rc.10, passes from rc.11. The
 * long note is at the end of this file.
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

  // Positive control: both grandchildren are subscribed while mounted.
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

/*
 * WHY THIS FILE EXISTS. `useCommand().on()` hangs its unsubscribe on the
 * component's scope, so a listener lives exactly as long as the component.
 * That holds only if Vue stops the scope.
 *
 * The shape is upstream's regression test for Vue 3.6.0-rc.11 `daf7004e`: a
 * vDOM `<form v-if>` holding a Vapor component, which renders Vapor
 * components, which each render a vDOM component. When the vDOM `v-if`
 * removes the form, vDOM owns the removal and removes the DOM itself, so the
 * Vapor components are unmounted with no parent node, and on rc.10 the vDOM
 * components inside them were never unmounted.
 *
 * Measured on rc.10 (docs/rc-alignment-log.md, the rc.11 cycle): after the
 * form left, one dispatch still ran both grandchildren's listeners, and
 * neither scope was ever disposed, not even by `app.unmount()`. A listener
 * that outlives its view runs its side effects for every later dispatch. On
 * rc.11 both are disposed with the form. Nothing in `src` changed for it.
 *
 * The first dispatch is the positive control: without it, "0 fired after
 * removal" could pass on a listener that never subscribed.
 */

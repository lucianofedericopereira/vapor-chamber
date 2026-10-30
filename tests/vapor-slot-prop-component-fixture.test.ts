// @vitest-environment happy-dom
/**
 * A component named by a slot prop, `<Provider v-slot="{ comp }"><comp /></Provider>`, whose prop changes while the slot stays mounted.
 * Why: a provider that swaps what its slot renders must swap the commands that answer too; with the old component left in place the page shows and answers the stale view.
 * Shows: the slot follows the prop, the `useCommand().on()` listener of the old component is released and the new one's answers, and unmount releases the last.
 * See: vuejs/core@8809141
 */

import { describe, expect, it } from 'vitest';
import { configureVue, resetCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

describe('a component named by a slot prop', () => {
  it('follows the prop, and the commands follow the component', async () => {
    await waitForVueDetection();
    const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    configureVue(v);
    resetCommandBus();
    const bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);

    const heard: string[] = [];
    const view = async (name: string) => {
      const { render } = await compileVapor(v, `<b>${name}</b>`);
      return v.defineVaporComponent({
        setup() {
          useCommand().on('ping', () => {
            heard.push(name);
          });
          return render({});
        },
      });
    };
    const A = await view('A');
    const B = await view('B');

    const s = v.shallowReactive({ comp: A });
    const provider = await compileVapor(v, '<slot :comp="s.comp" />');
    const Provider = v.defineVaporComponent({ setup: () => provider.render({ s }) });
    const top = await compileVapor(v, '<Provider v-slot="{ comp }"><comp /></Provider>');

    const host = document.createElement('div');
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => top.render({}) }));
    app.component('Provider', Provider);
    app.mount(host);

    expect(host.textContent).toBe('A');
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A']);

    s.comp = B;
    await v.nextTick();
    expect(host.textContent).toBe('B');
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A', 'B']);

    app.unmount();
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A', 'B']);
  });
});

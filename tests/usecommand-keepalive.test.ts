// @vitest-environment happy-dom
/**
 * useCommand().register follows KeepAlive: a deactivated page releases its handlers and takes them back when activated.
 * Why: if a cached page kept its handler, going back from page B to page A would leave B's handler answering while A is on screen.
 * Shows: with two cached Vapor pages, the page on screen answers pageSave after A -> B -> A, and no handler remains after unmount; listeners (on()) are not asserted.
 * See: ROADMAP.md
 */
import { expect, vi } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';
import { compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

it('KeepAlive: going back to a cached page makes ITS handler answer again', async () => {
  using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const v: any = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
  setCommandBus(createCommandBus());
  const bus = getCommandBus();
  const page = (name: string) => v.defineVaporComponent({
    name,
    setup() {
      useCommand().register('pageSave' as never, () => name);
      return v.template(`<i>${name}</i>`, true)();
    },
  });
  const A = page('A');
  const B = page('B');
  const current = v.shallowRef(A);
  const parent = await compileVapor(v, '<KeepAlive><component :is="cur" /></KeepAlive>');
  const Root = v.defineVaporComponent({ setup: () => parent.render({ get cur() { return current.value; } }) });
  const host = document.createElement('div');
  document.body.append(host);
  const app = v.createVaporApp(Root);
  app.mount(host);
  const tick = async () => { await v.nextTick(); await new Promise((r) => setTimeout(r, 0)); };

  expect(bus.dispatch('pageSave', {})).toSucceedWith('A');
  current.value = B;
  await tick();
  expect(bus.dispatch('pageSave', {})).toSucceedWith('B');
  current.value = A;
  await tick();
  expect(host.textContent).toBe('A');
  expect(bus.dispatch('pageSave', {})).toSucceedWith('A');

  app.unmount();
  host.remove();
  expect(bus.hasHandler('pageSave')).toBe(false);
});

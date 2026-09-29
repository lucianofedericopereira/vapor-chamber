// @vitest-environment happy-dom
/**
 * useCommand().register follows KeepAlive: the page on screen answers.
 *
 * useCommandHistory and useCommandError already pause and resume through
 * tryKeepAliveHooks; useCommand, the composable that registers handlers, did
 * not (an omission, owner 2026-09-27). Measured on rc.9: A -> B -> back to A,
 * and B's handler answered while A was on screen. Now a deactivated page
 * releases its handlers (register()'s cleanup removes only its own) and takes
 * them back when it is activated. Listeners (on()) are unchanged: whether a
 * cached page keeps listening is an open decision (docs/plan-failures-and-
 * contract.md, 7.1).
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

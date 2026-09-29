// @vitest-environment happy-dom
/**
 * register()'s cleanup removes only what it registered.
 *
 * Deleting whatever held the name when the cleanup runs is wrong in the order
 * the framework produces: KeepAlive with a max sets up the new page and THEN
 * evicts the old one, whose cleanup would delete the new page's handler while
 * it is on screen (measured on rc.9: `register B -> dispose A`, dispatch ->
 * ok: false). docs/plan-failures-and-contract.md, 2.1.
 */
import { describe, expect, vi } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { it } from '../src/vitest';
import { compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

describe('register() cleanup ownership', () => {
  it('a stale cleanup leaves a newer owner\'s handler and undo in place (sync bus)', ({ bus }) => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const undoB = () => 'undo B';
    const offA = bus.register('save', () => 'A', { undo: () => 'undo A' });
    const offB = bus.register('save', () => 'B', { undo: undoB });

    offA();
    expect(bus.dispatch('save', {})).toSucceedWith('B');
    expect(bus.getUndoHandler('save')).toBe(undoB);

    offB();
    expect(bus.hasHandler('save')).toBe(false);
    expect(bus.getUndoHandler('save')).toBeUndefined();
  });

  it('the same on the async bus', async ({ asyncBus: bus }) => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offA = bus.register('save', async () => 'A');
    bus.register('save', async () => 'B');
    offA();
    expect(await bus.dispatch('save', {})).toSucceedWith('B');
  });

  it('the test bus behaves the same (a double must not diverge)', () => {
    // The double records dispatches instead of running handlers, so ownership
    // is read through what it does expose: the registered undo handler.
    const bus = createTestBus();
    const undoB = () => 'undo B';
    const offA = bus.register('save', () => 'A', { undo: () => 'undo A' });
    bus.register('save', () => 'B', { undo: undoB });
    offA();
    expect(bus.getUndoHandler('save')).toBe(undoB);
  });

  it('a cleanup run twice does not remove a later owner', ({ bus }) => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offA = bus.register('save', () => 'A');
    offA();
    bus.register('save', () => 'B');
    offA();
    expect(bus.dispatch('save', {})).toSucceedWith('B');
  });

  it('KeepAlive with a max: the page on screen still answers after the other is evicted', async () => {
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
    const parent = await compileVapor(v, '<KeepAlive :max="1"><component :is="cur" /></KeepAlive>');
    const Root = v.defineVaporComponent({ setup: () => parent.render({ get cur() { return current.value; } }) });
    const host = document.createElement('div');
    document.body.append(host);
    const app = v.createVaporApp(Root);
    app.mount(host);

    current.value = B;
    await v.nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(host.textContent).toBe('B');
    expect(bus.dispatch('pageSave', {})).toSucceedWith('B');
    app.unmount();
    host.remove();
  });
});

// @vitest-environment happy-dom
/**
 * The Vapor outlet's `view` slot, `<RouterOutlet v-slot:view="{ Component }"><Component /></RouterOutlet>`, compiled on the installed Vue and mounted with a real router.
 * Why: an app wraps the routed component in the slot, so a slot that stayed on the old component would show the old page and leave its commands answering.
 * Shows: navigation swaps the component, the replaced component's `useCommand().on()` listener is released, a `<Transition>` around it runs on each swap, the default slot is still the no-match fallback, and with no match and no default the slot holds nothing.
 * See: src/router/vapor.ts, docs/router.md
 */
import * as Vue from 'vue';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureVue, resetCommandBus, setCommandBus, useCommand } from '../../src/chamber';
import { createCommandBus } from '../../src/command-bus';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';
import { RouterOutlet } from '../../src/router/vapor';
import { type VaporApi, compileVapor } from '../compile-vapor';

const v = Vue as unknown as VaporApi;
const ROWS: RouteRecord[] = [
  // Each source mounts as the layout, so `/app` is its outlet with no match.
  { name: 'layout', path: '/app', component: 'Layout' },
  { name: 'a', path: '/app/a', parent: 'layout', component: 'A' },
  { name: 'b', path: '/app/b', parent: 'layout', component: 'B' },
];

let done: () => void = () => {};
beforeAll(() => { configureVue(v); });
afterEach(() => { done(); resetCommandBus(); });

async function mount(source: string, ctx: Record<string, unknown> = {}) {
  const heard: string[] = [];
  const bus = createCommandBus({ onMissing: 'ignore' });
  setCommandBus(bus);
  const page = (text: string) => {
    const { template, defineVaporComponent } = v;
    return defineVaporComponent({
      setup() {
        useCommand().on('ping', () => { heard.push(text); });
        return template(`<p>${text}</p>`, 1)();
      },
    });
  };
  const layout = await compileVapor(v, source);
  const Layout = v.defineVaporComponent({ setup: () => layout.render(ctx) });
  const router = createRouter({ base: '', history: createMemoryHistory(''), routes: ROWS, components: { Layout, A: page('A'), B: page('B') } });
  await router.push('/app/a');
  const top = await compileVapor(v, '<RouterOutlet />');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => top.render({}) }));
  app.component('RouterOutlet', RouterOutlet);
  app.use(router);
  app.mount(host);
  done = () => { app.unmount(); host.remove(); router.dispose(); done = () => {}; };
  const push = async (to: string) => { await router.push(to); await v.nextTick(); };
  return { host, bus, heard, push };
}

describe('the Vapor outlet: the view slot', () => {
  it('follows the route, inside what the slot wraps, and releases the replaced listener', async () => {
    const { host, bus, heard, push } = await mount('<RouterOutlet v-slot:view="{ Component }"><main><Component /></main></RouterOutlet>');
    expect(host.innerHTML).toContain('<main>');
    expect(host.querySelector('main')?.textContent).toBe('A');
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A']);

    await push('/app/b');
    expect(host.querySelector('main')?.textContent).toBe('B');
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A', 'B']);

    done();
    bus.dispatch('ping', {});
    expect(heard).toEqual(['A', 'B']);
  });

  it('works around a Transition: each swap runs its hooks', async () => {
    const seen: string[] = [];
    const hook = (name: string) => (el: Element, end?: () => void) => { seen.push(`${name}:${el.textContent}`); end?.(); };
    const { host, push } = await mount(
      '<RouterOutlet v-slot:view="{ Component }"><Transition :css="false" @enter="enter" @leave="leave"><Component /></Transition></RouterOutlet>',
      { enter: hook('enter'), leave: hook('leave') },
    );
    expect(host.textContent).toBe('A');

    await push('/app/b');
    expect(host.textContent).toBe('B');
    expect(seen).toContain('leave:A');
    expect(seen).toContain('enter:B');
  });

  it('with a default slot, no match shows the fallback, and a match comes back through the view slot', async () => {
    const { host, push } = await mount(
      '<RouterOutlet><template #view="{ Component }"><main><Component /></main></template><template #default><em>none</em></template></RouterOutlet>',
    );
    expect(host.querySelector('main')?.textContent).toBe('A');
    await push('/app');
    expect(host.querySelector('main')).toBeNull();
    expect(host.textContent).toBe('none');
    await push('/app/b');
    expect(host.querySelector('main')?.textContent).toBe('B');
  });

  it('with no default slot, no match keeps the slot with nothing in it', async () => {
    const { host, push } = await mount('<RouterOutlet v-slot:view="{ Component }"><main><Component /></main></RouterOutlet>');
    await push('/app');
    expect(host.querySelector('main')?.textContent).toBe('');
    await push('/app/a');
    expect(host.querySelector('main')?.textContent).toBe('A');
  });

  it('no view slot: the component renders with no wrapper, as before the slot existed', async () => {
    const { host, push } = await mount('<RouterOutlet />');
    expect(host.querySelector('p')?.textContent).toBe('A');
    await push('/app/b');
    expect(host.querySelector('p')?.textContent).toBe('B');
  });
});

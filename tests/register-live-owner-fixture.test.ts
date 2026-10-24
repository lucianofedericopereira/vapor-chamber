// @vitest-environment happy-dom
/** Two pages own one action in a real Vapor app: the page on screen answers, whichever leaves or is cached. Rationale at the end. */
import { expect, vi } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand } from '../src/chamber';
import { defineVaporCommand } from '../src/chamber-vapor';
import { createCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';
import { compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function mountPages(own: (name: string) => void, template: string, start: 'A' | 'both') {
  const v: any = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
  setCommandBus(createCommandBus());
  const page = (name: string) => v.defineVaporComponent({
    name,
    setup() { own(name); return v.template(`<i>${name}</i>`, true)(); },
  });
  const A = page('A');
  const B = page('B');
  const cur = v.shallowRef(A);
  const showB = v.ref(start === 'both');
  const parent = await compileVapor(v, template);
  const Root = v.defineVaporComponent({ setup: () => parent.render({ get cur() { return cur.value; }, get showB() { return showB.value; }, A, B }) });
  const host = document.createElement('div');
  document.body.append(host);
  const app = v.createVaporApp(Root);
  app.mount(host);
  const tick = async () => { await v.nextTick(); await new Promise((r) => setTimeout(r, 0)); };
  const done = () => { app.unmount(); host.remove(); };
  return { A, B, cur, showB, host, tick, done, bus: getCommandBus() };
}

const owners = [
  ['defineVaporCommand', (name: string) => { defineVaporCommand('pageSave', () => name); }],
  ['useCommand().register', (name: string) => { useCommand().register('pageSave' as never, () => name); }],
] as const;

for (const [label, own] of owners) {
  it(`${label}: B unmounts while A stays, A answers`, async () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await mountPages(own, '<component :is="A" /><component v-if="showB" :is="B" />', 'both');
    expect(t.host.textContent).toBe('AB');
    expect(t.bus.dispatch('pageSave', {})).toSucceedWith('B');
    t.showB.value = false;
    await t.tick();
    expect(t.host.textContent).toBe('A');
    expect(t.bus.dispatch('pageSave', {})).toSucceedWith('A');
    t.done();
    expect(t.bus.hasHandler('pageSave')).toBe(false);
  });

  it(`${label}: KeepAlive A, B, back to A, A answers`, async () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await mountPages(own, '<KeepAlive><component :is="cur" /></KeepAlive>', 'A');
    t.cur.value = t.B;
    await t.tick();
    expect(t.bus.dispatch('pageSave', {})).toSucceedWith('B');
    t.cur.value = t.A;
    await t.tick();
    expect(t.host.textContent).toBe('A');
    expect(t.bus.dispatch('pageSave', {})).toSucceedWith('A');
    t.done();
    expect(t.bus.hasHandler('pageSave')).toBe(false);
  });
}

/*
 * The bus runs one handler per action, the newest registration still live. A
 * registration lives from register() until its own cleanup, so when the newer
 * page unmounts the older page on screen answers again. Before, its dispatch
 * answered `core:missing:handler`, with nothing in production (B4 f, log
 * 36.F42). The useCommand rows show the loss was the bus's, not one
 * composable's. defineVaporCommand follows KeepAlive as useCommand does since
 * v1.25.0: a cached page releases its registration and takes it back on
 * return. The bus-level cases are in tests/register-ownership.test.ts.
 */

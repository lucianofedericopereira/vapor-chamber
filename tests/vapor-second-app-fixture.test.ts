// @vitest-environment happy-dom
// FIXTURE - a Vapor app mounted from inside another app: the bus, the injection context and the provides it sees. The note is at the end.

import { afterEach, beforeAll, expect, it } from 'vitest';
import { configureVue, getCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import type { VaporApi } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  await waitForVueDetection();
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Seen = { inject: unknown; context: boolean; answer: unknown };

/** The first app mounts a second one: at once from a mounted hook, or later from a timer. */
async function secondApp(when: 'in-hook' | 'later', provide: boolean): Promise<{ seen: Seen; afterUnmount: unknown }> {
  setCommandBus(createCommandBus());
  const bus = getCommandBus();
  const seen = {} as Seen;
  const action = `second:${when}:${provide}`;
  let inner: { unmount: () => void } | undefined;

  const Inner = v.defineVaporComponent({
    setup() {
      seen.inject = v.inject('k', 'MISSING');
      seen.context = v.hasInjectionContext();
      useCommand().register(action as never, (() => 'answered') as never);
      return v.template('<em>inner</em>', true)();
    },
  });
  const mountInner = (): void => {
    const el = document.createElement('div');
    document.body.append(el);
    const app = v.createVaporApp(Inner);
    if (provide) app.provide('k', 'two');
    app.mount(el);
    inner = app;
    cleanups.push(() => el.remove());
  };

  const Outer = v.defineVaporComponent({
    setup() {
      if (when === 'in-hook') v.onMounted(mountInner);
      else setTimeout(mountInner, 0);
      return v.template('<div>outer</div>', true)();
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const first = v.createVaporApp(Outer);
  first.provide('k', 'one');
  first.mount(host);
  await v.nextTick();
  await new Promise((r) => setTimeout(r, 20));
  const reply = (bus.dispatch as (a: string, t: object) => { ok: boolean; value?: unknown; error?: { code: string } })(action, {});
  seen.answer = reply.ok ? reply.value : reply.error?.code;
  inner!.unmount();
  const after = (bus.dispatch as (a: string, t: object) => { ok: boolean; value?: unknown; error?: { code: string } })(action, {});
  first.unmount();
  host.remove();
  return { seen, afterUnmount: after.ok ? after.value : after.error?.code };
}

it('from a mounted hook the second app dispatches on the shared bus, and its unmount releases the handler', async () => {
  const r = await secondApp('in-hook', false);
  expect(r.seen).toMatchObject({ context: true, answer: 'answered' });
  expect(r.afterUnmount).toBe('core:missing:handler');
});

it('from a timer, the same', async () => {
  const r = await secondApp('later', false);
  expect(r.seen).toMatchObject({ context: true, answer: 'answered' });
  expect(r.afterUnmount).toBe('core:missing:handler');
});

it('from a timer the second app has its own provides: none, or the ones it was given', async () => {
  expect((await secondApp('later', false)).seen.inject).toBe('MISSING');
  expect((await secondApp('later', true)).seen.inject).toBe('two');
});

it('from a mounted hook the second app sees the first app\'s provides, over its own', async () => {
  expect((await secondApp('in-hook', false)).seen.inject).toBe('one');
  expect((await secondApp('in-hook', true)).seen.inject).toBe('one');
});

/*
 * WHY THIS FILE EXISTS. Lead L1 of .probes/harvest-vue-13687-vueconf.md:
 * vuejs/core#13687 comment 11 (xuyimingwork, 2026-08-10) asks how a Vapor
 * component mounted by code (a modal, a message) inherits the appContext and
 * provides now that the instance is hidden. Nobody answered in the thread.
 * What the fixture measured on Vue 3.6.0-rc.12 and rc.13 (the log, section
 * 36.F43):
 *
 *   - The bus. `useCommand()` resolves the shared bus, not an injection, so a
 *     second app reaches the same bus and releases its handler when it
 *     unmounts, from either place. Nothing in the library needs the first
 *     app's provides.
 *   - The provides. A second app created while a component of the first is the
 *     current instance (inside a hook) takes that component as its root's
 *     parent, and `inject` reads the first app's provides, ahead of
 *     `app.provide` on the second. Created later, from a timer, it has its
 *     own. That is Vue's behaviour and not ours. The two last tests record
 *     it so a change of Vue's shows here. A library that mounts a second app
 *     (a modal service) should create it outside a hook or pass what it needs
 *     with `app.provide` and expect the first app's keys to win inside a hook.
 */

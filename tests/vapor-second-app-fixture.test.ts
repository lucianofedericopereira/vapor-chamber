// @vitest-environment happy-dom
/**
 * A Vapor app mounted by code from inside another Vapor app, from a mounted hook or from a timer: the bus, the injection context and the provides it sees.
 * Why: `useCommand()` resolves the shared bus, not an injection, so a modal-style second app would reach the same bus; a second app created inside a hook takes the first app's component as its parent, so `inject` would read the first app's provides ahead of its own `app.provide`. A library that mounts a second app should create it outside a hook, or pass what it needs with `app.provide`.
 * Shows: from either place the second app has an injection context and dispatches on the shared bus, and its unmount releases the handler; from a timer `inject` returns the missing default or the app's own provide; from a hook it returns the first app's value even when the second app provides its own.
 * See: vuejs/core#13687, log s36.F43
 */

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

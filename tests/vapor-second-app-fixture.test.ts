// @vitest-environment happy-dom
/**
 * A Vapor app mounted by code from inside another Vapor app, from a mounted hook or from a timer: the bus, the injection context and the provides it sees.
 * Why: `useCommand()` resolves the shared bus, not an injection, so a modal-style second app would reach the same bus. Before rc.16 a second app created inside a hook took the first app's component as its parent, so `inject` read the first app's provides ahead of its own `app.provide`. rc.16 creates every app root without a parent instance (vuejs/core#16325), as it already did from a timer.
 * Shows: from either place the second app has an injection context and dispatches on the shared bus, and its unmount releases the handler; from a hook, as from a timer, `inject` returns the missing default or the app's own provide, never the first app's. A setup that threw leaves no current instance behind for the next app.
 * See: vuejs/core#13687, vuejs/core#16325, log s36.F43, log 36.F59
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

it('from a mounted hook the second app has its own provides, as it does from a timer', async () => {
  expect((await secondApp('in-hook', false)).seen.inject).toBe('MISSING');
  expect((await secondApp('in-hook', true)).seen.inject).toBe('two');
});

it('a setup that threw leaves no current instance for the next app root to inherit', async () => {
  setCommandBus(createCommandBus());
  const made = {} as { seen?: unknown };

  const Boom = v.defineVaporComponent({
    setup() {
      throw new Error('boom');
    },
  });
  const firstHost = document.createElement('div');
  document.body.append(firstHost);
  const first = v.createVaporApp(Boom);
  first.provide('k', 'one');
  // No errorHandler: dev rethrows out of the mount, which is where the leak was.
  expect(() => first.mount(firstHost)).toThrow('boom');
  try {
    first.unmount();
  } catch {
    // a root that never mounted has nothing to unmount
  }

  const Second = v.defineVaporComponent({
    setup() {
      made.seen = v.inject('k', 'MISSING');
      return v.template('<i>second</i>', true)();
    },
  });
  const secondHost = document.createElement('div');
  document.body.append(secondHost);
  const second = v.createVaporApp(Second);
  second.provide('k', 'two');
  second.mount(secondHost);
  expect(made.seen).toBe('two');

  second.unmount();
  firstHost.remove();
  secondHost.remove();
});

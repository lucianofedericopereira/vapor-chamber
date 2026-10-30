// @vitest-environment happy-dom
/**
 * The public composables (`useCommand`, `useSharedCommandState`, `useCommandQuery`, `useCommandGroup`, `useCommandError`, `defineVaporCommand`) run inside a real `createVaporApp` component.
 * Why: an API that behaves differently under Vapor than under VDOM fails silently, and only a real Vapor mount sees it; auto-cleanup rides on `getCurrentScope()`/`onScopeDispose()`, so a composable that is not disposed on unmount would leak its bus subscription.
 * Shows: each composable runs in a Vapor `setup()`, its returned refs update, and its listener or handler is gone from the bus after the component unmounts; the shared state is refcounted across two mounted components.
 * See: src/chamber.ts probeVue
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureVue,
  getCommandBus,
  setCommandBus,
  useCommand,
  useCommandError,
  useCommandGroup,
  useCommandQuery,
  useSharedCommandState,
} from '../src/chamber';
import { defineVaporCommand } from '../src/chamber-vapor';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds trees by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

/** Mount `setup` as the root of a real Vapor app; returns an unmount handle. */
async function mountVapor(setup: () => void) {
  const v = await vapor();
  // Same module object as the components: two imported Vue dists have disconnected reactivity.
  configureVue(v);
  const Root = v.defineVaporComponent({
    setup() {
      setup();
      return v.template('<div>root</div>', true)();
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(Root);
  app.mount(host);
  return {
    v,
    host,
    unmount: () => { app.unmount(); host.remove(); },
  };
}

describe('composables inside a real Vapor component', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('useCommand - dispatches, tracks its key, and unsubscribes on unmount', async () => {
    const bus = getCommandBus();
    let api!: ReturnType<typeof useCommand>;
    const seen: string[] = [];

    const { unmount } = await mountVapor(() => {
      api = useCommand();
      api.on('cartAdd', (cmd: any) => { seen.push(cmd.action); });
    });

    bus.register('cartAdd', () => 'ok');
    const key = api.pending('cartAdd', 'a');
    const res = api.dispatch('cartAdd', 'a');
    expect((res as any).ok).toBe(true);
    expect(key.value).toBe(false);
    expect(seen).toEqual(['cartAdd']);

    unmount();
    bus.dispatch('cartAdd', 'b');
    expect(seen).toEqual(['cartAdd']);
  });

  it('useSharedCommandState - two Vapor components observe the same bus-wide error state', async () => {
    const bus = getCommandBus();
    bus.register('boom', () => { throw new Error('shared-boom'); });
    let a!: ReturnType<typeof useSharedCommandState>;
    let b!: ReturnType<typeof useSharedCommandState>;

    const first = await mountVapor(() => { a = useSharedCommandState(); });
    const second = await mountVapor(() => { b = useSharedCommandState(); });

    bus.dispatch('boom', null);

    expect(a.lastError.value?.message).toBe('shared-boom');
    expect(b.lastError.value?.message).toBe('shared-boom');
    expect(a.errors.value.length).toBe(1);

    // Refcounted: the first unmount must not tear the entry out from under the other component.
    first.unmount();
    bus.dispatch('boom', null);
    expect(b.errors.value.length).toBe(2);
    second.unmount();
  });

  it('useCommandQuery - read path resolves inside a Vapor setup', async () => {
    const bus = getCommandBus();
    bus.register('cartTotal', () => 42);
    let q!: ReturnType<typeof useCommandQuery>;

    const { unmount } = await mountVapor(() => { q = useCommandQuery(); });

    const r = q.query('cartTotal', null);
    expect((r as any).ok).toBe(true);
    expect(q.data.value).toBe(42);
    unmount();
  });

  it('useCommandGroup - namespaced dispatch + register, all cleaned up on unmount', async () => {
    const bus = getCommandBus();
    let calls = 0;
    let group!: ReturnType<typeof useCommandGroup>;

    const { unmount } = await mountVapor(() => {
      group = useCommandGroup('cart');
      group.register('add', () => { calls++; return 'ok'; });
    });

    const res = bus.dispatch('cartAdd', 1);
    expect((res as any).ok).toBe(true);
    expect(calls).toBe(1);

    group.dispatch('add', 2);
    expect(calls).toBe(2);

    unmount();
    const after = bus.dispatch('cartAdd', 3);
    expect((after as any)).toFailWith('core:missing:handler');
    expect(calls).toBe(2);
  });

  it('useCommandError - captures a failed dispatch, then detaches on unmount', async () => {
    const bus = getCommandBus();
    bus.register('boom', () => { throw new Error('kaboom'); });
    let err!: ReturnType<typeof useCommandError>;

    const { unmount } = await mountVapor(() => { err = useCommandError(); });

    bus.dispatch('boom', null);
    expect(err.errors.value.length).toBe(1);
    expect(err.latestError.value?.message).toBe('kaboom');

    unmount();
    bus.dispatch('boom', null);
    expect(err.errors.value.length).toBe(1);
  });

  it('defineVaporCommand - the zero-overhead path works under a real Vapor app', async () => {
    const bus = getCommandBus();
    let handled = 0;
    let cmd!: ReturnType<typeof defineVaporCommand>;

    const { unmount } = await mountVapor(() => {
      cmd = defineVaporCommand('telemetry', () => { handled++; return null; });
    });

    cmd.dispatch({ name: 'page_view' });
    expect(handled).toBe(1);

    unmount();
    const after = bus.dispatch('telemetry', { name: 'after' });
    expect((after as any)).toFailWith('core:missing:handler');
    expect(handled).toBe(1);
  });
});

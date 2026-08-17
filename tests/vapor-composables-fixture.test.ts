// @vitest-environment happy-dom
/**
 * FIXTURE — the public composables running inside a REAL Vapor component.
 *
 * WHY THIS FILE EXISTS. The suite had 93 files and 1500+ tests, and exactly one
 * of the eight public `use*` composables had ever executed inside a real Vapor
 * component (`useCommandHistory`, and only from the rc.4 KeepAlive fixture).
 * Everything else was exercised under VDOM, under a bare `effectScope()`, or
 * with no scope at all. For a library named for Vapor that is the wrong way
 * round, and it is not a theoretical gap: the rc.4 cycle found
 * `tryKeepAliveHooks` gated on `getCurrentInstance()`, which answers null in a
 * Vapor `setup()`, so KeepAlive pause/resume had been inert on Vapor for
 * several releases while every test stayed green.
 *
 * The class of bug is specific: an API that behaves DIFFERENTLY under Vapor
 * than under VDOM, silently. A VDOM test cannot see it and a bare
 * `effectScope()` cannot either, because neither is the environment that
 * differs. Only mounting a real `createVaporApp` can.
 *
 * WHAT IS PINNED HERE, per composable: that it runs at all inside a Vapor
 * `setup()`, that the reactive values it hands back actually update, and — the
 * load-bearing one — that `tryAutoCleanup()` really disposes it when the Vapor
 * component unmounts. That last is the Vapor-sensitive part: auto-cleanup rides
 * on `getCurrentScope()`/`onScopeDispose()`, and if those answered the way
 * `getCurrentInstance()` does, every composable here would leak its bus
 * subscription on unmount with nothing to show for it.
 *
 * Chamber is pointed at the same module object the components are built from
 * via `configureVue()` — two separately-imported Vue dists are two disconnected
 * reactivity instances (chamber.ts §probeVue), so skipping that would measure
 * nothing.
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
  useCommandState,
  useSharedCommandState,
} from '../src/chamber';
import { defineVaporCommand } from '../src/chamber-vapor';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface — deliberately untyped; this file builds trees by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

/** Mount `setup` as the root of a real Vapor app; returns an unmount handle. */
async function mountVapor(setup: () => void) {
  const v = await vapor();
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

  it('useCommand — dispatches, tracks loading/error, and unsubscribes on unmount', async () => {
    const bus = getCommandBus();
    let api!: ReturnType<typeof useCommand>;
    const seen: string[] = [];

    const { unmount } = await mountVapor(() => {
      api = useCommand();
      api.on('cartAdd', (cmd: any) => { seen.push(cmd.action); });
    });

    bus.register('cartAdd', () => 'ok');
    const res = api.dispatch('cartAdd', 'a');
    expect((res as any).ok).toBe(true);
    expect(api.lastError.value).toBeNull();
    expect(seen).toEqual(['cartAdd']);

    // The Vapor-sensitive half: tryAutoCleanup must have armed on this scope.
    unmount();
    bus.dispatch('cartAdd', 'b');
    expect(seen).toEqual(['cartAdd']); // no growth — listener really went away
  });

  it('useCommandState — state updates from a dispatch and stops on unmount', async () => {
    const bus = getCommandBus();
    let state!: { value: { count: number } };

    const { unmount } = await mountVapor(() => {
      ({ state } = useCommandState({ count: 0 }, {
        counterSet: (_s: any, cmd: any) => ({ count: cmd.target as number }),
      }) as any);
    });

    bus.dispatch('counterSet', 7);
    expect(state.value).toEqual({ count: 7 });

    unmount();
    bus.dispatch('counterSet', 99);
    expect(state.value).toEqual({ count: 7 }); // subscription disposed with the component
  });

  it('useSharedCommandState — two Vapor components observe the same bus-wide error state', async () => {
    const bus = getCommandBus();
    bus.register('boom', () => { throw new Error('shared-boom'); });
    let a!: ReturnType<typeof useSharedCommandState>;
    let b!: ReturnType<typeof useSharedCommandState>;

    const first = await mountVapor(() => { a = useSharedCommandState(); });
    const second = await mountVapor(() => { b = useSharedCommandState(); });

    bus.dispatch('boom', null);

    // One shared entry per bus — both Vapor components read the same node.
    expect(a.lastError.value?.message).toBe('shared-boom');
    expect(b.lastError.value?.message).toBe('shared-boom');
    expect(a.errorCount.value).toBe(1);

    // Refcounted: the first unmount must not tear the entry out from under the
    // component still using it.
    first.unmount();
    bus.dispatch('boom', null);
    expect(b.errorCount.value).toBe(2);
    second.unmount();
  });

  it('useCommandQuery — read path resolves inside a Vapor setup', async () => {
    const bus = getCommandBus();
    bus.register('cartTotal', () => 42);
    let q!: ReturnType<typeof useCommandQuery>;

    const { unmount } = await mountVapor(() => { q = useCommandQuery(); });

    const r = q.query('cartTotal', null);
    expect((r as any).ok).toBe(true);
    expect(q.data.value).toBe(42);
    unmount();
  });

  it('useCommandGroup — namespaced dispatch + register, all cleaned up on unmount', async () => {
    const bus = getCommandBus();
    let calls = 0;
    let group!: ReturnType<typeof useCommandGroup>;

    const { unmount } = await mountVapor(() => {
      group = useCommandGroup('cart');
      group.register('add', () => { calls++; return 'ok'; });
    });

    // Registered under the namespaced name, reachable from the raw bus.
    const res = bus.dispatch('cartAdd', 1);
    expect((res as any).ok).toBe(true);
    expect(calls).toBe(1);

    // Exercises the memoised prefix cache on a repeat name.
    group.dispatch('add', 2);
    expect(calls).toBe(2);

    unmount();
    const after = bus.dispatch('cartAdd', 3);
    expect((after as any).ok).toBe(false); // handler unregistered with the scope
    expect(calls).toBe(2);
  });

  it('useCommandError — captures a failed dispatch, then detaches on unmount', async () => {
    const bus = getCommandBus();
    bus.register('boom', () => { throw new Error('kaboom'); });
    let err!: ReturnType<typeof useCommandError>;

    const { unmount } = await mountVapor(() => { err = useCommandError(); });

    bus.dispatch('boom', null);
    expect(err.errors.value.length).toBe(1);
    expect(err.latestError.value?.message).toBe('kaboom');

    unmount();
    bus.dispatch('boom', null);
    expect(err.errors.value.length).toBe(1); // no capture after disposal
  });

  it('defineVaporCommand — the zero-overhead path works under a real Vapor app', async () => {
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
    expect((after as any).ok).toBe(false); // handler released with the scope
    expect(handled).toBe(1);
  });
});

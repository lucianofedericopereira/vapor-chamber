// @vitest-environment happy-dom
/**
 * FIXTURE: per-(action, target) loading from `useSharedCommandState().pending`, in a real Vapor component.
 * Why: a panel asks "is THIS service restarting", which `anyPending` cannot answer; a change on one key must never re-run another key's reader.
 * Shows: a key is true while its target is in flight, false once the last settles; a settle with no start is ignored; refusals, plugin throws, onMissing 'throw' all settle.
 * See: tests/plugin-throw-fixture.test.ts, tests/isloading-profile.test.ts.
 */

import { beforeEach, describe, expect, vi } from 'vitest';
import { configureVue, useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus, type CommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
type VaporApi = any;
let v: VaporApi;

// The chamber uses the component's own dist: two Vue dists are two disconnected reactivity engines.
beforeEach(async () => {
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
});

/** A promise resolved from outside - the "service is still restarting" handle. */
function deferred<T = unknown>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Mount a Vapor component that reads one pending() per key in its own
 * sync-flush effect. Returns the live values, the per-key run counts, and the
 * composable handle.
 */
function mountPanel(bus: CommandBus, keys: Array<[string, unknown?]>) {
  const seen: Record<string, boolean[]> = {};
  let shared!: ReturnType<typeof useSharedCommandState>;
  const Panel = v.defineVaporComponent({
    setup() {
      shared = useSharedCommandState({ bus });
      for (const [action, target] of keys) {
        const name = `${action}:${String(target)}`;
        seen[name] = [];
        const flag = shared.pending(action, target);
        v.watchEffect(() => { seen[name].push(flag.value); }, { flush: 'sync' });
      }
      return v.template('<div>panel</div>', true)();
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(Panel);
  app.mount(host);
  return {
    seen,
    shared,
    unmount() { app.unmount(); host.remove(); },
  };
}

// A start is the bus's `started` fact, a settle its `settled` fact, matched by the Command object.
describe('pending - async bus', () => {
  it('true while THIS target is in flight, false once it settles; another target never re-runs', async () => {
    const bus = createAsyncCommandBus() as unknown as CommandBus;
    const gates: Record<string, ReturnType<typeof deferred>> = {};
    bus.register('svcRestart', (cmd) => (gates[cmd.target] = deferred()).promise);
    const p = mountPanel(bus, [['svcRestart', 'httpd'], ['svcRestart', 'nginx']]);

    expect(p.seen['svcRestart:httpd']).toEqual([false]);

    const run = bus.dispatch('svcRestart', 'httpd') as unknown as Promise<unknown>;
    // The start is announced before the async dispatch's first await.
    expect(p.seen['svcRestart:httpd']).toEqual([false, true]);

    gates.httpd.resolve('up');
    await run;
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);

    // Atomicity: the nginx reader ran once, at mount, and never again.
    expect(p.seen['svcRestart:nginx']).toEqual([false]);
    p.unmount();
  });

  it('two concurrent dispatches of one key count to 2 and back: true until the LAST settles', async () => {
    const bus = createAsyncCommandBus() as unknown as CommandBus;
    const gates: Array<ReturnType<typeof deferred>> = [];
    bus.register('svcRestart', () => { const d = deferred(); gates.push(d); return d.promise; });
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);

    const a = bus.dispatch('svcRestart', 'httpd') as unknown as Promise<unknown>;
    const b = bus.dispatch('svcRestart', 'httpd') as unknown as Promise<unknown>;
    // 0 -> 1 writes true; 1 -> 2 writes nothing (no re-run).
    expect(p.seen['svcRestart:httpd']).toEqual([false, true]);

    gates[0].resolve('a');
    await a;
    expect(p.shared.pending('svcRestart', 'httpd').value).toBe(true);
    expect(p.seen['svcRestart:httpd']).toEqual([false, true]);

    gates[1].resolve('b');
    await b;
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });

  it('a pre-flight abort leaves no stuck state and does not clear a concurrent in-flight dispatch', async () => {
    const bus = createAsyncCommandBus() as unknown as CommandBus;
    const gate = deferred();
    bus.register('svcRestart', () => gate.promise);
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);

    const live = bus.dispatch('svcRestart', 'httpd') as unknown as Promise<unknown>;
    expect(p.seen['svcRestart:httpd']).toEqual([false, true]);

    // Already-aborted: the bus settles it (after-hooks, the settled fact) without
    // a start. That settle must be ignored.
    const ac = new AbortController();
    ac.abort();
    const aborted = await (bus as any).dispatch('svcRestart', 'httpd', undefined, { signal: ac.signal });
    expect(aborted).toFailWith('core:aborted:dispatch');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true]);

    gate.resolve('up');
    await live;
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);

    // And on its own, with nothing in flight, it leaves the key false.
    await (bus as any).dispatch('svcRestart', 'httpd', undefined, { signal: ac.signal });
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });

  it('a handler that rejects settles the key', async () => {
    const bus = createAsyncCommandBus() as unknown as CommandBus;
    bus.register('svcRestart', async () => { throw new Error('down'); });
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    const r = await (bus.dispatch('svcRestart', 'httpd') as unknown as Promise<{ ok: boolean }>);
    expect(r.ok).toBe(false);
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });
});

describe('pending - sync bus', () => {
  it('true inside the handler, false after; another target never re-runs', ({ bus }) => {
    let during: boolean | undefined;
    const p = mountPanel(bus, [['svcRestart', 'httpd'], ['svcRestart', 'nginx']]);
    bus.register('svcRestart', () => { during = p.shared.pending('svcRestart', 'httpd').value; return 'up'; });

    bus.dispatch('svcRestart', 'httpd');
    expect(during).toBe(true);
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    expect(p.seen['svcRestart:nginx']).toEqual([false]);

    // A key nobody reads is counted while in flight, then kept at 0 or pruned
    // by the build profile (tests/isloading-profile.test.ts); neither reader
    // re-runs for it.
    bus.dispatch('svcRestart', 'apache');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    expect(p.seen['svcRestart:nginx']).toEqual([false]);
    p.unmount();
  });

  it('tracking starts at the first pending() on the bus: a dispatch already in flight is not counted', ({ bus }) => {
    const s = useSharedCommandState({ bus });
    let during: boolean | undefined;
    bus.register('svcRestart', () => { during = s.pending('svcRestart', 'httpd').value; });
    bus.dispatch('svcRestart', 'httpd');
    expect(during).toBe(false);
    // From then on it is.
    bus.dispatch('svcRestart', 'httpd');
    expect(during).toBe(true);
    s.dispose();
  });

  it('a rule that refuses: its start settles, nothing stuck, nothing stolen', ({ bus }) => {
    // Installed before the panel: the start is announced before every rule anyway.
    bus.use({ id: 'gate', authorize: () => (cmd, fail) => (cmd.payload === 'deny' ? { ok: false, value: undefined, error: fail('refused:action', 'denied') } : undefined) });
    bus.register('svcRestart', () => 'up');
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);

    const r = bus.dispatch('svcRestart', 'httpd', 'deny');
    expect(r).toFailWith('gate:refused:action');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);

    bus.dispatch('svcRestart', 'httpd');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false, true, false]);
    p.unmount();
  });

  it('a query of the same key (no counted start) does not clear it', ({ bus }) => {
    let observed: boolean | undefined;
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    bus.register('svcStatus', () => 'up');
    bus.register('svcRestart', () => {
      // A query settles with no start: ignored.
      bus.query('svcRestart', 'httpd');
      observed = p.shared.pending('svcRestart', 'httpd').value;
      return 'up';
    });
    bus.dispatch('svcRestart', 'httpd');
    expect(observed).toBe(true);
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });
});

describe('pending - keys', () => {
  it('object targets key by value (commandKey), not identity', ({ bus }) => {
    let during: boolean | undefined;
    const p = mountPanel(bus, [['svcRestart', { host: 'a', svc: 'httpd' }]]);
    bus.register('svcRestart', () => { during = p.shared.pending('svcRestart', { host: 'a', svc: 'httpd' }).value; });
    bus.dispatch('svcRestart', { svc: 'httpd', host: 'a' });
    expect(during).toBe(true);
    p.unmount();
  });

  it('pending(action) with no target is the exact key (action, undefined), not "any target"', ({ bus }) => {
    const obs: Array<[boolean, boolean]> = [];
    const p = mountPanel(bus, [['cacheFlush', undefined], ['cacheFlush', 'eu']]);
    bus.register('cacheFlush', () => {
      obs.push([p.shared.pending('cacheFlush').value, p.shared.pending('cacheFlush', 'eu').value]);
    });
    bus.dispatch('cacheFlush', 'eu');
    bus.dispatch('cacheFlush', undefined);
    expect(obs).toEqual([[false, true], [true, false]]);
    p.unmount();
  });

  it('the same signal comes back for one key, from any subscriber on the bus', ({ bus }) => {
    const a = useSharedCommandState({ bus });
    const b = useSharedCommandState({ bus });
    expect(a.pending('svcRestart', 'httpd')).toBe(b.pending('svcRestart', 'httpd'));
    expect(a.pending('svcRestart', 'httpd')).not.toBe(a.pending('svcRestart', 'nginx'));
    a.dispose(); b.dispose();
  });
});

describe('pending - lifecycle', () => {
  it('the last dispose releases the state: later dispatches no longer write the key', ({ bus }) => {
    bus.register('svcRestart', () => 'up');
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    const flag = p.shared.pending('svcRestart', 'httpd');
    p.unmount(); // scope disposal -> refCount 0

    let during: boolean | undefined;
    bus.register('svcProbe', () => { during = flag.value; });
    bus.dispatch('svcRestart', 'httpd');
    bus.dispatch('svcProbe', null);
    expect(during).toBe(false);
    expect(p.seen['svcRestart:httpd']).toEqual([false]);
  });

  it('RESOLVED (was a known limit): a plugin part that throws settles - the bus converts it, the key returns to false', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('svcRestart', () => 'up');
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    bus.use({ admit: () => { throw new Error('plugin blew up'); } });
    const r = bus.dispatch('svcRestart', 'httpd');
    expect((r.error as any)?.code).toBe('plugin:failed:plugin');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });

  it("onMissing: 'throw' settles before it throws - the caller still gets the throw, the key returns to false", () => {
    // The throw that remains by contract leaves execute() after the start was
    // announced. The dispatch settles it (after-hooks, the settled fact) before
    // re-throwing, so a started key cannot stay true.
    const bus = createCommandBus({ onMissing: 'throw' });
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    expect(() => bus.dispatch('svcRestart', 'httpd')).toThrow('No handler');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });

  it("async: onMissing: 'throw' settles before it rejects", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' }) as unknown as CommandBus;
    const p = mountPanel(bus, [['svcRestart', 'httpd']]);
    await expect(bus.dispatch('svcRestart', 'httpd') as unknown as Promise<unknown>).rejects.toThrow('No handler');
    expect(p.seen['svcRestart:httpd']).toEqual([false, true, false]);
    p.unmount();
  });
});

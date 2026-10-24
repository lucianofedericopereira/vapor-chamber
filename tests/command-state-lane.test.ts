// commandState as the bus's internal facts observer: what moved from the user's hooks, and why.
import { describe, expect, it, vi } from 'vitest';
import { commandState } from '../src/command-state';
import { createAsyncCommandBus, createCommandBus, inspectBus, type BaseBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';

function deferred<T = unknown>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('commandState - bus-wide counts', () => {
  it('anyPending counts a raw bus.dispatch, on both buses', async () => {
    const sync = createCommandBus();
    let during = false;
    const s = commandState(sync);
    const any = s.anyPending;
    sync.register('x', () => { during = any.value; });
    sync.dispatch('x', 1);
    expect({ during, after: any.value }).toEqual({ during: true, after: false });
    s.dispose();

    const bus = createAsyncCommandBus();
    const gate = deferred();
    bus.register('slow', () => gate.promise);
    const a = commandState(bus);
    const p = bus.dispatch('slow', 1);
    expect(a.anyPending.value).toBe(false); // in flight before counting began
    const q = bus.dispatch('slow', 2);
    expect(a.anyPending.value).toBe(true);
    gate.resolve('ok');
    await Promise.all([p, q]);
    expect(a.anyPending.value).toBe(false);
    a.dispose();
  });

  it('a listener reads the command as settled', () => {
    const bus = createCommandBus();
    bus.register('x', () => 'ok');
    const seen: boolean[] = [];
    bus.on('x', () => { seen.push(s.pending('x').value); });
    const s = commandState(bus);
    s.pending('x');
    bus.dispatch('x', undefined);
    expect(seen).toEqual([false]);
    s.dispose();
  });
});

describe('commandState - nothing on the user\'s hooks', () => {
  it('a sealed bus is never unsealed, and no hook or listener is added', () => {
    const bus = createCommandBus();
    let during = false;
    bus.register('x', () => { during = key.value; });
    bus.seal();
    const asked = vi.spyOn(bus, 'isSealed');
    const s = commandState(bus);
    const key = s.pending('x');
    void s.anyPending;
    const seen = inspectBus(bus);
    expect({ hooks: seen.afterHookCount, listeners: seen.listenerPatterns, asked: asked.mock.calls.length })
      .toEqual({ hooks: 0, listeners: [], asked: 0 });
    const r = bus.dispatch('x', undefined);
    expect({ ok: r.ok, during, after: key.value, sealed: bus.isSealed() }).toEqual({ ok: true, during: true, after: false, sealed: true });
    s.dispose();
  });

  it('a throwing subscribe() callback is logged, the dispatch runs, and the counts stay whole', () => {
    const bus = createCommandBus();
    const ran = vi.fn(() => 'ok');
    bus.register('x', ran);
    const s = commandState(bus);
    s.pending('x');
    const off = s.subscribe(() => { throw new Error('subscriber'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = bus.dispatch('x', undefined);
    const r2 = bus.dispatch('x', undefined);
    const logged = err.mock.calls.length;
    err.mockRestore();
    expect({ ok: r.ok && r2.ok, ran: ran.mock.calls.length, pending: s.pending('x').value, any: s.anyPending.value, logged })
      .toEqual({ ok: true, ran: 2, pending: false, any: false, logged: 4 });
    off();
    s.dispose();
  });
});

describe('commandState - every start settles (each exit)', () => {
  it('a rule refusal, a handler throw and onMissing: throw each settle their start (sync)', () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    bus.register('boom', () => { throw new Error('boom'); });
    bus.register('cancelled', () => 'never');
    bus.use({ authorize: () => (cmd) => (cmd.action === 'cancelled' ? { ok: false, value: undefined, error: new Error('no') } : undefined) });
    const s = commandState(bus);
    const keys = ['boom', 'cancelled', 'missing'].map((a) => s.pending(a));
    bus.dispatch('boom', undefined);
    bus.dispatch('cancelled', undefined);
    expect(() => bus.dispatch('missing', undefined)).toThrow();
    expect({ keys: keys.map((k) => k.value), any: s.anyPending.value, errors: s.errors.value.length })
      .toEqual({ keys: [false, false, false], any: false, errors: 3 });
    s.dispose();
  });

  it('exclusive and optimistic actions settle their start (async)', async () => {
    const bus = createAsyncCommandBus();
    const gate = deferred();
    bus.register('ex', () => gate.promise, { exclusive: {} });
    bus.register('opt', async () => { throw new Error('refused'); }, { optimistic: true, undo: () => {} });
    const s = commandState(bus);
    const ex = s.pending('ex');
    const opt = s.pending('opt');
    const p = bus.dispatch('ex', undefined);
    const r = await bus.dispatch('opt', undefined);
    expect(ex.value).toBe(true);
    gate.resolve('ok');
    await p;
    await (r.value as { done: Promise<unknown> }).done;
    expect({ ex: ex.value, opt: opt.value, any: s.anyPending.value }).toEqual({ ex: false, opt: false, any: false });
    s.dispose();
  });

  it('a failed query lands in errors and lights no key (positive control: a dispatch does)', () => {
    const bus = createCommandBus();
    let during: boolean[] = [];
    bus.register('read', () => { during.push(s.pending('read').value); throw new Error('read failed'); });
    const s = commandState(bus);
    s.pending('read');
    bus.query('read', undefined);
    const queried = during;
    during = [];
    bus.dispatch('read', undefined);
    expect({ queried, dispatched: during, errors: s.errors.value.map((e) => e.message) })
      .toEqual({ queried: [false], dispatched: [true], errors: ['read failed', 'read failed'] });
    s.dispose();
  });
});

describe('commandState - subscribe', () => {
  it('runs on a read key\'s transitions and on failures, never for an unread key', () => {
    const bus = createCommandBus();
    bus.register('read', () => 'ok');
    bus.register('unread', () => 'ok');
    bus.register('boom', () => { throw new Error('x'); });
    const s = commandState(bus);
    s.pending('read');
    const fn = vi.fn();
    const off = s.subscribe(fn);
    bus.dispatch('unread', undefined);
    const afterUnread = fn.mock.calls.length;
    bus.dispatch('read', undefined);
    const afterRead = fn.mock.calls.length;
    bus.dispatch('boom', undefined);
    off();
    bus.dispatch('read', undefined);
    expect({ afterUnread, afterRead, total: fn.mock.calls.length }).toEqual({ afterUnread: 0, afterRead: 2, total: 3 });
    s.dispose();
  });
});

describe('commandState - the buses it takes', () => {
  it('refuses a bus this library did not make', () => {
    const own = { dispatch: () => ({ ok: true }), on: () => () => {}, onBefore: () => () => {} } as unknown as BaseBus;
    expect(() => commandState(own)).toThrow(expect.objectContaining({ code: 'core:invalid:bus' }));
  });

  it('the refusal says why in development only (control: the development message names the buses)', async () => {
    const own = { dispatch: () => ({ ok: true }) } as unknown as BaseBus;
    const message = (run: () => unknown): string => { try { run(); return ''; } catch (e) { return (e as Error).message; } };
    const dev = message(() => commandState(own));
    vi.stubGlobal('__VC_DEV__', false);
    vi.resetModules();
    try {
      const fresh = await import('../src/command-state');
      expect({ dev: dev.includes('createTestBus'), prod: message(() => fresh.commandState(own)) })
        .toEqual({ dev: true, prod: 'commandState() needs a bus this library made.' });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('works on the test bus', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    const s = commandState(bus as unknown as BaseBus);
    const key = s.pending('x', 1);
    let during = false;
    bus.register('x', () => { during = key.value; });
    bus.dispatch('x', 1);
    expect({ during, after: key.value }).toEqual({ during: true, after: false });
    s.dispose();
  });
});

/*
 * Why these tests. The command state once hooked the user's bus: a
 * before-hook for the start (installed past the seal) and an `on('*')`
 * listener for the settle. So a sealed bus was unsealed and sealed again,
 * `inspectBus` counted a hook and a listener the app never added, a listener
 * registered before the state read a settled key as still in flight, and a
 * subscriber's throw inside the before-hook cancelled the dispatch. Its
 * any-loading flag counted only its own `dispatch` wrapper, so a raw dispatch
 * never showed (vapor-sfc's StatusBar). Plan 1.32 4.4 moves it onto the bus's
 * internal facts (revision 23), as its one observer: a fast lane read +16.8 ns
 * slower on a tracked dispatch (log 36.84). The query case is the
 * positive control of "lights no key": the same handler lights its key when
 * dispatched.
 */

/**
 * useSharedCommandState: the bus's command state as a Vue view.
 * Why: every caller on a bus must read one state (anyPending, pending keys, the errors ring), or components would show different in-flight and error state for the same bus.
 * Shows: callers share the same signal instances, buses are isolated, anyPending and pending(key) count every dispatch from any caller, errors is a ring capped at maxSize (default 10), clear() drops errors but not pending, and the state is released after the last dispose.
 * See: src/chamber.ts
 */
import { describe, expect, beforeEach } from 'vitest';
import {
  createCommandBus,
  setCommandBus,
  resetCommandBus,
  useCommand,
  useSharedCommandState,
} from '../src/index';
import { it } from '../src/vitest';

beforeEach(() => { resetCommandBus(); });

describe('useSharedCommandState - shared identity', () => {
  it('two callers on the same bus see the SAME signal instances', () => {
    const a = useSharedCommandState();
    const b = useSharedCommandState();
    expect(a.anyPending).toBe(b.anyPending);
    expect(a.lastError).toBe(b.lastError);
    expect(a.errors).toBe(b.errors);
    expect(a.pending('x', 1)).toBe(b.pending('x', 1));
    a.dispose(); b.dispose();
  });

  it('different buses get isolated shared states', () => {
    const busA = createCommandBus();
    const busB = createCommandBus();
    const a = useSharedCommandState({ bus: busA });
    const b = useSharedCommandState({ bus: busB });
    expect(a.anyPending).not.toBe(b.anyPending);
    a.dispose(); b.dispose();
  });
});

describe('useSharedCommandState - anyPending', () => {
  it('reflects every dispatch in flight, across subscribers', async ({ asyncBus: bus }) => {
    const releases: Array<() => void> = [];
    bus.register('slow', () => new Promise<string>((r) => { releases.push(() => r('ok')); }));
    setCommandBus(bus as any);

    const a = useSharedCommandState();
    const b = useSharedCommandState();
    expect(a.anyPending.value).toBe(false);

    const p1 = bus.dispatch('slow', 1);
    const p2 = bus.dispatch('slow', 2);
    expect({ a: a.anyPending.value, b: b.anyPending.value }).toEqual({ a: true, b: true });

    await new Promise((r) => setTimeout(r, 0));
    releases[0]();
    await p1;
    expect(a.anyPending.value).toBe(true); // p2 still in flight
    releases[1]();
    await p2;
    expect(a.anyPending.value).toBe(false);
    a.dispose(); b.dispose();
  });

  // The vapor-sfc StatusBar relies on this: a dispatch made through useCommand must show in the bar.
  it('anyPending and pending(key) count every dispatch, whoever made it', async ({ asyncBus: bus }) => {
    let release: () => void = () => {};
    bus.register('slow', () => new Promise<string>((r) => { release = () => r('ok'); }));
    setCommandBus(bus as any);
    const shared = useSharedCommandState();
    const key = shared.pending('slow', 1);
    const cmd = useCommand();
    const paths = {
      useCommand: () => cmd.dispatch('slow', 1),
      raw: () => bus.dispatch('slow', 1),
    };
    const seen: Record<string, { any: boolean; key: boolean }> = {};
    for (const [name, go] of Object.entries(paths)) {
      const p = go();
      await new Promise((r) => setTimeout(r, 0));
      seen[name] = { any: shared.anyPending.value, key: key.value };
      release();
      await p;
    }

    expect(seen).toEqual({
      useCommand: { any: true, key: true },
      raw: { any: true, key: true },
    });
    expect({ any: shared.anyPending.value, key: key.value }).toEqual({ any: false, key: false });
    cmd.dispose();
    shared.dispose();
  });
});

describe('useSharedCommandState - error capture', () => {
  it('records failed dispatches into the errors ring buffer', ({ bus }) => {
    bus.register('boom', () => { throw new Error('boom1'); });
    setCommandBus(bus);
    const s = useSharedCommandState();

    bus.dispatch('boom', null);
    bus.dispatch('boom', null);
    bus.dispatch('boom', null);

    expect(s.errors.value).toHaveLength(3);
    expect(s.lastError.value?.message).toBe('boom1');
    expect(s.errors.value[2]?.message).toBe('boom1');
    s.dispose();
  });

  it('respects the maxSize (default 10) - older errors drop off', ({ bus }) => {
    let i = 0;
    bus.register('boom', () => { throw new Error('e' + (++i)); });
    setCommandBus(bus);
    const s = useSharedCommandState();

    for (let n = 0; n < 15; n++) bus.dispatch('boom', null);

    expect(s.errors.value).toHaveLength(10);
    expect(s.errors.value[0]?.message).toBe('e6');
    expect(s.errors.value[9]?.message).toBe('e15');
    s.dispose();
  });

  it('honors a custom maxSize', ({ bus }) => {
    bus.register('boom', () => { throw new Error('x'); });
    setCommandBus(bus);
    const s = useSharedCommandState({ maxSize: 3 });

    for (let n = 0; n < 7; n++) bus.dispatch('boom', null);

    expect(s.errors.value).toHaveLength(3);
    s.dispose();
  });

  it('clear() wipes errors but keeps what is pending', async ({ asyncBus: bus }) => {
    bus.register('boom', async () => { throw new Error('x'); });
    let release: () => void = () => {};
    bus.register('slow', () => new Promise<string>((r) => { release = () => r('ok'); }));
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    await bus.dispatch('boom', null);
    expect(s.errors.value).toHaveLength(1);
    expect(s.lastError.value).not.toBeNull();

    const slow = s.pending('slow', null);
    const p = bus.dispatch('slow', null);
    expect(slow.value).toBe(true);

    s.clear();
    expect({ errors: s.errors.value.length, last: s.lastError.value, slow: slow.value }).toEqual({ errors: 0, last: null, slow: true });

    await new Promise((r) => setTimeout(r, 0));
    release();
    await p;
    s.dispose();
  });
});

describe('useSharedCommandState - async dispatch path', () => {
  it('async result that resolves with !ok records the error', async ({ asyncBus: bus }) => {
    bus.register('async-fail', async () => { throw new Error('async-boom'); });
    setCommandBus(bus as any);
    const s = useSharedCommandState();
    void s.anyPending;

    const result = await bus.dispatch('async-fail', null);

    expect(result.ok).toBe(false);
    expect(s.errors.value).toHaveLength(1);
    expect(s.lastError.value?.message).toBe('async-boom');
    expect(s.anyPending.value).toBe(false);
    s.dispose();
  });

  it('async result that resolves with ok=true does NOT record an error', async ({ asyncBus: bus }) => {
    bus.register('async-ok', async (cmd) => cmd.target);
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    const result = await bus.dispatch('async-ok', 42);

    expect(result).toSucceedWith(42);
    expect(s.errors.value).toHaveLength(0);
    s.dispose();
  });
});

describe('useSharedCommandState - disposal', () => {
  it('refCount tracks subscribers; state stays alive until all dispose', ({ bus }) => {
    bus.register('boom', () => { throw new Error('x'); });
    setCommandBus(bus);

    const a = useSharedCommandState();
    const b = useSharedCommandState();
    bus.dispatch('boom', null);

    a.dispose();
    expect(b.errors.value).toHaveLength(1);

    b.dispose();
    const c = useSharedCommandState();
    expect(c.errors.value).toHaveLength(0);
    c.dispose();
  });

  it('unhooks from the bus after the last dispose', ({ bus }) => {
    setCommandBus(bus as any);
    const shared = useSharedCommandState();
    bus.register('boom', () => { throw new Error('late failure'); });
    shared.dispose(); // last holder: the observer is handed back

    bus.dispatch('boom', {});

    const fresh = useSharedCommandState();
    expect(fresh.errors.value).toHaveLength(0);
    fresh.dispose();
    resetCommandBus();
  });
});

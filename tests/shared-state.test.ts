/**
 * useSharedCommandState — tests for the shared-loading composable.
 *
 * Locks v1.2.x behavior:
 *   - Multiple callers receive the SAME signal instances (not copies).
 *   - inFlight counter aggregates concurrent dispatches.
 *   - errors is a ring buffer capped at errorCap (default 10).
 *   - Ref-counted disposal: state is GC-eligible once all subscribers dispose.
 *   - Async + sync bus paths both update state correctly.
 *   - Per-bus isolation: separate buses get separate shared states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCommandBus,
  createAsyncCommandBus,
  setCommandBus,
  resetCommandBus,
  useSharedCommandState,
} from '../src/index';

beforeEach(() => { resetCommandBus(); });

describe('useSharedCommandState — shared identity', () => {
  it('two callers on the same bus see the SAME signal instances', () => {
    const a = useSharedCommandState();
    const b = useSharedCommandState();
    expect(a.isAnyLoading).toBe(b.isAnyLoading);
    expect(a.lastError).toBe(b.lastError);
    expect(a.errors).toBe(b.errors);
    expect(a.inFlight).toBe(b.inFlight);
    a.dispose(); b.dispose();
  });

  it('different buses get isolated shared states', () => {
    const busA = createCommandBus();
    const busB = createCommandBus();
    const a = useSharedCommandState({ bus: busA });
    const b = useSharedCommandState({ bus: busB });
    expect(a.isAnyLoading).not.toBe(b.isAnyLoading);
    a.dispose(); b.dispose();
  });
});

describe('useSharedCommandState — inFlight counter', () => {
  it('isAnyLoading reflects inFlight > 0 across multiple subscribers', async () => {
    const bus = createAsyncCommandBus();
    bus.register('slow', async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'ok';
    });
    setCommandBus(bus as any);

    const a = useSharedCommandState();
    const b = useSharedCommandState();

    expect(a.isAnyLoading.value).toBe(false);
    expect(b.inFlight.value).toBe(0);

    const p1 = a.dispatch('slow', 1);
    const p2 = b.dispatch('slow', 2);

    // Both subscribers see the same loading state — there are 2 in flight.
    expect(a.inFlight.value).toBe(2);
    expect(b.inFlight.value).toBe(2);
    expect(a.isAnyLoading.value).toBe(true);
    expect(b.isAnyLoading.value).toBe(true);

    await Promise.all([p1, p2]);

    expect(a.inFlight.value).toBe(0);
    expect(a.isAnyLoading.value).toBe(false);
    a.dispose(); b.dispose();
  });

  it('counter never goes below zero on edge cases', async () => {
    const bus = createCommandBus();
    bus.register('quick', () => 'ok');
    setCommandBus(bus);
    const s = useSharedCommandState();
    s.dispatch('quick', null);
    s.dispatch('quick', null);
    expect(s.inFlight.value).toBe(0);
    s.dispose();
  });
});

describe('useSharedCommandState — error capture', () => {
  it('records failed dispatches into the errors ring buffer', () => {
    const bus = createCommandBus();
    bus.register('boom', () => { throw new Error('boom1'); });
    setCommandBus(bus);
    const s = useSharedCommandState();

    s.dispatch('boom', null);
    s.dispatch('boom', null);
    s.dispatch('boom', null);

    expect(s.errorCount.value).toBe(3);
    expect(s.errors.value).toHaveLength(3);
    expect(s.lastError.value?.message).toBe('boom1');
    expect(s.errors.value[2]?.message).toBe('boom1');
    s.dispose();
  });

  it('respects the errorCap (default 10) — older errors drop off', () => {
    const bus = createCommandBus();
    let i = 0;
    bus.register('boom', () => { throw new Error('e' + (++i)); });
    setCommandBus(bus);
    const s = useSharedCommandState();

    for (let n = 0; n < 15; n++) s.dispatch('boom', null);

    expect(s.errors.value).toHaveLength(10);
    // Oldest 5 dropped; newest 10 remain. errors[0] should be e6.
    expect(s.errors.value[0]?.message).toBe('e6');
    expect(s.errors.value[9]?.message).toBe('e15');
    s.dispose();
  });

  it('honors a custom errorCap', () => {
    const bus = createCommandBus();
    bus.register('boom', () => { throw new Error('x'); });
    setCommandBus(bus);
    const s = useSharedCommandState({ errorCap: 3 });

    for (let n = 0; n < 7; n++) s.dispatch('boom', null);

    expect(s.errors.value).toHaveLength(3);
    s.dispose();
  });

  it('clear() wipes errors but preserves inFlight', async () => {
    const bus = createAsyncCommandBus();
    bus.register('boom', async () => { throw new Error('x'); });
    bus.register('slow', async () => { await new Promise(r => setTimeout(r, 30)); return 'ok'; });
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    await s.dispatch('boom', null);
    expect(s.errorCount.value).toBe(1);
    expect(s.lastError.value).not.toBeNull();

    const p = s.dispatch('slow', null);
    expect(s.inFlight.value).toBe(1);

    s.clear();
    expect(s.errorCount.value).toBe(0);
    expect(s.lastError.value).toBeNull();
    expect(s.inFlight.value).toBe(1);  // still in flight

    await p;
    s.dispose();
  });
});

describe('useSharedCommandState — async dispatch path', () => {
  it('async result that resolves with !ok records the error', async () => {
    const bus = createAsyncCommandBus();
    bus.register('async-fail', async () => { throw new Error('async-boom'); });
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    const result = await s.dispatch('async-fail', null);

    expect(result.ok).toBe(false);
    expect(s.errorCount.value).toBe(1);
    expect(s.lastError.value?.message).toBe('async-boom');
    expect(s.inFlight.value).toBe(0);
    s.dispose();
  });

  it('async result that resolves with ok=true does NOT record an error', async () => {
    const bus = createAsyncCommandBus();
    bus.register('async-ok', async (cmd) => cmd.target);
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    const result = await s.dispatch('async-ok', 42);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(s.errorCount.value).toBe(0);
    s.dispose();
  });

  it('forwards { signal } to bus.dispatch (AbortController integration)', async () => {
    const bus = createAsyncCommandBus();
    const handler = vi.fn(async () => 'never');
    bus.register('slow', handler);
    setCommandBus(bus as any);
    const s = useSharedCommandState();

    const ac = new AbortController();
    ac.abort();

    const result = await s.dispatch('slow', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    s.dispose();
  });
});

describe('useSharedCommandState — disposal', () => {
  it('refCount tracks subscribers; state stays alive until all dispose', () => {
    const bus = createCommandBus();
    bus.register('boom', () => { throw new Error('x'); });
    setCommandBus(bus);

    const a = useSharedCommandState();
    const b = useSharedCommandState();
    a.dispatch('boom', null);

    a.dispose();
    // b still subscribed — state alive, error count preserved
    expect(b.errorCount.value).toBe(1);

    b.dispose();
    // After last dispose, a NEW useSharedCommandState() should get a fresh state.
    const c = useSharedCommandState();
    expect(c.errorCount.value).toBe(0);
    c.dispose();
  });
});

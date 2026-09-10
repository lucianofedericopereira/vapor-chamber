/**
 * Five plugins, one cause: `next()` returns a PROMISE on the async bus.
 *
 * Each is declared `Plugin`, whose `next` returns a `CommandResult`, and each
 * read that return value directly. `promise.ok` is `undefined`, so every one
 * took the wrong branch - silently, with no throw and no warning. Found by
 * running examples/pattern-1-blade-cdn.html (the IIFE/CDN delivery, where
 * there are no types at all) and reading its console.
 *
 * The measurements in each test are what the plugin did BEFORE src/settled.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history, logger } from '../src/plugins-core';
import { circuitBreaker, metrics } from '../src/plugins-extra';
import { persist } from '../src/plugins-io';

describe('plugins on an async bus', () => {
  it('logger reports a success as a success, not as `error: undefined`', async () => {
    const errors: unknown[][] = [];
    const logs: unknown[][] = [];
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });

    const bus = createAsyncCommandBus();
    bus.register('ok', async () => 'fine');
    bus.use(logger());
    expect((await bus.dispatch('ok', {})).ok).toBe(true);

    expect(errors).toHaveLength(0);
    expect(logs).toContainEqual(['result:', 'fine']);
    vi.restoreAllMocks();
  });

  it('logger still reports a real failure', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });

    const bus = createAsyncCommandBus();
    bus.register('bad', async () => { throw new Error('boom'); });
    bus.use(logger());
    await bus.dispatch('bad', {});

    expect(errors).toHaveLength(1);
    expect((errors[0]?.[1] as Error)?.message).toBe('boom');
    vi.restoreAllMocks();
  });

  it('history records, so undo/redo is not inert (measured: 0 of 2 recorded)', async () => {
    const bus = createAsyncCommandBus();
    bus.register('add', async () => 'ok');
    const h = history({});
    bus.use(h);
    await bus.dispatch('add', {});
    await bus.dispatch('add', {});
    expect(h.getState().past).toHaveLength(2);
  });

  it('circuitBreaker does not trip on SUCCESS (measured: open after 5 successes)', async () => {
    const bus = createAsyncCommandBus();
    bus.register('ok', async () => 'fine');
    const cb = circuitBreaker({ threshold: 3, actions: ['ok'] });
    bus.use(cb);
    for (let i = 0; i < 5; i++) await bus.dispatch('ok', {});
    expect(cb.getState('ok')).toBe('closed');
  });

  it('circuitBreaker still trips on real failures', async () => {
    const bus = createAsyncCommandBus();
    bus.register('bad', async () => { throw new Error('boom'); });
    const cb = circuitBreaker({ threshold: 3, actions: ['bad'] });
    bus.use(cb);
    for (let i = 0; i < 3; i++) await bus.dispatch('bad', {});
    expect(cb.getState('bad')).toBe('open');
  });

  it('metrics times the settlement, not the promise (measured: 0.02ms for a 30ms handler)', async () => {
    const bus = createAsyncCommandBus();
    bus.register('slow', async () => { await new Promise((r) => setTimeout(r, 30)); return 'x'; });
    const m = metrics({});
    bus.use(m);
    await bus.dispatch('slow', {});
    const entry = m.entries()[0];
    expect(entry?.ok).toBe(true);
    expect(entry?.durationMs).toBeGreaterThan(10);
  });

  it('persist saves (measured: 0 writes)', async () => {
    const writes: string[] = [];
    const storage = { getItem: () => null, setItem: (k: string) => { writes.push(k); }, removeItem: () => {} };
    const bus = createAsyncCommandBus();
    bus.register('add', async () => 'ok');
    bus.use(persist({ key: 'k', storage: storage as never, getState: () => ({ n: 1 }), coalesce: false }));
    await bus.dispatch('add', {});
    expect(writes).toEqual(['k']);
  });

  it('the sync bus is byte-for-byte unaffected', () => {
    // onSettled preserves sync-ness: a sync next() is never wrapped in a
    // promise, so a sync plugin behaves exactly as before.
    const bus = createCommandBus();
    bus.register('add', () => 'ok');
    const h = history({});
    const m = metrics({});
    bus.use(h);
    bus.use(m);
    const result = bus.dispatch('add', {});
    expect(result).not.toHaveProperty('then');
    expect(result.ok).toBe(true);
    expect(h.getState().past).toHaveLength(1);
    expect(m.entries()[0]?.ok).toBe(true);
  });
});

/**
 * logger, history, circuitBreaker and metrics on the async bus, where `next()` returns a promise.
 * Why: a plugin reading `next()`'s return directly sees `promise.ok` as undefined and silently takes the wrong branch.
 * Shows: successes read as successes, failures as failures; history records, the breaker trips only on failure, metrics times the settlement; the sync bus stays sync.
 * See: src/settled.ts.
 */
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { history, logger } from '../src/plugins-core';
import { circuitBreaker, metrics } from '../src/plugins-extra';
import { it } from '../src/vitest';

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
  });

  it('history records, so undo/redo is not inert (measured: 0 of 2 recorded)', async ({ asyncBus: bus }) => {
    bus.register('add', async () => 'ok');
    const h = history({ bus });
    await bus.dispatch('add', {});
    await bus.dispatch('add', {});
    expect(h.getState().past).toHaveLength(2);
  });

  it('circuitBreaker does not trip on SUCCESS (measured: open after 5 successes)', async ({ asyncBus: bus }) => {
    bus.register('ok', async () => 'fine');
    const cb = circuitBreaker({ threshold: 3, actions: ['ok'] });
    bus.use(cb);
    for (let i = 0; i < 5; i++) await bus.dispatch('ok', {});
    expect(cb.getState('ok')).toBe('closed');
  });

  it('circuitBreaker still trips on real failures', async ({ asyncBus: bus }) => {
    bus.register('bad', async () => { throw new Error('boom'); });
    const cb = circuitBreaker({ threshold: 3, actions: ['bad'] });
    bus.use(cb);
    for (let i = 0; i < 3; i++) await bus.dispatch('bad', {});
    expect(cb.getState('bad')).toBe('open');
  });

  it('metrics times the settlement, not the promise (measured: 0.02ms for a 30ms handler)', async ({ asyncBus: bus }) => {
    const SLEEP_MS = 30;
    bus.register('slow', async () => { await new Promise((r) => setTimeout(r, SLEEP_MS)); return 'x'; });
    const m = metrics({});
    bus.use(m);
    await bus.dispatch('slow', {});
    const entry = m.entries()[0];
    expect(entry?.ok).toBe(true);
    // A fraction of the sleep, so the two cannot drift; no ceiling, so a slow machine still passes.
    expect(entry?.durationMs).toBeGreaterThan(SLEEP_MS / 3);
  });

  it('the sync bus is byte-for-byte unaffected', ({ bus }) => {
    // onSettled keeps sync-ness: a sync next() is never wrapped in a promise.
    bus.register('add', () => 'ok');
    const h = history({ bus });
    const m = metrics({});
    bus.use(m);
    const result = bus.dispatch('add', {});
    expect(result).not.toHaveProperty('then');
    expect(result.ok).toBe(true);
    expect(h.getState().past).toHaveLength(1);
    expect(m.entries()[0]?.ok).toBe(true);
  });
});

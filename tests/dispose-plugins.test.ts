/**
 * dispose() runs each installed plugin's dispose() before dropping it.
 *
 * Before: the JSDoc promised "cancels all pending timers/requests" and the
 * bus cancelled only its own throttle timers (and, since q2/1, settled its
 * waiting requests). debounce() and throttle() already exposed a dispose()
 * that nothing on the bus called, so their timers outlived the bus. Now a
 * plugin may carry dispose() (the Plugin and AsyncPlugin types say so), the bus
 * runs every installed one first, and the bus's own retry ends a pending wait
 * as core:aborted:dispatch - a cleared timer alone would have left that
 * dispatch pending forever.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, type BusError, type CommandResult, type Plugin } from '../src/command-bus';
import { debounce, throttle } from '../src/plugins-core';
import { it } from '../src/vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const code = (r: CommandResult | undefined): string | undefined => (r?.error as BusError | undefined)?.code;

describe('dispose() runs plugin dispose()', () => {
  it('cancels a pending debounce timer', () => {
    vi.useFakeTimers();
    const bus = createCommandBus();
    const handler = vi.fn(() => 1);
    bus.register('t', handler);
    bus.use(debounce(['t'], 50));
    bus.dispatch('t', 1);
    expect(vi.getTimerCount()).toBe(1);

    bus.dispose();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancels a throttle window timer', () => {
    vi.useFakeTimers();
    const bus = createCommandBus();
    bus.register('t', () => 1);
    bus.use(throttle(['t'], 1000));
    bus.dispatch('t', 1);
    expect(vi.getTimerCount()).toBe(1);

    bus.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a retry wait mid-sleep as core:aborted:dispatch and stops the attempts', async () => {
    vi.useFakeTimers();
    // The wait is full jitter, Math.random() * 100 ms: a draw under 1 ms ran
    // out inside the first advance below (1 run in about 100; Math.random 0
    // reproduces it). Pinned mid-range.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 100, actions: { t: 'idempotent' } } });
    const handler = vi.fn(async () => { throw new Error('flaky'); });
    bus.register('t', handler);
    let result: CommandResult | undefined;
    bus.dispatch('t', 1).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails, the backoff sleep is armed
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    bus.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(code(result)).toBe('core:aborted:dispatch');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the retry runs to its result when nothing disposes it, and a finished wait leaves nothing behind', async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus({ retry: { baseDelay: 100, actions: { t: 'idempotent' } } });
    let calls = 0;
    bus.register('t', async () => { if (++calls < 2) throw new Error('flaky'); return 'ok'; });
    let result: CommandResult | undefined;
    bus.dispatch('t', 1).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(100);

    expect(result?.value).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    bus.dispose(); // nothing pending: a no-op
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs every plugin dispose, even when one unsubscribes its own plugin', ({ bus }) => {
    const first = vi.fn();
    const second = vi.fn();
    let unsubFirst = (): void => {};
    const a: Plugin = Object.assign(((_c: unknown, next: () => CommandResult) => next()) as Plugin, { dispose: () => { first(); unsubFirst(); } });
    const b: Plugin = Object.assign(((_c: unknown, next: () => CommandResult) => next()) as Plugin, { dispose: second });
    unsubFirst = bus.use(a);
    bus.use(b);
    bus.use((_c, next) => next()); // a plugin without dispose is fine

    bus.dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('async bus: the same, and the plugins are gone afterwards', async ({ asyncBus: bus }) => {
    const spy = vi.fn();
    const passThrough: Plugin = (_c, next) => next();
    bus.use(Object.assign(passThrough, { dispose: spy }));
    bus.register('t', async () => 1);
    bus.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
    bus.register('t', async () => 2);
    expect((await bus.dispatch('t', 1)).value).toBe(2);
  });
});

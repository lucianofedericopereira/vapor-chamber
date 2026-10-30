/**
 * dispose() runs each installed plugin's dispose() before dropping it.
 * Why: a plugin's timers must not outlive its bus, and the bus's own retry must end a pending wait, since a cleared timer alone leaves that dispatch pending forever.
 * Shows: a retry mid-sleep ends as core:aborted:dispatch with no more attempts; a finished wait leaves no timer; every plugin dispose runs, even if one unsubscribes itself.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus, type BusError, type CommandResult, type PluginParts } from '../src/command-bus';
import { it } from '../src/vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const code = (r: CommandResult | undefined): string | undefined => (r?.error as BusError | undefined)?.code;

describe('dispose() runs plugin dispose()', () => {
  it('ends a retry wait mid-sleep as core:aborted:dispatch and stops the attempts', async () => {
    vi.useFakeTimers();
    // The wait is full jitter, and a draw under 1 ms would end inside the first advance, so it is pinned mid-range.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 100, actionPolicies: { t: 'idempotent' } } });
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
    const bus = createAsyncCommandBus({ retry: { baseDelay: 100, actionPolicies: { t: 'idempotent' } } });
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
    const a: PluginParts = { settled: () => {}, dispose: () => { first(); unsubFirst(); } };
    const b: PluginParts = { settled: () => {}, dispose: second };
    unsubFirst = bus.use(a);
    bus.use(b);
    bus.use({ settled: () => {} }); // a plugin without dispose is fine

    bus.dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('async bus: the same, and the plugins are gone afterwards', async ({ asyncBus: bus }) => {
    const spy = vi.fn();
    bus.use({ settled: () => {}, dispose: spy });
    bus.register('t', async () => 1);
    bus.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
    bus.register('t', async () => 2);
    expect((await bus.dispatch('t', 1)).value).toBe(2);
  });
});

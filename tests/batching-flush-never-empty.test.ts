/**
 * FIXTURE: `httpTransport` with `batch` never posts an empty batch, on any way a flush gets scheduled.
 * Why: `flush()` has no empty-batch guard; the invariant that a flush follows a push needs evidence, not a reading of the code.
 * Shows: a burst, separate ticks, a timed window, pre-aborted and queue-aborted dispatches, a dispatch during a flush: exact batch sizes, none 0.
 * See: log s35.25, log s35.168, tests/batching-abort.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { httpTransport } from '../src/transports';

/** A backend that answers every command, and records the size of every batch. */
function backend(onPost?: (n: number) => void) {
  const sizes: number[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { commands: Array<{ id: string }> };
    sizes.push(body.commands.length);
    onPost?.(sizes.length);
    return { ok: true, json: async () => ({ results: body.commands.map((c) => ({ id: c.id, state: 1 })) }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return sizes;
}

function busWith(window?: number) {
  const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api/vc/batch', batch: window === undefined ? {} : { window } }) });
  return bus;
}

describe('httpTransport with batch: a flush always carries at least one command', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a same-tick burst, then separate ticks', async () => {
    const sizes = backend();
    const bus = busWith();
    await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {}), bus.dispatch('c', {})]);
    await bus.dispatch('d', {});
    await bus.dispatch('e', {});
    expect(sizes).toEqual([3, 1, 1]);
  });

  it('a numeric window, two bursts, and idle time after each', async () => {
    vi.useFakeTimers();
    const sizes = backend();
    const bus = busWith(20);
    const first = [bus.dispatch('a', {}), bus.dispatch('b', {})];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(first);
    const second = [bus.dispatch('c', {})];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(second);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sizes).toEqual([2, 1]);
  });

  it('a dispatch whose signal is already aborted posts nothing at all', async () => {
    const sizes = backend();
    const bus = busWith();
    const controller = new AbortController();
    controller.abort();
    const result = await bus.dispatch('a', {}, undefined, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.ok).toBe(false);
    expect(sizes).toEqual([]);
  });

  it('a dispatch aborted while it waits in the queue leaves it, and the empty flush sends nothing', async () => {
    const sizes = backend();
    const bus = busWith();
    const controller = new AbortController();
    const pending = bus.dispatch('a', {}, undefined, { signal: controller.signal });
    controller.abort();
    expect((await pending).error).toMatchObject({ code: 'core:aborted:dispatch' });
    await new Promise((r) => setTimeout(r, 0));
    expect(sizes).toEqual([]);
  });

  it('a dispatch made while a flush is in flight gets a flush of its own', async () => {
    let bus!: ReturnType<typeof busWith>;
    let inner: Promise<unknown> | undefined;
    const sizes = backend((post) => {
      if (post === 1) inner = bus.dispatch('from-inside', {});
    });
    bus = busWith();
    await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);
    await inner;
    expect(sizes).toEqual([2, 1]);
  });
});

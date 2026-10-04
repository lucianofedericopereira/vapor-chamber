/**
 * FIXTURE - `createBatchingHttpBridge` never posts an empty batch, on any way
 * a flush gets scheduled. The long note is at the end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge } from '../src/transports';

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
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', ...(window === undefined ? {} : { window }) }));
  return bus;
}

describe('createBatchingHttpBridge: a flush always carries at least one command', () => {
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

  it('a dispatch aborted while it waits in the queue is still sent, in a batch of one', async () => {
    const sizes = backend();
    const bus = busWith();
    const controller = new AbortController();
    const pending = bus.dispatch('a', {}, undefined, { signal: controller.signal });
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(sizes).toEqual([1]);
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

/*
 * Why this file exists. `flush()` used to open with
 * `if (batch.length === 0) return;` under a `v8 ignore` marker whose comment
 * said the branch was unreachable. The guard was removed in log s35.25 on a
 * READING of the code: a flush is scheduled only after a push, once per
 * window, and only a flush empties the queue. A reading is not evidence, and a
 * green suite after the removal is a negative result with no positive control.
 *
 * This file is that evidence. It drives the bridge through each way a flush
 * is scheduled (a burst, separate ticks, a timed window with idle time after
 * it, a pre-aborted dispatch, a dispatch aborted while queued, a dispatch made
 * during a flush) and records the size of every batch the backend receives.
 * No batch is empty, and the counts are exact, so an extra empty POST would
 * fail the list as well as the rule.
 *
 * The positive control was run before this file was trusted: with `flush()`
 * edited to schedule one more flush after every real one, four of the five
 * tests fail on a recorded batch of 0 (the fifth posts nothing either way).
 * See log s35.25.
 */

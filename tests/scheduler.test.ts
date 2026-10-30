/**
 * The scheduler's lanes (ordered runs per key) and sleeper (cancellable sleeps).
 * Why: a lane that stayed blocked after a failed run would stall every later command on that key, and a sleep that could not be woken or aborted would hold a retry or debounce open.
 * Shows: a lane runs in order and a failed run releases it; a sleep resolves true when due and false when woken or aborted, and an abort ends only its own sleep.
 * See: tests/timer-delays.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { delayOption } from '../src/bounds';
import { createLanes, createSleeper } from '../src/scheduler';

// A sleep takes a Delay, not a number of milliseconds.
const ten = delayOption(10, 10);

describe('scheduler', () => {
  it('runs a lane in order, and a run that fails releases the lane', async () => {
    const lanes = createLanes();
    const order: string[] = [];
    const failed = lanes.run('k', async () => { order.push('a'); throw new Error('a'); });
    const next = lanes.run('k', () => { order.push('b'); return 'b'; });
    await expect(failed).rejects.toThrow('a');
    expect(await next).toBe('b');
    expect(order).toEqual(['a', 'b']);
  });

  it('a sleep resolves true when due and false when woken', async () => {
    vi.useFakeTimers();
    try {
      const waits = createSleeper();
      const due = waits.sleep(ten);
      vi.advanceTimersByTime(10);
      expect(await due).toBe(true);
      const woken = waits.sleep(ten);
      waits.wakeAll();
      expect(await woken).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sleep ends on its signal's abort, and only that sleep", async () => {
    vi.useFakeTimers();
    try {
      const waits = createSleeper();
      const ac = new AbortController();
      const mine = waits.sleep(ten, ac.signal);
      const other = waits.sleep(ten);
      ac.abort();
      expect(await mine).toBe(false);
      vi.advanceTimersByTime(10);
      expect(await other).toBe(true);
      expect(await waits.sleep(ten, ac.signal)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

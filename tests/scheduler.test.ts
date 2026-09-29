import { describe, expect, it, vi } from 'vitest';
import { createLanes, createSleeper } from '../src/scheduler';

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
      const due = waits.sleep(10);
      vi.advanceTimersByTime(10);
      expect(await due).toBe(true);
      const woken = waits.sleep(10);
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
      const mine = waits.sleep(10, ac.signal);
      const other = waits.sleep(10);
      ac.abort();
      expect(await mine).toBe(false);
      vi.advanceTimersByTime(10);
      expect(await other).toBe(true);
      expect(await waits.sleep(10, ac.signal)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

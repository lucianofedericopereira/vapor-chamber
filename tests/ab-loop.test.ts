// The A/B child's timing loop (scripts/ab/loop.cjs): an async workload's window
// closes when its promise settles, a sync one's when f returns (log s35.133).
import { createRequire } from 'node:module';
import { GCProfiler } from 'node:v8';
import { describe, expect, it } from 'vitest';

const { mkLoop } = createRequire(import.meta.url)('../scripts/ab/loop.cjs');

describe('ab timing loop', () => {
  it('awaits an async workload inside the window', async () => {
    const f = () => new Promise((r) => setTimeout(() => r(7), 20));
    const [wall, , , , v] = await mkLoop(true)(f, 1, GCProfiler);
    expect(v).toBe(7);
    expect(wall).toBeGreaterThanOrEqual(15e6);
  });

  it('a sync workload is timed as before: the value, not a promise', () => {
    const [wall, , , , v] = mkLoop(false)((n: number) => n * 2, 3, GCProfiler);
    expect(v).toBe(6);
    expect(wall).toBeLessThan(15e6);
  });
});

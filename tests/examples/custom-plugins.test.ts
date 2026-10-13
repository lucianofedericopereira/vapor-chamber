// examples/custom-plugins.ts, imported for real: its demo runs, then its exported bus is probed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, CommandBus } from '../../src/command-bus';

/** Imports the example fresh, with only `Date` faked so the rate-limit window can be stepped. */
async function loadExample(): Promise<{ bus: CommandBus; logs: string[] }> {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const { bus } = await import('../../examples/custom-plugins');
  return { bus: bus as unknown as CommandBus, logs };
}

/** Moves the clock past the example's 3-per-second rate-limit window. */
const nextWindow = () => vi.advanceTimersByTime(1001);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('transformPlugin', () => {
  it('leaves a command alone when its action is a name Object.prototype carries (CU-6)', async () => {
    const { bus } = await loadExample();
    const seen: Record<string, string[]> = {};
    bus.use((cmd: Command, next) => { seen[cmd.action] = Object.keys(cmd); return next(); });
    for (const action of ['toString', 'valueOf', 'hasOwnProperty']) {
      nextWindow();
      const r = bus.dispatch(action, { id: 1 });
      expect({ action, code: (r.error as { code?: string } | undefined)?.code, keys: seen[action] }).toEqual({
        action,
        code: 'core:missing:handler',
        keys: expect.not.arrayContaining(['0']),
      });
    }
    // Positive control: the action the example names still gets its transform.
    nextWindow();
    const added = bus.dispatch('itemAdd', { name: 'Widget' }, { quantity: 5 });
    expect(added.ok).toBe(true);
    expect((added.value as { metadata: Record<string, unknown> }).metadata).toEqual({ quantity: 5, addedAt: Date.now() });
  });
});

describe('the demo output', () => {
  it('shows three requests passing and the fourth refused by the rate limiter (CU-10)', async () => {
    const { logs } = await loadExample();
    const requests = logs.filter((l) => l.startsWith('Request '));
    expect(requests).toEqual([
      'Request 1: OK',
      'Request 2: OK',
      'Request 3: OK',
      'Request 4: Rate limit exceeded. Max 3 requests per 1000ms',
    ]);
  });

  it('shows the optimistic update kept or rolled back, as the handler decides (CU-10)', async () => {
    // The handler fails when Math.random() > 0.5.
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    expect((await loadExample()).logs).toContain('kept -> 1');
    // Positive control: a failing handler still rolls the update back.
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect((await loadExample()).logs).toContain('rolled back -> 0');
  });
});

/*
 * Why the real module: the example is what a reader copies, and the plugins
 * are its local functions, not exports. Importing it runs its demo and gives
 * the bus with every plugin installed in the example's order, so a probe
 * sees exactly what the demo does. Only Date is faked: the rate limiter
 * reads Date.now(), and stepping it past the window lets a probe dispatch
 * without being refused. Rows CU-6 and CU-10 of the 2026-10-12 release
 * audit.
 */

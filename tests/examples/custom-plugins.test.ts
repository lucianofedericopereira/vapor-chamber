// examples/custom-plugins.ts, imported for real: its demo runs, then its exported bus is probed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandBus, CommandResult } from '../../src/command-bus';

/** Imports the example fresh, with only `Date` faked so the rate-limit window stands still. */
async function loadExample(): Promise<{ bus: CommandBus; addItem: (item: object, payload: object) => CommandResult; logs: string[] }> {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const { bus, addItem } = await import('../../examples/custom-plugins');
  return { bus: bus as unknown as CommandBus, addItem: addItem as never, logs };
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the sender and the rules', () => {
  it('the sender mints the timestamp: the bus never rewrites the command', async () => {
    const { addItem } = await loadExample();
    const added = addItem({ name: 'Widget' }, { quantity: 5 });
    expect(added.ok).toBe(true);
    expect((added.value as { metadata: Record<string, unknown> }).metadata).toEqual({ quantity: 5, addedAt: Date.now() });
  });

  it('an action named after an Object.prototype member reaches no rule (CU-6)', async () => {
    const { bus } = await loadExample();
    for (const action of ['toString', 'valueOf', 'hasOwnProperty']) {
      const r = bus.dispatch(action, { id: 1 });
      expect({ action, code: (r.error as { code?: string } | undefined)?.code }).toEqual({ action, code: 'core:missing:handler' });
    }
  });

  it('the rate limiter counts only the action it is scoped to, whenever it was installed', async () => {
    const { bus } = await loadExample();
    // The demo spent the whole window on `publicStatus`: every other action still passes.
    for (let i = 0; i < 5; i++) expect(bus.dispatch('publicInfo', null).ok).toBe(true);
    // Positive control: the scoped action is still refused in the same window.
    const refused = bus.dispatch('publicStatus', null);
    expect((refused.error as { code?: string } | undefined)?.code).toBe('rateLimiter:limited:action');
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

  it('read-only mode refuses a write and answers a read, with no onBefore (plan 1.32 7)', async () => {
    const { logs } = await loadExample();
    expect(logs).toContain('itemAdd: Read-only mode: itemAdd is refused');
    expect(logs).toContain('publicInfo: OK');
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
 * are its local functions, not exports (the sender `addItem` is exported).
 * Importing it runs its demo and gives the bus with every plugin installed in
 * the example's order, so a probe sees exactly what the demo does. Only Date
 * is faked: the rate limiter reads Date.now(), and a frozen clock keeps its
 * window full for the probes. Rows CU-6 and CU-10 of the 2026-10-12 release
 * audit.
 */

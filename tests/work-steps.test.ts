/**
 * The work's steps (`reuse`, `admit`, `begin`) around a command's work, on the sync, async and test buses.
 * Why: if plugin outcomes depended on install order, a limit in front of a cache would spend a slot on a hit, a breaker in front of a limit would count its refusal, and a retry would re-run steps meant to run once per dispatch.
 * Shows: with either install order a cached hit spends no rateLimit slot and a refusal is no breaker failure; a stored answer skips every begin and the work; a throwing step is its plugin's `failed:plugin` and tickets taken still land; steps run once around retries; a ticket's signal and answer reach the work and the caller.
 * See: log s36.107
 */
import { describe, expect, it } from 'vitest';
import { _failures, type BaseBus, type Command, type CommandResult, type PluginParts, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, circuitBreaker, rateLimit } from '../src/plugins-extra';
import { createTestBus } from '../src/testing';

const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);
const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus({ retry: false })],
  ['test', () => createTestBus({ passthroughHandlers: true })],
];
const ORDERS = ['A then B', 'B then A'] as const;

describe.each(BUSES)('work steps on the %s bus', (_name, make) => {
  it('a cached read never spends a rateLimit slot, in either order', async () => {
    for (const order of ORDERS) {
      const bus = make();
      bus.register('load', (cmd: Command) => cmd.target.id);
      const parts = [cache(), rateLimit({ max: 2, window: 60_000 })];
      for (const p of order === 'A then B' ? parts : parts.reverse()) bus.use(p);
      await bus.dispatch('load', { id: 1 });
      await bus.dispatch('load', { id: 1 }); // a hit
      expect([order, code(await bus.dispatch('load', { id: 2 }))]).toEqual([order, 'ok']);
    }
  });

  it("a rateLimit refusal is no failure to circuitBreaker, in either order", async () => {
    for (const order of ORDERS) {
      const bus = make();
      bus.register('save', () => 1);
      const breaker = circuitBreaker({ threshold: 1 });
      const parts = [breaker, rateLimit({ max: 1, window: 60_000 })];
      for (const p of order === 'A then B' ? parts : parts.reverse()) bus.use(p);
      await bus.dispatch('save', null);
      expect(code(await bus.dispatch('save', null))).toBe('rateLimit:limited:action');
      expect([order, breaker.getState('save')]).toEqual([order, 'closed']);
    }
  });

  it('a stored answer skips every begin and the work', async () => {
    const bus = make();
    let ran = 0;
    let begun = 0;
    bus.register('load', () => { ran++; return 'work'; });
    bus.use({ id: 'counter', begin: () => { begun++; return undefined; } });
    bus.use({ id: 'store', reuse: () => ({ ok: true, value: 'stored', error: undefined }) });
    expect(await bus.dispatch('load', null)).toMatchObject({ ok: true, value: 'stored' });
    expect({ ran, begun }).toEqual({ ran: 0, begun: 0 });
  });

  it("a step's throw is its plugin's failed:plugin, and the tickets taken land with it", async () => {
    const bus = make();
    const landed: string[] = [];
    bus.register('save', () => 1);
    bus.use({ id: 'first', begin: () => ({ landed: (r: CommandResult) => { landed.push(code(r)); } }) });
    bus.use({ id: 'boom', begin: () => { throw new Error('x'); } });
    expect(code(await bus.dispatch('save', null))).toBe('boom:failed:plugin');
    expect(landed).toEqual(['boom:failed:plugin']);
  });

  it('a ticket lands with the work result (control)', async () => {
    const bus = make();
    const landed: unknown[] = [];
    bus.register('save', () => 7);
    bus.use({ id: 'watch', begin: () => ({ landed: (r: CommandResult) => { landed.push(r.value); } }) } satisfies PluginParts);
    await bus.dispatch('save', null);
    await bus.query('save', null);
    expect(landed).toEqual([7, 7]);
  });
});

describe('work steps on the async bus', () => {
  it('run once around every retry', async () => {
    const bus = createAsyncCommandBus({ retry: { maxAttempts: 3, baseDelay: 0 } });
    const limited = _failures('server');
    let attempts = 0;
    let begun = 0;
    bus.register('save', async () => { if (++attempts < 3) throw limited('limited:action', 'busy', { context: { retryIn: 0 } }); return 'ok'; });
    bus.use({ id: 'counter', begin: () => { begun++; return undefined; } });
    expect(code(await bus.dispatch('save', null))).toBe('ok');
    expect({ attempts, begun }).toEqual({ attempts: 3, begun: 1 });
  });

  it("gives the work a ticket's signal, and answers a ticket's answer", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    bus.register('save', async (cmd) => { seen = cmd.signal; return 'work'; });
    bus.use({ id: 'own', begin: () => ({ signal: ctrl.signal, answer: Promise.resolve({ ok: true, value: 'answer', error: undefined }) }) });
    expect(await bus.dispatch('save', null)).toMatchObject({ ok: true, value: 'answer' });
    expect(seen).toBe(ctrl.signal);
  });

  it("on the sync bus too: work the handler starts and does not await is cancelled by the step's own signal", () => {
    const bus = createCommandBus();
    const ctrl = new AbortController();
    let started: AbortSignal | undefined;
    bus.register('load', (cmd) => { started = cmd.signal; return 'started'; });
    bus.use({ id: 'own', begin: () => ({ signal: ctrl.signal }) });
    expect(bus.dispatch('load', null)).toMatchObject({ ok: true, value: 'started' });
    expect(started?.aborted).toBe(false);
    ctrl.abort();
    expect(started?.aborted).toBe(true);
  });
});

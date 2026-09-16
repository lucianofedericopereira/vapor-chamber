/**
 * A before-hook's throw is a VC_CORE_BEFORE_CANCEL result.
 *
 * The code has been in the BusErrorCode union, the BusError JSDoc's switch
 * example and ERROR_CODE_REGISTRY since v1.0 - and never produced: both buses
 * returned the raw thrown value as `result.error`, so a caller switching on
 * codes (the documented pattern) could not tell a cancelled dispatch from a
 * handler that threw. Now the throw is wrapped the way a plugin's is
 * (VC_PLUGIN_THREW): the thrown value is `cause`, its message is the
 * BusError's message, so a hook that throws `new Error('blocked')` still
 * reads "blocked"; a thrown BusError passes through as itself; severity and
 * emitter are the registry's ('warn', 'hook'); not retryable. The TestBus
 * cancels the same way.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus, BusError, RETRYABLE_CODES, type CommandResult } from '../src/command-bus';
import { createTestBus } from '../src/testing';

const busError = (r: CommandResult): BusError => {
  expect(r).toFailWith('VC_CORE_BEFORE_CANCEL');
  expect(r.error).toBeInstanceOf(BusError);
  return r.error as BusError;
};

describe.each([
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus()],
] as const)('%s bus: a before-hook throw', (_kind, make) => {
  it('is a VC_CORE_BEFORE_CANCEL BusError with the throw as cause and message', async () => {
    const bus: any = make();
    const handler = vi.fn(() => 'ran');
    bus.register('act', handler);
    const thrown = new Error('blocked');
    bus.onBefore(() => { throw thrown; });

    const r: CommandResult = await bus.dispatch('act', 1);

    const e = busError(r);
    expect(e.code).toBe('VC_CORE_BEFORE_CANCEL');
    expect(e.message).toBe('blocked');
    expect(e.cause).toBe(thrown);
    expect(e.emitter).toBe('hook');
    expect(e.severity).toBe('error'); // BusSeverity: the dispatch failed
    expect(e.stack ?? '').not.toMatch(/\n\s+at /); // no frames captured: the cause carries the hook's stack
    expect(thrown.stack).toMatch(/\n\s+at /);
    expect(e.action).toBe('act');
    expect(RETRYABLE_CODES.has(e.code)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a thrown BusError through as itself', async () => {
    const bus: any = make();
    bus.register('act', () => 'ran');
    const own = new BusError('VC_CORE_NAMING_VIOLATION', 'my code', { emitter: 'hook' });
    bus.onBefore(() => { throw own; });

    const r: CommandResult = await bus.dispatch('act', 1);

    expect(r.error).toBe(own);
  });

  it('wraps a thrown non-Error with its string form as the message', async () => {
    const bus: any = make();
    bus.register('act', () => 'ran');
    bus.onBefore(() => { throw 'nope'; });

    const r: CommandResult = await bus.dispatch('act', 1);

    const e = busError(r);
    expect(e.code).toBe('VC_CORE_BEFORE_CANCEL');
    expect(e.message).toBe('nope');
    expect(e.cause).toBe('nope');
  });

  it('after-hooks and listeners see the same result', async () => {
    const bus: any = make();
    bus.register('act', () => 'ran');
    bus.onBefore(() => { throw new Error('blocked'); });
    const seen: CommandResult[] = [];
    bus.onAfter((_c: unknown, res: CommandResult) => { seen.push(res); });
    bus.on('*', (_c: unknown, res: CommandResult) => { seen.push(res); });

    const r: CommandResult = await bus.dispatch('act', 1);

    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toBe(r);
  });
});

describe('TestBus: a before-hook throw', () => {
  it('cancels with the same VC_CORE_BEFORE_CANCEL result as a real bus', () => {
    const bus = createTestBus();
    bus.register('act', () => 'ran');
    const thrown = new Error('blocked');
    bus.onBefore(() => { throw thrown; });

    const r = bus.dispatch('act', 1);

    const e = busError(r);
    expect(e.code).toBe('VC_CORE_BEFORE_CANCEL');
    expect(e.message).toBe('blocked');
    expect(e.cause).toBe(thrown);
  });
});

// A dispatch's own abort has one shape wherever it lands (plan item 7).
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, BusError, conditionOf, failureCondition, type Command } from '../src/command-bus';
import { _failures } from '../src/failure';
import { routerError } from '@router/errors';
import { it } from '../src/vitest';

const abortedMidFlight = (ac: AbortController) => (cmd: Command) =>
  new Promise((_res, rej) => {
    cmd.signal!.addEventListener('abort', () => { try { cmd.signal!.throwIfAborted(); } catch (e) { rej(e); } });
    setTimeout(() => ac.abort(), 1);
  });

describe('an abort is named AbortError and stays a BusError', () => {
  it('names every aborted:* BusError AbortError, every other code BusError', () => {
    expect(new BusError('aborted:dispatch', 'x').name).toBe('AbortError');
    expect(_failures('transport')('aborted:request', 'x').name).toBe('AbortError');
    expect(routerError('aborted:navigation', 'x').name).toBe('AbortError');
    for (const code of ['missing:handler', 'already:x', 'conflict:x', 'invalid:x', 'refused:x', 'unauthenticated:x', 'limited:x', 'timeout:x', 'lost:x', 'exceeded:x', 'failed:x', 'unexpected:x', 'unknown:x'] as const) {
      expect(new BusError(code, 'x').name).toBe('BusError');
    }
  });

  it('before start: core:aborted:dispatch, named AbortError, the reason as cause', async () => {
    const bus = createAsyncCommandBus();
    bus.register('x', async () => 1);
    const ac = new AbortController();
    ac.abort();
    const r = await bus.dispatch('x', null, undefined, { signal: ac.signal });
    expect(r.error).toBeInstanceOf(BusError);
    expect(r.error).toMatchObject({ name: 'AbortError', code: 'core:aborted:dispatch' });
    expect((r.error as Error).cause).toBe(ac.signal.reason);
  });
});

describe('a mid-flight rethrow of the dispatch signal reason', () => {
  it('from a handler: core:aborted:dispatch, not the raw DOMException', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    bus.register('x', abortedMidFlight(ac));
    const r = await bus.dispatch('x', null, undefined, { signal: ac.signal });
    expect(r.error).toBeInstanceOf(BusError);
    expect(r.error).toMatchObject({ name: 'AbortError', code: 'core:aborted:dispatch' });
    expect((r.error as Error).cause).toBe(ac.signal.reason);
  });

  it('from a plugin: core:aborted:dispatch, no plugin bug, no DEV "Fix the plugin"', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    bus.register('x', async () => 1);
    bus.use(async (cmd) => abortedMidFlight(ac)(cmd) as never);
    const r = await bus.dispatch('x', null, undefined, { signal: ac.signal });
    expect(r.error).toMatchObject({ name: 'AbortError', code: 'core:aborted:dispatch' });
    expect(conditionOf(r.error)).toBe('aborted');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('control: a custom Error reason passes through as itself', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    const mine = new Error('mine');
    bus.register('x', (cmd) => new Promise((_res, rej) => {
      cmd.signal!.addEventListener('abort', () => rej(cmd.signal!.reason));
      setTimeout(() => ac.abort(mine), 1);
    }));
    const r = await bus.dispatch('x', null, undefined, { signal: ac.signal });
    expect(r.error).toBe(mine);
  });

  it('control: a handler that ignores the signal completes ok', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    bus.register('x', () => new Promise((res) => { setTimeout(() => ac.abort(), 1); setTimeout(() => res('done'), 5); }));
    const r = await bus.dispatch('x', null, undefined, { signal: ac.signal });
    expect(r).toMatchObject({ ok: true, value: 'done' });
  });

  it('control: an unrelated AbortError from the handler stays as thrown', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const own = new DOMException('own', 'AbortError');
    bus.register('x', async () => { throw own; });
    const r = await bus.dispatch('x', null, undefined, { signal: new AbortController().signal });
    expect(r.error).toBe(own);
    expect(failureCondition(r.error)).toBe('aborted');
  });

  it('control: an unrelated plugin throw stays plugin:failed:plugin with its DEV message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('x', async () => 1);
    bus.use(async () => { throw new Error('bug'); });
    const r = await bus.dispatch('x', null, undefined, { signal: new AbortController().signal });
    expect((r.error as BusError).code).toBe('plugin:failed:plugin');
    expect(r.error!.name).toBe('BusError');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

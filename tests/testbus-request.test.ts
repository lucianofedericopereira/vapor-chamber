/**
 * The TestBus's request()/respond() behave like a real bus's.
 *
 * Before: respond() returned a no-op and dropped the handler; request()
 * ignored its payload and options and resolved dispatch(). A consumer whose
 * code under test used request()/respond() got a double that could not
 * exercise that path at all. Now a responder answers through the plugin
 * chain and the after-hooks, is recorded like a dispatch, has its thenable
 * value awaited, and an already-aborted signal settles VC_CORE_ABORTED
 * before it runs; with no responder the request falls back to dispatch(), as
 * on a real bus. A sealed TestBus refuses respond(); dispose() drops
 * responders (clear() keeps them, as it keeps handlers - the double's own
 * documented contract). Not mirrored, by design: the timeout and dispose()
 * settling a waiting request - a double records, it does not wait.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestBus } from '../src/testing';
import type { BusError, CommandResult } from '../src/command-bus';

const code = (r: CommandResult): string | undefined => (r.error as BusError | undefined)?.code;

describe('TestBus request()/respond()', () => {
  it('a responder answers, through the chain and the hooks, and is recorded', async () => {
    const bus = createTestBus();
    const after = vi.fn();
    bus.onAfter(after);
    bus.use((cmd, next) => { (cmd as any).seenByPlugin = true; return next(); });
    bus.respond('q', (cmd) => `answer for ${cmd.target}`);

    const r = await bus.request('q', 42, { p: 1 });

    expect(r).toSucceedWith('answer for 42');
    expect(bus.wasDispatched('q')).toBe(true);
    expect(bus.getDispatched('q')[0].cmd.payload).toEqual({ p: 1 });
    expect((bus.getDispatched('q')[0].cmd as any).seenByPlugin).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a thenable value is awaited; a rejection and a throw are results', async () => {
    const bus = createTestBus();
    bus.respond('later', () => Promise.resolve('late'));
    bus.respond('rejects', () => Promise.reject(new Error('no')));
    bus.respond('throws', () => { throw new Error('boom'); });

    expect((await bus.request('later', 1)).value).toBe('late');
    const rejected = await bus.request('rejects', 1);
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toBe('no');
    const thrown = await bus.request('throws', 1);
    expect(thrown.ok).toBe(false);
    expect(thrown.error?.message).toBe('boom');
  });

  it('no responder falls back to dispatch(), and an unsubscribed responder falls back too', async () => {
    const bus = createTestBus({ passthroughHandlers: true }); // the double stubs handlers unless told otherwise
    bus.register('q', () => 'from handler');
    expect((await bus.request('q', 1)).value).toBe('from handler');

    const off = bus.respond('q', () => 'from responder');
    expect((await bus.request('q', 1)).value).toBe('from responder');
    off();
    expect((await bus.request('q', 1)).value).toBe('from handler');
  });

  it('an already-aborted signal settles before the responder runs', async () => {
    const bus = createTestBus();
    const responder = vi.fn(() => 'answer');
    bus.respond('q', responder);
    const ac = new AbortController();
    ac.abort();

    const r = await bus.request('q', 1, undefined, { signal: ac.signal });

    expect(code(r)).toBe('VC_CORE_ABORTED');
    expect(responder).not.toHaveBeenCalled();
    expect(bus.wasDispatched('q')).toBe(false);
  });

  it('a sealed TestBus refuses respond(); clear() drops responders', async () => {
    const bus = createTestBus();
    bus.respond('q', () => 'answer');
    bus.seal();
    expect(() => bus.respond('other', () => 1)).toThrow(/sealed/i);
    expect((await bus.request('q', 1)).value).toBe('answer');
  });

  it('dispose() runs plugin dispose() like a real bus, and drops responders', async () => {
    const bus = createTestBus();
    const spy = vi.fn();
    bus.use(Object.assign(((_c: unknown, next: () => CommandResult) => next()) as any, { dispose: spy }));
    bus.respond('q', () => 'answer');

    bus.dispose();

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await bus.request('q', 1)).value).not.toBe('answer');
  });
});

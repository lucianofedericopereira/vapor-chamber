/** circuitBreaker: a cancel is not a backend failure (log s35.170). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { BusError, createAsyncCommandBus, type Command } from '../src/command-bus';
import { circuitBreaker, supersede } from '../src/plugins-extra';

/** A search handler that honours cmd.signal and answers after 20 ms. */
const search = (cmd: Command) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve('ok'), 20);
  cmd.signal?.addEventListener('abort', () => { clearTimeout(t); reject(cmd.signal!.reason); });
});

describe('circuitBreaker and cancels', () => {
  it('four quick searches under supersede leave it closed', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('search', search);
    const cb = circuitBreaker({ threshold: 3, actions: ['search'] });
    bus.use(cb, { priority: 10 });
    bus.use(supersede({ actions: ['search'] }), { priority: 5 });
    await Promise.all([1, 2, 3, 4].map(() => bus.dispatch('search', { q: 'x' })));
    expect(cb.getState('search')).toBe('closed');
    expect((await bus.dispatch('search', { q: 'x' })).ok).toBe(true);
  });

  it("the caller's own abort does not count", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('search', search);
    const cb = circuitBreaker({ threshold: 1, actions: ['search'] });
    bus.use(cb);
    const ac = new AbortController();
    const p = bus.dispatch('search', {}, undefined, { signal: ac.signal });
    ac.abort();
    expect((await p).ok).toBe(false);
    expect(cb.getState('search')).toBe('closed');
  });
});

describe('every abort shape', () => {
  it("a library aborted: code and a raw AbortError do not count", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let n = 0;
    bus.register('upload', async () => {
      n++;
      throw n === 1 ? new BusError('aborted:upload', 'cancelled') : new DOMException('stopped', 'AbortError');
    });
    const cb = circuitBreaker({ threshold: 1, actions: ['upload'] });
    bus.use(cb);
    await bus.dispatch('upload', {});
    await bus.dispatch('upload', {});
    expect([n, cb.getState('upload')]).toEqual([2, 'closed']);
  });

  it("the caller's abort with its own Error reason does not count", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('search', search);
    const cb = circuitBreaker({ threshold: 1, actions: ['search'] });
    bus.use(cb);
    const ac = new AbortController();
    const p = bus.dispatch('search', {}, undefined, { signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    expect((await p).ok).toBe(false);
    expect(cb.getState('search')).toBe('closed');
  });

  it('control: a real failure that lands after the abort still counts', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    bus.register('save', async () => { ac.abort(new Error('user cancelled')); throw new Error('HTTP 500'); });
    const cb = circuitBreaker({ threshold: 1, actions: ['save'] });
    bus.use(cb);
    await bus.dispatch('save', {}, undefined, { signal: ac.signal });
    expect(cb.getState('save')).toBe('open');
  });
});

describe('controls', () => {
  it('backend failures still open it', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => { throw new Error('HTTP 500'); });
    const cb = circuitBreaker({ threshold: 2, actions: ['save'] });
    bus.use(cb);
    await bus.dispatch('save', {});
    await bus.dispatch('save', {});
    expect(cb.getState('save')).toBe('open');
  });

  it("a plugin's throw (a bug) still does not count", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    const cb = circuitBreaker({ threshold: 1, actions: ['save'] });
    bus.use(cb, { priority: 10 });
    bus.use(Object.assign(() => { throw new Error('plugin bug'); }, { id: 'buggy' }), { priority: 5 });
    await bus.dispatch('save', {});
    expect(cb.getState('save')).toBe('closed');
  });
});

/*
 * The breaker protects against a failing backend, and it already skips a
 * pipeline bug (`_isBug`). It counted every other failure, so `supersede`,
 * built for a search box, cancelled three keystrokes and opened the circuit:
 * the next search was refused `circuitBreaker:limited:action` (audit B5,
 * probe P4). Polly's circuit breaker handles "Any exceptions other than
 * OperationCanceledException" by default. A failure whose condition is
 * `aborted` (every `aborted:` code, and a raw AbortError) now neither
 * counts nor resets the run of real failures, as a bug does. Log s35.170.
 */

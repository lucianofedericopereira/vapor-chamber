import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { getCommandBus, setCommandBus, resetCommandBus, useCommandBus } from '../src/chamber';

// ─── dispatchBatch ────────────────────────────────────────────────────────────

describe('dispatchBatch (sync)', () => {
  it('should return ok:true and all results when all commands succeed', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.register('b', () => 2);

    const result = bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
    ]);

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].value).toBe(1);
    expect(result.results[1].value).toBe(2);
  });

  it('should stop on first failure and return ok:false', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.register('b', () => { throw new Error('boom'); });
    bus.register('c', () => 3);

    const result = bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
      { action: 'c', target: {} },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('boom');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
  });

  it('should pass payload to handlers', () => {
    const bus = createCommandBus();
    bus.register('add', (cmd) => cmd.target.x + cmd.payload.y);

    const result = bus.dispatchBatch([
      { action: 'add', target: { x: 3 }, payload: { y: 4 } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.results[0].value).toBe(7);
  });
});

describe('dispatchBatch (async)', () => {
  it('should resolve ok:true when all commands succeed', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async () => 'x');
    bus.register('b', async () => 'y');

    const result = await bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
    ]);

    expect(result.ok).toBe(true);
    expect(result.results[0].value).toBe('x');
    expect(result.results[1].value).toBe('y');
  });

  it('should stop on first failure', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async () => { throw new Error('async-fail'); });

    const result = await bus.dispatchBatch([{ action: 'a', target: {} }]);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('async-fail');
  });
});

// ─── onMissing (dead letter handling) ────────────────────────────────────────

describe('onMissing option', () => {
  it("defaults to 'error' — returns { ok: false, error }", () => {
    const bus = createCommandBus();
    const result = bus.dispatch('no.handler', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('No handler');
  });

  it("'throw' — throws when no handler", () => {
    const bus = createCommandBus({ onMissing: 'throw' });

    expect(() => bus.dispatch('no.handler', {})).toThrow('No handler');
  });

  it("'ignore' — returns { ok: true, value: undefined }", () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const result = bus.dispatch('no.handler', {});

    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('custom function — uses its return value', () => {
    const bus = createCommandBus({
      onMissing: (cmd) => ({ ok: true, value: `fallback:${cmd.action}` }),
    });

    const result = bus.dispatch('no.handler', {});

    expect(result.ok).toBe(true);
    expect(result.value).toBe('fallback:no.handler');
  });

  it("async bus: 'throw' works the same", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });

    await expect(bus.dispatch('no.handler', {})).rejects.toThrow('No handler');
  });
});

// ─── Plugin priority ──────────────────────────────────────────────────────────

describe('plugin priority', () => {
  it('higher priority plugin runs first regardless of registration order', () => {
    const bus = createCommandBus();
    const order: string[] = [];

    bus.use((cmd, next) => { order.push('low'); return next(); }, { priority: 1 });
    bus.use((cmd, next) => { order.push('high'); return next(); }, { priority: 10 });

    bus.register('test', () => null);
    bus.dispatch('test', {});

    expect(order).toEqual(['high', 'low']);
  });

  it('equal priority preserves registration order', () => {
    const bus = createCommandBus();
    const order: string[] = [];

    bus.use((cmd, next) => { order.push('first'); return next(); }, { priority: 5 });
    bus.use((cmd, next) => { order.push('second'); return next(); }, { priority: 5 });

    bus.register('test', () => null);
    bus.dispatch('test', {});

    expect(order).toEqual(['first', 'second']);
  });

  it('default priority (0) runs after explicitly prioritized plugins', () => {
    const bus = createCommandBus();
    const order: string[] = [];

    bus.use((cmd, next) => { order.push('default'); return next(); });
    bus.use((cmd, next) => { order.push('priority'); return next(); }, { priority: 1 });

    bus.register('test', () => null);
    bus.dispatch('test', {});

    expect(order).toEqual(['priority', 'default']);
  });

  it('unsubscribing a prioritized plugin works correctly', () => {
    const bus = createCommandBus();
    const order: string[] = [];

    const unsub = bus.use((cmd, next) => { order.push('high'); return next(); }, { priority: 10 });
    bus.use((cmd, next) => { order.push('low'); return next(); }, { priority: 1 });

    bus.register('test', () => null);
    unsub();
    bus.dispatch('test', {});

    expect(order).toEqual(['low']);
  });
});

// ─── createTestBus ────────────────────────────────────────────────────────────

describe('createTestBus', () => {
  it('records dispatched commands', () => {
    const bus = createTestBus();
    bus.dispatch('cart.add', { id: 1 }, { qty: 2 });

    expect(bus.recorded).toHaveLength(1);
    expect(bus.recorded[0].cmd.action).toBe('cart.add');
    expect(bus.recorded[0].cmd.target).toEqual({ id: 1 });
    expect(bus.recorded[0].cmd.payload).toEqual({ qty: 2 });
  });

  it('stubs unregistered handlers with { ok: true }', () => {
    const bus = createTestBus();
    const result = bus.dispatch('any.action', {});

    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('wasDispatched returns true after matching dispatch', () => {
    const bus = createTestBus();
    bus.dispatch('cart.add', {});

    expect(bus.wasDispatched('cart.add')).toBe(true);
    expect(bus.wasDispatched('cart.remove')).toBe(false);
  });

  it('getDispatched filters by action', () => {
    const bus = createTestBus();
    bus.dispatch('cart.add', { id: 1 });
    bus.dispatch('cart.add', { id: 2 });
    bus.dispatch('user.login', {});

    const adds = bus.getDispatched('cart.add');
    expect(adds).toHaveLength(2);
    expect(adds[0].cmd.target).toEqual({ id: 1 });
    expect(adds[1].cmd.target).toEqual({ id: 2 });
  });

  it('clear empties the recorded list', () => {
    const bus = createTestBus();
    bus.dispatch('cart.add', {});
    bus.clear();

    expect(bus.recorded).toHaveLength(0);
    expect(bus.wasDispatched('cart.add')).toBe(false);
  });

  it('executes registered handlers when provided', () => {
    const bus = createTestBus();
    bus.register('cart.add', (cmd) => cmd.target.id * 10);

    const result = bus.dispatch('cart.add', { id: 5 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(50);
    expect(bus.wasDispatched('cart.add')).toBe(true);
  });

  it('records results from registered handlers', () => {
    const bus = createTestBus();
    bus.register('fail', () => { throw new Error('oops'); });

    bus.dispatch('fail', {});

    expect(bus.recorded[0].result.ok).toBe(false);
    expect(bus.recorded[0].result.error?.message).toBe('oops');
  });

  it('dispatchBatch records each command', () => {
    const bus = createTestBus();
    bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
    ]);

    expect(bus.wasDispatched('a')).toBe(true);
    expect(bus.wasDispatched('b')).toBe(true);
  });
});

// ─── useCommandBus ────────────────────────────────────────────────────────────

describe('useCommandBus', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('returns the shared bus', () => {
    const bus = useCommandBus();
    expect(bus).toBe(getCommandBus());
  });

  it('can dispatch via the returned bus', () => {
    const bus = useCommandBus();
    bus.register('test', () => 42);

    const result = bus.dispatch('test', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });
});

// ─── resetCommandBus ──────────────────────────────────────────────────────────

describe('resetCommandBus', () => {
  it('creates a fresh bus after reset', () => {
    const bus1 = getCommandBus();
    bus1.register('test', () => 'from-bus1');

    resetCommandBus();

    const bus2 = getCommandBus();
    expect(bus2).not.toBe(bus1);

    // Old handler should not exist on new bus
    const result = bus2.dispatch('test', {});
    expect(result.ok).toBe(false);
  });
});

// ─── Naming convention ────────────────────────────────────────────────────────

describe('naming convention', () => {
  it('warns on invalid action names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({
      naming: {
        pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,
        onViolation: 'warn',
      }
    });

    bus.register('cart.add', () => 'result'); // dots not allowed
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cart.add'));

    warn.mockRestore();
  });

  it('throws on invalid action names when configured', () => {
    const bus = createCommandBus({
      naming: {
        pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,
        onViolation: 'throw',
      }
    });

    expect(() => bus.register('CART_ADD', () => 'result')).toThrow();
  });

  it('accepts valid snake_case names', () => {
    const bus = createCommandBus({
      naming: {
        pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,
        onViolation: 'throw',
      }
    });

    expect(() => bus.register('shop_cart_item_added', () => 'result')).not.toThrow();
  });

  it('validates at dispatch time too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({
      naming: {
        pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,
        onViolation: 'warn',
      }
    });

    bus.dispatch('InvalidName', {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('InvalidName'));

    warn.mockRestore();
  });
});

// ─── Wildcard / pattern listeners ─────────────────────────────────────────────

describe('on() pattern listeners', () => {
  it('wildcard * listens to all actions', () => {
    const bus = createCommandBus();
    const heard: string[] = [];

    bus.on('*', (cmd) => heard.push(cmd.action));
    bus.register('shopCartAdd', () => null);
    bus.register('uiToast', () => null);

    bus.dispatch('shopCartAdd', {});
    bus.dispatch('uiToast', {});

    expect(heard).toEqual(['shopCartAdd', 'uiToast']);
  });

  it('prefix* matches namespace', () => {
    const bus = createCommandBus();
    const heard: string[] = [];

    bus.on('shop*', (cmd) => heard.push(cmd.action));
    bus.register('shopCartAdd', () => null);
    bus.register('shopFilterApplied', () => null);
    bus.register('uiToast', () => null);

    bus.dispatch('shopCartAdd', {});
    bus.dispatch('shopFilterApplied', {});
    bus.dispatch('uiToast', {});

    expect(heard).toEqual(['shopCartAdd', 'shopFilterApplied']);
  });

  it('exact match works', () => {
    const bus = createCommandBus();
    const heard: string[] = [];

    bus.on('shopCartAdd', (cmd) => heard.push(cmd.action));
    bus.register('shopCartAdd', () => null);
    bus.register('shopCartRemove', () => null);

    bus.dispatch('shopCartAdd', {});
    bus.dispatch('shopCartRemove', {});

    expect(heard).toEqual(['shopCartAdd']);
  });

  it('unsubscribe stops listening', () => {
    const bus = createCommandBus();
    const heard: string[] = [];

    const unsub = bus.on('*', (cmd) => heard.push(cmd.action));
    bus.register('testAction', () => null);

    bus.dispatch('testAction', {});
    unsub();
    bus.dispatch('testAction', {});

    expect(heard).toEqual(['testAction']);
  });
});

// ─── Request / Response ───────────────────────────────────────────────────────

describe('request/respond', () => {
  it('request gets response from responder', async () => {
    const bus = createCommandBus();

    bus.respond('paymentGetToken', (cmd) => {
      return { token: 'tok_123', amount: cmd.target.amount };
    });

    const result = await bus.request('paymentGetToken', { amount: 100 });

    expect(result.ok).toBe(true);
    expect(result.value.token).toBe('tok_123');
  });

  it('request falls back to dispatch when no responder', async () => {
    const bus = createCommandBus();
    bus.register('testAction', (cmd) => cmd.target.value * 2);

    const result = await bus.request('testAction', { value: 5 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
  });

  it('request times out', async () => {
    const bus = createCommandBus();

    bus.respond('slowAction', async () => {
      return new Promise((resolve) => setTimeout(() => resolve('done'), 200));
    });

    const result = await bus.request('slowAction', {}, undefined, { timeout: 50 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('timed out');
  });

  it('respond can be unsubscribed', async () => {
    const bus = createCommandBus();
    bus.register('testAction', () => 'from_handler');

    const unsub = bus.respond('testAction', () => 'from_responder');

    let result = await bus.request('testAction', {});
    expect(result.value).toBe('from_responder');

    unsub();

    result = await bus.request('testAction', {});
    expect(result.value).toBe('from_handler'); // falls back to dispatch
  });
});

// ─── Undo handlers ────────────────────────────────────────────────────────────

describe('register with undo handler', () => {
  it('stores and retrieves undo handler', () => {
    const bus = createCommandBus();
    const undoFn = vi.fn();

    bus.register('cartAdd', () => 'added', { undo: undoFn });

    const handler = bus.getUndoHandler('cartAdd');
    expect(handler).toBe(undoFn);
  });

  it('undo handler removed on unregister', () => {
    const bus = createCommandBus();

    const unsub = bus.register('cartAdd', () => 'added', { undo: () => {} });
    unsub();

    expect(bus.getUndoHandler('cartAdd')).toBeUndefined();
  });
});

// ─── Per-command throttle ─────────────────────────────────────────────────────

describe('per-command throttle at register time', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('throttles handler execution', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.register('fastAction', handler, { throttle: 100 });

    const r1 = bus.dispatch('fastAction', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(r1.value).toBe('result');

    const r2 = bus.dispatch('fastAction', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(r2.ok).toBe(false);
    expect(r2.error?.message).toBe('throttled');
    expect((r2.error as any)?.retryIn).toBeGreaterThan(0);

    vi.advanceTimersByTime(100);

    const r3 = bus.dispatch('fastAction', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ─── SSR concurrency (independent bus instances, no state bleed) ─────────────

describe('SSR concurrency — createCommandBus isolation', () => {
  it('two independent buses do not share handlers', () => {
    const busA = createCommandBus();
    const busB = createCommandBus();

    busA.register('userLogin', () => 'session-A');
    busB.register('userLogin', () => 'session-B');

    const rA = busA.dispatch('userLogin', {});
    const rB = busB.dispatch('userLogin', {});

    expect(rA.value).toBe('session-A');
    expect(rB.value).toBe('session-B');
  });

  it('plugins installed on bus A do not affect bus B', () => {
    const log: string[] = [];
    const busA = createCommandBus();
    const busB = createCommandBus();

    busA.use((cmd, next) => { log.push(`A:${cmd.action}`); return next(); });
    busA.register('ping', () => null);
    busB.register('ping', () => null);

    busA.dispatch('ping', {});
    busB.dispatch('ping', {});

    expect(log).toEqual(['A:ping']); // B's dispatch never touches A's plugin
  });

  it('concurrent async dispatches on separate buses resolve independently', async () => {
    const busA = createAsyncCommandBus();
    const busB = createAsyncCommandBus();

    busA.register('fetch', async () => 'data-A');
    busB.register('fetch', async () => 'data-B');

    const [rA, rB] = await Promise.all([
      busA.dispatch('fetch', {}),
      busB.dispatch('fetch', {}),
    ]);

    expect(rA.value).toBe('data-A');
    expect(rB.value).toBe('data-B');
  });

  it('setCommandBus + resetCommandBus prevent handler bleed between requests', () => {
    // Simulate two SSR requests each setting their own bus
    const requestBusA = createCommandBus();
    const requestBusB = createCommandBus();

    requestBusA.register('getUser', () => ({ id: 1, name: 'Alice' }));
    requestBusB.register('getUser', () => ({ id: 2, name: 'Bob' }));

    // Request A
    setCommandBus(requestBusA);
    const resultA = getCommandBus().dispatch('getUser', {});
    resetCommandBus();

    // Request B
    setCommandBus(requestBusB);
    const resultB = getCommandBus().dispatch('getUser', {});
    resetCommandBus();

    expect(resultA.value).toEqual({ id: 1, name: 'Alice' });
    expect(resultB.value).toEqual({ id: 2, name: 'Bob' });
  });
});

// ---------------------------------------------------------------------------
// createTestBus — snapshot & time-travel
// ---------------------------------------------------------------------------

describe('createTestBus snapshot and time-travel', () => {
  it('snapshot returns a serializable copy', () => {
    const bus = createTestBus();
    bus.dispatch('a', { x: 1 });
    bus.dispatch('b', { x: 2 });

    const snap = bus.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0].cmd.action).toBe('a');

    snap.pop();
    expect(bus.recorded).toHaveLength(2);
  });

  it('snapshot is deep-equal to recorded but not the same reference', () => {
    const bus = createTestBus();
    bus.dispatch('cmd', { val: 42 }, { extra: true });

    const snap = bus.snapshot();
    expect(snap[0]).toEqual(bus.recorded[0]);
    expect(snap[0]).not.toBe(bus.recorded[0]);
  });

  it('travelTo returns commands from 0 to index inclusive', () => {
    const bus = createTestBus();
    bus.dispatch('a', {}); bus.dispatch('b', {}); bus.dispatch('c', {}); bus.dispatch('d', {});

    expect(bus.travelTo(2).map(c => c.action)).toEqual(['a', 'b', 'c']);
  });

  it('travelTo(0) returns only the first command', () => {
    const bus = createTestBus();
    bus.dispatch('first', {}); bus.dispatch('second', {});

    expect(bus.travelTo(0).map(c => c.action)).toEqual(['first']);
  });

  it('travelTo clamps to valid range', () => {
    const bus = createTestBus();
    bus.dispatch('only', {});

    expect(bus.travelTo(100).map(c => c.action)).toEqual(['only']);
    expect(bus.travelTo(-5).map(c => c.action)).toEqual(['only']);
  });

  it('travelToAction returns all commands up to last occurrence', () => {
    const bus = createTestBus();
    bus.dispatch('login', {}); bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 }); bus.dispatch('checkout', {});

    expect(bus.travelToAction('cartAdd').map(c => c.action)).toEqual(['login', 'cartAdd', 'cartAdd']);
  });

  it('travelToAction returns empty array if action was never dispatched', () => {
    const bus = createTestBus();
    bus.dispatch('something', {});
    expect(bus.travelToAction('never')).toEqual([]);
  });
});

// ─── hasHandler ───────────────────────────────────────────────────────────────

describe('bus.hasHandler', () => {
  it('returns false before register', () => {
    const bus = createCommandBus();
    expect(bus.hasHandler('foo')).toBe(false);
  });

  it('returns true after register', () => {
    const bus = createCommandBus();
    bus.register('foo', () => null);
    expect(bus.hasHandler('foo')).toBe(true);
  });

  it('returns false after unregister', () => {
    const bus = createCommandBus();
    const unsub = bus.register('foo', () => null);
    unsub();
    expect(bus.hasHandler('foo')).toBe(false);
  });

  it('works on async bus', async () => {
    const bus = createAsyncCommandBus();
    expect(bus.hasHandler('bar')).toBe(false);
    bus.register('bar', async () => null);
    expect(bus.hasHandler('bar')).toBe(true);
  });
});

// ─── dispatchBatch continueOnError ────────────────────────────────────────────

describe('dispatchBatch continueOnError', () => {
  it('processes all commands even when some fail', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.register('b', () => { throw new Error('boom'); });
    bus.register('c', () => 3);

    const result = bus.dispatchBatch(
      [{ action: 'a', target: {} }, { action: 'b', target: {} }, { action: 'c', target: {} }],
      { continueOnError: true }
    );

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[2].ok).toBe(true);
    expect(result.error?.message).toBe('boom');
  });

  it('async bus continueOnError processes all commands', async () => {
    const bus = createAsyncCommandBus();
    bus.register('x', async () => 'ok');
    bus.register('y', async () => { throw new Error('fail'); });
    bus.register('z', async () => 'done');

    const result = await bus.dispatchBatch(
      [{ action: 'x', target: {} }, { action: 'y', target: {} }, { action: 'z', target: {} }],
      { continueOnError: true }
    );

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results[2].value).toBe('done');
  });
});

// ─── register overwrite warning ───────────────────────────────────────────────

describe('register overwrite warning', () => {
  it('warns when registering the same action twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();

    bus.register('someAction', () => 'first');
    bus.register('someAction', () => 'second');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('someAction'));
    warn.mockRestore();
  });

  it('does not warn on first registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();

    bus.register('freshAction', () => null);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── bus.clear() ──────────────────────────────────────────────────────────────

describe('bus.clear() (sync)', () => {
  it('removes all handlers', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.clear();

    const result = bus.dispatch('a', {});
    expect(result.ok).toBe(false); // no handler → dead letter
  });

  it('removes plugins', () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.use((cmd, next) => { seen.push(cmd.action); return next(); });
    bus.register('a', () => null);
    bus.clear();

    bus.register('a', () => null);
    bus.dispatch('a', {});
    expect(seen).toHaveLength(0);
  });

  it('removes onAfter hooks', () => {
    const bus = createCommandBus();
    const fired: string[] = [];
    bus.onAfter((cmd) => fired.push(cmd.action));
    bus.register('a', () => null);
    bus.clear();

    bus.register('a', () => null);
    bus.dispatch('a', {});
    expect(fired).toHaveLength(0);
  });

  it('removes pattern listeners', () => {
    const bus = createCommandBus();
    const heard: string[] = [];
    bus.on('*', (cmd) => heard.push(cmd.action));
    bus.register('a', () => null);
    bus.clear();

    bus.register('a', () => null);
    bus.dispatch('a', {});
    expect(heard).toHaveLength(0);
  });
});

describe('bus.clear() (async)', () => {
  it('removes all handlers and plugins', async () => {
    const bus = createAsyncCommandBus();
    const seen: string[] = [];
    bus.use(async (cmd, next) => { seen.push(cmd.action); return next(); });
    bus.register('a', async () => 1);
    bus.clear();

    bus.register('a', async () => 2);
    const result = await bus.dispatch('a', {});
    expect(result.value).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

// ─── async bus on / request / respond ─────────────────────────────────────────

describe('async bus — on() pattern listeners', () => {
  it('wildcard * receives all dispatches', async () => {
    const bus = createAsyncCommandBus();
    const heard: string[] = [];

    bus.on('*', (cmd) => heard.push(cmd.action));
    bus.register('taskRun', async () => 'done');
    bus.register('taskCancel', async () => 'cancelled');

    await bus.dispatch('taskRun', {});
    await bus.dispatch('taskCancel', {});

    expect(heard).toEqual(['taskRun', 'taskCancel']);
  });

  it('prefix* matches namespace on async bus', async () => {
    const bus = createAsyncCommandBus();
    const heard: string[] = [];

    bus.on('task*', (cmd) => heard.push(cmd.action));
    bus.register('taskRun', async () => null);
    bus.register('uiRefresh', async () => null);

    await bus.dispatch('taskRun', {});
    await bus.dispatch('uiRefresh', {});

    expect(heard).toEqual(['taskRun']);
  });

  it('unsubscribe stops async listener', async () => {
    const bus = createAsyncCommandBus();
    const heard: string[] = [];

    const unsub = bus.on('*', (cmd) => heard.push(cmd.action));
    bus.register('ping', async () => null);

    await bus.dispatch('ping', {});
    unsub();
    await bus.dispatch('ping', {});

    expect(heard).toEqual(['ping']);
  });
});

describe('async bus — request/respond', () => {
  it('gets response from async responder', async () => {
    const bus = createAsyncCommandBus();

    bus.respond('dataFetch', async (cmd) => ({ rows: cmd.target.limit }));

    const result = await bus.request('dataFetch', { limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.value.rows).toBe(10);
  });

  it('falls back to dispatch when no responder on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('ping', async () => 'pong');

    const result = await bus.request('ping', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('pong');
  });

  it('respond can be unsubscribed on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('ping', async () => 'handler');

    const unsub = bus.respond('ping', async () => 'responder');

    let result = await bus.request('ping', {});
    expect(result.value).toBe('responder');

    unsub();
    result = await bus.request('ping', {});
    expect(result.value).toBe('handler');
  });

  it('request times out on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.respond('slow', async () => new Promise((resolve) => setTimeout(() => resolve('done'), 500)));

    const result = await bus.request('slow', {}, undefined, { timeout: 50 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('timed out');
  });
});

// ─── TestBus — plugin, onAfter, stubs ─────────────────────────────────────────

describe('createTestBus — plugin and hook support', () => {
  it('use(plugin) intercepts dispatches', () => {
    const bus = createTestBus();
    const seen: string[] = [];

    bus.use((cmd, next) => { seen.push(cmd.action); return next(); });
    bus.dispatch('hello', {});

    expect(seen).toEqual(['hello']);
  });

  it('unsubscribing plugin removes it', () => {
    const bus = createTestBus();
    const seen: string[] = [];

    const unsub = bus.use((cmd, next) => { seen.push(cmd.action); return next(); });
    unsub();
    bus.dispatch('hello', {});

    expect(seen).toHaveLength(0);
  });

  it('onAfter hook fires after dispatch', () => {
    const bus = createTestBus();
    const after: string[] = [];

    bus.onAfter((cmd) => after.push(cmd.action));
    bus.dispatch('ping', {});

    expect(after).toEqual(['ping']);
  });

  it('unsubscribing onAfter stops hook', () => {
    const bus = createTestBus();
    const after: string[] = [];

    const unsub = bus.onAfter((cmd) => after.push(cmd.action));
    unsub();
    bus.dispatch('ping', {});

    expect(after).toHaveLength(0);
  });

  it('on() stub returns unsubscribe without throwing', () => {
    const bus = createTestBus();
    const unsub = bus.on('*', () => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('request() stub resolves through dispatch', async () => {
    const bus = createTestBus();
    bus.register('ping', () => 'pong');

    const result = await bus.request('ping', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('pong');
  });

  it('respond() stub returns unsubscribe without throwing', () => {
    const bus = createTestBus();
    const unsub = bus.respond('action', () => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('getUndoHandler() returns handler registered with undo option', () => {
    const bus = createTestBus();
    const undoFn = vi.fn();

    bus.register('cartAdd', () => null, { undo: undoFn });
    expect(bus.getUndoHandler('cartAdd')).toBe(undoFn);
  });

  it('getUndoHandler() returns undefined when none registered', () => {
    const bus = createTestBus();
    bus.register('cartAdd', () => null);
    expect(bus.getUndoHandler('cartAdd')).toBeUndefined();
  });

  it('unregistering handler removes undo handler too', () => {
    const bus = createTestBus();
    const unsub = bus.register('cartAdd', () => null, { undo: () => {} });
    unsub();
    expect(bus.getUndoHandler('cartAdd')).toBeUndefined();
  });

  it('hasHandler() works on TestBus', () => {
    const bus = createTestBus();
    expect(bus.hasHandler('x')).toBe(false);
    bus.register('x', () => null);
    expect(bus.hasHandler('x')).toBe(true);
  });
});

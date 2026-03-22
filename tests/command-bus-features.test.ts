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

// ─── once() ───────────────────────────────────────────────────────────────────

describe('once() — sync bus', () => {
  it('fires exactly once and then auto-unsubscribes', () => {
    const bus = createCommandBus();
    bus.register('ping', () => null);
    const heard: string[] = [];

    bus.once('ping', (cmd) => heard.push(cmd.action));

    bus.dispatch('ping', {});
    bus.dispatch('ping', {});
    bus.dispatch('ping', {});

    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe('ping');
  });

  it('returned unsub cancels before it fires', () => {
    const bus = createCommandBus();
    bus.register('ping', () => null);
    const heard: string[] = [];

    const unsub = bus.once('ping', () => heard.push('fired'));
    unsub();
    bus.dispatch('ping', {});

    expect(heard).toHaveLength(0);
  });

  it('wildcard once fires only on the first matching action', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => null);
    bus.register('cartRemove', () => null);
    const heard: string[] = [];

    bus.once('cart*', (cmd) => heard.push(cmd.action));

    bus.dispatch('cartAdd', {});
    bus.dispatch('cartRemove', {});

    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe('cartAdd');
  });
});

describe('once() — async bus', () => {
  it('fires exactly once on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('ping', async () => null);
    const heard: string[] = [];

    bus.once('ping', (cmd) => heard.push(cmd.action));

    await bus.dispatch('ping', {});
    await bus.dispatch('ping', {});

    expect(heard).toHaveLength(1);
  });
});

describe('once() — mutation-during-iteration safety', () => {
  it('does not skip the next listener when multiple once() share the same pattern', () => {
    const bus = createCommandBus();
    bus.register('ping', () => null);
    const heard: number[] = [];

    bus.once('ping', () => heard.push(1));
    bus.once('ping', () => heard.push(2));
    bus.once('ping', () => heard.push(3));

    bus.dispatch('ping', {});

    // All three must fire on the first dispatch — none skipped during splice
    expect(heard).toEqual([1, 2, 3]);

    // None fire on subsequent dispatches
    bus.dispatch('ping', {});
    expect(heard).toHaveLength(3);
  });

  it('TestBus.on() fires listeners on dispatch', () => {
    const bus = createTestBus();
    const heard: string[] = [];

    bus.on('cartAdd', (cmd) => heard.push(cmd.action));
    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 });

    expect(heard).toEqual(['cartAdd', 'cartAdd']);
  });

  it('TestBus.once() fires exactly once', () => {
    const bus = createTestBus();
    const heard: string[] = [];

    bus.once('cartAdd', (cmd) => heard.push(cmd.action));
    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 });

    expect(heard).toHaveLength(1);
  });

  it('TestBus.clear() resets patternListeners', () => {
    const bus = createTestBus();
    const heard: string[] = [];

    bus.on('*', () => heard.push('fired'));
    bus.clear();
    bus.dispatch('anything', {});

    expect(heard).toHaveLength(0);
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

  it('passthroughHandlers: true still executes registered handlers', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('ping', () => 'pong');
    const result = bus.dispatch('ping', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('pong');
  });

  it('dispatchBatch stops on first failure and returns error', () => {
    const bus = createTestBus();
    bus.register('ok', () => 'fine');
    bus.register('fail', () => { throw new Error('batch-fail'); });

    const result = bus.dispatchBatch([
      { action: 'ok', target: {} },
      { action: 'fail', target: {} },
      { action: 'ok', target: {} },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('batch-fail');
    expect(result.results).toHaveLength(2); // stopped after failure
  });
});

// ─── naming convention: onViolation defaults to 'warn' (line 167) ────────────

describe('naming convention onViolation defaults to warn', () => {
  it("warns when onViolation is omitted (defaults to 'warn')", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({
      naming: { pattern: /^[a-z]+$/ }, // no onViolation — should default to 'warn'
    });
    bus.dispatch('INVALID', {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('INVALID'));
    warn.mockRestore();
  });
});

// ─── naming convention: 'ignore' mode ────────────────────────────────────────

describe("naming convention onViolation: 'ignore'", () => {
  it('silently allows invalid names without warning or throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({
      naming: { pattern: /^[a-z]+$/, onViolation: 'ignore' },
    });

    expect(() => bus.register('INVALID_NAME', () => null)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── wrapThrottle: circular ref safety ────────────────────────────────────────

describe('wrapThrottle circular-ref target', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('handles circular-reference target without throwing', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'ok');
    bus.register('circAction', handler, { throttle: 100 });

    const circular: any = { self: null };
    circular.self = circular;

    const r1 = bus.dispatch('circAction', circular);
    expect(r1.ok).toBe(true);

    const r2 = bus.dispatch('circAction', circular);
    expect(r2.ok).toBe(false);
    expect(r2.error?.message).toBe('throttled');
  });
});

// ─── async onMissing: 'ignore' and function modes ─────────────────────────────

describe("async bus onMissing extended", () => {
  it("'ignore' returns { ok: true } on async bus", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    const result = await bus.dispatch('noop', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('custom function used as fallback on async bus', async () => {
    const bus = createAsyncCommandBus({
      onMissing: (cmd) => ({ ok: true, value: `fallback:${cmd.action}` }),
    });
    const result = await bus.dispatch('missing', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('fallback:missing');
  });

  it('custom function that throws is caught on async bus', async () => {
    const bus = createAsyncCommandBus({
      onMissing: () => { throw new Error('dead-letter-boom'); },
    });
    const result = await bus.dispatch('missing', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('dead-letter-boom');
  });
});

// ─── syncRequest: plugin that throws ─────────────────────────────────────────

describe('syncRequest with throwing plugin', () => {
  it('resolves { ok: false } when plugin throws during request', async () => {
    const bus = createCommandBus();
    bus.respond('qa', () => 'answer');
    bus.use(() => { throw new Error('plugin-kaboom'); });

    const result = await bus.request('qa', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('plugin-kaboom');
  });
});

// ─── syncUse: async plugin warning ───────────────────────────────────────────

describe('syncUse async plugin warning', () => {
  it('warns when async function installed on sync bus', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.use(async (cmd, next) => next());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Async plugin'));
    warn.mockRestore();
  });
});

// ─── async bus: missing handler default 'error' (line 421) ────────────────────

describe('async bus default onMissing', () => {
  it("returns { ok: false } when no handler and no onMissing option", async () => {
    const bus = createAsyncCommandBus(); // default = 'error'
    const result = await bus.dispatch('neverRegistered', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('No handler');
  });
});

// ─── async register overwrite warning (line 460) ─────────────────────────────

describe('async register overwrite warning', () => {
  it('warns when registering the same action twice on async bus', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('ping', async () => 'first');
    bus.register('ping', async () => 'second');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ping'));
    warn.mockRestore();
  });
});

// ─── async request: responder that throws (line 494) ─────────────────────────

describe('async request with throwing responder', () => {
  it('returns { ok: false } when async responder throws', async () => {
    const bus = createAsyncCommandBus();
    bus.respond('boom', async () => { throw new Error('responder-boom'); });
    const result = await bus.request('boom', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('responder-boom');
  });
});

// ─── async bus getUndoHandler (line 551) ──────────────────────────────────────

describe('async bus getUndoHandler', () => {
  it('stores and retrieves undo handler on async bus', () => {
    const bus = createAsyncCommandBus();
    const undoFn = vi.fn();
    bus.register('cartAdd', async () => 'added', { undo: undoFn });
    expect(bus.getUndoHandler('cartAdd')).toBe(undoFn);
  });

  it('returns undefined when no undo handler on async bus', () => {
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 'added');
    expect(bus.getUndoHandler('cartAdd')).toBeUndefined();
  });
});

// ─── TestBus: passthroughHandlers throwing handler (line 107) ────────────────

describe('createTestBus passthroughHandlers error path', () => {
  it('catches throwing handler with passthroughHandlers: true', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('fail', () => { throw new Error('passthrough-fail'); });
    const result = bus.dispatch('fail', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('passthrough-fail');
  });
});

// ─── TestBus: afterHook silent catch (line 125) ───────────────────────────────

describe('createTestBus afterHook silent catch', () => {
  it('catches hook errors and logs them without interrupting dispatch', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createTestBus();
    bus.onAfter(() => { throw new Error('hook-boom'); });
    const result = bus.dispatch('ping', {});
    expect(result.ok).toBe(true); // dispatch still succeeds
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[vapor-chamber/test]'),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

// ─── TestBus: double-unsub guard (lines 159, 167) ────────────────────────────

describe('createTestBus double-unsub is a no-op', () => {
  it('calling use() unsub twice does not throw', () => {
    const bus = createTestBus();
    const unsub = bus.use((cmd, next) => next());
    unsub();
    expect(() => unsub()).not.toThrow(); // i === -1 on second call
  });

  it('calling onAfter() unsub twice does not throw', () => {
    const bus = createTestBus();
    const unsub = bus.onAfter(() => {});
    unsub();
    expect(() => unsub()).not.toThrow(); // i === -1 on second call
  });
});

// ─── sync onMissing function that throws (line 236) ──────────────────────────

describe('sync onMissing function catch', () => {
  it('returns { ok: false } when onMissing function throws on sync bus', () => {
    const bus = createCommandBus({
      onMissing: () => { throw new Error('sync-dead-letter-boom'); },
    });
    const result = bus.dispatch('missing', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('sync-dead-letter-boom');
  });
});

// ─── syncRequest: responder that throws (line 322) ───────────────────────────

describe('syncRequest responder catch', () => {
  it('returns { ok: false } when responder throws synchronously', async () => {
    const bus = createCommandBus();
    bus.respond('qa', () => { throw new Error('responder-throw'); });
    const result = await bus.request('qa', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('responder-throw');
  });
});

// ─── sync dispatchBatch: multiple failures with continueOnError (line 268) ────

describe('sync dispatchBatch continueOnError multiple failures', () => {
  it('only records the first error when multiple commands fail', () => {
    const bus = createCommandBus();
    bus.register('a', () => { throw new Error('first-fail'); });
    bus.register('b', () => { throw new Error('second-fail'); });
    bus.register('c', () => 'ok');

    const result = bus.dispatchBatch(
      [{ action: 'a', target: {} }, { action: 'b', target: {} }, { action: 'c', target: {} }],
      { continueOnError: true }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('first-fail');
    expect(result.results).toHaveLength(3);
    expect(result.results[2].value).toBe('ok');
  });
});

// ─── sync bus double-unsub guard (lines 293-304) ─────────────────────────────

describe('sync bus double-unsub is a no-op', () => {
  it('use() unsub called twice does not throw', () => {
    const bus = createCommandBus();
    const unsub = bus.use((cmd, next) => next());
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('onAfter() unsub called twice does not throw', () => {
    const bus = createCommandBus();
    const unsub = bus.onAfter(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('on() unsub called twice does not throw', () => {
    const bus = createCommandBus();
    const unsub = bus.on('*', () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ─── async dispatchBatch: multiple failures with continueOnError (line 451) ───

describe('async dispatchBatch continueOnError multiple failures', () => {
  it('only records the first error when multiple commands fail', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async () => { throw new Error('first-fail'); });
    bus.register('b', async () => { throw new Error('second-fail'); });
    bus.register('c', async () => 'ok');

    const result = await bus.dispatchBatch(
      [{ action: 'a', target: {} }, { action: 'b', target: {} }, { action: 'c', target: {} }],
      { continueOnError: true }
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('first-fail'); // first error wins
    expect(result.results).toHaveLength(3);
    expect(result.results[2].value).toBe('ok'); // still ran
  });
});

// ─── async register with throttle (line 463) ─────────────────────────────────

describe('async register with throttle option', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('throttles handler on async bus', async () => {
    const bus = createAsyncCommandBus();
    const handler = vi.fn(async () => 'result');
    bus.register('fastAsync', handler, { throttle: 100 });

    const r1 = await bus.dispatch('fastAsync', { id: 1 });
    expect(r1.ok).toBe(true);

    const r2 = await bus.dispatch('fastAsync', { id: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.error?.message).toBe('throttled');
  });
});

// ─── async bus double-unsub guard (lines 473-484) ────────────────────────────

describe('async bus double-unsub is a no-op', () => {
  it('use() unsub called twice does not throw', async () => {
    const bus = createAsyncCommandBus();
    const unsub = bus.use(async (cmd, next) => next());
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('onAfter() unsub called twice does not throw', async () => {
    const bus = createAsyncCommandBus();
    const unsub = bus.onAfter(async () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('on() unsub called twice does not throw', async () => {
    const bus = createAsyncCommandBus();
    const unsub = bus.on('*', () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ─── syncRequest: async responder .then / .catch (lines 337-338) ─────────────

describe('syncRequest async responder', () => {
  it('resolves with value when async responder resolves', async () => {
    const bus = createCommandBus();
    bus.respond('async', () => Promise.resolve('async-result'));
    const result = await bus.request('async', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('async-result');
  });

  it('returns { ok: false } when async responder rejects', async () => {
    const bus = createCommandBus();
    bus.respond('async', () => Promise.reject(new Error('async-reject')));
    const result = await bus.request('async', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('async-reject');
  });
});

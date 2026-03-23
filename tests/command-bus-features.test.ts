import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, createCommandPool, commandKey, unsealBus, inspectBus, BusError } from '../src/command-bus';
import { optimisticUndo } from '../src/plugins-core';
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
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('cart.add', (cmd) => cmd.target.id * 10);

    const result = bus.dispatch('cart.add', { id: 5 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(50);
    expect(bus.wasDispatched('cart.add')).toBe(true);
  });

  it('records results from registered handlers', () => {
    const bus = createTestBus({ passthroughHandlers: true });
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
    expect(r2.error?.message).toContain('throttled');
    expect((r2.error as any)?.context?.retryIn).toBeGreaterThan(0);

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
    const bus = createTestBus({ passthroughHandlers: true });
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
    const bus = createTestBus({ passthroughHandlers: true });
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
    expect(r2.error?.message).toContain('throttled');
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
    expect(r2.error?.message).toContain('throttled');
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

// ─── Command.meta ──────────────────────────────────────────────────────────────

describe('Command.meta — auto-stamped metadata', () => {
  it('stamps meta.ts and meta.id on every dispatch', () => {
    const bus = createCommandBus();
    let captured: any;
    bus.register('test', (cmd) => { captured = cmd; return 'ok'; });
    bus.dispatch('test', { id: 1 });
    expect(captured.meta).toBeDefined();
    expect(typeof captured.meta.ts).toBe('number');
    expect(typeof captured.meta.id).toBe('string');
    expect(captured.meta.id.length).toBeGreaterThan(0);
  });

  it('each dispatch gets a unique meta.id', () => {
    const bus = createCommandBus();
    const ids: string[] = [];
    bus.register('test', (cmd) => { ids.push(cmd.meta!.id); });
    bus.dispatch('test', {});
    bus.dispatch('test', {});
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('propagates __correlationId and __causationId from payload', () => {
    const bus = createCommandBus();
    let captured: any;
    bus.register('test', (cmd) => { captured = cmd; });
    bus.dispatch('test', {}, { __correlationId: 'corr-1', __causationId: 'cause-1' });
    expect(captured.meta.correlationId).toBe('corr-1');
    expect(captured.meta.causationId).toBe('cause-1');
  });

  it('stamps meta on async dispatch', async () => {
    const bus = createAsyncCommandBus();
    let captured: any;
    bus.register('test', async (cmd) => { captured = cmd; return 'ok'; });
    await bus.dispatch('test', {});
    expect(captured.meta).toBeDefined();
    expect(typeof captured.meta.ts).toBe('number');
    expect(typeof captured.meta.id).toBe('string');
  });
});

// ─── bus.query() ─────────────────────────────────────────────────────────────

describe('bus.query() — read-only dispatch', () => {
  it('executes handler and returns result', () => {
    const bus = createCommandBus();
    bus.register('getUser', (cmd) => ({ name: 'Dev', id: cmd.target.id }));
    const result = bus.query('getUser', { id: 42 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ name: 'Dev', id: 42 });
  });

  it('skips beforeHooks (no mutation gating)', () => {
    const bus = createCommandBus();
    const beforeCalls: string[] = [];
    bus.onBefore((cmd) => { beforeCalls.push(cmd.action); });
    bus.register('getUser', () => 'data');
    bus.query('getUser', {});
    expect(beforeCalls).toEqual([]); // beforeHook NOT called
  });

  it('still fires afterHooks and on() listeners', () => {
    const bus = createCommandBus();
    const afterCalls: string[] = [];
    const onCalls: string[] = [];
    bus.onAfter((cmd) => { afterCalls.push(cmd.action); });
    bus.on('*', (cmd) => { onCalls.push(cmd.action); });
    bus.register('getUser', () => 'data');
    bus.query('getUser', {});
    expect(afterCalls).toEqual(['getUser']);
    expect(onCalls).toEqual(['getUser']);
  });

  it('runs through plugin pipeline', () => {
    const bus = createCommandBus();
    const pluginCalls: string[] = [];
    bus.use((cmd, next) => { pluginCalls.push(cmd.action); return next(); });
    bus.register('getUser', () => 'data');
    bus.query('getUser', {});
    expect(pluginCalls).toEqual(['getUser']);
  });

  it('works on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('getUser', async () => 'async-data');
    const result = await bus.query('getUser', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('async-data');
  });

  it('async query skips beforeHooks', async () => {
    const bus = createAsyncCommandBus();
    const beforeCalls: string[] = [];
    bus.onBefore(async (cmd) => { beforeCalls.push(cmd.action); });
    bus.register('getUser', async () => 'data');
    await bus.query('getUser', {});
    expect(beforeCalls).toEqual([]);
  });
});

// ─── bus.emit() ─────────────────────────────────────────────────────────────

describe('bus.emit() — domain events', () => {
  it('notifies on() listeners without requiring a handler', () => {
    const bus = createCommandBus();
    const events: string[] = [];
    bus.on('orderCreated', (cmd) => { events.push(cmd.action); });
    bus.emit('orderCreated', { orderId: 42 });
    expect(events).toEqual(['orderCreated']);
  });

  it('notifies wildcard listeners', () => {
    const bus = createCommandBus();
    const events: string[] = [];
    bus.on('order*', (cmd) => { events.push(cmd.action); });
    bus.emit('orderCreated', { orderId: 1 });
    bus.emit('orderShipped', { orderId: 2 });
    expect(events).toEqual(['orderCreated', 'orderShipped']);
  });

  it('passes data as cmd.target', () => {
    const bus = createCommandBus();
    let captured: any;
    bus.on('orderCreated', (cmd) => { captured = cmd.target; });
    bus.emit('orderCreated', { orderId: 42, total: 99 });
    expect(captured).toEqual({ orderId: 42, total: 99 });
  });

  it('does not throw when no listeners registered', () => {
    const bus = createCommandBus();
    expect(() => bus.emit('noListeners', {})).not.toThrow();
  });

  it('works on async bus', () => {
    const bus = createAsyncCommandBus();
    const events: string[] = [];
    bus.on('test', (cmd) => { events.push(cmd.action); });
    bus.emit('test', {});
    expect(events).toEqual(['test']);
  });
});

// ─── bus.registeredActions() ─────────────────────────────────────────────────

describe('bus.registeredActions() — introspection', () => {
  it('returns empty array when no handlers registered', () => {
    const bus = createCommandBus();
    expect(bus.registeredActions()).toEqual([]);
  });

  it('returns all registered action names', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => {});
    bus.register('cartRemove', () => {});
    bus.register('orderCreate', () => {});
    const actions = bus.registeredActions();
    expect(actions).toContain('cartAdd');
    expect(actions).toContain('cartRemove');
    expect(actions).toContain('orderCreate');
    expect(actions.length).toBe(3);
  });

  it('reflects unregister', () => {
    const bus = createCommandBus();
    const unsub = bus.register('temp', () => {});
    expect(bus.registeredActions()).toContain('temp');
    unsub();
    expect(bus.registeredActions()).not.toContain('temp');
  });

  it('works on async bus', () => {
    const bus = createAsyncCommandBus();
    bus.register('asyncAction', async () => {});
    expect(bus.registeredActions()).toEqual(['asyncAction']);
  });
});

// ─── TestBus.onBefore (now fires for real) ──────────────────────────────────

describe('TestBus.onBefore — real implementation', () => {
  it('fires onBefore hooks before dispatch', () => {
    const bus = createTestBus();
    const calls: string[] = [];
    bus.onBefore((cmd) => { calls.push(cmd.action); });
    bus.dispatch('test', {});
    expect(calls).toEqual(['test']);
  });

  it('cancels dispatch when onBefore throws', () => {
    const bus = createTestBus();
    bus.onBefore(() => { throw new Error('blocked'); });
    const result = bus.dispatch('test', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('blocked');
  });

  it('unsub removes the hook', () => {
    const bus = createTestBus();
    const calls: string[] = [];
    const unsub = bus.onBefore((cmd) => { calls.push(cmd.action); });
    bus.dispatch('a', {});
    unsub();
    bus.dispatch('b', {});
    expect(calls).toEqual(['a']);
  });
});

// ─── TestBus.query / emit / registeredActions ───────────────────────────────

describe('TestBus — query, emit, registeredActions', () => {
  it('query skips beforeHooks on TestBus', () => {
    const bus = createTestBus();
    const beforeCalls: string[] = [];
    bus.onBefore((cmd) => { beforeCalls.push(cmd.action); });
    bus.query('getUser', { id: 1 });
    expect(beforeCalls).toEqual([]);
    expect(bus.wasDispatched('getUser')).toBe(true);
  });

  it('emit notifies listeners without handler', () => {
    const bus = createTestBus();
    const events: string[] = [];
    bus.on('orderCreated', (cmd) => { events.push(cmd.action); });
    bus.emit('orderCreated', { orderId: 1 });
    expect(events).toEqual(['orderCreated']);
  });

  it('registeredActions returns registered names', () => {
    const bus = createTestBus();
    bus.register('a', () => {});
    bus.register('b', () => {});
    expect(bus.registeredActions()).toContain('a');
    expect(bus.registeredActions()).toContain('b');
  });
});

// ─── seal() ────────────────────────────────────────────────────────────────────

describe('seal() — freeze bus topology', () => {
  it('seal() prevents register() after sealing', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.seal();
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.register('b', () => 2)).toThrow(/sealed/i);
  });

  it('seal() prevents use() after sealing', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(() => bus.use((cmd, next) => next())).toThrow(/sealed/i);
  });

  it('seal() prevents onBefore() after sealing', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(() => bus.onBefore(() => {})).toThrow(/sealed/i);
  });

  it('seal() prevents onAfter() after sealing', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(() => bus.onAfter(() => {})).toThrow(/sealed/i);
  });

  it('seal() prevents respond() after sealing', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(() => bus.respond('x', () => 42)).toThrow(/sealed/i);
  });

  it('dispatch still works after sealing', () => {
    const bus = createCommandBus();
    bus.register('a', () => 99);
    bus.seal();
    const result = bus.dispatch('a', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe(99);
  });

  it('on() and once() still work after sealing (listeners are not topology)', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.seal();
    const events: string[] = [];
    bus.on('a', () => events.push('heard'));
    bus.dispatch('a', {});
    expect(events).toEqual(['heard']);
  });

  it('isSealed() returns false before sealing', () => {
    const bus = createCommandBus();
    expect(bus.isSealed()).toBe(false);
  });

  it('seal() throws BusError with correct code', () => {
    const bus = createCommandBus();
    bus.seal();
    try {
      bus.register('x', () => {});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BusError);
      expect((e as BusError).code).toBe('VC_CORE_SEALED');
    }
  });
});

describe('seal() — async bus', () => {
  it('seal() prevents register() on async bus', () => {
    const bus = createAsyncCommandBus();
    bus.seal();
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.register('a', async () => 1)).toThrow(/sealed/i);
  });

  it('dispatch still works after sealing on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async () => 42);
    bus.seal();
    const result = await bus.dispatch('a', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });
});

// ─── commandPool ───────────────────────────────────────────────────────────────

describe('createCommandPool — zero-GC circular buffer', () => {
  it('acquires command objects with correct fields', () => {
    const pool = createCommandPool(4);
    const cmd = pool.acquire('cartAdd', { id: 1 }, { qty: 2 });
    expect(cmd.action).toBe('cartAdd');
    expect(cmd.target).toEqual({ id: 1 });
    expect(cmd.payload).toEqual({ qty: 2 });
  });

  it('reuses slots in circular fashion', () => {
    const pool = createCommandPool(2);
    const cmd1 = pool.acquire('a', 1);
    const cmd2 = pool.acquire('b', 2);
    // Third acquire wraps around to slot 0
    const cmd3 = pool.acquire('c', 3);
    expect(cmd3).toBe(cmd1); // same object reference
    expect(cmd3.action).toBe('c');
    expect(cmd3.target).toBe(3);
  });

  it('stats() tracks acquired count and cursor', () => {
    const pool = createCommandPool(8);
    pool.acquire('a', 1);
    pool.acquire('b', 2);
    pool.acquire('c', 3);
    const s = pool.stats();
    expect(s.size).toBe(8);
    expect(s.acquired).toBe(3);
    expect(s.cursor).toBe(3);
  });

  it('stats cursor wraps around', () => {
    const pool = createCommandPool(2);
    pool.acquire('a', 1);
    pool.acquire('b', 2);
    pool.acquire('c', 3); // wraps
    expect(pool.stats().cursor).toBe(1);
    expect(pool.stats().acquired).toBe(3);
  });

  it('reset() clears all slots and counters', () => {
    const pool = createCommandPool(4);
    pool.acquire('a', 1);
    pool.acquire('b', 2);
    pool.reset();
    const s = pool.stats();
    expect(s.acquired).toBe(0);
    expect(s.cursor).toBe(0);
    // After reset, acquire returns a blank slot
    const cmd = pool.acquire('fresh', 99);
    expect(cmd.action).toBe('fresh');
  });

  it('size property is correct', () => {
    const pool = createCommandPool(16);
    expect(pool.size).toBe(16);
  });

  it('throws on invalid size', () => {
    expect(() => createCommandPool(0)).toThrow(RangeError);
    expect(() => createCommandPool(-1)).toThrow(RangeError);
  });

  it('meta is reset on acquire', () => {
    const pool = createCommandPool(2);
    const cmd = pool.acquire('a', 1);
    (cmd as any).meta = { ts: 123, id: 'test' };
    // Wrap around and reacquire same slot
    pool.acquire('b', 2);
    const cmd2 = pool.acquire('c', 3); // same slot as cmd
    expect(cmd2.meta).toBeUndefined();
  });

  it('default pool size is 64', () => {
    const pool = createCommandPool();
    expect(pool.size).toBe(64);
  });

  it('works with bus.dispatch using pooled commands', () => {
    const bus = createCommandBus();
    const pool = createCommandPool(4);
    const results: number[] = [];
    bus.register('test', (cmd) => {
      results.push(cmd.target);
      return cmd.target;
    });

    for (let i = 0; i < 8; i++) {
      const cmd = pool.acquire('test', i);
      bus.dispatch(cmd.action, cmd.target, cmd.payload);
    }

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

// ─── dispose() ─────────────────────────────────────────────────────────────────

describe('dispose() — full teardown', () => {
  it('clears handlers, hooks, listeners, and plugins', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.onBefore(() => {});
    bus.onAfter(() => {});
    bus.on('a', () => {});
    bus.use((cmd, next) => next());

    bus.dispose();

    expect(bus.hasHandler('a')).toBe(false);
    expect(bus.registeredActions()).toEqual([]);
  });

  it('dispatch returns dead-letter after dispose', () => {
    const bus = createCommandBus({ deadLetter: 'error' });
    bus.register('a', () => 1);
    bus.dispose();
    const result = bus.dispatch('a', {});
    expect(result.ok).toBe(false);
  });

  it('dispose on async bus clears everything', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async () => 1);
    bus.dispose();
    expect(bus.hasHandler('a')).toBe(false);
  });
});

// ─── Recursion depth guard ─────────────────────────────────────────────────────

describe('recursion depth guard', () => {
  it('stops infinite dispatch loops (sync)', () => {
    const bus = createCommandBus();
    let count = 0;
    bus.register('loop', (cmd) => {
      count++;
      // Re-dispatch — will eventually hit MAX_DISPATCH_DEPTH
      return bus.dispatch('loop', cmd.target);
    });
    const result = bus.dispatch('loop', {});
    // The handler ran exactly MAX_DISPATCH_DEPTH times (16)
    expect(count).toBe(16);
    // Top-level dispatch returns ok:true (handler itself succeeded)
    // but the deepest dispatch returns the depth error
    expect(result.ok).toBe(true);
  });

  it('stops infinite dispatch loops (async)', async () => {
    const bus = createAsyncCommandBus();
    let count = 0;
    bus.register('loop', async (cmd) => {
      count++;
      return bus.dispatch('loop', cmd.target);
    });
    await bus.dispatch('loop', {});
    expect(count).toBe(16);
  });

  it('depth resets after normal dispatch completes', () => {
    const bus = createCommandBus();
    let depth1Count = 0;
    let depth2Count = 0;

    bus.register('inner', () => { depth2Count++; return 'ok'; });
    bus.register('outer', () => {
      depth1Count++;
      return bus.dispatch('inner', {});
    });

    // First dispatch — nests 2 deep
    bus.dispatch('outer', {});
    expect(depth1Count).toBe(1);
    expect(depth2Count).toBe(1);

    // Second dispatch — depth should have reset, so this works fine
    bus.dispatch('outer', {});
    expect(depth1Count).toBe(2);
    expect(depth2Count).toBe(2);
  });

  it('deep error result contains VC_CORE_MAX_DEPTH code', () => {
    const bus = createCommandBus();
    let deepResult: any;
    bus.register('loop', (cmd) => {
      const r = bus.dispatch('loop', cmd.target);
      if (!r.ok) deepResult = r;
      return r;
    });
    bus.dispatch('loop', {});
    expect(deepResult).toBeDefined();
    expect(deepResult.ok).toBe(false);
    expect((deepResult.error as BusError).code).toBe('VC_CORE_MAX_DEPTH');
  });
});

// ─── TestBus dispose() ─────────────────────────────────────────────────────────

describe('TestBus dispose()', () => {
  it('clears recorded dispatches and all state', () => {
    const bus = createTestBus();
    bus.register('a', () => 1);
    bus.dispatch('a', {});
    expect(bus.recorded.length).toBe(1);

    bus.dispose();

    expect(bus.recorded.length).toBe(0);
    expect(bus.hasHandler('a')).toBe(false);
  });
});

// ─── unsealBus — tree-shakeable unseal ─────────────────────────────────────

describe('unsealBus()', () => {
  it('unseals a sealed sync bus', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(bus.isSealed()).toBe(true);
    unsealBus(bus);
    expect(bus.isSealed()).toBe(false);
    // Can register again after unseal
    bus.register('a', () => 1);
    expect(bus.hasHandler('a')).toBe(true);
  });

  it('unseals a sealed async bus', () => {
    const bus = createAsyncCommandBus();
    bus.seal();
    unsealBus(bus);
    expect(bus.isSealed()).toBe(false);
    bus.register('a', async () => 1);
    expect(bus.hasHandler('a')).toBe(true);
  });

  it('is a no-op on an already unsealed bus', () => {
    const bus = createCommandBus();
    unsealBus(bus); // should not throw
    expect(bus.isSealed()).toBe(false);
  });
});

// ─── commandKey fast-path ──────────────────────────────────────────────────

describe('commandKey — fast path for primitives', () => {
  it('handles string target', () => {
    expect(commandKey('a', 'hello')).toBe('a:hello');
  });

  it('handles number target', () => {
    expect(commandKey('a', 42)).toBe('a:42');
  });

  it('handles boolean target', () => {
    expect(commandKey('a', true)).toBe('a:true');
  });

  it('handles null target', () => {
    expect(commandKey('a', null)).toBe('a:null');
  });

  it('handles undefined target', () => {
    expect(commandKey('a', undefined)).toBe('a:undefined');
  });

  it('sorts object keys for stability', () => {
    const key1 = commandKey('a', { b: 2, a: 1 });
    const key2 = commandKey('a', { a: 1, b: 2 });
    expect(key1).toBe(key2);
  });
});

// ─── Per-instance throttle timers ──────────────────────────────────────────

describe('per-instance throttle timers', () => {
  it('dispose on one bus does not affect another bus', () => {
    const bus1 = createCommandBus();
    const bus2 = createCommandBus();

    bus1.register('a', () => 1, { throttle: 10000 });
    bus2.register('a', () => 2, { throttle: 10000 });

    // First dispatch on each — goes through
    const r1 = bus1.dispatch('a', {});
    const r2 = bus2.dispatch('a', {});
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Dispose bus1 — should only clear bus1's timers
    bus1.dispose();

    // Bus2 should still have its throttle active
    const r3 = bus2.dispatch('a', {});
    expect(r3.ok).toBe(false);
    expect(r3.error?.message).toContain('throttled');

    bus2.dispose();
  });
});

// ─── TestBus seal and depth guard ──────────────────────────────────────────

describe('TestBus seal()', () => {
  it('prevents register after sealing', () => {
    const bus = createTestBus();
    bus.seal();
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.register('a', () => 1)).toThrow(/sealed/i);
  });

  it('prevents use after sealing', () => {
    const bus = createTestBus();
    bus.seal();
    expect(() => bus.use((cmd, next) => next())).toThrow(/sealed/i);
  });

  it('clear resets sealed state', () => {
    const bus = createTestBus();
    bus.seal();
    bus.clear();
    expect(bus.isSealed()).toBe(false);
    bus.register('a', () => 1); // should not throw
  });
});

describe('TestBus depth guard', () => {
  it('stops infinite loops', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    let count = 0;
    bus.register('loop', () => {
      count++;
      return bus.dispatch('loop', {});
    });
    bus.dispatch('loop', {});
    expect(count).toBe(16);
  });
});

// ─── transactional dispatchBatch ──────────────────────────────────────────────

describe('transactional dispatchBatch (sync)', () => {
  it('rolls back succeeded commands when a later command fails', () => {
    const bus = createCommandBus();
    const undoCalls: string[] = [];
    bus.register('reserve', (cmd) => `reserved-${cmd.target.id}`, { undo: (cmd) => { undoCalls.push(`undo-reserve-${cmd.target.id}`); } });
    bus.register('charge', () => { throw new Error('payment-declined'); }, { undo: () => { undoCalls.push('undo-charge'); } });

    const result = bus.dispatchBatch([
      { action: 'reserve', target: { id: 1 } },
      { action: 'charge', target: { amount: 50 } },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('payment-declined');
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.rollbacks).toHaveLength(1);
    expect(result.rollbacks![0].ok).toBe(true);
    expect(undoCalls).toEqual(['undo-reserve-1']);
  });

  it('returns no rollbacks when first command fails', () => {
    const bus = createCommandBus();
    bus.register('fail', () => { throw new Error('first-fail'); });

    const result = bus.dispatchBatch([
      { action: 'fail', target: {} },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(result.rollbacks).toHaveLength(0);
  });

  it('skips commands without undo handlers during rollback', () => {
    const bus = createCommandBus();
    const undoCalls: string[] = [];
    bus.register('a', () => 'ok-a'); // no undo
    bus.register('b', () => 'ok-b', { undo: () => { undoCalls.push('undo-b'); } });
    bus.register('c', () => { throw new Error('c-fail'); });

    const result = bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
      { action: 'c', target: {} },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(undoCalls).toEqual(['undo-b']); // only b rolled back, a skipped (no undo)
    expect(result.rollbacks).toHaveLength(1);
  });

  it('all succeed — no rollbacks field', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1, { undo: () => {} });
    bus.register('b', () => 2, { undo: () => {} });

    const result = bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
    ], { transactional: true });

    expect(result.ok).toBe(true);
    expect(result.rollbacks).toBeUndefined();
  });

  it('captures undo handler errors in rollback results', () => {
    const bus = createCommandBus();
    bus.register('a', () => 'ok', { undo: () => { throw new Error('undo-broke'); } });
    bus.register('b', () => { throw new Error('b-fail'); });

    const result = bus.dispatchBatch([
      { action: 'a', target: {} },
      { action: 'b', target: {} },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(result.rollbacks).toHaveLength(1);
    expect(result.rollbacks![0].ok).toBe(false);
    expect(result.rollbacks![0].error?.message).toBe('undo-broke');
  });
});

describe('transactional dispatchBatch (async)', () => {
  it('rolls back succeeded commands when a later command fails', async () => {
    const bus = createAsyncCommandBus();
    const undoCalls: string[] = [];
    bus.register('reserve', async (cmd) => `reserved-${cmd.target.id}`, { undo: (cmd) => { undoCalls.push(`undo-reserve-${cmd.target.id}`); } });
    bus.register('charge', async () => { throw new Error('payment-declined'); });

    const result = await bus.dispatchBatch([
      { action: 'reserve', target: { id: 1 } },
      { action: 'charge', target: { amount: 50 } },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('payment-declined');
    expect(result.rollbacks).toHaveLength(1);
    expect(undoCalls).toEqual(['undo-reserve-1']);
  });

  it('runs rollback in reverse order across multiple succeeded commands', async () => {
    const bus = createAsyncCommandBus();
    const undoCalls: string[] = [];
    bus.register('step1', async () => 'ok1', { undo: () => { undoCalls.push('undo-1'); } });
    bus.register('step2', async () => 'ok2', { undo: () => { undoCalls.push('undo-2'); } });
    bus.register('step3', async () => 'ok3', { undo: () => { undoCalls.push('undo-3'); } });
    bus.register('step4', async () => { throw new Error('step4-fail'); });

    const result = await bus.dispatchBatch([
      { action: 'step1', target: {} },
      { action: 'step2', target: {} },
      { action: 'step3', target: {} },
      { action: 'step4', target: {} },
    ], { transactional: true });

    expect(result.ok).toBe(false);
    expect(undoCalls).toEqual(['undo-3', 'undo-2', 'undo-1']); // reverse order
    expect(result.rollbacks).toHaveLength(3);
  });
});

// ─── optimisticUndo plugin ────────────────────────────────────────────────────

describe('optimisticUndo (sync bus)', () => {
  it('passes through actions without undo handlers', () => {
    const bus = createCommandBus();
    bus.register('plain', () => 'real-result');
    bus.use(optimisticUndo(bus, ['plain']));

    const result = bus.dispatch('plain', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('real-result');
  });

  it('passes through actions not in the action list', () => {
    const bus = createCommandBus();
    bus.register('other', () => 'other-result');
    bus.use(optimisticUndo(bus, ['cartAdd']));

    const result = bus.dispatch('other', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('other-result');
  });

  it('calls undo handler on sync failure and fires onRollback', () => {
    const bus = createCommandBus();
    const undoCalls: any[] = [];
    const rollbackCalls: any[] = [];
    bus.register('cartAdd', () => { throw new Error('out-of-stock'); }, {
      undo: (cmd) => { undoCalls.push(cmd.target); },
    });
    bus.use(optimisticUndo(bus, ['cartAdd'], {
      onRollback: (cmd, err) => { rollbackCalls.push({ action: cmd.action, msg: err.message }); },
    }));

    const result = bus.dispatch('cartAdd', { id: 5 }, { qty: 2 });
    expect(result.ok).toBe(false);
    expect(undoCalls).toEqual([{ id: 5 }]);
    expect(rollbackCalls).toEqual([{ action: 'cartAdd', msg: 'out-of-stock' }]);
  });

  it('returns predicted value on async bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 'real-value', {
      undo: () => {},
    });
    bus.use(optimisticUndo(bus as any, ['cartAdd'], {
      predict: (cmd) => ({ predicted: true, id: cmd.target.id }),
    }) as any);

    const result = await bus.dispatch('cartAdd', { id: 42 }, { qty: 1 });
    // optimisticUndo intercepts and returns predicted result synchronously
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ predicted: true, id: 42 });
  });

  it('fires onRollbackError when undo handler throws on sync bus', () => {
    const bus = createCommandBus();
    const errors: any[] = [];
    bus.register('cartAdd', () => { throw new Error('handler-fail'); }, {
      undo: () => { throw new Error('undo-fail'); },
    });
    bus.use(optimisticUndo(bus, ['cartAdd'], {
      onRollbackError: (_cmd, undoErr, origErr) => {
        errors.push({ undo: undoErr.message, orig: origErr.message });
      },
    }));

    bus.dispatch('cartAdd', { id: 1 });
    expect(errors).toEqual([{ undo: 'undo-fail', orig: 'handler-fail' }]);
  });
});

// ─── inspectBus (tree-shakeable) ──────────────────────────────────────────────

describe('inspectBus (sync)', () => {
  it('returns full topology snapshot', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 'added', { undo: () => {} });
    bus.register('cartRemove', () => 'removed');
    bus.use((cmd, next) => next(), { priority: 10 });
    bus.use((cmd, next) => next(), { priority: 5 });
    bus.onBefore(() => {});
    bus.onAfter(() => {});
    bus.on('cart*', () => {});
    bus.on('*', () => {});
    bus.respond('cartCheck', () => true);

    const info = inspectBus(bus);

    expect(info.actions).toEqual(['cartAdd', 'cartRemove']);
    expect(info.undoActions).toEqual(['cartAdd']);
    expect(info.responderActions).toEqual(['cartCheck']);
    expect(info.pluginCount).toBe(2);
    expect(info.pluginPriorities).toEqual([10, 5]); // sorted high-first
    expect(info.beforeHookCount).toBe(1);
    expect(info.afterHookCount).toBe(1);
    expect(info.listenerPatterns).toEqual(['cart*', '*']);
    expect(info.sealed).toBe(false);
    expect(info.dispatchDepth).toBe(0);
    expect(info.activeTimers).toBe(0);
  });

  it('reflects sealed state', () => {
    const bus = createCommandBus();
    bus.seal();
    expect(inspectBus(bus).sealed).toBe(true);
  });

  it('reflects state after clear', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.use((_, next) => next());
    bus.onBefore(() => {});
    bus.clear();

    const info = inspectBus(bus);
    expect(info.actions).toEqual([]);
    expect(info.pluginCount).toBe(0);
    expect(info.beforeHookCount).toBe(0);
  });
});

describe('inspectBus (async)', () => {
  it('returns full topology snapshot', () => {
    const bus = createAsyncCommandBus();
    bus.register('fetch', async () => 'data', { undo: () => {} });
    bus.respond('query', async () => 42);

    const info = inspectBus(bus);

    expect(info.actions).toEqual(['fetch']);
    expect(info.undoActions).toEqual(['fetch']);
    expect(info.responderActions).toEqual(['query']);
    expect(info.sealed).toBe(false);
  });
});

describe('TestBus.inspect()', () => {
  it('returns topology snapshot', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('a', () => 1, { undo: () => {} });
    bus.register('b', () => 2);
    bus.onBefore(() => {});
    bus.on('a*', () => {});

    const info = (bus as any).inspect();

    expect(info.actions).toEqual(['a', 'b']);
    expect(info.undoActions).toEqual(['a']);
    expect(info.pluginCount).toBe(0);
    expect(info.beforeHookCount).toBe(1);
    expect(info.listenerPatterns).toEqual(['a*']);
    expect(info.sealed).toBe(false);
  });
});

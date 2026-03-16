import { describe, it, expect, beforeEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { getCommandBus, setCommandBus, useCommandBus } from '../src/chamber';

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
    expect(result.results).toHaveLength(2); // a succeeded, b failed, c never ran
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

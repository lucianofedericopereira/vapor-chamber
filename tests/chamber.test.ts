/**
 * src/chamber.ts composables on the shared bus: getCommandBus, useCommand, signal(), useCommandHistory, useCommandGroup, useCommandError, useCommandQuery.
 * Why: this is the Vue surface every app calls; signal() is a shallow ref because state is only ever replaced whole, and a deep ref proxies every write.
 * Shows: one replaceable shared bus; dispatch, pending, failures as results; shallow signals still react; history records, undoes, redoes, filters, caps, disposes; groups prefix; errors and queries captured.
 * See: docs/performance.md, tests/chamber-gaps.test.ts.
 */
import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  useCommand,
  useCommandHistory,
  useCommandGroup,
  useCommandError,
  useCommandQuery,
  signal,
  waitForVueDetection,
} from '../src/chamber';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { isShallow, isReactive, effectScope, watchEffect } from 'vue';
import { it } from '../src/vitest';

describe('getCommandBus / setCommandBus', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('should return a command bus', () => {
    const bus = getCommandBus();

    expect(bus).toBeDefined();
    expect(typeof bus.dispatch).toBe('function');
    expect(typeof bus.register).toBe('function');
  });

  it('should return the same instance', () => {
    const bus1 = getCommandBus();
    const bus2 = getCommandBus();

    expect(bus1).toBe(bus2);
  });

  it('should allow setting a custom bus', () => {
    const customBus = createCommandBus();
    customBus.register('customAction', () => 'custom');

    setCommandBus(customBus);

    const result = getCommandBus().dispatch('customAction', {});
    expect(result.value).toBe('custom');
  });
});

describe('useCommand', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('an unregister called by hand, then again by teardown, removes nothing the second time', () => {
    const bus = getCommandBus();
    const scope = effectScope();
    let off!: () => void;
    scope.run(() => { off = useCommand().register('pageSave' as never, () => 'page'); });
    off();
    // A later owner of the same action must survive the scope's teardown,
    // which runs the same unregister again.
    bus.register('pageSave', () => 'later');
    scope.stop();
    expect(bus.dispatch('pageSave', {})).toSucceedWith('later');
  });

  it('should return dispatch function', () => {
    const { dispatch } = useCommand();

    expect(typeof dispatch).toBe('function');
  });

  it('should dispatch commands', () => {
    const bus = getCommandBus();
    bus.register('testAction', (cmd) => cmd.target.value);

    const { dispatch } = useCommand();
    const result = dispatch('testAction', { value: 42 });

    expect(result).toSucceedWith(42);
  });

  it('pending tracks the dispatched key, from the bus', () => {
    const bus = getCommandBus();
    let during = false;
    bus.register('testAction', () => { during = key.value; return 'done'; });

    const { dispatch, pending } = useCommand();
    const key = pending('testAction', {});

    expect(key.value).toBe(false);
    dispatch('testAction', {});
    expect({ during, after: key.value }).toEqual({ during: true, after: false });
  });

  it('a failure is the dispatch\'s own result', () => {
    const bus = getCommandBus();
    bus.register('testError', () => {
      throw new Error('Test error');
    });

    const { dispatch } = useCommand();
    const result = dispatch('testError', {}) as { ok: boolean; error?: Error };

    expect({ ok: result.ok, message: result.error?.message }).toEqual({ ok: false, message: 'Test error' });
  });

});

describe('signal() factory - shallow reactivity', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });
  afterEach(() => {
    resetCommandBus();
  });

  // These fail if signal() goes back to a deep ref.
  it('returns a SHALLOW Vue ref once Vue is detected', async () => {
    await waitForVueDetection();
    const s = signal({ nested: { n: 1 } });
    expect(isShallow(s)).toBe(true);
    // shallow => nested value is the raw object, not a reactive proxy
    expect(isReactive(s.value.nested)).toBe(false);
  });

  it('still drives reactivity on whole-value replacement (the library contract)', async () => {
    await waitForVueDetection();
    const state = signal({ items: [] as number[] });
    getCommandBus().register('itemAdd', (cmd) => { state.value = { items: [...state.value.items, cmd.target as number] }; });

    const seen: number[] = [];
    const scope = effectScope();
    scope.run(() => {
      watchEffect(() => { seen.push(state.value.items.length); });
    });

    const bus = getCommandBus();
    bus.dispatch('itemAdd', 1);
    bus.dispatch('itemAdd', 2);
    await Promise.resolve(); // let the effect flush

    // Effect saw the initial mount (0) and reacted to whole-value reassignments.
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(2);
    scope.stop();
  });
});

describe('useCommandHistory', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('should track command history', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past, canUndo } = useCommandHistory();

    expect(past.value.length).toBe(0);
    expect(canUndo.value).toBe(false);

    bus.dispatch('testAction', { id: 1 });

    expect(past.value.length).toBe(1);
    expect(canUndo.value).toBe(true);
  });

  it('should undo commands', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past, future, undo, canRedo } = useCommandHistory();

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

    expect(past.value.length).toBe(2);

    const undone = undo();

    expect(undone?.target.id).toBe(2);
    expect(past.value.length).toBe(1);
    expect(future.value.length).toBe(1);
    expect(canRedo.value).toBe(true);
  });

  it('should redo commands', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past, future, undo, redo } = useCommandHistory();

    bus.dispatch('testAction', { id: 1 });
    undo();

    expect(past.value.length).toBe(0);
    expect(future.value.length).toBe(1);

    const redone = redo();

    expect(redone?.target.id).toBe(1);
    expect(past.value.length).toBe(1);
    expect(future.value.length).toBe(0);
  });

  it('undo() and redo() are no-ops on empty stacks', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');
    const { past, future, canUndo, canRedo, undo, redo } = useCommandHistory();

    // Nothing recorded yet - both ends must be safe to call, since UI usually
    // wires them straight to buttons that exist before any command runs.
    expect(undo()).toBeUndefined();
    expect(redo()).toBeUndefined();
    expect(past.value).toHaveLength(0);
    expect(future.value).toHaveLength(0);
    expect(canUndo.value).toBe(false);
    expect(canRedo.value).toBe(false);

    // With history but nothing undone, redo is still a no-op.
    bus.dispatch('testAction', { id: 1 });
    expect(redo()).toBeUndefined();
    expect(past.value).toHaveLength(1);
  });

  it('a fresh dispatch after an undo drops the redo stack', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');
    const { past, future, canRedo, undo } = useCommandHistory();

    bus.dispatch('testAction', { id: 1 });
    undo();
    expect(future.value).toHaveLength(1);
    expect(canRedo.value).toBe(true);

    // Branching away from an undone timeline invalidates the redo path -
    // the same rule every editor uses.
    bus.dispatch('testAction', { id: 2 });
    expect(future.value).toHaveLength(0);
    expect(canRedo.value).toBe(false);
    expect(past.value).toHaveLength(1);
  });

  it('redo does not double-record when the payload cannot carry a marker', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');
    const { past, future, undo, redo } = useCommandHistory();

    // A primitive payload cannot be marked, so the one-shot identity match stops the replay being recorded again.
    bus.dispatch('testAction', { id: 1 }, 'primitive-payload' as never);
    expect(past.value).toHaveLength(1);

    undo();
    expect(future.value).toHaveLength(1);

    redo();
    expect(past.value).toHaveLength(1); // not 2
    expect(future.value).toHaveLength(0);
  });

  it('should clear history', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past, future, undo, clear } = useCommandHistory();

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    undo();

    clear();

    expect(past.value.length).toBe(0);
    expect(future.value.length).toBe(0);
  });

  it('should respect filter option', () => {
    const bus = getCommandBus();
    bus.register('trackAction', () => 'tracked');
    bus.register('otherAction', () => 'not tracked');

    const { past } = useCommandHistory({
      actions: ['track*'],
    });

    bus.dispatch('trackAction', { id: 1 });
    bus.dispatch('otherAction', { id: 2 });
    bus.dispatch('trackAction', { id: 3 });

    expect(past.value.length).toBe(2);
  });

  it('redo should re-dispatch through the bus', () => {
    const bus = getCommandBus();
    let count = 0;
    bus.register('inc', () => { count++; });

    const { undo, redo } = useCommandHistory();

    bus.dispatch('inc', {});
    expect(count).toBe(1);

    undo();
    // undo runs inverse handler if registered, but inc has no undo - count stays 1
    expect(count).toBe(1);

    redo();
    // redo should re-dispatch 'inc' through the bus
    expect(count).toBe(2);
  });

  it('should respect maxSize option', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past } = useCommandHistory({ maxSize: 2 });

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    bus.dispatch('testAction', { id: 3 });

    expect(past.value.length).toBe(2);
    expect(past.value[0].target.id).toBe(2);
  });

  it('should return dispose function', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { past, dispose } = useCommandHistory();

    bus.dispatch('testAction', { id: 1 });
    expect(past.value.length).toBe(1);

    dispose();

    bus.dispatch('testAction', { id: 2 });
    // After dispose, hook is unsubscribed, so history doesn't track
    expect(past.value.length).toBe(1);
  });
});

describe('useCommandGroup', () => {
  beforeEach(() => resetCommandBus());

  it('prefixes dispatch with namespace', ({ bus }) => {
    setCommandBus(bus);

    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const cart = useCommandGroup('cart');
    cart.dispatch('add', { id: 1 });
    cart.dispatch('remove', { id: 1 });

    expect(dispatched).toEqual(['cartAdd', 'cartRemove']);
  });

  it('prefixes register with namespace', ({ bus }) => {
    setCommandBus(bus);

    const cart = useCommandGroup('cart');
    const results: string[] = [];
    cart.register('add', (cmd) => { results.push(`added:${cmd.target.id}`); });

    bus.dispatch('cartAdd', { id: 42 });
    expect(results).toEqual(['added:42']);
  });

  it('dispatch returns result from namespaced handler', ({ bus }) => {
    setCommandBus(bus);

    const orders = useCommandGroup('orders');
    orders.register('get', (cmd) => ({ orderId: cmd.target.id, status: 'pending' }));

    const result = orders.dispatch('get', { id: 7 });
    expect(result).toSucceedWith({ orderId: 7, status: 'pending' });
  });

  it('isolates namespaces - cart handlers do not respond to order dispatches', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);

    const cart = useCommandGroup('cart');
    const orders = useCommandGroup('orders');
    const cartCalls: number[] = [];
    const orderCalls: number[] = [];

    cart.register('add', (cmd) => cartCalls.push(cmd.target.id));
    orders.register('cancel', (cmd) => orderCalls.push(cmd.target.id));

    cart.dispatch('add', { id: 1 });
    orders.dispatch('cancel', { id: 2 });
    orders.dispatch('add', { id: 99 }); // cross-namespace: ignored

    expect(cartCalls).toEqual([1]);
    expect(orderCalls).toEqual([2]);
  });

  it('exposes the namespace string', () => {
    resetCommandBus();
    const group = useCommandGroup('analytics');
    expect(group.namespace).toBe('analytics');
  });

  it('cart.register("add") registers "cartAdd"', ({ bus }) => {
    setCommandBus(bus);

    const cart = useCommandGroup('cart');
    const calls: number[] = [];
    cart.register('add', (cmd) => calls.push(cmd.target.id));

    bus.dispatch('cartAdd', { id: 7 });
    expect(calls).toEqual([7]);
  });

  it('cart.dispatch("remove") dispatches "cartRemove"', ({ bus }) => {
    setCommandBus(bus);

    const seen: string[] = [];
    bus.onAfter((cmd) => seen.push(cmd.action));

    const cart = useCommandGroup('cart');
    cart.dispatch('remove', { id: 3 });

    expect(seen).toContain('cartRemove');
  });

  it('query() dispatches namespaced read-only query', ({ bus }) => {
    setCommandBus(bus);

    bus.register('cartGetTotal', () => 99);

    const cart = useCommandGroup('cart');
    const result = cart.query('getTotal', {});

    expect(result).toSucceedWith(99);
  });

  it('emit() fires namespaced domain events', ({ bus }) => {
    setCommandBus(bus);

    const received: string[] = [];
    bus.on('cart*', (cmd) => received.push(cmd.action));

    const cart = useCommandGroup('cart');
    cart.emit('updated', { total: 50 });

    expect(received).toEqual(['cartUpdated']);
  });
});

describe('useCommandError', () => {
  beforeEach(() => resetCommandBus());

  it('captures failed dispatches', ({ bus }) => {
    setCommandBus(bus);
    bus.register('fail', () => { throw new Error('boom'); });

    const { errors, latestError } = useCommandError();
    bus.dispatch('fail', {});

    expect(errors.value).toHaveLength(1);
    expect(latestError.value?.message).toBe('boom');
    expect(errors.value[0].cmd.action).toBe('fail');
  });

  it('does not capture successful dispatches', ({ bus }) => {
    setCommandBus(bus);
    bus.register('ok', () => 'fine');

    const { errors } = useCommandError();
    bus.dispatch('ok', {});

    expect(errors.value).toHaveLength(0);
  });

  it('filter narrows which errors are captured', ({ bus }) => {
    setCommandBus(bus);
    bus.register('cartFail', () => { throw new Error('cart error'); });
    bus.register('userFail', () => { throw new Error('user error'); });

    const { errors } = useCommandError({ actions: ['cart*'] });
    bus.dispatch('cartFail', {});
    bus.dispatch('userFail', {});

    expect(errors.value).toHaveLength(1);
    expect(errors.value[0].cmd.action).toBe('cartFail');
  });

  it('clearErrors resets state', ({ bus }) => {
    setCommandBus(bus);
    bus.register('fail', () => { throw new Error('x'); });

    const { errors, latestError, clearErrors } = useCommandError();
    bus.dispatch('fail', {});

    expect(errors.value).toHaveLength(1);
    clearErrors();
    expect(errors.value).toHaveLength(0);
    expect(latestError.value).toBeNull();
  });
});

describe('useCommand async pending', () => {
  beforeEach(() => resetCommandBus());

  it('pending stays true until the async result resolves', async () => {
    const asyncBus = createAsyncCommandBus();
    setCommandBus(asyncBus as any);

    asyncBus.register('fetchData', async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'data';
    });

    const { dispatch, pending } = useCommand();
    const key = pending('fetchData', {});

    const resultPromise = dispatch('fetchData', {});

    // pending is true while the handler is running
    expect(key.value).toBe(true);

    const result = await resultPromise;

    expect(key.value).toBe(false);
    expect(result).toSucceedWith('data');
  });

  it('pending resets on an async failure, which is the result', async () => {
    const asyncBus = createAsyncCommandBus();
    setCommandBus(asyncBus as any);

    asyncBus.register('failAsync', async () => {
      throw new Error('async boom');
    });

    const { dispatch, pending } = useCommand();
    const key = pending('failAsync', {});

    const result = await dispatch('failAsync', {});

    expect(key.value).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('async boom');
  });
});

describe('useCommandQuery', () => {
  beforeEach(() => resetCommandBus());

  it('queries and populates data signal', ({ bus }) => {
    setCommandBus(bus);
    bus.register('getUser', (cmd) => ({ id: cmd.target.id, name: 'Alice' }));

    const { query, data, loading } = useCommandQuery();

    const result = query('getUser', { id: 42 });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect(data.value).toEqual({ id: 42, name: 'Alice' });
    expect(loading.value).toBe(false);
  });

  it('a failed query is its result, and data stays empty', ({ bus }) => {
    setCommandBus(bus);
    bus.register('getUser', () => { throw new Error('not found'); });

    const { query, data } = useCommandQuery();

    const result = query('getUser', { id: 99 }) as { ok: boolean; error?: Error };

    expect(result.ok).toBe(false);
    expect(data.value).toBeNull();
    expect(result.error?.message).toBe('not found');
  });

  it('handles async queries', async () => {
    const asyncBus = createAsyncCommandBus();
    setCommandBus(asyncBus as any);

    asyncBus.register('getProducts', async () => {
      await new Promise(r => setTimeout(r, 10));
      return [{ id: 1, name: 'Widget' }];
    });

    const { query, data, loading } = useCommandQuery();

    const resultPromise = query('getProducts', {});
    expect(loading.value).toBe(true);

    await resultPromise;

    expect(loading.value).toBe(false);
    expect(data.value).toEqual([{ id: 1, name: 'Widget' }]);
  });

});

describe('useCommandHistory - undo handler execution', () => {
  beforeEach(() => { setCommandBus(createCommandBus()); });
  afterEach(() => { resetCommandBus(); });

  it('calls the registered undo handler on undo()', () => {
    const bus = getCommandBus();
    const undoFn = vi.fn();
    bus.register('cartAdd', (cmd) => cmd.target, { undo: undoFn });

    const { undo, canUndo } = useCommandHistory();
    bus.dispatch('cartAdd', { id: 1 });

    expect(canUndo.value).toBe(true);
    undo();

    expect(undoFn).toHaveBeenCalledWith(expect.objectContaining({ action: 'cartAdd' }));
  });

  it('re-dispatches the command on redo()', () => {
    const bus = getCommandBus();
    const handler = vi.fn((cmd: any) => cmd.target);
    bus.register('cartAdd', handler, { undo: vi.fn() });

    const { undo, redo } = useCommandHistory();
    bus.dispatch('cartAdd', { id: 1 });
    undo();
    redo();

    // handler called: initial dispatch + redo re-dispatch = 2 times
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('undo catches and logs handler errors', () => {
    const bus = getCommandBus();
    using consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.register('op', () => 1, { undo: () => { throw new Error('undo failed'); } });

    const { undo } = useCommandHistory();
    bus.dispatch('op', {});
    undo(); // should not throw

    expect(consoleError).toHaveBeenCalled();
  });
});

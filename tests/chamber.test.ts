import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
  useCommandGroup,
  useCommandError,
} from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

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

  it('should return dispatch function', () => {
    const { dispatch } = useCommand();

    expect(typeof dispatch).toBe('function');
  });

  it('should dispatch commands', () => {
    const bus = getCommandBus();
    bus.register('testAction', (cmd) => cmd.target.value);

    const { dispatch } = useCommand();
    const result = dispatch('testAction', { value: 42 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('should track loading state', () => {
    const bus = getCommandBus();
    bus.register('testAction', () => 'done');

    const { dispatch, loading } = useCommand();

    expect(loading.value).toBe(false);

    dispatch('testAction', {});

    // After sync dispatch, loading is false again
    expect(loading.value).toBe(false);
  });

  it('should track last error', () => {
    const bus = getCommandBus();
    bus.register('testError', () => {
      throw new Error('Test error');
    });

    const { dispatch, lastError } = useCommand();

    expect(lastError.value).toBe(null);

    dispatch('testError', {});

    expect(lastError.value?.message).toBe('Test error');
  });

  it('should clear error on successful dispatch', () => {
    const bus = getCommandBus();
    bus.register('testError', () => {
      throw new Error('Error');
    });
    bus.register('testSuccess', () => 'ok');

    const { dispatch, lastError } = useCommand();

    dispatch('testError', {});
    expect(lastError.value).not.toBe(null);

    dispatch('testSuccess', {});
    expect(lastError.value).toBe(null);
  });

});

describe('useCommandState', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('should return initial state', () => {
    const { state } = useCommandState({ count: 0 }, {});

    expect(state.value).toEqual({ count: 0 });
  });

  it('should update state on command', () => {
    const { state } = useCommandState(
      { count: 0 },
      {
        'counterIncrement': (s) => ({ count: s.count + 1 }),
        'counterDecrement': (s) => ({ count: s.count - 1 }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('counterIncrement', {});
    expect(state.value.count).toBe(1);

    bus.dispatch('counterIncrement', {});
    expect(state.value.count).toBe(2);

    bus.dispatch('counterDecrement', {});
    expect(state.value.count).toBe(1);
  });

  it('should pass command to handler', () => {
    const { state } = useCommandState(
      { items: [] as number[] },
      {
        'itemAdd': (s, cmd) => ({
          items: [...s.items, cmd.target as number],
        }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('itemAdd', 1);
    bus.dispatch('itemAdd', 2);
    bus.dispatch('itemAdd', 3);

    expect(state.value.items).toEqual([1, 2, 3]);
  });

  it('should return dispose function', () => {
    const { state, dispose } = useCommandState(
      { count: 0 },
      {
        'counterIncrement': (s) => ({ count: s.count + 1 }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('counterIncrement', {});
    expect(state.value.count).toBe(1);

    dispose();

    // After dispose, handler is unregistered
    const result = bus.dispatch('counterIncrement', {});
    expect(result.ok).toBe(false);
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
      filter: (cmd) => cmd.action.startsWith('track'),
    });

    bus.dispatch('trackAction', { id: 1 });
    bus.dispatch('otherAction', { id: 2 });
    bus.dispatch('trackAction', { id: 3 });

    expect(past.value.length).toBe(2);
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

// ---------------------------------------------------------------------------
// useCommandGroup
// ---------------------------------------------------------------------------

describe('useCommandGroup', () => {
  beforeEach(() => resetCommandBus());

  it('prefixes dispatch with namespace', () => {
    const bus = createCommandBus();
    setCommandBus(bus);

    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const cart = useCommandGroup('cart');
    cart.dispatch('add', { id: 1 });
    cart.dispatch('remove', { id: 1 });

    expect(dispatched).toEqual(['cartAdd', 'cartRemove']);
  });

  it('prefixes register with namespace', () => {
    const bus = createCommandBus();
    setCommandBus(bus);

    const cart = useCommandGroup('cart');
    const results: string[] = [];
    cart.register('add', (cmd) => { results.push(`added:${cmd.target.id}`); });

    bus.dispatch('cartAdd', { id: 42 });
    expect(results).toEqual(['added:42']);
  });

  it('dispatch returns result from namespaced handler', () => {
    const bus = createCommandBus();
    setCommandBus(bus);

    const orders = useCommandGroup('orders');
    orders.register('get', (cmd) => ({ orderId: cmd.target.id, status: 'pending' }));

    const result = orders.dispatch('get', { id: 7 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ orderId: 7, status: 'pending' });
  });

  it('isolates namespaces — cart handlers do not respond to order dispatches', () => {
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

  it('cart.register("add") registers "cartAdd"', () => {
    const bus = createCommandBus();
    setCommandBus(bus);

    const cart = useCommandGroup('cart');
    const calls: number[] = [];
    cart.register('add', (cmd) => calls.push(cmd.target.id));

    bus.dispatch('cartAdd', { id: 7 });
    expect(calls).toEqual([7]);
  });

  it('cart.dispatch("remove") dispatches "cartRemove"', () => {
    const bus = createCommandBus();
    setCommandBus(bus);

    const seen: string[] = [];
    bus.onAfter((cmd) => seen.push(cmd.action));

    const cart = useCommandGroup('cart');
    cart.dispatch('remove', { id: 3 });

    expect(seen).toContain('cartRemove');
  });
});

// ---------------------------------------------------------------------------
// useCommandError
// ---------------------------------------------------------------------------

describe('useCommandError', () => {
  beforeEach(() => resetCommandBus());

  it('captures failed dispatches', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    bus.register('fail', () => { throw new Error('boom'); });

    const { errors, latestError } = useCommandError();
    bus.dispatch('fail', {});

    expect(errors.value).toHaveLength(1);
    expect(latestError.value?.message).toBe('boom');
    expect(errors.value[0].cmd.action).toBe('fail');
  });

  it('does not capture successful dispatches', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    bus.register('ok', () => 'fine');

    const { errors } = useCommandError();
    bus.dispatch('ok', {});

    expect(errors.value).toHaveLength(0);
  });

  it('filter narrows which errors are captured', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    bus.register('cartFail', () => { throw new Error('cart error'); });
    bus.register('userFail', () => { throw new Error('user error'); });

    const { errors } = useCommandError({ filter: (cmd) => cmd.action.startsWith('cart') });
    bus.dispatch('cartFail', {});
    bus.dispatch('userFail', {});

    expect(errors.value).toHaveLength(1);
    expect(errors.value[0].cmd.action).toBe('cartFail');
  });

  it('clearErrors resets state', () => {
    const bus = createCommandBus();
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

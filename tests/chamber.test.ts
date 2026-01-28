import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCommandBus,
  setCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
} from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

describe('getCommandBus / setCommandBus', () => {
  beforeEach(() => {
    // Reset shared bus
    setCommandBus(createCommandBus());
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
    customBus.register('custom.action', () => 'custom');

    setCommandBus(customBus);

    const result = getCommandBus().dispatch('custom.action', {});
    expect(result.value).toBe('custom');
  });
});

describe('useCommand', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('should return dispatch function', () => {
    const { dispatch } = useCommand();

    expect(typeof dispatch).toBe('function');
  });

  it('should dispatch commands', () => {
    const bus = getCommandBus();
    bus.register('test.action', (cmd) => cmd.target.value);

    const { dispatch } = useCommand();
    const result = dispatch('test.action', { value: 42 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('should track loading state', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { dispatch, loading } = useCommand();

    expect(loading.value).toBe(false);

    dispatch('test.action', {});

    // After sync dispatch, loading is false again
    expect(loading.value).toBe(false);
  });

  it('should track last error', () => {
    const bus = getCommandBus();
    bus.register('test.error', () => {
      throw new Error('Test error');
    });

    const { dispatch, lastError } = useCommand();

    expect(lastError.value).toBe(null);

    dispatch('test.error', {});

    expect(lastError.value?.message).toBe('Test error');
  });

  it('should clear error on successful dispatch', () => {
    const bus = getCommandBus();
    bus.register('test.error', () => {
      throw new Error('Error');
    });
    bus.register('test.success', () => 'ok');

    const { dispatch, lastError } = useCommand();

    dispatch('test.error', {});
    expect(lastError.value).not.toBe(null);

    dispatch('test.success', {});
    expect(lastError.value).toBe(null);
  });

  it('should expose register and use methods', () => {
    const { register, use } = useCommand();

    expect(typeof register).toBe('function');
    expect(typeof use).toBe('function');
  });
});

describe('useCommandState', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('should return initial state', () => {
    const { state } = useCommandState({ count: 0 }, {});

    expect(state.value).toEqual({ count: 0 });
  });

  it('should update state on command', () => {
    const { state } = useCommandState(
      { count: 0 },
      {
        'counter.increment': (s) => ({ count: s.count + 1 }),
        'counter.decrement': (s) => ({ count: s.count - 1 }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('counter.increment', {});
    expect(state.value.count).toBe(1);

    bus.dispatch('counter.increment', {});
    expect(state.value.count).toBe(2);

    bus.dispatch('counter.decrement', {});
    expect(state.value.count).toBe(1);
  });

  it('should pass command to handler', () => {
    const { state } = useCommandState(
      { items: [] as number[] },
      {
        'item.add': (s, cmd) => ({
          items: [...s.items, cmd.target as number],
        }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('item.add', 1);
    bus.dispatch('item.add', 2);
    bus.dispatch('item.add', 3);

    expect(state.value.items).toEqual([1, 2, 3]);
  });

  it('should return dispose function', () => {
    const { state, dispose } = useCommandState(
      { count: 0 },
      {
        'counter.increment': (s) => ({ count: s.count + 1 }),
      }
    );

    const bus = getCommandBus();

    bus.dispatch('counter.increment', {});
    expect(state.value.count).toBe(1);

    dispose();

    // After dispose, handler is unregistered
    const result = bus.dispatch('counter.increment', {});
    expect(result.ok).toBe(false);
  });
});

describe('useCommandHistory', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
  });

  it('should track command history', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { past, canUndo } = useCommandHistory();

    expect(past.value.length).toBe(0);
    expect(canUndo.value).toBe(false);

    bus.dispatch('test.action', { id: 1 });

    expect(past.value.length).toBe(1);
    expect(canUndo.value).toBe(true);
  });

  it('should undo commands', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { past, future, undo, canRedo } = useCommandHistory();

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });

    expect(past.value.length).toBe(2);

    const undone = undo();

    expect(undone?.target.id).toBe(2);
    expect(past.value.length).toBe(1);
    expect(future.value.length).toBe(1);
    expect(canRedo.value).toBe(true);
  });

  it('should redo commands', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { past, future, undo, redo } = useCommandHistory();

    bus.dispatch('test.action', { id: 1 });
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
    bus.register('test.action', () => 'done');

    const { past, future, undo, clear } = useCommandHistory();

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });
    undo();

    clear();

    expect(past.value.length).toBe(0);
    expect(future.value.length).toBe(0);
  });

  it('should respect filter option', () => {
    const bus = getCommandBus();
    bus.register('track.action', () => 'tracked');
    bus.register('other.action', () => 'not tracked');

    const { past } = useCommandHistory({
      filter: (cmd) => cmd.action.startsWith('track.'),
    });

    bus.dispatch('track.action', { id: 1 });
    bus.dispatch('other.action', { id: 2 });
    bus.dispatch('track.action', { id: 3 });

    expect(past.value.length).toBe(2);
  });

  it('should respect maxSize option', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { past } = useCommandHistory({ maxSize: 2 });

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });
    bus.dispatch('test.action', { id: 3 });

    expect(past.value.length).toBe(2);
    expect(past.value[0].target.id).toBe(2);
  });

  it('should return dispose function', () => {
    const bus = getCommandBus();
    bus.register('test.action', () => 'done');

    const { past, dispose } = useCommandHistory();

    bus.dispatch('test.action', { id: 1 });
    expect(past.value.length).toBe(1);

    dispose();

    bus.dispatch('test.action', { id: 2 });
    // After dispose, hook is unsubscribed, so history doesn't track
    expect(past.value.length).toBe(1);
  });
});

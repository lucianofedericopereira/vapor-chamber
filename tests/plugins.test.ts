import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { logger, validator, history, debounce, throttle } from '../src/plugins';

describe('logger plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should log command and result', () => {
    const bus = createCommandBus();
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const groupEnd = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger());
    bus.register('test.action', () => 'result');

    bus.dispatch('test.action', { id: 1 }, { extra: 'data' });

    expect(group).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('target:', { id: 1 });
    expect(log).toHaveBeenCalledWith('payload:', { extra: 'data' });
    expect(log).toHaveBeenCalledWith('result:', 'result');
    expect(groupEnd).toHaveBeenCalled();
  });

  it('should use console.group when collapsed is false', () => {
    const bus = createCommandBus();
    const group = vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ collapsed: false }));
    bus.register('test.action', () => 'result');

    bus.dispatch('test.action', {});

    expect(group).toHaveBeenCalled();
  });

  it('should respect filter option', () => {
    const bus = createCommandBus();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ filter: (cmd) => cmd.action.startsWith('cart.') }));
    bus.register('cart.add', () => 'cart');
    bus.register('user.login', () => 'user');

    bus.dispatch('cart.add', {});
    expect(log).toHaveBeenCalled();

    log.mockClear();

    bus.dispatch('user.login', {});
    expect(log).not.toHaveBeenCalled();
  });
});

describe('validator plugin', () => {
  it('should allow valid commands', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'test.action': () => null,
    }));
    bus.register('test.action', () => 'success');

    const result = bus.dispatch('test.action', {});

    expect(result.ok).toBe(true);
    expect(result.value).toBe('success');
  });

  it('should block invalid commands', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'test.action': () => 'Validation failed',
    }));
    bus.register('test.action', () => 'success');

    const result = bus.dispatch('test.action', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Validation failed');
  });

  it('should pass command to validator', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'test.action': (cmd) => cmd.target?.value > 0 ? null : 'Value must be positive',
    }));
    bus.register('test.action', () => 'success');

    expect(bus.dispatch('test.action', { value: 5 }).ok).toBe(true);
    expect(bus.dispatch('test.action', { value: -1 }).ok).toBe(false);
  });

  it('should skip unregistered actions', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'validated.action': () => 'Blocked',
    }));
    bus.register('other.action', () => 'success');

    const result = bus.dispatch('other.action', {});

    expect(result.ok).toBe(true);
  });
});

describe('history plugin', () => {
  it('should track successful commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('should not track failed commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.error', () => {
      throw new Error('Failed');
    });

    bus.dispatch('test.error', {});

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(0);
  });

  it('should undo commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });

    const undone = historyPlugin.undo();

    expect(undone?.target.id).toBe(2);
    expect(historyPlugin.getState().past.length).toBe(1);
    expect(historyPlugin.getState().future.length).toBe(1);
    expect(historyPlugin.getState().canRedo).toBe(true);
  });

  it('should redo commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    historyPlugin.undo();

    const redone = historyPlugin.redo();

    expect(redone?.target.id).toBe(1);
    expect(historyPlugin.getState().past.length).toBe(1);
    expect(historyPlugin.getState().future.length).toBe(0);
  });

  it('should clear future on new command', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });
    historyPlugin.undo();

    expect(historyPlugin.getState().future.length).toBe(1);

    bus.dispatch('test.action', { id: 3 });

    expect(historyPlugin.getState().future.length).toBe(0);
  });

  it('should respect maxSize', () => {
    const bus = createCommandBus();
    const historyPlugin = history({ maxSize: 2 });

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });
    bus.dispatch('test.action', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.past[0].target.id).toBe(2);
    expect(state.past[1].target.id).toBe(3);
  });

  it('should respect filter', () => {
    const bus = createCommandBus();
    const historyPlugin = history({
      filter: (cmd) => cmd.action.startsWith('track.'),
    });

    bus.use(historyPlugin);
    bus.register('track.action', () => 'tracked');
    bus.register('other.action', () => 'not tracked');

    bus.dispatch('track.action', { id: 1 });
    bus.dispatch('other.action', { id: 2 });
    bus.dispatch('track.action', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
  });

  it('should clear history', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('test.action', () => 'success');

    bus.dispatch('test.action', { id: 1 });
    historyPlugin.undo();

    historyPlugin.clear();

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(0);
    expect(state.future.length).toBe(0);
  });
});

describe('debounce plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should debounce specified actions', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(debounce(['test.action'], 100));
    bus.register('test.action', handler);

    // Same target = same debounce key
    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 1 });

    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not debounce unspecified actions', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(debounce(['debounced.action'], 100));
    bus.register('other.action', handler);

    bus.dispatch('other.action', {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should return pending status for debounced calls', () => {
    const bus = createCommandBus();

    bus.use(debounce(['test.action'], 100));
    bus.register('test.action', () => 'result');

    const result = bus.dispatch('test.action', {});

    expect(result.ok).toBe(true);
    expect(result.value?.pending).toBe(true);
  });

  it('should debounce per target', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(debounce(['test.action'], 100));
    bus.register('test.action', handler);

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });

    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe('throttle plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should execute first call immediately', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['test.action'], 100));
    bus.register('test.action', handler);

    const result = bus.dispatch('test.action', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.value).toBe('result');
  });

  it('should throttle subsequent calls', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['test.action'], 100));
    bus.register('test.action', handler);

    bus.dispatch('test.action', {});
    const throttled = bus.dispatch('test.action', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(throttled.value?.throttled).toBe(true);
  });

  it('should allow calls after wait period', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['test.action'], 100));
    bus.register('test.action', handler);

    bus.dispatch('test.action', {});

    vi.advanceTimersByTime(100);

    bus.dispatch('test.action', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should not throttle unspecified actions', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['throttled.action'], 100));
    bus.register('other.action', handler);

    bus.dispatch('other.action', {});
    bus.dispatch('other.action', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should throttle per target', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['test.action'], 100));
    bus.register('test.action', handler);

    bus.dispatch('test.action', { id: 1 });
    bus.dispatch('test.action', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

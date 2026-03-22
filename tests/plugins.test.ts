import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { logger, validator, history, debounce, throttle, authGuard, optimistic } from '../src/plugins';

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
    bus.register('testAction', () => 'result');

    bus.dispatch('testAction', { id: 1 }, { extra: 'data' });

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
    bus.register('testAction', () => 'result');

    bus.dispatch('testAction', {});

    expect(group).toHaveBeenCalled();
  });

  it('should respect filter option', () => {
    const bus = createCommandBus();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ filter: (cmd) => cmd.action.startsWith('cart') }));
    bus.register('cartAdd', () => 'cart');
    bus.register('userLogin', () => 'user');

    bus.dispatch('cartAdd', {});
    expect(log).toHaveBeenCalled();

    log.mockClear();

    bus.dispatch('userLogin', {});
    expect(log).not.toHaveBeenCalled();
  });
});

describe('validator plugin', () => {
  it('should allow valid commands', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'testAction': () => null,
    }));
    bus.register('testAction', () => 'success');

    const result = bus.dispatch('testAction', {});

    expect(result.ok).toBe(true);
    expect(result.value).toBe('success');
  });

  it('should block invalid commands', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'testAction': () => 'Validation failed',
    }));
    bus.register('testAction', () => 'success');

    const result = bus.dispatch('testAction', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Validation failed');
  });

  it('should pass command to validator', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'testAction': (cmd) => cmd.target?.value > 0 ? null : 'Value must be positive',
    }));
    bus.register('testAction', () => 'success');

    expect(bus.dispatch('testAction', { value: 5 }).ok).toBe(true);
    expect(bus.dispatch('testAction', { value: -1 }).ok).toBe(false);
  });

  it('should skip unregistered actions', () => {
    const bus = createCommandBus();

    bus.use(validator({
      'validatedAction': () => 'Blocked',
    }));
    bus.register('otherAction', () => 'success');

    const result = bus.dispatch('otherAction', {});

    expect(result.ok).toBe(true);
  });
});

describe('history plugin', () => {
  it('should track successful commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('should not track failed commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('testError', () => {
      throw new Error('Failed');
    });

    bus.dispatch('testError', {});

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(0);
  });

  it('should undo commands', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

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
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
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
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    historyPlugin.undo();

    expect(historyPlugin.getState().future.length).toBe(1);

    bus.dispatch('testAction', { id: 3 });

    expect(historyPlugin.getState().future.length).toBe(0);
  });

  it('should respect maxSize', () => {
    const bus = createCommandBus();
    const historyPlugin = history({ maxSize: 2 });

    bus.use(historyPlugin);
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    bus.dispatch('testAction', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.past[0].target.id).toBe(2);
    expect(state.past[1].target.id).toBe(3);
  });

  it('should respect filter', () => {
    const bus = createCommandBus();
    const historyPlugin = history({
      filter: (cmd) => cmd.action.startsWith('track'),
    });

    bus.use(historyPlugin);
    bus.register('trackAction', () => 'tracked');
    bus.register('otherAction', () => 'not tracked');

    bus.dispatch('trackAction', { id: 1 });
    bus.dispatch('otherAction', { id: 2 });
    bus.dispatch('trackAction', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
  });

  it('should clear history', () => {
    const bus = createCommandBus();
    const historyPlugin = history();

    bus.use(historyPlugin);
    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
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

    bus.use(debounce(['testAction'], 100));
    bus.register('testAction', handler);

    // Same target = same debounce key
    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 1 });

    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not debounce unspecified actions', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(debounce(['debouncedAction'], 100));
    bus.register('otherAction', handler);

    bus.dispatch('otherAction', {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should return pending status for debounced calls', () => {
    const bus = createCommandBus();

    bus.use(debounce(['testAction'], 100));
    bus.register('testAction', () => 'result');

    const result = bus.dispatch('testAction', {});

    expect(result.ok).toBe(true);
    expect(result.value?.pending).toBe(true);
  });

  it('should debounce per target', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(debounce(['testAction'], 100));
    bus.register('testAction', handler);

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

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

    bus.use(throttle(['testAction'], 100));
    bus.register('testAction', handler);

    const result = bus.dispatch('testAction', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.value).toBe('result');
  });

  it('should throttle subsequent calls', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['testAction'], 100));
    bus.register('testAction', handler);

    bus.dispatch('testAction', {});
    const throttled = bus.dispatch('testAction', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(throttled.ok).toBe(false);
    expect(throttled.error?.message).toBe('throttled');
  });

  it('should allow calls after wait period', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['testAction'], 100));
    bus.register('testAction', handler);

    bus.dispatch('testAction', {});

    vi.advanceTimersByTime(100);

    bus.dispatch('testAction', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should not throttle unspecified actions', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['throttledAction'], 100));
    bus.register('otherAction', handler);

    bus.dispatch('otherAction', {});
    bus.dispatch('otherAction', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should throttle per target', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.use(throttle(['testAction'], 100));
    bus.register('testAction', handler);

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

// ─── history with bus (undo executes inverse handler) ─────────────────────────

describe('history plugin with bus (undo/redo execution)', () => {
  it('should execute undo handler when bus is provided', () => {
    const bus = createCommandBus();
    const undoFn = vi.fn();

    bus.register('cartAdd', () => 'added', { undo: undoFn });

    const historyPlugin = history({ bus });
    bus.use(historyPlugin);

    bus.dispatch('cartAdd', { id: 1 });
    historyPlugin.undo();

    expect(undoFn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cartAdd', target: { id: 1 } })
    );
  });

  it('should re-dispatch on redo when bus is provided', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'result');

    bus.register('cartAdd', handler);

    const historyPlugin = history({ bus });
    bus.use(historyPlugin);

    bus.dispatch('cartAdd', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    historyPlugin.undo();
    historyPlugin.redo();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ─── authGuard plugin ─────────────────────────────────────────────────────────

describe('authGuard plugin', () => {
  it('should block protected actions when not authenticated', () => {
    const bus = createCommandBus();

    bus.use(authGuard({
      isAuthenticated: () => false,
      protected: ['shopCart', 'shopWishlist'],
    }));

    bus.register('shopCartAdd', () => 'added');
    bus.register('uiToast', () => 'toasted');

    const blocked = bus.dispatch('shopCartAdd', {});
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toContain('Unauthorized');

    const allowed = bus.dispatch('uiToast', {});
    expect(allowed.ok).toBe(true);
  });

  it('should allow when authenticated', () => {
    const bus = createCommandBus();

    bus.use(authGuard({
      isAuthenticated: () => true,
      protected: ['shopCart'],
    }));

    bus.register('shopCartAdd', () => 'added');
    expect(bus.dispatch('shopCartAdd', {}).ok).toBe(true);
  });

  it('should call onUnauthenticated callback', () => {
    const bus = createCommandBus();
    const callback = vi.fn();

    bus.use(authGuard({
      isAuthenticated: () => false,
      protected: ['shopCart'],
      onUnauthenticated: callback,
    }));

    bus.register('shopCartAdd', () => 'added');
    bus.dispatch('shopCartAdd', { productId: 123 });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shopCartAdd' })
    );
  });
});

// ─── optimistic plugin ────────────────────────────────────────────────────────

describe('optimistic plugin', () => {
  it('should keep optimistic update on success', () => {
    const bus = createCommandBus();
    const state = { count: 0 };

    bus.use(optimistic({
      'counterIncrement': {
        apply: () => { state.count++; return () => { state.count--; }; }
      }
    }));

    bus.register('counterIncrement', () => 'ok');
    bus.dispatch('counterIncrement', {});

    expect(state.count).toBe(1);
  });

  it('should rollback on failure', () => {
    const bus = createCommandBus();
    const state = { count: 0 };

    bus.use(optimistic({
      'counterIncrement': {
        apply: () => { state.count++; return () => { state.count--; }; }
      }
    }));

    bus.register('counterIncrement', () => { throw new Error('fail'); });
    bus.dispatch('counterIncrement', {});

    expect(state.count).toBe(0);
  });
});

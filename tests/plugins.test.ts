/**
 * The logger, validator, history and authGuard plugins from src/plugins, and register({ optimistic }).
 * Why: the logger must show each dispatch at the configured level and style, a validator or auth guard must refuse before the handler runs with the plugin as owner, history must undo and redo without recording its own triggers, and an optimistic change must roll back on failure.
 * Shows: logger output (target, payload, result, collapsed, filter, level, badges with and without `window`); validator allow, block, command argument and skip of unlisted actions; history tracking, undo, redo, future cleared by a new command, maxSize, filter, clear, trigger actions excluded from recording and removed by dispose(), and undo/redo run through the bus; authGuard blocks protected actions as `unauthenticated`, allows when signed in and calls onUnauthenticated; an optimistic update is kept on success and undone on failure.
 * See: docs/contract.md.
 */
import { conditionOf } from '../src/command-bus';
import { describe, expect, vi, } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { logger, validator, history, authGuard } from '../src/plugins';
import { stubGlobal } from '../src/vitest-pure';
import { it } from '../src/vitest';

describe('logger plugin', () => {

  it('should log command and result', ({ bus }) => {
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

  it('should use console.group when collapsed is false', ({ bus }) => {
    const group = vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ collapsed: false }));
    bus.register('testAction', () => 'result');

    bus.dispatch('testAction', {});

    expect(group).toHaveBeenCalled();
  });

  it('should respect filter option', ({ bus }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ actions: ['cart*'] }));
    bus.register('cartAdd', () => 'cart');
    bus.register('userLogin', () => 'user');

    bus.dispatch('cartAdd', {});
    expect(log).toHaveBeenCalled();

    log.mockClear();

    bus.dispatch('userLogin', {});
    expect(log).not.toHaveBeenCalled();
  });

  it('level: "warn" suppresses ok dispatches but still logs failures', ({ bus }) => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ level: 'warn' }));
    bus.register('quietAction', () => 'fine');

    bus.dispatch('quietAction', {}); // ok -> info -> suppressed
    expect(group).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    bus.dispatch('missingAction', {}); // no handler -> error -> logged
    expect(group).toHaveBeenCalledWith('⚡ missingAction');
    expect(error).toHaveBeenCalledWith('error:', expect.anything());
  });

  it('level: "debug" keeps logging ok dispatches like the default', ({ bus }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ level: 'debug' }));
    bus.register('act', () => 'ok');
    bus.dispatch('act', {});

    expect(log).toHaveBeenCalledWith('result:', 'ok');
  });

  it('badges: true prefixes fixed-width [  OK  ] / [ FAIL ] badges (plain text in Node)', ({ bus }) => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ badges: true }));
    bus.register('goodAction', () => 'ok');

    bus.dispatch('goodAction', {});
    expect(group).toHaveBeenCalledWith('[  OK  ] ⚡ goodAction');

    bus.dispatch('badAction', {}); // no handler -> failure
    expect(group).toHaveBeenCalledWith('[ FAIL ] ⚡ badAction');
  });

  it('badges: true uses %c styling when window exists', () => {
    using _window = stubGlobal('window', {});
    const bus = createCommandBus();
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(logger({ badges: true }));
    bus.register('act', () => 'ok');
    bus.dispatch('act', {});

    expect(group).toHaveBeenCalledWith(
      '%c[  OK  ]%c ⚡ act',
      expect.stringContaining('monospace'),
      '',
    );
  });
});

describe('validator plugin', () => {
  it('should allow valid commands', ({ bus }) => {

    bus.use(validator({
      'testAction': () => null,
    }));
    bus.register('testAction', () => 'success');

    const result = bus.dispatch('testAction', {});

    expect(result).toSucceedWith('success');
  });

  it('should block invalid commands', ({ bus }) => {

    bus.use(validator({
      'testAction': () => 'Validation failed',
    }));
    bus.register('testAction', () => 'success');

    const result = bus.dispatch('testAction', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Validation failed');
  });

  it('should pass command to validator', ({ bus }) => {

    bus.use(validator({
      'testAction': (cmd) => cmd.target?.value > 0 ? null : 'Value must be positive',
    }));
    bus.register('testAction', () => 'success');

    expect(bus.dispatch('testAction', { value: 5 }).ok).toBe(true);
    expect(bus.dispatch('testAction', { value: -1 }).ok).toBe(false);
  });

  it('should skip unregistered actions', ({ bus }) => {

    bus.use(validator({
      'validatedAction': () => 'Blocked',
    }));
    bus.register('otherAction', () => 'success');

    const result = bus.dispatch('otherAction', {});

    expect(result.ok).toBe(true);
  });
});

describe('history plugin - undoAction/redoAction triggers', () => {
  it('repeated undo + redo work when triggers are dispatched through the bus (cart scenario)', ({ bus }) => {
    let total = 0;
    const h = history({ bus, undoAction: 'cart.undo', redoAction: 'cart.redo' });
    bus.register('cart.add', (cmd) => { total += cmd.target as number; }, {
      undo: (cmd) => { total -= cmd.target as number; },
    });

    bus.dispatch('cart.add', 1);
    bus.dispatch('cart.add', 2);
    expect(total).toBe(3);

    // A trigger recorded into history would make the second undo pop the trigger and wipe the redo stack.
    bus.dispatch('cart.undo', {});
    bus.dispatch('cart.undo', {}); // must also apply
    expect(total).toBe(0);
    expect(h.getState().canRedo).toBe(true); // redo stack survives

    bus.dispatch('cart.redo', {});
    expect(total).toBe(1);
    expect(h.getState().past.length).toBe(1);
  });

  it('trigger actions are excluded from recording even if filter matches them', ({ bus }) => {
    const h = history({
      bus,
      actions: ['cart*'],
      undoAction: 'cart.undo',
      redoAction: 'cart.redo',
    });
    bus.register('cart.add', () => 'ok');

    bus.dispatch('cart.add', 1);
    bus.dispatch('cart.undo', {});
    expect(h.getState().past.length).toBe(0);
    expect(h.getState().future.length).toBe(1); // not wiped by recording the trigger
  });

  it('dispose() unregisters the trigger handlers', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const h = history({ bus, undoAction: 'u', redoAction: 'r' });
    expect(bus.hasHandler('u')).toBe(true);
    h.dispose();
    expect(bus.hasHandler('u')).toBe(false);
    expect(bus.hasHandler('r')).toBe(false);
  });
});

describe('history plugin', () => {
  it('should track successful commands', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it('should not track failed commands', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testError', () => {
      throw new Error('Failed');
    });

    bus.dispatch('testError', {});

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(0);
  });

  it('should undo commands', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });

    const undone = historyPlugin.undo();

    expect(undone?.target.id).toBe(2);
    expect(historyPlugin.getState().past.length).toBe(1);
    expect(historyPlugin.getState().future.length).toBe(1);
    expect(historyPlugin.getState().canRedo).toBe(true);
  });

  it('should redo commands', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    historyPlugin.undo();

    const redone = historyPlugin.redo();

    expect(redone?.target.id).toBe(1);
    expect(historyPlugin.getState().past.length).toBe(1);
    expect(historyPlugin.getState().future.length).toBe(0);
  });

  it('should clear future on new command', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    historyPlugin.undo();

    expect(historyPlugin.getState().future.length).toBe(1);

    bus.dispatch('testAction', { id: 3 });

    expect(historyPlugin.getState().future.length).toBe(0);
  });

  it('should respect maxSize', ({ bus }) => {
    const historyPlugin = history({ bus, maxSize: 2 });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    bus.dispatch('testAction', { id: 2 });
    bus.dispatch('testAction', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
    expect(state.past[0].target.id).toBe(2);
    expect(state.past[1].target.id).toBe(3);
  });

  it('should respect filter', ({ bus }) => {
    const historyPlugin = history({
      bus,
      actions: ['track*'],
    });

    bus.register('trackAction', () => 'tracked');
    bus.register('otherAction', () => 'not tracked');

    bus.dispatch('trackAction', { id: 1 });
    bus.dispatch('otherAction', { id: 2 });
    bus.dispatch('trackAction', { id: 3 });

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(2);
  });

  it('should clear history', ({ bus }) => {
    const historyPlugin = history({ bus });

    bus.register('testAction', () => 'success');

    bus.dispatch('testAction', { id: 1 });
    historyPlugin.undo();

    historyPlugin.clear();

    const state = historyPlugin.getState();
    expect(state.past.length).toBe(0);
    expect(state.future.length).toBe(0);
  });
});

describe('history plugin with bus (undo/redo execution)', () => {
  it('should execute undo handler when bus is provided', ({ bus }) => {
    const undoFn = vi.fn();

    bus.register('cartAdd', () => 'added', { undo: undoFn });

    const historyPlugin = history({ bus });

    bus.dispatch('cartAdd', { id: 1 });
    historyPlugin.undo();

    expect(undoFn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cartAdd', target: { id: 1 } })
    );
  });

  it('should re-dispatch on redo when bus is provided', ({ bus }) => {
    const handler = vi.fn(() => 'result');

    bus.register('cartAdd', handler);

    const historyPlugin = history({ bus });

    bus.dispatch('cartAdd', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    historyPlugin.undo();
    historyPlugin.redo();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('authGuard plugin', () => {
  it('should block protected actions when not authenticated', ({ bus }) => {

    bus.use(authGuard({
      isAuthenticated: () => false,
      protected: ['shopCart*', 'shopWishlist*'],
    }));

    bus.register('shopCartAdd', () => 'added');
    bus.register('uiToast', () => 'toasted');

    const blocked = bus.dispatch('shopCartAdd', {});
    // No session is `unauthenticated`, not `refused`.
    expect(blocked).toFailWith('authGuard:unauthenticated:action');
    expect(conditionOf(blocked.error)).toBe('unauthenticated');
    expect(blocked.error?.message).toContain('Unauthorized');

    const allowed = bus.dispatch('uiToast', {});
    expect(allowed.ok).toBe(true);
  });

  it('should allow when authenticated', ({ bus }) => {

    bus.use(authGuard({
      isAuthenticated: () => true,
      protected: ['shopCart*'],
    }));

    bus.register('shopCartAdd', () => 'added');
    expect(bus.dispatch('shopCartAdd', {}).ok).toBe(true);
  });

  it('should call onUnauthenticated callback', ({ bus }) => {
    const callback = vi.fn();

    bus.use(authGuard({
      isAuthenticated: () => false,
      protected: ['shopCart*'],
      onUnauthenticated: callback,
    }));

    bus.register('shopCartAdd', () => 'added');
    bus.dispatch('shopCartAdd', { productId: 123 });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shopCartAdd' })
    );
  });
});

describe('register optimistic', () => {
  it('keeps the change on success', ({ bus }) => {
    const state = { count: 0 };
    bus.register('counterIncrement', () => { state.count++; return 'ok'; }, { undo: () => { state.count--; }, optimistic: true });
    bus.dispatch('counterIncrement', {});
    expect(state.count).toBe(1);
  });

  it('rolls back on failure', ({ bus }) => {
    const state = { count: 0 };
    bus.register('counterIncrement', () => { state.count++; throw new Error('fail'); }, { undo: () => { state.count--; }, optimistic: true });
    bus.dispatch('counterIncrement', {});
    expect(state.count).toBe(0);
  });
});


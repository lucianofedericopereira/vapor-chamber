/**
 * Tests for src/chamber-vapor.ts — Vue 3.6+ Vapor API
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVaporChamberApp, getVaporInteropPlugin, defineVaporCommand, useVaporCommand } from '../src/chamber-vapor';
import { getCommandBus, resetCommandBus } from '../src/chamber';

beforeEach(() => {
  resetCommandBus();
});

afterEach(() => {
  resetCommandBus();
});

describe('createVaporChamberApp', () => {
  it('throws when Vapor is not available (no Vue 3.6+)', () => {
    expect(() => createVaporChamberApp({})).toThrow(
      /Vue 3\.6\+ with Vapor mode required/
    );
  });

  it('error message mentions installation instructions', () => {
    try {
      createVaporChamberApp({});
    } catch (e: any) {
      expect(e.message).toContain('vue@^3.6.0-beta.1');
      expect(e.message).toContain('createApp()');
    }
  });
});

describe('getVaporInteropPlugin', () => {
  it('returns null when Vapor is not available', () => {
    // In test environment without Vue 3.6, this should return null/undefined
    const result = getVaporInteropPlugin();
    expect(result == null).toBe(true);
  });
});

describe('defineVaporCommand', () => {
  it('registers a handler and returns dispatch function', () => {
    const handler = vi.fn((cmd) => cmd.target.qty * 2);
    const { dispatch, dispose } = defineVaporCommand('quickCalc', handler);

    const result = dispatch({ qty: 5 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
    expect(handler).toHaveBeenCalledOnce();

    dispose();
  });

  it('dispatch passes target and payload correctly', () => {
    const handler = vi.fn();
    const { dispatch, dispose } = defineVaporCommand('track', handler);

    dispatch({ event: 'click' }, { meta: 'info' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'track',
        target: { event: 'click' },
        payload: { meta: 'info' },
      })
    );

    dispose();
  });

  it('dispose unregisters the handler', () => {
    const handler = vi.fn();
    const { dispose } = defineVaporCommand('temp', handler);

    const bus = getCommandBus();
    expect(bus.hasHandler('temp')).toBe(true);

    dispose();
    expect(bus.hasHandler('temp')).toBe(false);
  });

  it('supports undo option', () => {
    const undo = vi.fn();
    const { dispose } = defineVaporCommand('withUndo', vi.fn(), { undo });

    const bus = getCommandBus();
    expect(bus.getUndoHandler('withUndo')).toBe(undo);

    dispose();
  });

  it('works with high-frequency dispatches (fire-and-forget)', () => {
    let count = 0;
    const { dispatch, dispose } = defineVaporCommand('counter', () => ++count);

    for (let i = 0; i < 1000; i++) {
      dispatch({});
    }

    expect(count).toBe(1000);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// useVaporCommand
// ---------------------------------------------------------------------------

describe('useVaporCommand', () => {
  it('dispatches commands and tracks loading/error reactively', () => {
    const bus = getCommandBus();
    bus.register('vaporAdd', (cmd) => cmd.target.id);

    const { dispatch, loading, lastError, dispose } = useVaporCommand();

    expect(loading.value).toBe(false);
    expect(lastError.value).toBe(null);

    const result = dispatch('vaporAdd', { id: 42 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    // After sync dispatch, loading is back to false
    expect(loading.value).toBe(false);
    expect(lastError.value).toBe(null);

    dispose();
  });

  it('captures errors in lastError signal', () => {
    const bus = getCommandBus();
    bus.register('vaporFail', () => { throw new Error('vapor-boom'); });

    const { dispatch, lastError, dispose } = useVaporCommand();

    const result = dispatch('vaporFail', {});
    expect(result.ok).toBe(false);
    expect(lastError.value).toBeInstanceOf(Error);
    expect(lastError.value?.message).toBe('vapor-boom');

    dispose();
  });

  it('register() adds handlers through the composable', () => {
    const handler = vi.fn(() => 'registered');
    const { register, dispatch, dispose } = useVaporCommand();

    register('vaporReg', handler);
    const result = dispatch('vaporReg', { x: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('registered');
    expect(handler).toHaveBeenCalledOnce();

    dispose();
  });

  it('on() subscribes to patterns through the composable', () => {
    const listener = vi.fn();
    const bus = getCommandBus();
    bus.register('vaporEvt', () => 'ok');

    const { on, dispose } = useVaporCommand();
    on('vaporEvt', listener);

    bus.dispatch('vaporEvt', {});
    expect(listener).toHaveBeenCalledOnce();

    dispose();
  });

  it('dispose() cleans up all registrations and subscriptions', () => {
    const handler = vi.fn();
    const listener = vi.fn();
    const bus = getCommandBus();

    const { register, on, dispose } = useVaporCommand();
    register('vaporClean', handler);
    on('vaporClean', listener);

    expect(bus.hasHandler('vaporClean')).toBe(true);

    dispose();

    expect(bus.hasHandler('vaporClean')).toBe(false);
    // Listener should not fire after dispose
    bus.register('vaporClean', () => 'post-dispose');
    bus.dispatch('vaporClean', {});
    expect(listener).not.toHaveBeenCalled();
  });
});

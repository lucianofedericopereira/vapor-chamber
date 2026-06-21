/**
 * Tests for src/chamber-vapor.ts — Vue 3.6+ Vapor API
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVaporChamberApp, getVaporInteropPlugin, defineVaporCommand, defineVaporCustomElement, defineVaporComponent, defineVaporAsyncComponent, useVaporAsyncCommand } from '../src/chamber-vapor';
import { getCommandBus, resetCommandBus, setCommandBus, useCommand } from '../src/chamber';
import { createAsyncCommandBus } from '../src/command-bus';

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
// useCommand — full composable (register / on / emit / dispose)
// ---------------------------------------------------------------------------

describe('useCommand — register/on/emit/dispose', () => {
  it('dispatches commands and tracks loading/error reactively', () => {
    const bus = getCommandBus();
    bus.register('vaporAdd', (cmd) => cmd.target.id);

    const { dispatch, loading, lastError, dispose } = useCommand();

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

    const { dispatch, lastError, dispose } = useCommand();

    const result = dispatch('vaporFail', {});
    expect(result.ok).toBe(false);
    expect(lastError.value).toBeInstanceOf(Error);
    expect(lastError.value?.message).toBe('vapor-boom');

    dispose();
  });

  it('register() adds handlers through the composable', () => {
    const handler = vi.fn(() => 'registered');
    const { register, dispatch, dispose } = useCommand();

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

    const { on, dispose } = useCommand();
    on('vaporEvt', listener);

    bus.dispatch('vaporEvt', {});
    expect(listener).toHaveBeenCalledOnce();

    dispose();
  });

  it('dispose() cleans up all registrations and subscriptions', () => {
    const handler = vi.fn();
    const listener = vi.fn();
    const bus = getCommandBus();

    const { register, on, dispose } = useCommand();
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

  it('emit() fires domain events through the bus', () => {
    const listener = vi.fn();
    const bus = getCommandBus();
    bus.on('cartUpdated', listener);

    const { emit, dispose } = useCommand();
    emit('cartUpdated', { itemCount: 5 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cartUpdated', target: { itemCount: 5 } }),
      expect.objectContaining({ ok: true }),
    );

    dispose();
  });

  it('loading stays true until async handler resolves', async () => {
    const asyncBus = createAsyncCommandBus();
    setCommandBus(asyncBus as any);

    asyncBus.register('asyncFetch', async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'fetched';
    });

    const { dispatch, loading, lastError, dispose } = useCommand();

    const resultPromise = dispatch('asyncFetch', {});
    expect(loading.value).toBe(true);

    const result = await resultPromise;

    expect(loading.value).toBe(false);
    expect(result.ok).toBe(true);
    expect(lastError.value).toBeNull();

    dispose();
  });
});

// ---------------------------------------------------------------------------
// Vue 3.6.0-beta.10+ APIs
// ---------------------------------------------------------------------------

describe('defineVaporCustomElement', () => {
  it('returns null when Vue 3.6.0-beta.10 is not available', () => {
    expect(defineVaporCustomElement({})).toBeNull();
  });
});

describe('defineVaporComponent', () => {
  it('returns null when Vue 3.6.0-beta.10 is not available', () => {
    expect(defineVaporComponent({})).toBeNull();
  });

  // Vue 3.6.0-beta.11 alignment (#14770 + emit/$attrs split):
  // wrapper must forward options unchanged so generic inference and the
  // emits-vs-attrs separation flow through to Vue without modification.
  it('passes options through unchanged so beta.11 attrs/emits + generics flow through', async () => {
    const chamber = await import('../src/chamber');
    const fakeDefine = vi.fn((options: any) => ({ __defined: true, options }));
    const spy = vi.spyOn(chamber, 'getDefineVaporComponentFn').mockReturnValue(fakeDefine);
    try {
      const options = {
        props: { label: String },
        emits: ['select'],
        setup: () => () => null,
      };
      const result = defineVaporComponent(options);
      expect(spy).toHaveBeenCalled();
      expect(fakeDefine).toHaveBeenCalledTimes(1);
      // Critical: the wrapper must NOT mutate or strip emits — beta.11 relies on
      // the declared emits list to keep onXxx listeners out of $attrs.
      expect(fakeDefine.mock.calls[0]![0]).toBe(options);
      expect(fakeDefine.mock.calls[0]![0].emits).toEqual(['select']);
      expect((result as any).__defined).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('defineVaporAsyncComponent', () => {
  // Vue 3.6.0-beta.14: defineVaporAsyncComponent is now exported from the main
  // Vue package (vapor: expose async component alias for SSR runtime). The
  // wrapper calls through to it when available, and returns null otherwise.
  it('returns null when the fn is not available (mocked)', async () => {
    const chamber = await import('../src/chamber');
    const spy = vi.spyOn(chamber, 'getDefineVaporAsyncComponentFn').mockReturnValue(null);
    try {
      expect(defineVaporAsyncComponent(() => Promise.resolve({}))).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('calls through to Vue defineVaporAsyncComponent when available (beta.14+)', async () => {
    const loader = () => Promise.resolve({ setup: () => null });
    const fakeResult = { __asyncLoader: loader, name: 'AsyncComponentWrapper' };
    const fakeDefine = vi.fn(() => fakeResult);
    const chamber = await import('../src/chamber');
    const spy = vi.spyOn(chamber, 'getDefineVaporAsyncComponentFn').mockReturnValue(fakeDefine);
    try {
      const result = defineVaporAsyncComponent(loader);
      expect(fakeDefine).toHaveBeenCalledWith(loader);
      expect(result).toBe(fakeResult);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// useVaporAsyncCommand
// ---------------------------------------------------------------------------

describe('useVaporAsyncCommand', () => {
  beforeEach(() => resetCommandBus());

  it('dispatches async commands with reactive loading', async () => {
    const asyncBus = createAsyncCommandBus();
    asyncBus.register('orderCreate', async () => {
      await new Promise(r => setTimeout(r, 10));
      return { orderId: 123 };
    });

    const { dispatch, loading, lastError, dispose } = useVaporAsyncCommand(asyncBus);

    const resultPromise = dispatch('orderCreate', { items: [1, 2] });
    expect(loading.value).toBe(true);

    const result = await resultPromise;
    expect(loading.value).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ orderId: 123 });
    expect(lastError.value).toBeNull();

    dispose();
  });

  it('captures async errors in lastError', async () => {
    const asyncBus = createAsyncCommandBus();
    asyncBus.register('fail', async () => { throw new Error('async fail'); });

    const { dispatch, loading, lastError, dispose } = useVaporAsyncCommand(asyncBus);

    const result = await dispatch('fail', {});
    expect(loading.value).toBe(false);
    expect(result.ok).toBe(false);
    expect(lastError.value?.message).toBe('async fail');

    dispose();
  });
});

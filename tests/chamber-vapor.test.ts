/**
 * Tests for src/chamber-vapor.ts - Vue 3.6+ Vapor API
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

  it('error message diagnoses WHY detection failed, not just that it did', () => {
    // The old assertion sat inside a bare try/catch with no `expect.assertions`,
    // so it also passed when nothing threw at all. Assert on the thrown value
    // directly instead - the failure mode this test exists to catch is the
    // message going vague, and it cannot catch that if it can pass vacuously.
    expect(() => createVaporChamberApp({})).toThrow(/Vue 3\.6\+ with Vapor mode required/);

    let message = '';
    try { createVaporChamberApp({}); } catch (e) { message = (e as Error).message; }

    // Three different problems, one message each: Vue absent, Vue present
    // without the Vapor build, and Vue present but unreachable through either
    // detection channel. The hint names which one applies.
    expect(message).toMatch(/configureVue\(/);
    expect(message).toContain('createApp()');
    // No version literal in the message: one goes stale with every release.
    expect(message).not.toContain('beta.1');
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
    expect(result).toSucceedWith(10);
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
// useCommand - full composable (register / on / emit / dispose)
// ---------------------------------------------------------------------------

describe('useCommand - register/on/emit/dispose', () => {
  it('dispatches commands, and pending tracks the key', () => {
    const bus = getCommandBus();
    let during = false;
    bus.register('vaporAdd', (cmd) => { during = key.value; return cmd.target.id; });

    const { dispatch, pending, dispose } = useCommand();
    const key = pending('vaporAdd', { id: 42 });

    expect(key.value).toBe(false);
    const result = dispatch('vaporAdd', { id: 42 });
    expect(result).toSucceedWith(42);
    expect({ during, after: key.value }).toEqual({ during: true, after: false });

    dispose();
  });

  it('a failure is the dispatch\'s own result', () => {
    const bus = getCommandBus();
    bus.register('vaporFail', () => { throw new Error('vapor-boom'); });

    const { dispatch, dispose } = useCommand();

    const result = dispatch('vaporFail', {}) as { ok: boolean; error?: Error };
    expect({ ok: result.ok, message: result.error?.message }).toEqual({ ok: false, message: 'vapor-boom' });

    dispose();
  });

  it('register() adds handlers through the composable', () => {
    const handler = vi.fn(() => 'registered');
    const { register, dispatch, dispose } = useCommand();

    register('vaporReg', handler);
    const result = dispatch('vaporReg', { x: 1 });
    expect(result).toSucceedWith('registered');
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

  it('pending stays true until the async handler resolves', async () => {
    const asyncBus = createAsyncCommandBus();
    setCommandBus(asyncBus as any);

    asyncBus.register('asyncFetch', async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'fetched';
    });

    const { dispatch, pending, dispose } = useCommand();
    const key = pending('asyncFetch', {});

    const resultPromise = dispatch('asyncFetch', {});
    expect(key.value).toBe(true);

    const result = await resultPromise;

    expect(key.value).toBe(false);
    expect(result.ok).toBe(true);

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
    using spy = vi.spyOn(chamber, 'getDefineVaporComponentFn').mockReturnValue(fakeDefine);
    const options = {
      props: { label: String },
      emits: ['select'],
      setup: () => () => null,
    };
    const result = defineVaporComponent(options);
    expect(spy).toHaveBeenCalled();
    expect(fakeDefine).toHaveBeenCalledTimes(1);
    // Critical: the wrapper must NOT mutate or strip emits - beta.11 relies on
    // the declared emits list to keep onXxx listeners out of $attrs.
    expect(fakeDefine.mock.calls[0]![0]).toBe(options);
    expect(fakeDefine.mock.calls[0]![0].emits).toEqual(['select']);
    expect((result as any).__defined).toBe(true);
  });
});

describe('defineVaporAsyncComponent', () => {
  // Vue 3.6.0-beta.14: defineVaporAsyncComponent is now exported from the main
  // Vue package (vapor: expose async component alias for SSR runtime). The
  // wrapper calls through to it when available, and returns null otherwise.
  it('returns null when the fn is not available (mocked)', async () => {
    const chamber = await import('../src/chamber');
    using _spy = vi.spyOn(chamber, 'getDefineVaporAsyncComponentFn').mockReturnValue(null);
    expect(defineVaporAsyncComponent(() => Promise.resolve({}))).toBeNull();
  });

  it('calls through to Vue defineVaporAsyncComponent when available (beta.14+)', async () => {
    const loader = () => Promise.resolve({ setup: () => null });
    const fakeResult = { __asyncLoader: loader, name: 'AsyncComponentWrapper' };
    const fakeDefine = vi.fn(() => fakeResult);
    const chamber = await import('../src/chamber');
    using _spy = vi.spyOn(chamber, 'getDefineVaporAsyncComponentFn').mockReturnValue(fakeDefine);
    const result = defineVaporAsyncComponent(loader);
    expect(fakeDefine).toHaveBeenCalledWith(loader);
    expect(result).toBe(fakeResult);
  });
});

// ---------------------------------------------------------------------------
// useVaporAsyncCommand
// ---------------------------------------------------------------------------

describe('useVaporAsyncCommand', () => {
  beforeEach(() => resetCommandBus());

  it('dispatches async commands, and pending tracks the key', async () => {
    const asyncBus = createAsyncCommandBus();
    asyncBus.register('orderCreate', async () => {
      await new Promise(r => setTimeout(r, 10));
      return { orderId: 123 };
    });

    const { dispatch, pending, dispose } = useVaporAsyncCommand(asyncBus);
    const key = pending('orderCreate', { items: [1, 2] });

    const resultPromise = dispatch('orderCreate', { items: [1, 2] });
    expect(key.value).toBe(true);

    const result = await resultPromise;
    expect(key.value).toBe(false);
    expect(result).toSucceedWith({ orderId: 123 });

    dispose();
  });

  it('an async failure is the dispatch\'s own result', async () => {
    const asyncBus = createAsyncCommandBus();
    asyncBus.register('fail', async () => { throw new Error('async fail'); });

    const { dispatch, dispose } = useVaporAsyncCommand(asyncBus);

    const result = await dispatch('fail', {});
    expect({ ok: result.ok, message: result.error?.message }).toEqual({ ok: false, message: 'async fail' });

    dispose();
  });

  it('a dispatch that rejects is a failed result', async () => {
    const boom = new Error('rejected');
    const asyncBus = { dispatch: () => Promise.reject(boom) };

    const { dispatch } = useVaporAsyncCommand(asyncBus as never); // a stub bus: only `dispatch` is exercised
    expect(await dispatch('x', {})).toEqual({ ok: false, error: boom, value: undefined });
  });

  it('defaults to the shared command bus when no asyncBus is given', async () => {
    const bus = getCommandBus();
    bus.register('shared', (cmd) => ({ echoed: cmd.target }));

    const { dispatch } = useVaporAsyncCommand();
    const result = await dispatch('shared', { id: 1 });

    expect(result).toSucceedWith({ echoed: { id: 1 } });
  });
});

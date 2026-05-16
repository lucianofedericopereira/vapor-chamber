import { describe, it, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus, configureUid } from '../src/command-bus';

describe('createCommandBus', () => {
  describe('dispatch', () => {
    it('should return error when no handler registered', () => {
      const bus = createCommandBus();
      const result = bus.dispatch('unknownAction', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('No handler');
    });

    it('should execute registered handler', () => {
      const bus = createCommandBus();
      bus.register('testAction', (cmd) => cmd.target.value * 2);

      const result = bus.dispatch('testAction', { value: 5 });

      expect(result.ok).toBe(true);
      expect(result.value).toBe(10);
    });

    it('should pass action, target, and payload to handler', () => {
      const bus = createCommandBus();
      const handler = vi.fn((cmd) => cmd);

      bus.register('testAction', handler);
      bus.dispatch('testAction', { id: 1 }, { extra: 'data' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        action: 'testAction',
        target: { id: 1 },
        payload: { extra: 'data' },
      }));
    });

    it('should catch handler errors and return error result', () => {
      const bus = createCommandBus();
      bus.register('testError', () => {
        throw new Error('Handler failed');
      });

      const result = bus.dispatch('testError', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Handler failed');
    });
  });

  describe('register', () => {
    it('should return unregister function', () => {
      const bus = createCommandBus();
      const unregister = bus.register('testAction', () => 'result');

      expect(bus.dispatch('testAction', {}).ok).toBe(true);

      unregister();

      expect(bus.dispatch('testAction', {}).ok).toBe(false);
    });

    it('should replace existing handler', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bus = createCommandBus();
      bus.register('testAction', () => 'first');
      bus.register('testAction', () => 'second');

      const result = bus.dispatch('testAction', {});

      expect(result.value).toBe('second');
      vi.restoreAllMocks();
    });
  });

  describe('use (plugins)', () => {
    it('should execute plugin before handler', () => {
      const bus = createCommandBus();
      const order: string[] = [];

      bus.use((cmd, next) => {
        order.push('plugin-before');
        const result = next();
        order.push('plugin-after');
        return result;
      });

      bus.register('testAction', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('testAction', {});

      expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
    });

    it('should allow plugin to short-circuit', () => {
      const bus = createCommandBus();
      const handler = vi.fn(() => 'handler-result');

      bus.use((cmd, next) => {
        return { ok: false, error: new Error('Blocked') };
      });

      bus.register('testAction', handler);

      const result = bus.dispatch('testAction', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Blocked');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should execute plugins in order (first = outermost)', () => {
      const bus = createCommandBus();
      const order: string[] = [];

      bus.use((cmd, next) => {
        order.push('plugin1-before');
        const result = next();
        order.push('plugin1-after');
        return result;
      });

      bus.use((cmd, next) => {
        order.push('plugin2-before');
        const result = next();
        order.push('plugin2-after');
        return result;
      });

      bus.register('testAction', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('testAction', {});

      expect(order).toEqual([
        'plugin1-before',
        'plugin2-before',
        'handler',
        'plugin2-after',
        'plugin1-after',
      ]);
    });

    it('should return unsubscribe function', () => {
      const bus = createCommandBus();
      const plugin = vi.fn((cmd, next) => next());

      const unsubscribe = bus.use(plugin);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', {});
      expect(plugin).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('testAction', {});
      expect(plugin).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAfter (hooks)', () => {
    it('should run after hooks after dispatch', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', { id: 1 });

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'testAction', target: { id: 1 }, payload: undefined }),
        { ok: true, value: 'result' }
      );
    });

    it('should run hook even on error', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('testError', () => {
        throw new Error('Oops');
      });

      bus.dispatch('testError', {});

      expect(hook).toHaveBeenCalled();
      expect(hook.mock.calls[0][1].ok).toBe(false);
    });

    it('should catch hook errors silently', () => {
      const bus = createCommandBus();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.onAfter(() => {
        throw new Error('Hook error');
      });
      bus.register('testAction', () => 'result');

      const result = bus.dispatch('testAction', {});

      expect(result.ok).toBe(true);
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    it('should return unsubscribe function', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      const unsubscribe = bus.onAfter(hook);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', {});
      expect(hook).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('testAction', {});
      expect(hook).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createAsyncCommandBus', () => {
  it('should handle async handlers', async () => {
    const bus = createAsyncCommandBus();

    bus.register('asyncAction', async (cmd) => {
      await new Promise((r) => setTimeout(r, 10));
      return cmd.target.value * 2;
    });

    const result = await bus.dispatch('asyncAction', { value: 5 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
  });

  it('should catch async errors', async () => {
    const bus = createAsyncCommandBus();

    bus.register('asyncError', async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('Async error');
    });

    const result = await bus.dispatch('asyncError', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Async error');
  });

  it('should support async plugins', async () => {
    const bus = createAsyncCommandBus();
    const order: string[] = [];

    bus.use(async (cmd, next) => {
      order.push('plugin-before');
      await new Promise((r) => setTimeout(r, 5));
      const result = await next();
      order.push('plugin-after');
      return result;
    });

    bus.register('asyncAction', async () => {
      order.push('handler');
      return 'done';
    });

    await bus.dispatch('asyncAction', {});

    expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
  });

  it('should support async hooks', async () => {
    const bus = createAsyncCommandBus();
    const hookCalled = vi.fn();

    bus.onAfter(async (cmd, result) => {
      await new Promise((r) => setTimeout(r, 5));
      hookCalled(result);
    });

    bus.register('asyncAction', async () => 'result');

    await bus.dispatch('asyncAction', {});

    expect(hookCalled).toHaveBeenCalledWith({ ok: true, value: 'result' });
  });
});

// ---------------------------------------------------------------------------
// configureUid
// ---------------------------------------------------------------------------

describe('configureUid', () => {
  it('replaces the id generator used by stampMeta', () => {
    let counter = 0;
    configureUid(() => `test-${++counter}`);

    const bus = createCommandBus();
    bus.register('op', (cmd) => cmd.meta?.id);
    const r1 = bus.dispatch('op', {});
    const r2 = bus.dispatch('op', {});

    // restore default before asserting so other tests are not affected
    configureUid(() => `restored-${Math.random()}`);

    expect(r1.value).toBe('test-1');
    expect(r2.value).toBe('test-2');
  });
});

// ---------------------------------------------------------------------------
// syncQuery bare-bus fast path (no plugins/hooks/listeners)
// ---------------------------------------------------------------------------

describe('syncQuery bare-bus fast path', () => {
  it('returns handler result with no plugins installed', () => {
    const bus = createCommandBus();
    bus.register('getCount', () => 42);
    // No plugins, hooks, or listeners — exercises the bare-bus branch
    const r = bus.query('getCount', {});
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it('returns handleMissing when no handler on bare bus', () => {
    const bus = createCommandBus();
    const r = bus.query('missing', {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('No handler');
  });

  it('uses full runner path when a plugin is installed', () => {
    const bus = createCommandBus();
    bus.register('get', () => 1);
    const pluginSpy = vi.fn((_cmd: any, next: any) => next());
    bus.use(pluginSpy);
    bus.query('get', {});
    expect(pluginSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listenerOffAll with wildcard pattern
// ---------------------------------------------------------------------------

describe('listenerOffAll with wildcard pattern', () => {
  it('removes only the matching wildcard listener', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    const cartListener = vi.fn();
    const allListener  = vi.fn();
    bus.on('cart*', cartListener);
    bus.on('*',     allListener);

    bus.offAll('cart*');
    bus.dispatch('cartAdd', {});

    expect(cartListener).not.toHaveBeenCalled();
    expect(allListener).toHaveBeenCalled(); // untouched
  });

  it('removes exact-match listener via offAll', () => {
    const bus = createCommandBus();
    bus.register('op', () => 1);
    const listener = vi.fn();
    bus.on('op', listener);

    bus.offAll('op');
    bus.dispatch('op', {});

    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// asyncDispatchBatch mid-flight abort with transactional rollback
// ---------------------------------------------------------------------------

describe('asyncDispatchBatch mid-flight abort', () => {
  it('triggers transactional rollback when signal aborts mid-batch', async () => {
    const bus = createAsyncCommandBus();
    const log: string[] = [];
    bus.register('a', async () => { log.push('a'); return 1; });
    bus.register('b', async () => {
      log.push('b');
      ac.abort(); // abort mid-flight
      return 2;
    });
    bus.register('undoA', async () => { log.push('undoA'); });

    const ac = new AbortController();
    const result = await bus.dispatchBatch(
      [
        { action: 'a', target: {} },
        { action: 'b', target: {} },
        { action: 'c', target: {} },
      ],
      { signal: ac.signal, transactional: false },
    );

    expect(result.ok).toBe(false);
    expect(log).toContain('a');
    expect(log).toContain('b');
    expect(log).not.toContain('c'); // aborted before reaching c
  });
});

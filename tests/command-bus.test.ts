import { describe, it, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';

describe('createCommandBus', () => {
  describe('dispatch', () => {
    it('should return error when no handler registered', () => {
      const bus = createCommandBus();
      const result = bus.dispatch('unknown.action', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('No handler');
    });

    it('should execute registered handler', () => {
      const bus = createCommandBus();
      bus.register('test.action', (cmd) => cmd.target.value * 2);

      const result = bus.dispatch('test.action', { value: 5 });

      expect(result.ok).toBe(true);
      expect(result.value).toBe(10);
    });

    it('should pass action, target, and payload to handler', () => {
      const bus = createCommandBus();
      const handler = vi.fn((cmd) => cmd);

      bus.register('test.action', handler);
      bus.dispatch('test.action', { id: 1 }, { extra: 'data' });

      expect(handler).toHaveBeenCalledWith({
        action: 'test.action',
        target: { id: 1 },
        payload: { extra: 'data' },
      });
    });

    it('should catch handler errors and return error result', () => {
      const bus = createCommandBus();
      bus.register('test.error', () => {
        throw new Error('Handler failed');
      });

      const result = bus.dispatch('test.error', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Handler failed');
    });
  });

  describe('register', () => {
    it('should return unregister function', () => {
      const bus = createCommandBus();
      const unregister = bus.register('test.action', () => 'result');

      expect(bus.dispatch('test.action', {}).ok).toBe(true);

      unregister();

      expect(bus.dispatch('test.action', {}).ok).toBe(false);
    });

    it('should replace existing handler', () => {
      const bus = createCommandBus();
      bus.register('test.action', () => 'first');
      bus.register('test.action', () => 'second');

      const result = bus.dispatch('test.action', {});

      expect(result.value).toBe('second');
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

      bus.register('test.action', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('test.action', {});

      expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
    });

    it('should allow plugin to short-circuit', () => {
      const bus = createCommandBus();
      const handler = vi.fn(() => 'handler-result');

      bus.use((cmd, next) => {
        return { ok: false, error: new Error('Blocked') };
      });

      bus.register('test.action', handler);

      const result = bus.dispatch('test.action', {});

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

      bus.register('test.action', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('test.action', {});

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
      bus.register('test.action', () => 'result');

      bus.dispatch('test.action', {});
      expect(plugin).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('test.action', {});
      expect(plugin).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAfter (hooks)', () => {
    it('should run after hooks after dispatch', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('test.action', () => 'result');

      bus.dispatch('test.action', { id: 1 });

      expect(hook).toHaveBeenCalledWith(
        { action: 'test.action', target: { id: 1 }, payload: undefined },
        { ok: true, value: 'result' }
      );
    });

    it('should run hook even on error', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('test.error', () => {
        throw new Error('Oops');
      });

      bus.dispatch('test.error', {});

      expect(hook).toHaveBeenCalled();
      expect(hook.mock.calls[0][1].ok).toBe(false);
    });

    it('should catch hook errors silently', () => {
      const bus = createCommandBus();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.onAfter(() => {
        throw new Error('Hook error');
      });
      bus.register('test.action', () => 'result');

      const result = bus.dispatch('test.action', {});

      expect(result.ok).toBe(true);
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    it('should return unsubscribe function', () => {
      const bus = createCommandBus();
      const hook = vi.fn();

      const unsubscribe = bus.onAfter(hook);
      bus.register('test.action', () => 'result');

      bus.dispatch('test.action', {});
      expect(hook).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('test.action', {});
      expect(hook).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createAsyncCommandBus', () => {
  it('should handle async handlers', async () => {
    const bus = createAsyncCommandBus();

    bus.register('async.action', async (cmd) => {
      await new Promise((r) => setTimeout(r, 10));
      return cmd.target.value * 2;
    });

    const result = await bus.dispatch('async.action', { value: 5 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
  });

  it('should catch async errors', async () => {
    const bus = createAsyncCommandBus();

    bus.register('async.error', async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('Async error');
    });

    const result = await bus.dispatch('async.error', {});

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

    bus.register('async.action', async () => {
      order.push('handler');
      return 'done';
    });

    await bus.dispatch('async.action', {});

    expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
  });

  it('should support async hooks', async () => {
    const bus = createAsyncCommandBus();
    const hookCalled = vi.fn();

    bus.onAfter(async (cmd, result) => {
      await new Promise((r) => setTimeout(r, 5));
      hookCalled(result);
    });

    bus.register('async.action', async () => 'result');

    await bus.dispatch('async.action', {});

    expect(hookCalled).toHaveBeenCalledWith({ ok: true, value: 'result' });
  });
});

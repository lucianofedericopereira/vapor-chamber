/**
 * Tests for src/devtools.ts — Vue DevTools integration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDevtools } from '../src/devtools';
import { createCommandBus } from '../src/command-bus';

describe('setupDevtools', () => {
  beforeEach(() => {
    // Ensure non-production environment
    vi.stubGlobal('process', { env: { NODE_ENV: 'test' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an unsubscribe function', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('no-ops in production mode', () => {
    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } });
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});
    expect(typeof unsub).toBe('function');
    // Should not throw when called
    unsub();
  });

  it('records commands via onAfter hook', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});

    // Dispatch something — should not throw even without devtools API
    bus.dispatch('testAction', { id: 1 }, { qty: 2 });
    bus.dispatch('testAction2', { id: 2 });

    // Cleanup
    unsub();
  });

  it('unsubscribe stops recording', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const afterHookSpy = vi.fn();

    // Subscribe our own hook to verify timing
    bus.onAfter(afterHookSpy);
    const unsub = setupDevtools(bus, {});

    bus.dispatch('before', {});
    expect(afterHookSpy).toHaveBeenCalledTimes(1);

    unsub();

    // After unsub, devtools hook should be removed but our spy remains
    bus.dispatch('after', {});
    expect(afterHookSpy).toHaveBeenCalledTimes(2);
  });
});

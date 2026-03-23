/**
 * Tests for all Track A bug fixes (A1–A7)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestBus } from '../src/testing';
import { createAsyncCommandBus } from '../src/command-bus';
import { createFormBus } from '../src/form';

// ---------------------------------------------------------------------------
// A1: testing.ts — passthroughHandlers fix
// ---------------------------------------------------------------------------

describe('A1: createTestBus passthroughHandlers', () => {
  it('default mode: stubs handlers (does NOT execute them)', () => {
    const handler = vi.fn(() => 42);
    const bus = createTestBus();
    bus.register('test', handler);
    const result = bus.dispatch('test', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined(); // Stubbed — handler NOT called
    expect(handler).not.toHaveBeenCalled();
  });

  it('default mode: records dispatch even when stubbed', () => {
    const bus = createTestBus();
    bus.register('test', () => 42);
    bus.dispatch('test', { id: 1 });
    expect(bus.wasDispatched('test')).toBe(true);
    expect(bus.getDispatched('test')[0].cmd.target).toEqual({ id: 1 });
  });

  it('default mode: returns { ok: true, value: undefined } for unregistered actions', () => {
    const bus = createTestBus();
    const result = bus.dispatch('nonexistent', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('passthroughHandlers: true executes the real handler', () => {
    const handler = vi.fn(() => 42);
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('test', handler);
    const result = bus.dispatch('test', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('passthroughHandlers: true catches handler errors', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('fail', () => { throw new Error('boom'); });
    const result = bus.dispatch('fail', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('boom');
  });

  it('passthroughHandlers: true still stubs when no handler registered', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    const result = bus.dispatch('unknown', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A2: command-bus.ts — asyncRequest dedup
// ---------------------------------------------------------------------------

describe('A2: asyncRequest deduplication', () => {
  it('concurrent requests to same action+target return the same Promise', async () => {
    const bus = createAsyncCommandBus();
    let callCount = 0;
    bus.register('slow', async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 50));
      return 'done';
    });

    const [r1, r2] = await Promise.all([
      bus.request('slow', { id: 1 }),
      bus.request('slow', { id: 1 }),
    ]);

    // Both should get the same result
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Handler should only have been called once (deduped)
    expect(callCount).toBe(1);
  });

  it('requests with different targets are NOT deduped', async () => {
    const bus = createAsyncCommandBus();
    let callCount = 0;
    bus.register('fetch', async () => {
      callCount++;
      return callCount;
    });

    const [r1, r2] = await Promise.all([
      bus.request('fetch', { id: 1 }),
      bus.request('fetch', { id: 2 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(callCount).toBe(2); // Different targets = separate calls
  });

  it('dedup entry is cleaned up after resolution', async () => {
    const bus = createAsyncCommandBus();
    let callCount = 0;
    bus.register('counter', async () => ++callCount);

    // First request
    await bus.request('counter', { id: 1 });
    expect(callCount).toBe(1);

    // Second request after first completes — should NOT be deduped
    await bus.request('counter', { id: 1 });
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A7: form.ts — isValidating and isBusy
// ---------------------------------------------------------------------------

describe('A7: form isValidating and isBusy', () => {
  it('exposes isValidating and isBusy signals', () => {
    const form = createFormBus({ fields: { name: '' } });
    expect(form.isValidating).toBeDefined();
    expect(form.isBusy).toBeDefined();
    expect(form.isValidating.value).toBe(false);
    expect(form.isBusy.value).toBe(false);
  });

  it('isValidating is true during async validation', async () => {
    let validatingDuringRule = false;
    const form = createFormBus({
      fields: { email: 'test@x.com' },
      rules: {
        email: async (v) => {
          validatingDuringRule = form.isValidating.value;
          await new Promise(r => setTimeout(r, 10));
          return null;
        },
      },
      onSubmit: async () => {},
    });

    await form.submit();
    expect(validatingDuringRule).toBe(true);
    // After submit completes, isValidating should be false
    expect(form.isValidating.value).toBe(false);
  });

  it('isBusy reflects both isValidating and isSubmitting', async () => {
    let busyDuringValidation = false;
    let busyDuringSubmit = false;

    const form = createFormBus({
      fields: { name: 'ok' },
      rules: {
        name: async () => {
          busyDuringValidation = form.isBusy.value;
          return null;
        },
      },
      onSubmit: async () => {
        busyDuringSubmit = form.isBusy.value;
      },
    });

    await form.submit();
    expect(busyDuringValidation).toBe(true);
    expect(busyDuringSubmit).toBe(true);
    expect(form.isBusy.value).toBe(false);
  });

  it('reset() clears isValidating and isBusy', () => {
    const form = createFormBus({ fields: { x: '' } });
    // Manually verify reset path
    form.reset();
    expect(form.isValidating.value).toBe(false);
    expect(form.isBusy.value).toBe(false);
  });
});

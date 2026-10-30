/**
 * The TestBus answers dispatch and query with the same result keys as the real bus.
 * Why: a result missing a key (`error` on success, `value` on failure) would change the object's shape, so shape-sensitive code and benches would behave differently through the harness than in production.
 * Shows: the key sets of success and failure dispatch results, and of a query result, equal the real bus's; the real success result has exactly error, ok and value; the test bus reports the right ok and value.
 */

import { describe, expect } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { it } from '../src/vitest';

const keys = (r: unknown) => Object.keys(r as object).sort();

describe('TestBus result parity', () => {
  it('produces the same key set as the real bus, on both paths', () => {
    const bus = createCommandBus();
    bus.register('ok', () => 'v');
    bus.register('bad', () => { throw new Error('x'); });
    const realOk = bus.dispatch('ok', {});
    const realErr = bus.dispatch('bad', {});

    // passthroughHandlers runs the handler, so the error path is reachable; the default stubs every handler to ok.
    const test = createTestBus({ passthroughHandlers: true });
    test.register('ok', () => 'v');
    test.register('bad', () => { throw new Error('x'); });
    const testOk = test.dispatch('ok', {});
    const testErr = test.dispatch('bad', {});

    expect(keys(testOk)).toEqual(keys(realOk));
    expect(keys(testErr)).toEqual(keys(realErr));
    // Equal sets alone would pass if both lacked a key.
    expect(keys(realOk)).toEqual(['error', 'ok', 'value']);
    expect(testOk.ok).toBe(true);
    expect(testOk.value).toBe('v');
    expect(testErr.ok).toBe(false);
  });

  it('query() answers in that shape too', () => {
    const bus = createCommandBus();
    bus.register('read', () => 42);
    const real = bus.query('read', {});

    const test = createTestBus({ passthroughHandlers: true });
    test.register('read', () => 42);

    expect(keys(test.query('read', {}))).toEqual(keys(real));
  });
});

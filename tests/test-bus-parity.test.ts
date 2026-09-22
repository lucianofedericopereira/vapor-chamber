/**
 * The TestBus must answer in the same SHAPE the real bus does.
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

    // `passthroughHandlers` so the harness actually runs the handler and can
    // reach its error path; the default stubs every handler to ok.
    const test = createTestBus({ passthroughHandlers: true });
    test.register('ok', () => 'v');
    test.register('bad', () => { throw new Error('x'); });
    const testOk = test.dispatch('ok', {});
    const testErr = test.dispatch('bad', {});

    expect(keys(testOk)).toEqual(keys(realOk));
    expect(keys(testErr)).toEqual(keys(realErr));
    // Not just "same length": the real bus carries BOTH keys on BOTH paths.
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

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
//
// src/testing.ts imported `_okResult` / `_errResult` from the bus and then
// built its results with object literals anyway, nine times. The literals
// omitted a key the constructors always set - `error: undefined` on success,
// `value: undefined` on failure - so a TestBus result was `{ok,value}` where
// every real bus result is `{ok,value,error}`.
//
// `result.error` reads `undefined` either way, which is why nothing failed.
// What differs is `'error' in result`, `Object.keys(result)`, and the object's
// hidden class: code that is monomorphic on the real result shape goes
// polymorphic the moment it is exercised through the test harness, so a bench
// or a shape-sensitive path measures something the production bus never does.
//
// That is the defect this module has already had twice, both recorded in its
// own comments: results without `meta`, which sent every meta consumer down its
// defensive no-op branch so that "NOTHING FAILS"; and a listener fan-out cursor
// fixed in the real buses and not here, so a test could assert behaviour the
// production bus does not have. Same class, third instance. Asserting the key
// sets are EQUAL rather than listing them means the next key added to the
// constructors fails here until the harness carries it too.

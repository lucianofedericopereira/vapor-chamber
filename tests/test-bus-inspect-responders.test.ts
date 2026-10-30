/**
 * createTestBus().inspect() lists the actions registered with respond().
 * Why: a test that inspects the test bus would see no responders, unlike the real bus.
 * Shows: responderActions holds the registered action, and is empty after the responder is removed.
 */
import { describe, expect, it } from 'vitest';
import { createTestBus } from '../src/testing';

describe('createTestBus - inspect', () => {
  it('lists the actions respond() registered', () => {
    const bus = createTestBus();
    const off = bus.respond('cartCheck', () => true);
    expect(bus.inspect().responderActions).toEqual(['cartCheck']);
    off();
    expect(bus.inspect().responderActions).toEqual([]);
  });
});

/**
 * createTestBus().inspect() lists its responders, as the real bus's does.
 * It always reported `responderActions: []`.
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

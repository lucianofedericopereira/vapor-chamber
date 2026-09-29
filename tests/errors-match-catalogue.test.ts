/**
 * The errors the library builds match its own catalogue (ERROR_CODE_REGISTRY):
 * each carries a catalogued code, and the owner in that code is the one the
 * wiring minted it for. Before the factory, every site filled code, emitter and
 * severity by hand and drifted from the catalogue (validator() refused with no
 * code at all). docs/plan-failures-and-contract.md, 2.1 and 4.5.
 */
import { describe, expect } from 'vitest';
import { createAsyncCommandBus, ownerOf } from '../src/command-bus';
import { throttle, validator } from '../src/plugins-core';
import { ERROR_CODE_REGISTRY } from '../src/schema';
import type { BusError } from '../src/command-bus';
import { it } from '../src/vitest';

const entry = (code: string) => ERROR_CODE_REGISTRY.find((e) => e.code === code)!;

function matchesCatalogue(error: unknown): void {
  // The catalogue documents every code the library raises; the owner in the
  // code is the one the wiring stamped (plan 4.5).
  const e = error as BusError;
  expect(e.code, 'the error carries a catalogue code').toBeDefined();
  expect(entry(e.code), `${e.code} is catalogued`).toBeDefined();
  expect(e.code.split(':')[0]).toBe(ownerOf(e));
}

describe('errors match the catalogue', () => {
  it('validator() refuses as its own invalid:payload, keeping the rule\'s own message', ({ bus }) => {
    bus.use(validator({ save: () => 'The name is required.' }));
    bus.register('save', () => 'saved');
    const result = bus.dispatch('save', {});
    expect(result).toFailWith('validator:invalid:payload');
    expect(result.error?.message).toBe('The name is required.');
    matchesCatalogue(result.error);
  });

  it('throttle() refuses as its own limited:handler', ({ bus }) => {
    bus.use(throttle(['save'], 10_000));
    bus.register('save', () => 'saved');
    bus.dispatch('save', {});
    const second = bus.dispatch('save', {});
    expect(second).toFailWith('throttle:limited:handler');
  });

  it('a throttled handler refuses as the catalogue says', ({ bus }) => {
    bus.register('save', () => 'saved', { throttle: 10_000 });
    bus.dispatch('save', {});
    const second = bus.dispatch('save', {});
    expect(second).toFailWith('core:limited:handler');
    matchesCatalogue(second.error);
  });

  it('an aborted dispatch refuses as the catalogue says', async () => {
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 'saved');
    const ac = new AbortController();
    ac.abort();
    const result = await bus.dispatch('save', {}, undefined, { signal: ac.signal });
    expect(result).toFailWith('core:aborted:dispatch');
    matchesCatalogue(result.error);
  });
});

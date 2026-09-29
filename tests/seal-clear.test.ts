/**
 * seal() is a commit: a sealed bus refuses clear().
 *
 * seal() exists for the command LEDGER - dispatch is the "do", the undo
 * handler the rollback - and for SECURITY: authGuard and every other plugin
 * stay in place. A clear() that succeeded on a sealed bus would delete the undo
 * handlers and every plugin with nothing able to put them back, and
 * history().undo() would find no inverse and fall back to a data-only pop:
 * the ledger would record a rollback that never ran.
 *
 * dispose() is teardown, not reconfiguration: it still works on a sealed bus
 * and leaves it sealed. The TestBus behaves the same way (a double that
 * unsealed would pass a test the real bus fails), and unsealBus() reopens it,
 * as it reopens a real bus.
 */
import { describe, expect } from 'vitest';
import { createCommandBus, createAsyncCommandBus, unsealBus, inspectBus, type BusError } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { createTestBus } from '../src/testing';
import { it } from '../src/vitest';

/** The BusError code `fn` throws, or undefined when it does not throw. */
const thrownCode = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as BusError).code; }
  return undefined;
};

describe.each([
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus()],
] as const)('a sealed %s bus refuses clear()', (_kind, make) => {
  it('throws core:refused:bus and keeps handlers, undo handlers and plugins', () => {
    const bus: any = make();
    bus.register('pay', () => 'paid', { undo: () => {} });
    bus.use((_c: unknown, next: () => unknown) => next());
    bus.seal();

    expect(thrownCode(() => bus.clear())).toBe('core:refused:bus');
    expect(bus.hasHandler('pay')).toBe(true);
    expect(bus.getUndoHandler('pay')).toBeTypeOf('function');
    expect(inspectBus(bus).pluginCount).toBe(1);
    expect(bus.isSealed()).toBe(true);
  });

  it('clears after unsealBus(), the documented HMR order', () => {
    const bus: any = make();
    bus.register('pay', () => 'paid');
    bus.seal();
    unsealBus(bus);
    bus.clear();
    expect(bus.hasHandler('pay')).toBe(false);
  });

  it('dispose() still tears a sealed bus down, and it stays sealed', () => {
    const bus: any = make();
    bus.register('pay', () => 'paid');
    bus.seal();
    expect(() => bus.dispose()).not.toThrow();
    expect(bus.hasHandler('pay')).toBe(false);
    expect(bus.isSealed()).toBe(true);
  });
});

describe('the ledger case: a stray clear() cannot turn a rollback into a no-op', () => {
  it('undo() still runs the inverse after a refused clear()', ({ bus }) => {
    let balance = 0;
    bus.register('pay', () => { balance += 10; }, { undo: () => { balance -= 10; } });
    const h = history({ bus });
    bus.use(h);
    bus.seal();

    bus.dispatch('pay', {});
    expect(balance).toBe(10);
    expect(thrownCode(() => bus.clear())).toBe('core:refused:bus');
    h.undo();
    expect(balance).toBe(0); // the rollback ran
  });
});

describe('the TestBus seals like the real bus', () => {
  it('a sealed TestBus refuses clear() and stays sealed', () => {
    const bus = createTestBus();
    bus.seal();
    expect(thrownCode(() => bus.clear())).toBe('core:refused:bus');
    expect(bus.isSealed()).toBe(true);
  });

  it('dispose() on a sealed TestBus works and leaves it sealed', () => {
    const bus = createTestBus();
    bus.register('a', () => 1);
    bus.seal();
    bus.dispose();
    expect(bus.hasHandler('a')).toBe(false);
    expect(bus.isSealed()).toBe(true);
  });

  it('unsealBus() reopens a sealed TestBus, as it reopens a real bus', () => {
    const bus = createTestBus();
    bus.seal();
    unsealBus(bus);
    expect(bus.isSealed()).toBe(false);
    bus.clear();
    expect(() => bus.register('a', () => 1)).not.toThrow();
  });
});

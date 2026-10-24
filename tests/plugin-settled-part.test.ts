/** A plugin's `settled` part: the bus places it on the settled result, never in the chain. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type BaseBus } from '../src/command-bus';
import { logger } from '../src/plugins-core';
import { schemaLogger } from '../src/schema';
import { createTestBus } from '../src/testing';

afterEach(() => { vi.restoreAllMocks(); });

function quiet() {
  const groups = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  return (action: string) => groups.mock.calls.filter((c) => String(c[0]).includes(action)).length;
}

const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus()],
  ['test', () => createTestBus({ passthroughHandlers: true })],
];

describe.each(BUSES)('a settled part on the %s bus', (_name, make) => {
  it("logs a rule's refusal", async () => {
    const logged = quiet();
    const bus = make();
    bus.register('save', () => 1);
    bus.use(logger());
    bus.use({ authorize: () => () => ({ ok: false, value: undefined, error: new Error('no') }) });
    await bus.dispatch('save', 1);
    expect(logged('save')).toBe(1);
  });

  it('logs a success (control)', async () => {
    const logged = quiet();
    const bus = make();
    bus.register('save', () => 1);
    bus.use(logger());
    await bus.dispatch('save', 1);
    expect(logged('save')).toBe(1);
  });

  it('stops when its remover runs', async () => {
    const logged = quiet();
    const bus = make();
    bus.register('save', () => 1);
    const off = bus.use(logger());
    off();
    await bus.dispatch('save', 1);
    expect(logged('save')).toBe(0);
  });

  it('logs a query', async () => {
    const logged = quiet();
    const bus = make();
    bus.register('load', () => 1);
    bus.use(schemaLogger({ load: {} }));
    await bus.query('load', 1);
    expect(logged('load')).toBe(1);
  });

  it("logs a settled part's throw, and the dispatch keeps its result", async () => {
    quiet();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = make();
    bus.register('save', () => 1);
    bus.use(logger({ actionFilter: () => { throw new Error('boom'); } }));
    const r = await bus.dispatch('save', 1);
    expect(r).toMatchObject({ ok: true, value: 1 });
    expect(errors).toHaveBeenCalled();
  });

  it('runs only on the actions its scope covers', async () => {
    const seen: string[] = [];
    const bus = make();
    bus.register('cartAdd', () => 1);
    bus.register('userLoad', () => 1);
    bus.use({ actions: ['cart*'], settled: (cmd: { action: string }) => { seen.push(cmd.action); } });
    await bus.dispatch('cartAdd', 1);
    await bus.dispatch('userLoad', 1);
    expect(seen).toEqual(['cartAdd']);
  });

  it('refuses an object that declares nothing the bus places', () => {
    const bus = make();
    expect(() => bus.use({ id: 'empty' } as never)).toThrow(expect.objectContaining({ code: 'core:invalid:plugin' }));
  });
});

/*
 * Plan 1.32 step 7a (.probes/step-7-pickup.md). An observer reads the settled
 * result (plan 3, the Listeners row), so `logger` and `schemaLogger` are parts
 * objects: `use()` places their `settled` part where `onAfter` hooks run, and
 * no chain level holds them. They hear every outcome a hook hears, a
 * before-hook's cancel included, in any install order
 * (tests/same-in-any-order.test.ts). The control rows show the scenario works.
 * A parts object that declares no part the bus places is refused, as a
 * transport is: `use()`'s rule is a function, or an object with a placed part.
 */

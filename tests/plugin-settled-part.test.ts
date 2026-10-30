/**
 * A plugin's `settled` part (logger, schemaLogger) on the sync, async and test buses.
 * Why: an observer must hear every settled outcome, a rule's refusal included, wherever it is installed; a plugin object that declares no part the bus places would silently do nothing.
 * Shows: the logger logs a refusal, a success and a query once each, stops after its remover runs, logs a throwing part without changing the dispatch result, runs only on its `actions` scope, and `use()` refuses an object with no placed part.
 * See: log s36.98.
 */
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

/**
 * history({ bus }) recording on the sync and async bus, and with the outbox.
 * Why: history records through its own bus hook; if recording depended on bus.use or plugin order, a plugin that answers in place of the handler could hide a step, and a command held in the outbox would get an undo for a write never sent.
 * Shows: a dispatch is recorded without bus.use, a step that answers in place of the handler still records one entry, a refused dispatch is not recorded, dispose() stops recording, a sealed bus stays sealed, and an outbox-held command is not recorded.
 * See: src/ledger.ts, tests/composables-sealed-bus.test.ts, tests/same-in-any-order.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { type BaseBus, createAsyncCommandBus, createCommandBus, history } from '../src/index';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';

const BUSES = [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const;

describe.each(BUSES)('history({ bus }) on the %s bus', (_name, make) => {
  // `add` answers 1, or throws when `fails`.
  const busWith = (fails = false) => {
    const bus = make();
    (bus as BaseBus).register('add', () => { if (fails) throw new Error('no'); return 1; });
    return bus;
  };

  it('records a dispatch with no bus.use', async () => {
    const bus = busWith();
    const h = history({ bus });
    await bus.dispatch('add', {});
    expect(h.getState().past.map((c) => c.action)).toEqual(['add']);
  });

  it('records what the caller got when a step answers in place of the handler', async () => {
    const bus = busWith();
    bus.use({ reuse: () => ({ ok: true, value: 2, error: undefined }) });
    const h = history({ bus });
    await bus.dispatch('add', {});
    expect(h.getState().past.length).toBe(1);
  });

  it('a refused dispatch is not recorded', async () => {
    const bus = busWith(true);
    const h = history({ bus });
    await bus.dispatch('add', {});
    expect(h.getState().past).toEqual([]);
  });

  it('dispose() stops recording', async () => {
    const bus = busWith();
    const h = history({ bus });
    await bus.dispatch('add', {});
    h.dispose();
    await bus.dispatch('add', {});
    expect(h.getState().past.length).toBe(1);
  });

  it('installs on a sealed bus and leaves it sealed', async () => {
    const bus = busWith();
    bus.seal();
    const h = history({ bus });
    expect(bus.isSealed()).toBe(true);
    await bus.dispatch('add', {});
    expect(h.getState().past.length).toBe(1);
  });
});

describe('history with the outbox', () => {
  it('a held command is not recorded', async () => {
    const outbox = createOutbox({ storage: null, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 'sent', error: undefined })), outbox });
    const h = history({ bus });
    await bus.dispatch('save', { id: 1 });
    outbox.dispose();
    expect(h.getState().past).toEqual([]);
  });
});

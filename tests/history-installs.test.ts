/** `history({ bus })` records on its own, the same wherever plugins sit. The long note is at the end. */
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
  // Plan 1.32 row 7.
  it('a held command is not recorded', async () => {
    const outbox = createOutbox({ storage: null, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 'sent', error: undefined })), outbox });
    const h = history({ bus });
    await bus.dispatch('save', { id: 1 });
    outbox.dispose();
    expect(h.getState().past).toEqual([]);
  });
});

/*
 * Before 4h, history() was a chain plugin: it recorded nothing until `bus.use`, and a plugin
 * outside it that answered without `next()` was never seen, so its position decided what the
 * history held. It now records in an after-hook, as useCommandHistory did, through the one
 * recorder in src/ledger.ts. The sealed case follows useCommandHistory's: the observer goes in
 * past the seal (tests/composables-sealed-bus.test.ts). The dispose case records once first,
 * so it fails if nothing records at all.
 *
 * The outbox row came from tests/same-in-any-order.test.ts. As a plugin, history recorded the
 * outbox's `{ queued }` answer in one install order only (.probes/same-in-any-order.json, B
 * then A: 1). Since 4i the outbox is a bus option and a held command answers an `Accepted`,
 * which is not the end: the ledger records no step for it, and an undo cannot run the inverse
 * of a write that was never sent.
 */

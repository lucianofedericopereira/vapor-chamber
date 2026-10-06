/** A plugin's memory of a command ends when its undo lands, so a redo runs (plan 1.27 item 6 F6a). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { cache, idempotent } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';

type List = { items: string[] };
const useCart = defineChamberStore('cart', {
  state: (): List => ({ items: [] }),
  reducers: { add: (s: List, item: string) => ({ items: [...s.items, item] }) },
  undo: true,
});
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('history redo runs after the undo, past a plugin that remembered the command', () => {
  it.each([['cart*'], ['cartAdd']])('sync bus, cache({ actions: [%j] })', (scope) => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    bus.use(cache({ actions: [scope] }));
    const cart = useCart(bus);
    cart.add('milk');
    h.undo();
    expect(cart.state.value.items).toEqual([]);
    h.redo();
    expect(cart.state.value.items).toEqual(['milk']);
    cart.$dispose();
  });

  it("async bus, idempotent({ actions: ['cart*'] })", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    bus.use(idempotent({ actions: ['cart*'] }));
    const cart = useCart(bus);
    await cart.add('milk');
    h.undo();
    await settle();
    expect(cart.state.value.items).toEqual([]);
    h.redo();
    await settle();
    expect(cart.state.value.items).toEqual(['milk']);
    cart.$dispose();
  });

  it('an app handler registered with undo, behind idempotent', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    bus.use(idempotent({ actions: ['docSave'] }));
    let saved = 0;
    bus.register('docSave', async () => ++saved, { undo: () => { saved--; } });
    await bus.dispatch('docSave', { id: 1 });
    h.undo();
    await settle();
    expect(saved).toBe(0);
    h.redo();
    await settle();
    expect(saved).toBe(1);
  });
});

describe('only a landed undo forgets', () => {
  const run = (undo: () => unknown) => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('docSave', () => ++runs, { undo });
    bus.use(cache({ actions: ['docSave'] }));
    let first: Command | undefined;
    bus.on('docSave', (cmd) => { first ??= cmd; });
    bus.dispatch('docSave', 1);
    bus.dispatch('docSave$undo', first);
    bus.dispatch('docSave', 1);
    return runs;
  };

  it('an undo that lands: the same dispatch runs again', () => {
    expect(run(() => undefined)).toBe(2);
  });

  it('control: an undo that throws, or answers { ok: false }, forgets nothing', () => {
    expect(run(() => { throw new Error('locked'); })).toBe(1);
    expect(run(() => ({ ok: false, error: new Error('refused') }))).toBe(1);
  });
});

describe('controls: memory that no undo touched is kept', () => {
  it('no plugin: redo restores the step', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const cart = useCart(bus);
    cart.add('milk');
    h.undo();
    h.redo();
    expect(cart.state.value.items).toEqual(['milk']);
    cart.$dispose();
  });

  it('a cached read stays cached across an undo of another command', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    bus.use(cache({ actions: ['userGet'] }));
    let reads = 0;
    bus.register('userGet', () => ++reads);
    const cart = useCart(bus);
    bus.dispatch('userGet', 1);
    cart.add('milk');
    h.undo();
    bus.dispatch('userGet', 1);
    expect(reads).toBe(1);
    cart.$dispose();
  });

  it('a command the custom key skips is never kept: undo and redo run it', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    bus.use(h);
    bus.use(idempotent({ key: () => null }));
    let saved = 0;
    bus.register('docSave', async () => ++saved, { undo: () => { saved--; } });
    await bus.dispatch('docSave', { id: 1 });
    h.undo();
    await settle();
    h.redo();
    await settle();
    expect(saved).toBe(1);
  });

  it('idempotent still collapses a double click', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent({ actions: ['orderCreate'] }));
    let runs = 0;
    bus.register('orderCreate', async () => ++runs);
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    expect(runs).toBe(1);
  });
});

/*
 * history's redo dispatches the recorded action again (origin 'redo'). A
 * cache or idempotent plugin that kept the first run's answer gave it back,
 * so the handler never ran: the store stayed undone and history read the step
 * as redone (log s35.150, finding F6a). The rule of item 6 is that a state
 * change is never answered from memory. An undo that landed makes the kept
 * answer stale, as a write makes a stored response stale in RFC 9111 4.4. The
 * bus tells every installed plugin through `forget(cmd)` after the `$undo`
 * inverse lands, so a plugin whose scope does not match the `$undo` name (an
 * exact `['cartAdd']`) still hears it. "Landed" is the ledger's rule: no
 * throw, no rejection, no `{ ok: false }`. Log s35.181.
 */

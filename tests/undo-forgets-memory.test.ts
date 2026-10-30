/**
 * A plugin's memory of a command ends when its undo lands, so a redo runs.
 * Why: history's redo dispatches the recorded action again; a cache or idempotent plugin that kept the first
 * answer would return it, the handler would not run, and the store would stay undone while history reads the step
 * as redone. An undone command's kept answer is stale, as a write makes a stored response stale (RFC 9111 4.4).
 * Shows: redo restores the step past cache and idempotent, including a scope that does not match the $undo name;
 * only an undo that lands forgets (a throw or { ok: false } does not); and unrelated memory is kept.
 * See: docs/rc-alignment-log.md s35.181, s35.150, RFC 9111 4.4
 */
import { describe, expect, it } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, idempotent } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';
import { history } from '../src/plugins-core';

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

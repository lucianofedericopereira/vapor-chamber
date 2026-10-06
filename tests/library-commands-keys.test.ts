/** A `$` command never meets an app's memory: not through a custom key, not through a run in flight (plan 1.27 item 6 F6b, F6c). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, idempotent } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';

type List = { items: string[] };
const useCart = defineChamberStore('cart', {
  state: (): List => ({ items: [] }),
  reducers: { add: (s: List, item: string) => ({ items: [...s.items, item] }) },
});
const byTarget = (cmd: Command): string => String(cmd.target);

describe('F6b: a custom key never answers a $ command from an app entry', () => {
  it('cache({ key }) keyed by target: a reset still resets', () => {
    const bus = createCommandBus();
    bus.register('load', () => 'loaded');
    bus.use(cache({ key: byTarget }));
    const cart = useCart(bus);
    bus.dispatch('load', null);
    cart.add('milk');
    cart.$reset();
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });

  it('idempotent({ key }) keyed by target: a reset still resets', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('load', async () => 'loaded');
    bus.use(idempotent({ key: byTarget }));
    const cart = useCart(bus);
    await bus.dispatch('load', null);
    await cart.add('milk');
    await cart.$reset();
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });

  it('control: the custom key still answers an app hit', () => {
    const bus = createCommandBus();
    let loads = 0;
    bus.register('load', () => ++loads);
    bus.use(cache({ key: byTarget }));
    bus.dispatch('load', 1);
    bus.dispatch('load', 1);
    expect(loads).toBe(1);
  });
});

describe('F6c: idempotent never joins a $ command to one in flight', () => {
  it('write, reset, write, reset, all in flight: the store ends empty', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    const cart = useCart(bus);
    await Promise.all([cart.add('a'), cart.$reset(), cart.add('b'), cart.$reset()]);
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });

  it('control: two identical app commands in flight share one run', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    let runs = 0;
    bus.register('orderCreate', async () => ++runs);
    const [a, b] = await Promise.all([bus.dispatch('orderCreate', { sku: 1 }), bus.dispatch('orderCreate', { sku: 1 })]);
    expect([runs, a.value, b.value]).toEqual([1, 1, 1]);
  });
});

/*
 * Item 6's rule: a `$` command (a reset, an undo, a tab's sync) is a state
 * change, never answered from memory. cache and idempotent already never
 * store a `$` result (log s35.150). Two paths were left (findings F6b, F6c).
 * A custom `key` that ignores the action gave `load(null)` and `cart$reset`
 * the same key "null", so the reset got `load`'s stored answer and never ran.
 * A `$` command now takes the default key, which holds its `$` name. And
 * idempotent put every key in flight, so a second reset sent while the first
 * was in flight got the first's promise: the write between them survived the
 * second reset. A `$` command is no longer put in flight. Log s35.182.
 */

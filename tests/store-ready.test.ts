/**
 * `store.$ready` resolves once the store holds the state it starts from: its saved state, its tabs' state, or both.
 * Why: without a signal that the start state landed, an app's "empty? add the starter lines" check would run on the default state and double the cart, and a wait on $onField would never end when nothing was saved or the saved state equals the default.
 * Shows: $ready is a Promise<void> that resolves after the async read lands (saved, absent, equal to the default, failed, refused, or store disposed first) and after a tab holds the lock or takes the open tab's state; a store with neither is ready at once; a page with no Web Locks resolves; $ready is reserved against actions.
 * See: log s36.F41.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';
import { type PersistStorage, saveTo } from '../src/store-persist';
import { shareTabs } from '../src/store-share';
import { listen, quiet } from './tabs-quiet';

type Cart = { items: number[] };
const reducers = { add: (s: Cart, id: number) => ({ items: [...s.items, id] }) };
const state = (): Cart => ({ items: [] });

/** An async storage by the PersistStorage contract, as `indexedDbStorage()` answers: `getItem` a promise after `ms`. */
function asyncStorage(saved: Record<string, string>, ms = 5, fail = false): PersistStorage {
  return {
    getItem: (k) => new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error('blocked')) : resolve(saved[k] ?? null)), ms)),
    setItem: (k, v) => { saved[k] = v; return Promise.resolve(); },
  };
}
const syncStorage = (saved: Record<string, string>): PersistStorage => ({ getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } });

/** The app's code on a page load: wait for the store, then put the starter lines in an empty cart. */
async function seed(cart: { $ready: Promise<void>; state: { value: Cart }; add: (id: number) => unknown }): Promise<void> {
  await cart.$ready;
  if (cart.state.value.items.length === 0) { cart.add(1); cart.add(2); }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('$ready with persist', () => {
  const useCart = (storage: PersistStorage, validate?: (s: Cart) => boolean) =>
    defineChamberStore('cart', { state, reducers, persist: saveTo({ key: 'vc:cart', storage, validate }) });

  it('a page load seeds an empty cart once: the saved cart is kept and saved as it was', async () => {
    const saved = { 'vc:cart': '{"items":[1,2]}' };
    const cart = useCart(asyncStorage(saved))(createCommandBus());
    await seed(cart);
    await new Promise((r) => setTimeout(r, 10));
    expect(cart.state.value.items).toEqual([1, 2]);
    expect(saved['vc:cart']).toBe('{"items":[1,2]}');
    cart.$dispose();
  });

  it('control: on a sync storage the same load keeps the cart, and $ready is already a promise', async () => {
    const saved = { 'vc:cart': '{"items":[1,2]}' };
    const cart = useCart(syncStorage(saved))(createCommandBus());
    expect(cart.$ready).toBeInstanceOf(Promise);
    expect(cart.state.value.items).toEqual([1, 2]);
    await seed(cart);
    expect(cart.state.value.items).toEqual([1, 2]);
    cart.$dispose();
  });

  it('resolves when nothing was saved, and a new visit seeds the cart', async () => {
    const saved: Record<string, string> = {};
    const cart = useCart(asyncStorage(saved))(createCommandBus());
    expect(cart.$ready).toBeInstanceOf(Promise);
    await seed(cart);
    expect(cart.state.value.items).toEqual([1, 2]);
    cart.$dispose();
  });

  it('resolves when the saved state equals the default, where no field event fires', async () => {
    const count = defineChamberStore('count', {
      state: () => ({ n: 0 }),
      reducers: { inc: (s: { n: number }) => ({ n: s.n + 1 }) },
      persist: saveTo({ key: 'vc:count', storage: asyncStorage({ 'vc:count': '{"n":0}' }) }),
    })(createCommandBus());
    const fields: unknown[] = [];
    count.$onField('n', (v) => fields.push(v));
    expect(count.$ready).toBeInstanceOf(Promise);
    await count.$ready;
    expect(count.state.value.n).toBe(0);
    expect(fields).toEqual([]);
    count.$dispose();
  });

  it('resolves when the read fails or the saved state is refused, on the default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = useCart(asyncStorage({}, 1, true))(createCommandBus());
    expect(failed.$ready).toBeInstanceOf(Promise);
    await failed.$ready;
    expect(failed.state.value.items).toEqual([]);
    failed.$dispose();
    const refused = useCart(asyncStorage({ 'vc:cart': '{"items":[9]}' }), () => false)(createCommandBus());
    await refused.$ready;
    expect(refused.state.value.items).toEqual([]);
    refused.$dispose();
  });

  it('resolves for a store disposed before the read landed', async () => {
    const cart = useCart(asyncStorage({ 'vc:cart': '{"items":[1]}' }))(createCommandBus());
    cart.$dispose();
    await expect(cart.$ready).resolves.toBeUndefined();
  });

  it('a store with neither persist nor share is ready at once, typed Promise<void>', async () => {
    const cart = defineChamberStore('plain', { state, reducers })(createCommandBus());
    expectTypeOf(cart.$ready).toEqualTypeOf<Promise<void>>();
    expect(cart.$ready).toBeInstanceOf(Promise);
    await cart.$ready;
    cart.$dispose();
  });

  it('an action named $ready is refused, as every $ name is', () => {
    expect(() => defineChamberStore('x', { state, reducers: { $ready: reducers.add } })).toThrow(/\$/);
  });
});

describe('$ready with share', () => {
  const closers: Array<() => void> = [];
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('addEventListener', () => {});
    vi.stubGlobal('removeEventListener', () => {});
  });
  afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

  let n = 0;
  /** A channel of its own, and every message on it. */
  function channel(): { name: string; heard: unknown[] } {
    const name = `ready-${n++}`;
    const { heard, close } = listen(name);
    closers.push(close);
    return { name, heard };
  }
  function tab(name: string, storage?: PersistStorage) {
    const cart = defineChamberStore('cart', {
      state, reducers, share: shareTabs(name), persist: storage ? saveTo({ key: 'vc:cart', storage }) : undefined,
    })(createCommandBus());
    closers.push(() => cart.$dispose());
    return cart;
  }

  it('a tab opened beside one holding [1,2] seeds nothing: both keep [1,2]', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await seed(a);
    await quiet(heard);
    const b = tab(name);
    await seed(b);
    await quiet(heard);
    expect(b.state.value.items).toEqual([1, 2]);
    expect(a.state.value.items).toEqual([1, 2]);
  });

  it('control: a tab alone is ready once it holds the lock, and seeds its cart', async () => {
    const { name } = channel();
    const a = tab(name);
    await seed(a);
    expect(a.state.value.items).toEqual([1, 2]);
  });

  it('with persist too, a tab waits for its read and its tabs: it takes the open tab\'s cart', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await seed(a);
    await quiet(heard);
    // The read lands in a microtask, before any message can: ready on the read alone, the tab would seed.
    const instant: PersistStorage = { getItem: () => Promise.resolve(null), setItem: () => Promise.resolve() };
    const b = tab(name, instant);
    await seed(b);
    await quiet(heard);
    expect(b.state.value.items).toEqual([1, 2]);
    expect(a.state.value.items).toEqual([1, 2]);
  });

  it('resolves for a tab disposed before it was granted or answered', async () => {
    const { name } = channel();
    const a = tab(name);
    a.$dispose();
    await expect(a.$ready).resolves.toBeUndefined();
  });

  it('a page with no Web Locks shares nothing and is ready at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('navigator', { locks: null });
    const { name } = channel();
    const a = tab(name);
    await seed(a);
    expect(a.state.value.items).toEqual([1, 2]);
  });
});

/**
 * A store's `persist` option: read at creation, saved once per microtask after any write.
 * Why: a persist scoped to commands would miss a state written by another command's reply, a page unload could fall between a write and its save, and an async storage cannot hold a sync bus, so early writes must replay on the saved state without being saved over it.
 * Shows: on both runtimes the saved state is the first state while $reset gives state(); a burst saves once, also after $reset and undo; validate refuses a wrong shape; early writes replay on an async read (also with undo, after a $reset, and when the replay throws); a failed write, a blocked or missing storage and corrupt JSON save nothing or warn without failing dispatch; custom serialize works; saveTo without a key throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandResult, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { pace } from '../src/pace';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { httpTransport } from '../src/transports';
import { saveTo } from '../src/store-persist';

type Cart = { items: number[] };
const state = (): Cart => ({ items: [] });
const reducers = {
  add: (s: Cart, id: number) => ({ items: [...s.items, id] }),
  drop: (s: Cart, id: number) => ({ items: s.items.filter((x) => x !== id) }),
};

/** A Storage-shaped map that counts writes. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const sets: string[] = [];
  return {
    data, sets,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { sets.push(v); data.set(k, v); },
  };
}
/** The same, answering promises; `land()` answers the pending read. */
function later(saved: string | null) {
  const sets: string[] = [];
  let land!: () => void;
  const read = new Promise<string | null>((r) => { land = () => r(saved); });
  return { sets, land, getItem: () => read, setItem: async (_k: string, v: string) => { sets.push(v); } };
}
const microtask = () => Promise.resolve();
const settle = () => new Promise((r) => setTimeout(r, 0));

/** persist's own warnings: the library may also log a signal heads-up once per process. */
const persisted = (w: { mock: { calls: unknown[][] } }): string[] =>
  w.mock.calls.map((c) => String(c[0]).split('\n')[0]).filter((t) => t.startsWith('[vapor-chamber] [ WARN ] persist'));

afterEach(() => { vi.restoreAllMocks(); });

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  const def = define as typeof defineCore;
  describe(`${runtime} store: persist`, () => {
    it('the saved state is the first state; $reset still gives state()', () => {
      const storage = memory({ 'vc:cart': '{"items":[7]}' });
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'vc:cart', storage }) })(createCommandBus());
      expect(cart.state.value).toEqual({ items: [7] });
      cart.$reset();
      expect(cart.state.value).toEqual({ items: [] });
      cart.$dispose();
    });

    it('saves once per microtask after a burst of writes, the last state', async () => {
      const storage = memory();
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'vc:cart', storage }) })(createCommandBus());
      expect(storage.sets).toEqual([]);
      cart.add(1); cart.add(2); cart.add(3);
      expect(storage.sets).toEqual([]);
      await microtask();
      expect(storage.sets).toEqual(['{"items":[1,2,3]}']);
      cart.$dispose();
    });

    it('saves a write whatever wrote it: $reset and an undo', async () => {
      const storage = memory();
      const bus = createCommandBus();
      const h = history({ bus });
      const cart = def('cart', { state, reducers, undo: true, persist: saveTo({ key: 'vc:cart', storage }) })(bus);
      cart.add(1);
      await microtask();
      h.undo();
      await microtask();
      cart.add(2);
      cart.$reset();
      await microtask();
      expect(storage.sets).toEqual(['{"items":[1]}', '{"items":[]}', '{"items":[]}']);
      cart.$dispose();
    });

    it('validate refuses a read state of another shape: state(), one warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bad = memory({ k: '{"items":"x"}' });
      const refused = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage: bad, validate: (s) => Array.isArray(s.items) }) })(createCommandBus());
      expect(refused.state.value).toEqual({ items: [] });
      expect(persisted(warn)).toEqual(['[vapor-chamber] [ WARN ] persist:invalid:state: validation failed for key "k", so the store starts fresh']);
      refused.$dispose();
    });

    it('an async storage: the writes before the read are replayed on the saved state, and nothing is saved before it', async () => {
      const storage = later('{"items":[1,2]}');
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      expect(cart.state.value).toEqual({ items: [] });
      cart.add(3);
      cart.drop(1);
      await microtask();
      expect(storage.sets).toEqual([]);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [2, 3] });
      expect(storage.sets).toEqual(['{"items":[2,3]}']);
      cart.$dispose();
    });

    it('an async storage with nothing saved keeps the early writes and saves them', async () => {
      const storage = later(null);
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      cart.add(4);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [4] });
      expect(storage.sets).toEqual(['{"items":[4]}']);
      cart.$dispose();
    });

    it('an async read with no early write is the state, not saved back', async () => {
      const storage = later('{"items":[9]}');
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [9] });
      expect(storage.sets).toEqual([]);
      cart.$dispose();
    });

    it('an early $reset and a server state are kept by the replay; a store disposed first is not written', async () => {
      const storage = later('{"items":[1]}');
      const bus = createAsyncCommandBus({ retry: false });
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(bus);
      await cart.add(2);
      await cart.$reset();
      await cart.add(3);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [3] });
      expect(storage.sets).toEqual(['{"items":[3]}']);
      cart.$dispose();
      const gone = later('{"items":[1]}');
      const other = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage: gone }) })(createCommandBus());
      other.$dispose();
      gone.land();
      await settle();
      expect(other.state.value).toEqual({ items: [] });
    });

    it("an early server's state is kept by the replay: later writes build on it", async () => {
      const storage = later('{"items":[1]}');
      const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: { items: [9] } }, headers: {} }));
      const bus = createAsyncCommandBus({ retry: false, transport: { cartSave: httpTransport({ endpoint: '/vc', httpClient: { post } as never }) } });
      const cart = def('cart', { state, reducers: { ...reducers, save: null }, answer: (_s, v) => v as Cart, persist: saveTo({ key: 'k', storage }) })(bus);
      await cart.add(2);
      await cart.save();
      await cart.add(3);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [9, 3] });
      // After the read landed, a server state is simply written.
      await cart.save();
      expect(cart.state.value).toEqual({ items: [9] });
      cart.$dispose();
    });

    it('with undo: true, the early writes are replayed too', async () => {
      const storage = later('{"items":[1]}');
      const cart = def('cart', { state, reducers, undo: true, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      cart.add(2);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [1, 2] });
      cart.$dispose();
    });

    it('a reducer that throws in the replay: warned, the store keeps its state and saves it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const storage = later('{"items":"not a list"}');
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      cart.drop(1);
      storage.land();
      await settle();
      expect(cart.state.value).toEqual({ items: [] });
      expect(persisted(warn)).toHaveLength(1);
      expect(storage.sets).toEqual(['{"items":[]}']);
      cart.$dispose();
    });

    it('blocked storage: the read and the save warn, the dispatch succeeds', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage: blocked }) })(createCommandBus());
      expect((cart.add(1) as CommandResult).ok).toBe(true);
      await microtask();
      expect(persisted(warn)).toHaveLength(2);
      cart.$dispose();
    });

    it('no storage at all (SSR): the store starts on state() and a write saves nothing', async () => {
      const ls = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      if (ls) delete (globalThis as { localStorage?: unknown }).localStorage;
      try {
        const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k' }) })(createCommandBus());
        cart.add(1);
        await microtask();
        expect(cart.state.value).toEqual({ items: [1] });
        cart.$dispose();
      } finally {
        if (ls) Object.defineProperty(globalThis, 'localStorage', ls);
      }
    });

    it('a debounced sender: nothing is saved before it ran, once after (same-in-any-order, moved)', async () => {
      const storage = memory();
      const bus = createCommandBus();
      const send = pace(bus.dispatch, { debounce: 20 });
      const cart = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage }) })(bus);
      vi.useFakeTimers();
      try {
        void send('cartAdd', 1);
        await vi.advanceTimersByTimeAsync(5);
        expect(storage.sets).toEqual([]);
        await vi.advanceTimersByTimeAsync(60);
        expect(storage.sets).toEqual(['{"items":[1]}']);
      } finally {
        vi.useRealTimers();
      }
      cart.$dispose();
    });

    it('a write that fails saves nothing', async () => {
      const storage = memory();
      const failing = { ...reducers, boom: (): Cart => { throw new Error('no'); } };
      const cart = def('cart', { state, reducers: failing, persist: saveTo({ key: 'k', storage }) })(createCommandBus());
      expect((cart.boom() as CommandResult).ok).toBe(false);
      await microtask();
      expect(storage.sets).toEqual([]);
      cart.$dispose();
    });

    it('corrupt JSON reads as nothing saved, silently; validate runs only on a read state', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const validate = vi.fn(() => true);
      const corrupt = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage: memory({ k: '{not json' }), validate }) })(createCommandBus());
      expect(corrupt.state.value).toEqual({ items: [] });
      corrupt.$dispose();
      const empty = def('cart', { state, reducers, persist: saveTo({ key: 'k', storage: memory(), validate }) })(createCommandBus());
      empty.$dispose();
      expect(validate).not.toHaveBeenCalled();
      expect(persisted(warn)).toEqual([]);
    });

    it('custom serialize and deserialize', async () => {
      const storage = memory({ k: '5,6' });
      const persist = saveTo({ key: 'k', storage, serialize: (s: Cart) => s.items.join(','), deserialize: (raw: string) => ({ items: raw.split(',').map(Number) }) });
      const cart = def('cart', { state, reducers, persist })(createCommandBus());
      expect(cart.state.value).toEqual({ items: [5, 6] });
      cart.add(7);
      await microtask();
      expect(storage.sets).toEqual(['5,6,7']);
      cart.$dispose();
    });

    it('saveTo without a key throws when it is called', () => {
      expect(() => saveTo({} as { key: string })).toThrow(TypeError);
    });
  });
}

describe('saveTo in production', () => {
  it('without a key: the short TypeError', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const mod = await import('../src/store-persist');
      expect(() => mod.saveTo({} as { key: string })).toThrow(/^persist: key$/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

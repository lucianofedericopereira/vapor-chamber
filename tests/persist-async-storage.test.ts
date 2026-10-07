/** persist on an async storage (IndexedDB): hydrate() reads it, load() refuses it. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { indexedDbStorage } from '../src/idb';
import { persist, type PersistStorage } from '../src/plugins-io';

/** Minimal fake IDB, the outbox test's plus `delete`. */
function fakeIndexedDb() {
  const data = new Map<string, any>();
  function request(result?: any) {
    const req: any = { onsuccess: null, onerror: null, result };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  const db = {
    createObjectStore: () => ({}),
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => request(data.get(k)),
        put: (v: any, k: string) => { data.set(k, v); return request(); },
        delete: (k: string) => { data.delete(k); return request(); },
        clear: () => { data.clear(); return request(); },
      }),
    }),
  };
  return {
    data,
    open: () => {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('persist on IndexedDB', () => {
  it('saves after a dispatch, hydrate() reads it back, clear() removes it', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb);
    let state = { n: 0 };
    const bus = createCommandBus();
    bus.register('inc', () => { state = { n: state.n + 1 }; });
    const p = persist({ key: 'vc:n', getState: () => state, storage: indexedDbStorage() });
    bus.use(p);
    bus.dispatch('inc', null);
    await settle();
    expect(idb.data.get('vc:n')).toBe('{"n":1}');

    const next = persist({ key: 'vc:n', getState: () => state, storage: indexedDbStorage() });
    expect(await next.hydrate()).toEqual({ n: 1 });
    next.clear();
    await settle();
    expect(await next.hydrate()).toBeNull();
  });

  it('a value that is not a string reads as nothing saved', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb);
    idb.data.set('vc:n', 42);
    expect(await persist({ key: 'vc:n', getState: () => 0, storage: indexedDbStorage() }).hydrate()).toBeNull();
  });

  it('load() throws a TypeError naming hydrate() on an async storage', () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb());
    const p = persist({ key: 'vc:n', getState: () => 0, storage: indexedDbStorage() });
    expect(() => p.load()).toThrow(TypeError);
    expect(() => p.load()).toThrow(/hydrate/);
  });

  it('without indexedDB, a save and a clear warn and the dispatch succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('x', () => 1);
    const p = persist({ key: 'vc:n', getState: () => 0, storage: indexedDbStorage() });
    bus.use(p);
    expect(bus.dispatch('x', null).ok).toBe(true);
    p.clear();
    await settle();
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((s) => s.includes('failed to save key "vc:n"'))).toBe(true);
    expect(said.some((s) => s.includes('failed to clear key "vc:n"'))).toBe(true);
    expect(await p.hydrate()).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).some((s) => s.includes('failed to load key "vc:n"'))).toBe(true);
  });
});

describe('load() on an async storage', () => {
  it('drops a read that rejects, so nothing reaches unhandledrejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const storage: PersistStorage = { getItem: () => Promise.reject(new Error('denied')), setItem: () => {}, removeItem: () => {} };
      expect(() => persist({ key: 'k', getState: () => 0, storage }).load()).toThrow(TypeError);
      await settle();
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('in production: the same TypeError, the short text', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const io = await import('../src/plugins-io');
      const storage: PersistStorage = { getItem: () => Promise.resolve(null), setItem: () => {}, removeItem: () => {} };
      expect(() => io.persist({ key: 'k', getState: () => 0, storage }).load()).toThrow(/^persist: hydrate$/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('persist.hydrate() on any storage', () => {
  const sync = (raw: string | null): PersistStorage => ({ getItem: () => raw, setItem: () => {}, removeItem: () => {} });

  it('reads a sync storage, as load() does', async () => {
    const p = persist({ key: 'k', getState: () => 0, storage: sync('{"a":1}') });
    expect(await p.hydrate()).toEqual({ a: 1 });
    expect(p.load()).toEqual({ a: 1 });
  });

  it('applies validate, as load() does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = persist({ key: 'k', getState: () => 0, storage: sync('{"a":1}'), validate: () => false });
    expect(await p.hydrate()).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/validation failed for key "k"/);
  });

  it('with no storage at all (SSR) answers null', async () => {
    vi.stubGlobal('localStorage', undefined);
    expect(await persist({ key: 'k', getState: () => 0 }).hydrate()).toBeNull();
  });
});

/*
 * Plan .probes/1.28-plan.md item 9a. persist was synchronous: an IndexedDB
 * storage could not be used, though the outbox had one. The open and request
 * code is now one helper (src/idb.ts) for both. A storage whose methods answer
 * promises is read with hydrate(). load() refuses it with a TypeError rather
 * than a null: a null reads as "nothing saved", and the app's next save would
 * overwrite the saved state. Rejected writes warn, as thrown ones did.
 */

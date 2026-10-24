/** A store's persist on an async storage (IndexedDB): read when it answers, its failures warned. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandResult, createCommandBus } from '../src/command-bus';
import { indexedDbStorage } from '../src/idb';
import type { PersistStorage } from '../src/store-persist';
import { defineChamberStore } from '../src/store/core';
import { saveTo } from '../src/store-persist';

/**
 * Minimal fake IDB: the request succeeds, then its transaction completes. With
 * `abort`, a write's transaction aborts after its request succeeded instead.
 */
function fakeIndexedDb(abort?: { error: DOMException | null }) {
  const data = new Map<string, any>();
  const db = {
    createObjectStore: () => ({}),
    transaction: (_name: string, mode: IDBTransactionMode) => {
      const tx: any = { oncomplete: null, onabort: null, error: null };
      function request(result?: any) {
        const req: any = { onsuccess: null, onerror: null, result };
        queueMicrotask(() => {
          req.onsuccess?.();
          if (abort && mode === 'readwrite') queueMicrotask(() => { tx.error = abort.error; tx.onabort?.(); });
          else queueMicrotask(() => tx.oncomplete?.());
        });
        return req;
      }
      tx.objectStore = () => ({
        get: (k: string) => request(data.get(k)),
        put: (v: any, k: string) => { if (!abort) data.set(k, v); return request(); },
      });
      return tx;
    },
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

type N = { n: number };
const useN = (storage: PersistStorage) =>
  defineChamberStore('n', { state: (): N => ({ n: 0 }), reducers: { inc: (s: N) => ({ n: s.n + 1 }) }, persist: saveTo({ key: 'vc:n', storage }) });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** persist's own warnings: the library may also log a signal heads-up once per process. */
const persisted = (w: { mock: { calls: unknown[][] } }): string[] =>
  w.mock.calls.map((c) => String(c[0]).split('\n')[0]).filter((t) => t.startsWith('[vapor-chamber] [ WARN ] persist'));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a store's persist on IndexedDB", () => {
  it('saves after a write, and the next store reads it back', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb);
    const a = useN(indexedDbStorage())(createCommandBus());
    await settle();
    a.inc();
    await settle();
    expect(idb.data.get('vc:n')).toBe('{"n":1}');
    a.$dispose();
    const b = useN(indexedDbStorage())(createCommandBus());
    expect(b.state.value).toEqual({ n: 0 });
    await settle();
    expect(b.state.value).toEqual({ n: 1 });
    b.$dispose();
  });

  it('a value that is not a string reads as nothing saved', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb);
    idb.data.set('vc:n', 42);
    const s = useN(indexedDbStorage())(createCommandBus());
    await settle();
    expect(s.state.value).toEqual({ n: 0 });
    s.$dispose();
  });

  it('without indexedDB: the read and the save warn, the dispatch succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = useN(indexedDbStorage())(createCommandBus());
    await settle();
    expect((s.inc() as CommandResult).ok).toBe(true);
    await settle();
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((t) => t.includes('failed to load key "vc:n"'))).toBe(true);
    expect(said.some((t) => t.includes('failed to save key "vc:n"'))).toBe(true);
    s.$dispose();
  });

  it('a validate that throws on an async read warns, and the store stays on state()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: PersistStorage = { getItem: async () => '{"n":5}', setItem: async () => {} };
    const s = defineChamberStore('n', { state: (): N => ({ n: 0 }), reducers: {}, persist: saveTo<N>({ key: 'vc:n', storage, validate: () => { throw new Error('nope'); } }) })(createCommandBus());
    await settle();
    expect(s.state.value).toEqual({ n: 0 });
    expect(persisted(warn)).toContain('[vapor-chamber] [ WARN ] persist:failed:load: failed to load key "vc:n"');
    s.$dispose();
  });

  it('a read that rejects warns, reaches no unhandledrejection, and the store stays on state()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = useN({ getItem: () => Promise.reject(new Error('denied')), setItem: () => {} })(createCommandBus());
      await settle();
      await settle();
      expect(unhandled).toEqual([]);
      expect(s.state.value).toEqual({ n: 0 });
      expect(String(persisted(warn)[0])).toMatch(/failed to load key "vc:n"/);
      s.$dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

/** A fake IDB whose open() fails, with `error` on the request (null: private browsing, a quota refusal). */
function failingOpen(error: Error | null) {
  return {
    open: () => {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, error };
      queueMicrotask(() => req.onerror?.());
      return req;
    },
  };
}

/** A fake IDB that opens, then fails each request with no error. */
function failingRequest() {
  const fail = () => { const r: any = { onsuccess: null, onerror: null, error: null }; queueMicrotask(() => r.onerror?.()); return r; };
  const db = { createObjectStore: () => ({}), transaction: () => ({ objectStore: () => ({ get: fail, put: fail }) }) };
  return {
    open: () => {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
}

const settledAs = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => `${e.name}: ${e.message}`);

describe('indexedDbStorage, its own failures (each reaches persist, which warns)', () => {
  it('an open() that fails with no error rejects with one that says so', async () => {
    vi.stubGlobal('indexedDB', failingOpen(null));
    expect(await settledAs(indexedDbStorage().getItem('k') as Promise<unknown>)).toBe('Error: indexedDB open failed');
  });

  it('a failed open() is not cached: the next call opens again', async () => {
    vi.stubGlobal('indexedDB', failingOpen(new Error('open denied')));
    const s = indexedDbStorage();
    expect(await settledAs(s.getItem('k') as Promise<unknown>)).toBe('Error: open denied');
    vi.stubGlobal('indexedDB', fakeIndexedDb());
    expect(await settledAs(s.setItem('k', 'v') as Promise<unknown>)).toBe('resolved');
  });

  it('a request that fails with no error rejects with one that says so', async () => {
    vi.stubGlobal('indexedDB', failingRequest());
    expect(await settledAs(indexedDbStorage().getItem('k') as Promise<unknown>)).toBe('Error: indexedDB request failed');
  });

  it.each([
    ["the browser's error", new DOMException('quota', 'QuotaExceededError'), 'QuotaExceededError: quota'],
    ['an Error naming the store, when the abort carries none', null, 'Error: indexedDB write to "state" did not commit'],
  ])('a write that does not commit rejects with %s, and nothing is stored', async (_name, error, answer) => {
    const idb = fakeIndexedDb({ error });
    vi.stubGlobal('indexedDB', idb);
    expect(await settledAs(indexedDbStorage().setItem('k', 'v') as Promise<unknown>)).toBe(answer);
    expect(idb.data.has('k')).toBe(false);
  });
});

/*
 * IndexedDB answers with promises, so a store on it cannot have its saved
 * state when it is created. It starts on `state()` and takes the saved state
 * when the read lands, the writes made before then replayed on top
 * (tests/store-persist.test.ts). Every failure the storage can give, no
 * database at all, a rejected read, a value that is not a string, warns and
 * leaves the store working: persistence is best effort and never fails a
 * write. An IndexedDB write settles when it commits
 * (tests/browser/idb-commit.browser.test.ts).
 */

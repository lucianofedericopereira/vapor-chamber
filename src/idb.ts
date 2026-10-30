/**
 * vapor-chamber - one IndexedDB key-value store, for a store's persist (the outbox's queue included).
 *
 * Zero dependencies. The database opens lazily on first use, so a module
 * load touches nothing (SSR-safe). Each call is one request in its own
 * transaction, so a write is atomic.
 */

import type { PersistStorage } from './store-persist';

/** @internal One object store of one database: `indexedDbStorage`'s. */
export function _idbStore(dbName: string, storeName: string) {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise === null) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb: IDBFactory | undefined = (globalThis as any).indexedDB;
        if (!idb) {
          reject(new Error('indexedDB is not available in this environment'));
          return;
        }
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(storeName); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
      });
      // Don't cache the failure: a later call may run where IDB exists. Written
      // here, not in the executor, which runs before the assignment above lands.
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  /**
   * Run one request in its own transaction; resolve with `request.result`. A
   * read resolves on the request's success. A write resolves only when its
   * transaction commits: the transaction can still abort after the request
   * succeeded, and the write is then gone (tests/browser/idb-commit.browser.test.ts).
   */
  function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return open().then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = op(tx.objectStore(storeName));
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
      if (mode === 'readonly') req.onsuccess = () => resolve(req.result as T);
      else {
        tx.oncomplete = () => resolve(req.result as T);
        tx.onabort = () => reject(tx.error ?? new Error(`indexedDB write to "${storeName}" did not commit`));
      }
    }));
  }

  return {
    get: (key: string): Promise<unknown> => run('readonly', s => s.get(key)),
    put: (key: string, value: unknown): Promise<void> => run('readwrite', s => s.put(value, key)),
  };
}

/**
 * indexedDbStorage - an IndexedDB storage for a store's `persist`. Prefer it
 * over `localStorage` for a large state: no ~5 MB origin quota, no synchronous
 * I/O. Its answers are promises: the store reads the saved state when it
 * lands (docs/store.md, Saved state). Failures reach the store, which warns.
 *
 * @param dbName    Database name. Default: `'vc-persist'`.
 * @param storeName Object store name. Default: `'state'`.
 *
 * @example
 * defineChamberStore('cart', { state, reducers, persist: saveTo({ key: 'vc:cart', storage: indexedDbStorage() }) });
 */
export function indexedDbStorage(dbName: string = 'vc-persist', storeName: string = 'state'): PersistStorage {
  const db = _idbStore(dbName, storeName);
  return {
    getItem: (key) => db.get(key).then(v => (typeof v === 'string' ? v : null)),
    setItem: (key, value) => db.put(key, value),
  };
}

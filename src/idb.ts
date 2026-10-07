/**
 * vapor-chamber - one IndexedDB key-value store, for the outbox and persist.
 *
 * Zero dependencies. The database opens lazily on first use, so a module
 * load touches nothing (SSR-safe). Each call is one request in its own
 * transaction, so a write is atomic.
 */

import type { PersistStorage } from './plugins-io';

/** @internal One object store of one database: the outbox's and persist's storage. */
export function _idbStore(dbName: string, storeName: string) {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise === null) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb: IDBFactory | undefined = (globalThis as any).indexedDB;
        if (!idb) {
          dbPromise = null; // don't cache the failure - a later call may run where IDB exists
          reject(new Error('indexedDB is not available in this environment'));
          return;
        }
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(storeName); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error ?? new Error('indexedDB open failed')); };
      });
    }
    return dbPromise;
  }

  /** Run one request in its own transaction; resolve with `request.result`. */
  function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return open().then(db => new Promise<T>((resolve, reject) => {
      const store = db.transaction(storeName, mode).objectStore(storeName);
      const req = op(store);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    }));
  }

  return {
    get: (key: string): Promise<unknown> => run('readonly', s => s.get(key)),
    put: (key: string, value: unknown): Promise<void> => run('readwrite', s => s.put(value, key)),
    delete: (key: string): Promise<void> => run('readwrite', s => s.delete(key)),
    clear: (): Promise<void> => run('readwrite', s => s.clear()),
  };
}

/**
 * indexedDbStorage - an IndexedDB storage for `persist`. Prefer it over
 * `localStorage` for a large state: no ~5 MB origin quota, no synchronous I/O.
 * Its answers are promises, so read the saved state with `hydrate()`, not
 * `load()`. Failures reach persist, which warns.
 *
 * @param dbName    Database name. Default: `'vc-persist'`.
 * @param storeName Object store name. Default: `'state'`.
 *
 * @example
 * const cartPersist = persist({ key: 'vc:cart', getState, storage: indexedDbStorage() });
 * const saved = await cartPersist.hydrate(); // before the first dispatch
 */
export function indexedDbStorage(dbName: string = 'vc-persist', storeName: string = 'state'): PersistStorage {
  const db = _idbStore(dbName, storeName);
  return {
    getItem: (key) => db.get(key).then(v => (typeof v === 'string' ? v : null)),
    setItem: (key, value) => db.put(key, value),
    removeItem: (key) => db.delete(key),
  };
}

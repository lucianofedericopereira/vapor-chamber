/**
 * In Chromium: an IndexedDB write settles when its transaction commits, a read when its request succeeds.
 * Why: a transaction can still abort after its write request succeeded, rolling the write back; only the commit makes it durable.
 * Shows: with no abort the value reads back; an abort after success rejects put() and stores nothing; a read still resolves; a store's persist warns.
 * See: log 36.14 D14.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _idbStore, indexedDbStorage } from '../../src/idb';
import { createCommandBus } from '../../src/command-bus';
import { defineChamberStore, saveTo } from '../../src/store/core';

const nativeTransaction = IDBDatabase.prototype.transaction;
afterEach(() => {
  IDBDatabase.prototype.transaction = nativeTransaction;
  vi.restoreAllMocks();
});

const fresh = () => `vc-idb-commit-${Math.random().toString(36).slice(2)}`;

/** From now on, every `mode` transaction aborts from its request's success event, before the library's onsuccess: a quota failure cannot be forced here. */
function abortAfterSuccess(mode: IDBTransactionMode): void {
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const tx = nativeTransaction.apply(this, args);
    if (tx.mode !== mode) return tx;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (name: string) => {
      const store = objectStore(name);
      for (const m of ['get', 'put'] as const) {
        const call = (store[m] as (...a: unknown[]) => IDBRequest).bind(store);
        (store as any)[m] = (...a: unknown[]) => {
          const req = call(...a);
          req.addEventListener('success', () => tx.abort());
          return req;
        };
      }
      return store;
    };
    return tx;
  } as typeof nativeTransaction;
}

const settled = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => `rejected ${e.message}`);

describe('an IndexedDB write whose transaction aborts after its request succeeded', () => {
  it('control: with no abort, put() resolves and the value reads back', async () => {
    const store = _idbStore(fresh(), 's');
    await store.put('k', 'v');
    expect(await store.get('k')).toBe('v');
  });

  it('put() rejects, and the value is not in the store', async () => {
    const store = _idbStore(fresh(), 's');
    abortAfterSuccess('readwrite');
    // An explicit abort leaves transaction.error null, so the rejection is the library's own Error naming the store.
    const answer = await settled(store.put('k', 'v'));
    expect([answer, await store.get('k')]).toEqual(['rejected indexedDB write to "s" did not commit', undefined]);
  });

  it('a read still resolves on its request, though its transaction aborts after', async () => {
    const store = _idbStore(fresh(), 's');
    await store.put('k', 'v');
    abortAfterSuccess('readonly');
    expect(await store.get('k')).toBe('v');
  });

  it("a store's persist warns that the save failed", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = indexedDbStorage(fresh());
    await storage.getItem('vc:n'); // the database is open before the abort is armed
    const n = defineChamberStore('n', { state: () => ({ n: 0 }), reducers: { inc: (s: { n: number }) => ({ n: s.n + 1 }) }, persist: saveTo({ key: 'vc:n', storage }) })(createCommandBus());
    await new Promise((r) => setTimeout(r, 20)); // its read has landed
    abortAfterSuccess('readwrite');
    n.inc();
    await vi.waitFor(() => expect(warn.mock.calls.map((c) => String(c[0]).split('\n')[0])).toContain('[vapor-chamber] [ WARN ] persist:failed:save: failed to save key "vc:n"'));
    n.$dispose();
  });

});

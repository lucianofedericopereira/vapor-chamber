/** In Chromium: an IndexedDB write settles when its transaction commits, a read when its request succeeds (log 36.14 D14). Note at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _idbStore, indexedDbStorage } from '../../src/idb';
import { indexedDbOutbox } from '../../src/outbox';
import { persist } from '../../src/plugins-io';

const nativeTransaction = IDBDatabase.prototype.transaction;
afterEach(() => {
  IDBDatabase.prototype.transaction = nativeTransaction;
  vi.restoreAllMocks();
});

const fresh = () => `vc-idb-commit-${Math.random().toString(36).slice(2)}`;

/** From now on, every `mode` transaction aborts from its request's success event. */
function abortAfterSuccess(mode: IDBTransactionMode): void {
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const tx = nativeTransaction.apply(this, args);
    if (tx.mode !== mode) return tx;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (name: string) => {
      const store = objectStore(name);
      for (const m of ['get', 'put', 'delete', 'clear'] as const) {
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
    const answer = await settled(store.put('k', 'v'));
    expect([answer, await store.get('k')]).toEqual(['rejected indexedDB write to "s" did not commit', undefined]);
  });

  it.each([
    ['delete()', (s: ReturnType<typeof _idbStore>) => s.delete('k')],
    ['clear()', (s: ReturnType<typeof _idbStore>) => s.clear()],
  ])('%s rejects, and the value is still in the store', async (_name, write) => {
    const store = _idbStore(fresh(), 's');
    await store.put('k', 'v');
    abortAfterSuccess('readwrite');
    const answer = await settled(write(store));
    expect([answer, await store.get('k')]).toEqual(['rejected indexedDB write to "s" did not commit', 'v']);
  });

  it('a read still resolves on its request, though its transaction aborts after', async () => {
    const store = _idbStore(fresh(), 's');
    await store.put('k', 'v');
    abortAfterSuccess('readonly');
    expect(await store.get('k')).toBe('v');
  });

  it('persist warns that the save failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = persist({ key: 'vc:n', getState: () => 1, storage: indexedDbStorage(fresh()) });
    await p.hydrate(); // the database is open before the abort is armed
    abortAfterSuccess('readwrite');
    p.save();
    await vi.waitFor(() => expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[vapor-chamber] persist: failed to save key "vc:n":'));
  });

  it('the outbox adapter warns that the save failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = indexedDbOutbox(fresh());
    await s.load();
    abortAfterSuccess('readwrite');
    await s.save([{ id: 'r1', action: 'a', target: null, key: 'k', queuedAt: '1970-01-01T00:00:00.001Z' }]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[vapor-chamber\] outbox: failed to save to indexedDB "vc-idb-commit-/);
    IDBDatabase.prototype.transaction = nativeTransaction;
    expect(await s.load()).toBeNull();
  });
});

/*
 * A write is durable only when its transaction commits: the transaction can
 * still abort after the write request succeeded, and the write is then rolled
 * back. A quota failure at commit could not be forced in the headless shell
 * (Storage.overrideQuotaForOrigin left the quota at 10 GB), so these tests
 * abort the transaction from the request's success event, as the spec allows
 * any script to. That is the same outcome: request success, then no commit.
 * The listener is added before the library sets `onsuccess`, so it runs first.
 *
 * An explicit abort() leaves `transaction.error` null (the spec aborts "with
 * null"), so the rejection is the library's own Error naming the store. A
 * commit failure (quota, I/O) sets `transaction.error`, and that is what the
 * write rejects with then. The Node suite's fakes cover both arms.
 */

/**
 * Tests for the offline outbox: createOutbox, localStorageOutbox, indexedDbOutbox
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus, commandKey } from '../src/index';
import { createOutbox, localStorageOutbox, indexedDbOutbox } from '../src/outbox';
import type { OutboxRecord, OutboxStorage } from '../src/outbox';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** In-memory OutboxStorage with spy-able methods and inspectable data. */
function memoryStorage(initial: OutboxRecord[] | null = null) {
  let data: OutboxRecord[] | null = initial ? initial.slice() : null;
  return {
    load: vi.fn((): OutboxRecord[] | null => (data ? data.slice() : null)),
    save: vi.fn((records: OutboxRecord[]): void => { data = records.slice(); }),
    clear: vi.fn((): void => { data = null; }),
    get data() { return data; },
  };
}

// ---------------------------------------------------------------------------
// createOutbox — queueing
// ---------------------------------------------------------------------------

describe('createOutbox — queueing', () => {
  it('queues matching commands while offline, returns { queued: true }, bumps pending, persists', async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({ actions: ['cart*'], storage, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    outbox.install(bus);

    const queuedEvents: any[] = [];
    bus.on('outboxQueued', (cmd) => queuedEvents.push(cmd.target));

    const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ queued: true });
    expect(result.value.id).toBeTruthy();
    expect(outbox.pending.value).toBe(1);

    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.data).toHaveLength(1);
    expect(storage.data![0]).toMatchObject({
      action: 'cartAdd',
      target: { id: 1 },
      payload: { qty: 2 },
      key: commandKey('cartAdd', { id: 1 }),
    });

    // 'outboxQueued' fires with the record
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0].action).toBe('cartAdd');
  });

  it('non-matching actions pass through untouched', async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({ actions: ['cart*'], storage, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);

    const handler = vi.fn(async (cmd: any) => {
      // no idempotency key stamped on pass-through commands
      expect(cmd.meta?.idempotencyKey).toBeUndefined();
      return 'logged-in';
    });
    bus.register('userLogin', handler);

    const result = await bus.dispatch('userLogin', { user: 'a' });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('logged-in');
    expect(handler).toHaveBeenCalledOnce();
    expect(outbox.pending.value).toBe(0);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('passes matching commands through when online with an empty queue', async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({ storage, isOnline: () => true, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    bus.register('cartAdd', async () => 'handled');

    const result = await bus.dispatch('cartAdd', { id: 1 });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('handled');
    expect(outbox.pending.value).toBe(0);
  });

  it('uses navigator.onLine as the default connectivity probe', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const storage = memoryStorage();
    const outbox = createOutbox({ storage, autoFlush: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    outbox.install(bus);

    const result = await bus.dispatch('cartAdd', { id: 1 });
    expect(result.value).toMatchObject({ queued: true });
    expect(outbox.pending.value).toBe(1);
  });

  it('maxQueue drops the oldest record with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    const outbox = createOutbox({ storage, isOnline: () => false, autoFlush: false, maxQueue: 2 });
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    outbox.install(bus);

    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });
    await bus.dispatch('c', { n: 3 });

    expect(outbox.pending.value).toBe(2);
    expect(storage.data!.map(r => r.action)).toEqual(['b', 'c']); // oldest ('a') dropped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxQueue'));
  });

  it('clear() empties the queue and the storage', async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({ storage, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    outbox.install(bus);

    await bus.dispatch('a', { n: 1 });
    expect(outbox.pending.value).toBe(1);

    await outbox.clear();
    expect(outbox.pending.value).toBe(0);
    expect(storage.clear).toHaveBeenCalledOnce();
    expect(storage.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createOutbox — flush / replay
// ---------------------------------------------------------------------------

describe('createOutbox — flush', () => {
  it('replays in FIFO order with the original idempotency keys visible downstream', async () => {
    const storage = memoryStorage();
    let online = false;
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);

    // Downstream plugin (e.g. where idempotent/transport would sit) observes meta.
    const seen: Array<{ action: string; key?: string; origin?: string }> = [];
    bus.use((cmd, next) => {
      seen.push({ action: cmd.action, key: cmd.meta?.idempotencyKey, origin: (cmd.meta as any)?.origin });
      return next();
    }, { priority: 100 });

    bus.register('a', async () => 'ra');
    bus.register('b', async () => 'rb');

    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });
    expect(outbox.pending.value).toBe(2);
    expect(seen).toHaveLength(0); // queued commands never reached downstream plugins

    const key1 = storage.data![0].key;
    const key2 = storage.data![1].key;

    const flushed: any[] = [];
    bus.on('outboxFlushed', (cmd) => flushed.push(cmd.target));

    online = true;
    const summary = await outbox.flush();

    expect(summary).toEqual({ replayed: 2, failed: 0 });
    expect(seen.map(s => s.action)).toEqual(['a', 'b']); // strict FIFO
    expect(seen[0].key).toBe(key1); // ORIGINAL keys, not re-derived
    expect(seen[1].key).toBe(key2);
    expect(seen.every(s => s.origin === 'replay')).toBe(true);
    expect(outbox.pending.value).toBe(0);
    expect(storage.data).toEqual([]);
    expect(flushed).toEqual([{ replayed: 2, failed: 0 }]);
  });

  it('a failing replay stops the flush and preserves order; retry succeeds on next flush', async () => {
    const storage = memoryStorage();
    let online = false;
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);

    let failFirst = true;
    const runs: string[] = [];
    bus.register('a', async () => {
      if (failFirst) throw new Error('boom');
      runs.push('a');
      return 'ok-a';
    });
    bus.register('b', async () => { runs.push('b'); return 'ok-b'; });

    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });

    online = true;
    const first = await outbox.flush();
    expect(first).toEqual({ replayed: 0, failed: 1 });
    expect(runs).toEqual([]); // 'b' never overtook the failed 'a'
    expect(outbox.pending.value).toBe(2);
    expect(storage.data!.map(r => r.action)).toEqual(['a', 'b']); // order preserved

    failFirst = false;
    const second = await outbox.flush();
    expect(second).toEqual({ replayed: 2, failed: 0 });
    expect(runs).toEqual(['a', 'b']);
    expect(outbox.pending.value).toBe(0);
  });

  it('queue-behind semantics: a dispatch during an in-progress flush lands behind the queued records', async () => {
    const storage = memoryStorage();
    let online = false;
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);

    const runs: string[] = [];
    bus.register('a', async () => {
      runs.push('a');
      // New dispatch DURING the flush — must queue behind 'b', not run now.
      const r = await bus.dispatch('c', { n: 3 });
      expect(r.ok).toBe(true);
      expect(r.value).toMatchObject({ queued: true });
      return 'ok-a';
    });
    bus.register('b', async () => { runs.push('b'); return 'ok-b'; });
    bus.register('c', async () => { runs.push('c'); return 'ok-c'; });

    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });

    online = true;
    const summary = await outbox.flush();

    expect(runs).toEqual(['a', 'b', 'c']); // 'c' landed behind 'b'
    expect(summary).toEqual({ replayed: 3, failed: 0 });
    expect(outbox.pending.value).toBe(0);
  });

  it('flush() without a bus rejects; flush(bus) works without install()', async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({ storage, isOnline: () => true, autoFlush: false });
    await expect(outbox.flush()).rejects.toThrow(/no bus/);

    const bus = createAsyncCommandBus();
    bus.use(outbox.plugin, { priority: 200 });
    const summary = await outbox.flush(bus);
    expect(summary).toEqual({ replayed: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// createOutbox — hydrate / dispose / autoFlush
// ---------------------------------------------------------------------------

describe('createOutbox — hydrate and lifecycle', () => {
  it('hydrate() restores a persisted queue and flush replays it with the original key', async () => {
    const record: OutboxRecord = {
      id: 'r1',
      action: 'cartAdd',
      target: { id: 7 },
      payload: { qty: 1 },
      key: 'cartAdd:{"id":7}',
      queuedAt: 123,
    };
    const storage = memoryStorage([record]);
    const outbox = createOutbox({ storage, isOnline: () => true, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);

    const seenKeys: Array<string | undefined> = [];
    bus.register('cartAdd', async (cmd) => { seenKeys.push(cmd.meta?.idempotencyKey); return 'ok'; });

    await outbox.hydrate();
    expect(outbox.pending.value).toBe(1);

    const summary = await outbox.flush();
    expect(summary).toEqual({ replayed: 1, failed: 0 });
    expect(seenKeys).toEqual(['cartAdd:{"id":7}']);
    expect(outbox.pending.value).toBe(0);
  });

  it('autoFlush registers the window "online" listener and flushes on reconnect', async () => {
    let online = false;
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
      removeEventListener: vi.fn(),
    });

    const storage = memoryStorage();
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: true });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    bus.register('a', async () => 'ok');

    await bus.dispatch('a', { n: 1 });
    expect(outbox.pending.value).toBe(1);

    online = true;
    listeners.get('online')!(); // browser fires 'online'
    await vi.waitFor(() => expect(outbox.pending.value).toBe(0));
  });

  it('dispose() removes the "online" listener', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });

    const outbox = createOutbox({ storage: memoryStorage(), autoFlush: true });
    expect(add).toHaveBeenCalledWith('online', expect.any(Function));

    outbox.dispose();
    expect(remove).toHaveBeenCalledWith('online', add.mock.calls[0][1]);

    outbox.dispose(); // idempotent — no second removal
    expect(remove).toHaveBeenCalledOnce();
  });

  it('autoFlush: false does not touch window', () => {
    const add = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: vi.fn() });
    createOutbox({ storage: memoryStorage(), autoFlush: false });
    expect(add).not.toHaveBeenCalled();
  });

  it('hydrate() is a no-op when storage has nothing persisted (load() resolves null)', async () => {
    const outbox = createOutbox({ storage: memoryStorage(), isOnline: () => true, autoFlush: false });
    await outbox.hydrate();
    expect(outbox.pending.value).toBe(0);
  });

  it('hydrate() is a no-op when the persisted queue is an empty array', async () => {
    const outbox = createOutbox({ storage: memoryStorage([]), isOnline: () => true, autoFlush: false });
    await outbox.hydrate();
    expect(outbox.pending.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// localStorageOutbox
// ---------------------------------------------------------------------------

describe('localStorageOutbox', () => {
  const record: OutboxRecord = { id: 'r1', action: 'a', target: { n: 1 }, payload: { p: 2 }, key: 'a:{"n":1}', queuedAt: 1 };

  it('round-trips records through localStorage', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    });

    const s = localStorageOutbox('test:outbox');
    expect(await s.load()).toBeNull();

    await s.save([record]);
    expect(store.has('test:outbox')).toBe(true);
    expect(await s.load()).toEqual([record]);

    await s.clear();
    expect(await s.load()).toBeNull();
  });

  it('is SSR-safe: no localStorage → load() returns null, save/clear are no-ops', async () => {
    const s = localStorageOutbox();
    expect(await s.load()).toBeNull();
    await expect(Promise.resolve(s.save([record]))).resolves.toBeUndefined();
    await expect(Promise.resolve(s.clear())).resolves.toBeUndefined();
  });

  it('returns null on corrupt JSON with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {},
      removeItem: () => {},
    });
    const s = localStorageOutbox();
    expect(await s.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when the stored JSON parses but is not an array', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ not: 'an array' }),
      setItem: () => {},
      removeItem: () => {},
    });
    const s = localStorageOutbox();
    expect(await s.load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// indexedDbOutbox — smoke test with a minimal in-memory fake (no deps)
// ---------------------------------------------------------------------------

/** Minimal fake IDB: enough surface for open/upgrade + get/put/clear requests. */
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

describe('indexedDbOutbox', () => {
  const record: OutboxRecord = { id: 'r1', action: 'a', target: { n: 1 }, key: 'a:{"n":1}', queuedAt: 1 };

  it('round-trips records through a fake indexedDB', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb());

    const s = indexedDbOutbox();
    expect(await s.load()).toBeNull();

    await s.save([record]);
    expect(await s.load()).toEqual([record]);

    await s.clear();
    expect(await s.load()).toBeNull();
  });

  it('is SSR-safe: no indexedDB → load() resolves null, save/clear warn but do not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = indexedDbOutbox();
    expect(await s.load()).toBeNull();
    await s.save([record]);
    await s.clear();
    expect(warn).toHaveBeenCalled();
  });

  it('works end-to-end as the outbox storage', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb());

    const storage: OutboxStorage = indexedDbOutbox();
    let online = false;
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    bus.register('a', async () => 'ok');

    await bus.dispatch('a', { n: 1 });
    expect(outbox.pending.value).toBe(1);

    // A "second session" hydrates the same persisted queue.
    const outbox2 = createOutbox({ storage: indexedDbOutbox(), isOnline: () => true, autoFlush: false });
    const bus2 = createAsyncCommandBus();
    outbox2.install(bus2);
    bus2.register('a', async () => 'ok');
    await outbox2.hydrate();
    expect(outbox2.pending.value).toBe(1);

    online = true;
    const summary = await outbox2.flush();
    expect(summary).toEqual({ replayed: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// createOutbox — key derivation and replay failure shapes
// ---------------------------------------------------------------------------

describe("createOutbox — custom key + non-Error replay failure", () => {
  it("uses a supplied key() instead of the default commandKey", async () => {
    const storage = memoryStorage();
    const outbox = createOutbox({
      actions: ["cart*"],
      storage,
      isOnline: () => false,
      autoFlush: false,
      // A caller-supplied idempotency key — e.g. one the backend already knows.
      key: (cmd) => `custom:${cmd.action}:${(cmd.target as { id: number }).id}`,
    });
    const bus = createAsyncCommandBus({ onMissing: "ignore" });
    outbox.install(bus);

    await bus.dispatch("cartAdd", { id: 7 });

    expect(storage.data?.[0].key).toBe("custom:cartAdd:7");
    // and specifically NOT the default derivation
    expect(storage.data?.[0].key).not.toBe(commandKey("cartAdd", { id: 7 }));
  });

});

/** Fake IDB whose open() fails — private browsing, quota, corrupted profile. */
function failingOpenIndexedDb() {
  return {
    open: () => {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, error: new Error("open denied") };
      queueMicrotask(() => req.onerror?.());
      return req;
    },
  };
}

/** Fake IDB that opens fine but fails the individual request. */
function failingRequestIndexedDb() {
  const db = {
    createObjectStore: () => ({}),
    transaction: () => ({
      objectStore: () => ({
        get: () => { const r: any = { onsuccess: null, onerror: null, error: null }; queueMicrotask(() => r.onerror?.()); return r; },
        put: () => { const r: any = { onsuccess: null, onerror: null, error: null }; queueMicrotask(() => r.onerror?.()); return r; },
        clear: () => { const r: any = { onsuccess: null, onerror: null, error: null }; queueMicrotask(() => r.onerror?.()); return r; },
      }),
    }),
  };
  return {
    open: () => {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
}

describe("indexedDbOutbox — failure paths", () => {
  const record: OutboxRecord = { id: "r1", action: "a", target: { n: 1 }, key: "k", queuedAt: 1 };

  it("a failed open() surfaces as a warning, not a throw, and does not poison later attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", failingOpenIndexedDb());

    const s = indexedDbOutbox();
    // Storage is a best-effort cache for an offline queue: losing it must
    // degrade to "nothing persisted", never break the dispatch path.
    await expect(s.save([record])).resolves.not.toThrow();
    expect(await s.load()).toBeNull();
    expect(warn).toHaveBeenCalled();

    // The cached open promise is cleared on failure, so a second call retries
    // rather than replaying the first rejection forever.
    await expect(s.save([record])).resolves.not.toThrow();
  });

  it("a failed request surfaces the same way once the db is open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", failingRequestIndexedDb());

    const s = indexedDbOutbox();
    expect(await s.load()).toBeNull();
    await expect(s.save([record])).resolves.not.toThrow();
    await expect(s.clear()).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Storage failures are warnings, never throws — the queue must outlive them
// ---------------------------------------------------------------------------

describe("storage failure paths", () => {
  const record: OutboxRecord = { id: "r1", action: "a", target: { n: 1 }, key: "k", queuedAt: 1 };

  it("localStorageOutbox warns instead of throwing when the store rejects writes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Quota exceeded is the real case here: Safari private mode throws on
    // setItem rather than reporting a full quota, and an offline queue that
    // cannot persist must still work in memory.
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("read denied"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("remove denied"); },
    });

    const s = localStorageOutbox();
    expect(s.load()).toBeNull();
    expect(() => s.save([record])).not.toThrow();
    expect(() => s.clear()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("createOutbox survives a storage that rejects on every call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage: OutboxStorage = {
      load: async () => { throw new Error("load failed"); },
      save: async () => { throw new Error("save failed"); },
      clear: async () => { throw new Error("clear failed"); },
    };
    const outbox = createOutbox({ storage, isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ onMissing: "ignore" });
    outbox.install(bus);

    // hydrate(), saveQueue() and clear() each swallow-and-warn on their own,
    // so the in-memory queue stays authoritative even with no working storage.
    await expect(outbox.hydrate()).resolves.not.toThrow();

    const result = await bus.dispatch("cartAdd", { id: 1 });
    expect(result.ok).toBe(true);
    expect(outbox.pending.value).toBe(1); // queued in memory despite save() failing

    await expect(outbox.clear()).resolves.not.toThrow();
    expect(outbox.pending.value).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

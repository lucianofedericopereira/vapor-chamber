/**
 * Tests for the offline outbox: createOutbox on the bus, its queue saved by persist
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Accepted, createAsyncCommandBus, type Command, type CommandResult } from '../src/index';
import { createOutbox } from '../src/outbox';
import type { Outbox, OutboxOptions, OutboxRecord } from '../src/outbox';
import type { PersistStorage } from '../src/store-persist';
import { queueStorage, storedRecord } from './outbox-storage';
import { defineTransport } from '../src/transports';
import { indexedDbStorage } from '../src/idb';
import { _failures } from '../src/command-bus';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The queue's storage: its saves counted, its last saved records readable. */
// Its own name: an outbox in a page opens tabs, and Node shares BroadcastChannel and locks across vitest's workers.
const NAME = 'vc:outbox:outbox-test';
const memoryStorage = (initial: OutboxRecord[] | null = null) => queueStorage(initial, { key: NAME });
/** A microtask: persist saves once per microtask after a write. */
const saved = () => Promise.resolve();

/**
 * A bus whose every action goes out through one transport that records what it sent; `fail`
 * answers in its place for a command it names. `online` is read by the outbox per send.
 */
function world(opts: Partial<OutboxOptions> & { storage?: PersistStorage } = {}) {
  const sent: Command[] = [];
  const state = { online: false, fail: (_cmd: Command): CommandResult | undefined => undefined };
  const transport = defineTransport(async (cmd) => {
    const failed = state.fail(cmd);
    if (failed) return failed;
    sent.push(cmd);
    return { ok: true, value: `r-${cmd.action}`, error: undefined };
  });
  const storage = opts.storage ?? null;
  const outbox: Outbox = createOutbox({ name: NAME, isOnline: () => state.online, autoFlush: false, ...opts, storage });
  const bus = createAsyncCommandBus({ retry: false, transport, outbox });
  return { bus, outbox, storage, sent, state, actions: () => sent.map((c) => c.action) };
}
const doneOf = (r: CommandResult): Promise<CommandResult> => (r.value as Accepted).done;
/** A failure as its owner raises it, a real `BusError`. */
const coded = (code: string): CommandResult => {
  const [owner, ...rest] = code.split(':');
  return { ok: false, value: undefined, error: _failures(owner)(rest.join(':') as never, code) };
};
const remote422 = (): CommandResult => coded('remote:invalid:payload');

// ---------------------------------------------------------------------------
// createOutbox - holding
// ---------------------------------------------------------------------------

describe('createOutbox - holding', () => {
  it('holds a covered command while offline: an Accepted, pending bumped, the record saved', async () => {
    const storage = memoryStorage();
    const { bus, outbox, sent } = world({ actions: ['cart*'], storage });

    const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(result.ok).toBe(true);
    expect(result.value).toBeInstanceOf(Accepted);
    expect(outbox.pending.value).toBe(1);
    expect(sent).toEqual([]);
    await saved();
    expect(storage.saves).toBe(1);
    expect(storage.rows()[0]).toMatchObject({ action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 } });
    expect(storage.rows()[0]!.key).toBe(storage.rows()[0]!.id); // the record's id alone (log 36.48)
  });

  it('stamps queuedAt as an RFC 3339 UTC string that round-trips through Date.parse', async () => {
    const storage = memoryStorage();
    const { bus } = world({ storage });

    const before = Date.now();
    await bus.dispatch('cartAdd', { id: 1 });
    const after = Date.now();

    await saved();
    const queuedAt = storage.rows()[0]!.queuedAt;
    expect(queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ms = Date.parse(queuedAt);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(new Date(ms).toISOString()).toBe(queuedAt);
  });

  it('an action outside `actions` is sent at once, unkeyed by the outbox', async () => {
    const storage = memoryStorage();
    const { bus, outbox, sent } = world({ actions: ['cart*'], storage });

    const result = await bus.dispatch('userLogin', { user: 'a' });

    expect(result).toSucceedWith('r-userLogin');
    expect(sent).toHaveLength(1);
    expect(outbox.pending.value).toBe(0);
    await saved();
    expect(storage.saves).toBe(0);
  });

  it('`actionFilter` narrows what is held', async () => {
    const { bus, outbox } = world({ actionFilter: (a) => a !== 'cartPeek' });
    await bus.dispatch('cartPeek', {});
    expect(outbox.pending.value).toBe(0);
    await bus.dispatch('cartAdd', {});
    expect(outbox.pending.value).toBe(1);
  });

  it('a local handler is never held', async () => {
    const outbox = createOutbox({ name: NAME, storage: memoryStorage(), isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ outbox });
    bus.register('cartAdd', async () => 'handled');
    expect(await bus.dispatch('cartAdd', {})).toSucceedWith('handled');
    expect(outbox.pending.value).toBe(0);
  });

  it('sends a covered command when online with nothing held', async () => {
    const { bus, outbox, state } = world();
    state.online = true;
    expect(await bus.dispatch('cartAdd', { id: 1 })).toSucceedWith('r-cartAdd');
    expect(outbox.pending.value).toBe(0);
  });

  it('reads navigator.onLine once at creation when no isOnline is given', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { bus, outbox } = world({ isOnline: undefined });
    const result = await bus.dispatch('cartAdd', { id: 1 });
    expect(result.value).toBeInstanceOf(Accepted);
    expect(outbox.pending.value).toBe(1);
  });

  it('assumes online when there is no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined);
    const { bus, outbox } = world({ isOnline: undefined });
    expect(await bus.dispatch('cartAdd', { id: 1 })).toSucceedWith('r-cartAdd');
    expect(outbox.pending.value).toBe(0);
  });

  it('maxSize drops the oldest record with a warning, and its caller hears it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    const { bus, outbox } = world({ storage, maxSize: 2 });

    const first = await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });
    await bus.dispatch('c', { n: 3 });

    expect(outbox.pending.value).toBe(2);
    await saved();
    expect(storage.rows().map((r) => r.action)).toEqual(['b', 'c']); // oldest ('a') dropped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxSize'));
    expect(await doneOf(first)).toFailWith('outbox:exceeded:queue');
  });

  // Same class as `cache({ maxSize: -1 })`, which hung its eviction loop. Here
  // the identical `while (length > max)` shape threw instead: on a negative
  // bound the condition stays true once the queue is empty, `shift()` returns
  // undefined, and the warning dereferenced it.
  it('a negative maxSize is clamped instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, outbox } = world({ maxSize: -1 });
    const result = await bus.dispatch('a', { n: 1 });
    // Clamped to 0: held, then dropped at once by the bound, which is what maxSize 0 means.
    expect(result.ok).toBe(true);
    expect(outbox.pending.value).toBe(0);
  });

  // NaN propagates through Math.trunc/Math.max and loses every comparison, so
  // `queue.length > maxSize` never fired and the bound vanished - measured at
  // 300 records queued before this guard. ../bounds falls back to the
  // documented default: holding nothing while offline would discard the
  // commands the outbox exists to hold.
  it('a NaN maxSize falls back to the default instead of unbounding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, outbox } = world({ maxSize: Number('nope') });
    for (let i = 0; i < 250; i++) await bus.dispatch('a', { i });
    expect(outbox.pending.value).toBe(200);
  });

  it('clear() empties the queue and its saved copy, and a waiting caller hears it', async () => {
    const storage = memoryStorage();
    const { bus, outbox } = world({ storage });

    const held = await bus.dispatch('a', { n: 1 });
    expect(outbox.pending.value).toBe(1);

    await outbox.clear();
    expect(outbox.pending.value).toBe(0);
    await saved();
    expect(storage.rows()).toEqual([]);
    expect(await doneOf(held)).toFailWith('outbox:aborted:clear');
  });
});

// ---------------------------------------------------------------------------
// createOutbox - the stored queue
// ---------------------------------------------------------------------------

describe('createOutbox - the stored queue', () => {
  const stored = (n: number): OutboxRecord => storedRecord({ id: String(n), action: `a${n}`, target: { n }, key: `k${n}`, queuedAt: new Date(n).toISOString() });

  it('a sync storage loads at creation: nothing waits at startup', async () => {
    const { outbox, bus, state } = world({ storage: memoryStorage() });
    state.online = true;
    expect(await bus.dispatch('cartAdd', {})).toSucceedWith('r-cartAdd');
    expect(outbox.pending.value).toBe(0);
  });

  it('loads at creation and replays with the stored key', async () => {
    const storage = memoryStorage([{ ...stored(7), action: 'cartAdd', key: 'cartAdd:{"id":7}' }]);
    const { outbox, sent, state } = world({ storage });
    expect(outbox.pending.value).toBe(1);
    state.online = true;
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
    expect(sent.map((c) => c.meta?.idempotencyKey)).toEqual(['cartAdd:{"id":7}']);
    expect(outbox.pending.value).toBe(0);
  });

  it('an async storage holds every covered send until it lands, its records first', async () => {
    const storage = queueStorage([stored(1)], { async: true, key: NAME });
    const { bus, outbox, state, actions } = world({ storage });
    state.online = true;
    const r = await bus.dispatch('cartAdd', {});
    expect(r.value).toBeInstanceOf(Accepted);
    await outbox.flush();
    expect(actions()).toEqual(['a1', 'cartAdd']);
  });

  it('persists the trim when the loaded queue is over the bound', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage([1, 2, 3, 4].map(stored));
    const { outbox } = world({ storage, maxSize: 2 });
    expect(outbox.pending.value).toBe(2);
    // Without persisting the trim, storage kept all four and the same two
    // records were re-loaded and re-dropped on every startup.
    await saved();
    expect(storage.rows().map((r) => r.action)).toEqual(['a3', 'a4']);
  });

  it('does not rewrite storage when nothing is dropped', async () => {
    const storage = memoryStorage([stored(1)]);
    const { outbox } = world({ storage, maxSize: 10 });
    expect(outbox.pending.value).toBe(1);
    await saved();
    expect(storage.saves).toBe(0);
  });

  it('loads nothing from null or an empty array', () => {
    expect(world({ storage: memoryStorage() }).outbox.pending.value).toBe(0);
    expect(world({ storage: memoryStorage([]) }).outbox.pending.value).toBe(0);
  });

  it("a stored record refused for good goes to `rejected`; this session's caller hears its own", async () => {
    const storage = memoryStorage([stored(1)]);
    const { bus, outbox, state } = world({ storage });
    const held = await bus.dispatch('cartAdd', {});
    state.fail = remote422;
    state.online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 0, rejected: 2 });
    expect(outbox.rejected.value.map((x) => x.record.id)).toEqual(['1']);
    expect((await doneOf(held)).ok).toBe(false);
    expect(outbox.pending.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createOutbox - flush / replay
// ---------------------------------------------------------------------------

describe('createOutbox - flush', () => {
  it('replays in FIFO order with the original keys and origin replay; done settles with each answer', async () => {
    const storage = memoryStorage();
    const { bus, outbox, sent, state } = world({ storage });

    const ra = await bus.dispatch('a', { n: 1 });
    const rb = await bus.dispatch('b', { n: 2 });
    expect(outbox.pending.value).toBe(2);
    await saved();
    const keys = storage.rows().map((r) => r.key);

    state.online = true;
    expect(await outbox.flush()).toEqual({ replayed: 2, failed: 0, rejected: 0 });
    expect(sent.map((c) => c.action)).toEqual(['a', 'b']); // strict FIFO
    expect(sent.map((c) => c.meta?.idempotencyKey)).toEqual(keys); // ORIGINAL keys
    expect(sent.every((c) => c.meta?.origin === 'replay')).toBe(true);
    expect(outbox.pending.value).toBe(0);
    await saved();
    expect(storage.rows()).toEqual([]);
    expect(await doneOf(ra)).toSucceedWith('r-a');
    expect(await doneOf(rb)).toSucceedWith('r-b');
  });

  it('a retryable failure stops the flush and keeps the order; the next flush sends both', async () => {
    const storage = memoryStorage();
    const { bus, outbox, state, actions } = world({ storage });
    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });

    state.online = true;
    state.fail = (cmd) => (cmd.action === 'a' ? { ok: false, value: undefined, error: new Error('down') } : undefined);
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(actions()).toEqual([]); // 'b' never overtook the failed 'a'
    await saved();
    expect(storage.rows().map((r) => r.action)).toEqual(['a', 'b']);

    state.fail = () => undefined;
    expect(await outbox.flush()).toEqual({ replayed: 2, failed: 0, rejected: 0 });
    expect(actions()).toEqual(['a', 'b']);
  });

  it('a transport that throws keeps the record (transport:failed:send is not a verdict)', async () => {
    const state = { online: false, explode: true };
    const transport = defineTransport(async () => { if (state.explode) throw new Error('wire exploded'); return { ok: true, value: 'ok', error: undefined }; });
    const outbox = createOutbox({ storage: null, isOnline: () => state.online, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport, outbox });
    await bus.dispatch('a', {});
    state.online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    state.explode = false;
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
  });

  it('a held command goes to the local handler when its action has no transport any more', async () => {
    const storage = memoryStorage([storedRecord({ id: 'r1', action: 'local', target: 1, key: 'k' })]);
    const transport = defineTransport(async () => ({ ok: true, value: 'sent', error: undefined }));
    const outbox = createOutbox({ name: NAME, storage, isOnline: () => true, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: { cart: transport }, outbox });
    bus.register('local', async () => 'ran-here');
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
  });

  it('a command sent during a flush is held behind the records', async () => {
    const { bus, outbox, state, actions } = world();
    await bus.dispatch('a', { n: 1 });
    await bus.dispatch('b', { n: 2 });
    state.online = true;
    let during: CommandResult | undefined;
    state.fail = (cmd) => {
      if (cmd.action === 'a' && during === undefined) void bus.dispatch('c', { n: 3 }).then((r) => { during = r; });
      return undefined;
    };
    const summary = await outbox.flush();
    expect(during?.value).toBeInstanceOf(Accepted);
    expect(actions()).toEqual(['a', 'b', 'c']);
    expect(summary).toEqual({ replayed: 3, failed: 0, rejected: 0 });
  });

  it('flush() off a bus rejects', async () => {
    const outbox = createOutbox({ storage: null, isOnline: () => true, autoFlush: false });
    await expect(outbox.flush()).rejects.toThrow(/on no bus/);
  });

  it('a second flush during one joins it', async () => {
    const { bus, outbox, state } = world();
    await bus.dispatch('a', {});
    state.online = true;
    const [x, y] = await Promise.all([outbox.flush(), outbox.flush()]);
    expect(x).toBe(y);
  });

  it('going offline mid-flush leaves the rest held', async () => {
    const { bus, outbox, state, actions } = world();
    await bus.dispatch('a', {});
    await bus.dispatch('b', {});
    state.online = true;
    state.fail = (cmd) => { if (cmd.action === 'a') state.online = false; return undefined; };
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
    expect(actions()).toEqual(['a']);
    expect(outbox.pending.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createOutbox - the default isRetryable
// ---------------------------------------------------------------------------

describe('createOutbox - the default rule', () => {
  async function replay(fail: (cmd: Command) => CommandResult | undefined) {
    const storage = memoryStorage();
    const w = world({ storage });
    const ra = await w.bus.dispatch('a', { n: 1 });
    await w.bus.dispatch('b', { n: 2 });
    w.state.fail = fail;
    w.state.online = true;
    return { ...w, storage, ra, summary: await w.outbox.flush() };
  }
  it("a server's verdict is final: dropped, its caller hears it, and the queue drains", async () => {
    const { summary, storage, actions, ra } = await replay((cmd) => (cmd.action === 'a' ? remote422() : undefined));
    expect(summary).toEqual({ replayed: 1, failed: 0, rejected: 1 });
    expect(actions()).toEqual(['b']);
    await saved();
    expect(storage.rows()).toEqual([]);
    expect((await doneOf(ra)).ok).toBe(false);
  });

  it('a library failure other than invalid is kept', async () => {
    const { summary, storage } = await replay((cmd) => (cmd.action === 'a' ? coded('transport:failed:send') : undefined));
    expect(summary).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    await saved();
    expect(storage.rows().map((r) => r.action)).toEqual(['a', 'b']);
  });

  it('a library invalid is final', async () => {
    const { summary } = await replay((cmd) => (cmd.action === 'a' ? coded('validator:invalid:payload') : undefined));
    expect(summary).toEqual({ replayed: 1, failed: 0, rejected: 1 });
  });
});

// ---------------------------------------------------------------------------
// createOutbox - window listeners and lifecycle
// ---------------------------------------------------------------------------

describe('createOutbox - window listeners and lifecycle', () => {
  function stubWindow() {
    const listeners: Record<string, Array<() => void>> = {};
    const add = vi.fn((ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); });
    const remove = vi.fn((ev: string, fn: () => void) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); });
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
    return { listeners, add, remove, fire: (ev: string) => { for (const f of listeners[ev] ?? []) f(); } };
  }

  it('the offline and online events keep the flag, and online flushes', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const win = stubWindow();
    const { bus, outbox } = world({ isOnline: undefined, autoFlush: true });
    win.fire('offline');
    const r = await bus.dispatch('a', {});
    expect(r.value).toBeInstanceOf(Accepted);
    win.fire('online');
    expect(await doneOf(r)).toSucceedWith('r-a');
    expect(outbox.pending.value).toBe(0);
  });

  it('an online event on an outbox with nothing held does nothing', () => {
    const win = stubWindow();
    const { outbox } = world({ autoFlush: true });
    expect(() => win.fire('online')).not.toThrow();
    expect(outbox.pending.value).toBe(0);
  });

  it("an online event before the outbox is on a bus flushes nothing", async () => {
    const win = stubWindow();
    const storage = memoryStorage([storedRecord({ id: 'r1', action: 'a', target: 1, key: 'k' })]);
    const outbox = createOutbox({ name: NAME, storage, isOnline: () => true });
    win.fire('online');
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.rows()).toHaveLength(1);
    outbox.dispose();
  });

  it('a stored queue flushes once loaded on a bus while online', async () => {
    stubWindow();
    const storage = memoryStorage([storedRecord({ id: 'r1', action: 'a', target: 1, key: 'k' })]);
    const sent: string[] = [];
    const transport = defineTransport(async (cmd) => { sent.push(cmd.action); return { ok: true, value: 'ok', error: undefined }; });
    const outbox = createOutbox({ name: NAME, storage, isOnline: () => true });
    createAsyncCommandBus({ retry: false, transport, outbox });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['a']);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });

  it('dispose() removes both listeners, once; the bus disposes its outbox', () => {
    const win = stubWindow();
    const { bus } = world({ isOnline: undefined, autoFlush: true });
    expect(win.add).toHaveBeenCalledTimes(2);
    bus.dispose();
    expect(win.remove).toHaveBeenCalledTimes(2);
  });

  it('with isOnline given and autoFlush off, the window is not touched', () => {
    const win = stubWindow();
    world({ autoFlush: false });
    expect(win.add).not.toHaveBeenCalled();
  });

  it('a store that fails to load warns and starts empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing: PersistStorage = { getItem: () => { throw new Error('load failed'); }, setItem: () => {} };
    expect(world({ storage: throwing }).outbox.pending.value).toBe(0);
    const rejecting: PersistStorage = { getItem: async () => { throw new Error('load failed'); }, setItem: () => {} };
    const { outbox } = world({ storage: rejecting });
    await new Promise((r) => setTimeout(r, 0));
    expect(outbox.pending.value).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The queue on IndexedDB (indexedDbStorage), with a minimal in-memory fake
// ---------------------------------------------------------------------------

/**
 * Minimal fake IDB: enough surface for open/upgrade + get/put requests. The
 * real order: the request succeeds, then its transaction completes.
 */
function fakeIndexedDb() {
  const data = new Map<string, any>();
  const db = {
    createObjectStore: () => ({}),
    transaction: () => {
      const tx: any = { oncomplete: null, onabort: null, error: null };
      function request(result?: any) {
        const req: any = { onsuccess: null, onerror: null, result };
        queueMicrotask(() => {
          req.onsuccess?.();
          queueMicrotask(() => tx.oncomplete?.());
        });
        return req;
      }
      tx.objectStore = () => ({
        get: (k: string) => request(data.get(k)),
        put: (v: any, k: string) => { data.set(k, v); return request(); },
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

describe('the queue on IndexedDB', () => {
  it('works end-to-end as the outbox storage', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb());
    const first = world({ storage: indexedDbStorage() });
    await first.bus.dispatch('a', { n: 1 });
    expect(first.outbox.pending.value).toBe(1);
    await new Promise((r) => setTimeout(r, 0));

    // A "second session" loads the same stored queue at creation.
    const second = world({ storage: indexedDbStorage() });
    await vi.waitFor(() => expect(second.outbox.pending.value).toBe(1));
    second.state.online = true;
    expect(await second.outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
  });
});

// ---------------------------------------------------------------------------
// createOutbox - key derivation and replay failure shapes
// ---------------------------------------------------------------------------

describe("createOutbox - custom key", () => {
  it("uses a supplied key() instead of the default record id", async () => {
    const storage = memoryStorage();
    // A caller-supplied idempotency key - e.g. one the backend already knows.
    const { bus } = world({ actions: ["cart*"], storage, key: (cmd) => `custom:${cmd.action}:${(cmd.target as { id: number }).id}` });

    await bus.dispatch("cartAdd", { id: 7 });

    await saved();
    expect(storage.rows()[0]?.key).toBe("custom:cartAdd:7");
    // and specifically NOT the default derivation
    expect(storage.rows()[0]?.key).not.toBe(storage.rows()[0]?.id);
  });
});

// ---------------------------------------------------------------------------
// Storage failures are warnings, never throws - the queue must outlive them
// ---------------------------------------------------------------------------

describe("storage failure paths", () => {
  it("createOutbox survives a storage that rejects on every call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage: PersistStorage = {
      getItem: async () => { throw new Error("load failed"); },
      setItem: async () => { throw new Error("save failed"); },
    };
    const { bus, outbox } = world({ storage });
    await new Promise((r) => setTimeout(r, 0));

    // The load and every save each swallow-and-warn on their own (persist),
    // so the in-memory queue stays authoritative even with no working storage.
    const result = await bus.dispatch("cartAdd", { id: 1 });
    expect(result.ok).toBe(true);
    expect(outbox.pending.value).toBe(1); // held in memory despite save() failing

    await expect(outbox.clear()).resolves.not.toThrow();
    expect(outbox.pending.value).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

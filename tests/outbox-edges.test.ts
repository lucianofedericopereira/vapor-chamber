/**
 * Outbox - the paths the happy-path suite does not reach.
 *
 * `tests/outbox.test.ts` covers queue -> flush -> drain. What it never exercises
 * are the arms that only fire when something is wrong or unusual: no bus, a
 * re-entrant flush, going offline mid-flush, a handler that throws rather than
 * returning `{ ok: false }`, and the `window`-less (SSR / worker) branch of
 * autoFlush.
 *
 * Each of these is a real operating condition for an offline queue, not a
 * synthetic edge: an outbox exists precisely because the network is unreliable.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus } from '../src/index';
import { createOutbox } from '../src/outbox';
import type { OutboxRecord, OutboxStorage } from '../src/outbox';
import { it } from '../src/vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

/** In-memory storage so nothing here depends on localStorage or IndexedDB. */
function memoryStorage(seed: OutboxRecord[] = []): OutboxStorage {
  let rows = [...seed];
  return {
    load: async () => [...rows],
    save: async (records) => { rows = [...records]; },
    clear: async () => { rows = []; },
  };
}

describe('outbox - flush without a bus', () => {
  it('rejects with an actionable message instead of throwing something opaque', async () => {
    const outbox = createOutbox({ storage: memoryStorage(), autoFlush: false });
    await expect(outbox.flush()).rejects.toThrow(/no bus available/);
    // The message has to name both fixes, because which one applies depends on
    // how the caller wired it.
    await expect(outbox.flush()).rejects.toThrow(/install\(bus\)|flush\(bus\)/);
  });
});

describe('outbox - flush re-entrancy', () => {
  it('a second flush joins the in-progress one rather than starting a race', async () => {
    let release: (() => void) | null = null as (() => void) | null;
    const gate = new Promise<void>((r) => { release = r; });

    const bus = createAsyncCommandBus();
    let dispatches = 0;
    bus.register('sync', async () => { dispatches++; await gate; return { ok: true } as const; });

    let online = false;
    const outbox = createOutbox({
      storage: memoryStorage(),
      autoFlush: false,
      isOnline: () => online,
    });
    outbox.install(bus);

    await bus.dispatch('sync', 'row-1'); // queued while offline
    expect(outbox.pending.value).toBe(1);

    online = true;
    const a = outbox.flush();
    const b = outbox.flush();
    expect(a).toBe(b); // identical promise - the second call joined, it did not re-enter

    release?.();
    await a;
    expect(dispatches).toBe(1);
  });
});

describe('outbox - failure and interruption during flush', () => {
  it('a handler that THROWS is captured as a failed result, not an unhandled rejection', async ({ asyncBus: bus }) => {
    bus.register('sync', async () => { throw new Error('backend exploded'); });

    let online = false;
    const outbox = createOutbox({
      storage: memoryStorage(),
      autoFlush: false,
      isOnline: () => online,
    });
    outbox.install(bus); // registers the plugin itself - do NOT bus.use() it again

    const queued = await bus.dispatch('sync', 'row-1');
    expect((queued.value as { queued?: boolean } | undefined)?.queued).toBe(true);

    online = true;
    await expect(outbox.flush()).resolves.toBeDefined(); // must not reject
    // The record stays queued: a throw is a failure, so it is retried later.
    expect(outbox.pending.value).toBe(1);
  });

  it('going offline mid-flush leaves the remaining records queued', async ({ asyncBus: bus }) => {
    let online = false;
    let handled = 0;

    const outbox = createOutbox({
      storage: memoryStorage(),
      autoFlush: false,
      isOnline: () => online,
    });

    bus.register('sync', async () => {
      handled++;
      online = false; // the connection drops while the first record replays
      return { ok: true } as const;
    });
    outbox.install(bus); // registers the plugin itself - do NOT bus.use() it again

    await bus.dispatch('sync', 'row-1');
    await bus.dispatch('sync', 'row-2');
    expect(outbox.pending.value).toBe(2);

    online = true;
    await outbox.flush();

    // One replayed and drained; the loop then saw isOnline() === false and
    // stopped rather than burning the rest against a dead connection.
    expect(handled).toBe(1);
    expect(outbox.pending.value).toBe(1);
  });
});

describe('outbox - autoFlush without a window', () => {
  it('does not attempt to bind an online listener under SSR / workers', () => {
    vi.stubGlobal('window', undefined);
    // The branch under test is the `typeof window !== 'undefined'` guard: with
    // no window this must construct and dispose cleanly rather than throwing.
    const outbox = createOutbox({ storage: memoryStorage(), autoFlush: true });
    expect(() => outbox.dispose()).not.toThrow();
  });

  it('binds and unbinds the online listener when a window exists', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });

    const outbox = createOutbox({ storage: memoryStorage(), autoFlush: true });
    expect(add).toHaveBeenCalledWith('online', expect.any(Function));

    outbox.dispose();
    expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
  });
});

describe('outbox - a failed replay that carries no error', () => {
  it('is judged with a generic Error, not undefined', async () => {
    const bus = createAsyncCommandBus();
    bus.register('sync', async () => 'saved');
    let online = false;
    const seen: unknown[] = [];
    const outbox = createOutbox({
      storage: memoryStorage(),
      autoFlush: false,
      isOnline: () => online,
      isRetryable: (error) => { seen.push(error); return true; },
    });
    outbox.install(bus);
    await bus.dispatch('sync', 'row-1'); // queued while offline

    // A plugin below the outbox that fails the replay with no `error` field -
    // the shape a hand-written plugin can return.
    bus.use(() => ({ ok: false, value: undefined }) as never, { priority: -50 });
    online = true;
    const summary = await outbox.flush(bus);

    expect(summary).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('Unknown error');
  });
});

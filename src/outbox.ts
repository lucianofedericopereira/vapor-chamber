/**
 * vapor-chamber — Offline outbox
 *
 * Queue commands durably while offline, replay them in order on reconnect,
 * and deduplicate server-side via the Idempotency-Key header.
 *
 * The outbox composes three existing primitives into one headline feature:
 *   - the `idempotent()` key convention (`commandKey(action, target)` stamped
 *     onto `cmd.meta.idempotencyKey`),
 *   - the HTTP bridge, which forwards `meta.idempotencyKey` as an
 *     `Idempotency-Key` header so the backend can reject duplicate writes,
 *   - the `persist()` storage style for durable, SSR-safe queue snapshots.
 *
 * Install the plugin OUTERMOST (higher priority than `idempotent` and the
 * transport) so offline commands are captured before any wire work happens.
 */

import type { AsyncCommandBus, AsyncPlugin, Command, CommandResult } from './command-bus';
import { commandKey, matchesPattern } from './command-bus';
import { signal } from './signal';
import type { Signal } from './signal';

function makeActionFilter(patterns: string[] | undefined): (action: string) => boolean {
  if (!patterns?.length) return () => true;
  return (action: string) => patterns.some(p => matchesPattern(p, action));
}

/** Lightweight unique record ID — timestamp + random suffix (same style as the WS bridge). */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

/**
 * A queued command awaiting replay. JSON-serializable by design — `target` and
 * `payload` round-trip through the storage adapter, so keep them plain data
 * (no functions, no DOM nodes) for actions routed through the outbox.
 */
export type OutboxRecord = {
  /** Unique record ID (distinct from the command's `meta.id`, which is re-stamped on replay). */
  id: string;
  /** The command's action name. */
  action: string;
  /** The command's target, exactly as dispatched. */
  target: any;
  /** The command's payload, exactly as dispatched. */
  payload?: any;
  /**
   * The idempotency key derived at ENQUEUE time. Replays stamp this original
   * key onto `cmd.meta.idempotencyKey`, so the backend sees the same
   * `Idempotency-Key` header for every delivery attempt of this command.
   */
  key: string;
  /** Date.now() at enqueue time. */
  queuedAt: number;
};

/**
 * Durable storage for the outbox queue. All methods may be sync or async —
 * the outbox awaits them either way. `load()` returns `null` when nothing is
 * persisted (or the backing store is unavailable, e.g. SSR).
 */
export type OutboxStorage = {
  load(): Promise<OutboxRecord[] | null> | OutboxRecord[] | null;
  save(records: OutboxRecord[]): Promise<void> | void;
  clear(): Promise<void> | void;
};

/**
 * localStorageOutbox — default storage adapter: the whole queue as one JSON
 * value in `localStorage`. SSR-safe: when `localStorage` is unavailable,
 * `load()` returns null and `save()`/`clear()` are no-ops (with a console
 * warning on save failure, e.g. quota exceeded).
 *
 * @param storageKey Storage key. Default: `'vc:outbox'`.
 *
 * @example
 * const outbox = createOutbox({ storage: localStorageOutbox('vc:cart-outbox') });
 */
export function localStorageOutbox(storageKey: string = 'vc:outbox'): OutboxStorage {
  function getStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
      return (globalThis as any).localStorage as Storage;
    }
    return null;
  }

  return {
    load(): OutboxRecord[] | null {
      const store = getStore();
      if (!store) return null;
      try {
        const raw = store.getItem(storageKey);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as OutboxRecord[]) : null;
      } catch (e) {
        console.warn(`[vapor-chamber] outbox: failed to load key "${storageKey}":`, e);
        return null;
      }
    },
    save(records: OutboxRecord[]): void {
      const store = getStore();
      if (!store) return;
      try { store.setItem(storageKey, JSON.stringify(records)); }
      catch (e) { console.warn(`[vapor-chamber] outbox: failed to save key "${storageKey}":`, e); }
    },
    clear(): void {
      const store = getStore();
      if (!store) return;
      try { store.removeItem(storageKey); }
      catch (e) { console.warn(`[vapor-chamber] outbox: failed to clear key "${storageKey}":`, e); }
    },
  };
}

/**
 * indexedDbOutbox — zero-dependency IndexedDB adapter. Stores the whole queue
 * as one value under a fixed key, so reads and writes are single-transaction
 * and atomic. Prefer this over `localStorageOutbox` when queued payloads are
 * large (localStorage has a ~5 MB origin quota and synchronous I/O).
 *
 * SSR-safe: the database is opened lazily on first use; when `indexedDB` is
 * unavailable, `load()` resolves to null and `save()`/`clear()` warn and no-op.
 *
 * @param dbName    Database name. Default: `'vc-outbox'`.
 * @param storeName Object store name. Default: `'records'`.
 *
 * @example
 * const outbox = createOutbox({ storage: indexedDbOutbox() });
 * await outbox.hydrate();
 */
export function indexedDbOutbox(dbName: string = 'vc-outbox', storeName: string = 'records'): OutboxStorage {
  const QUEUE_KEY = 'queue';
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise === null) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const idb: IDBFactory | undefined = (globalThis as any).indexedDB;
        if (!idb) {
          dbPromise = null; // don't cache the failure — a later call may run where IDB exists
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
    async load(): Promise<OutboxRecord[] | null> {
      try {
        const result = await run<unknown>('readonly', s => s.get(QUEUE_KEY));
        return Array.isArray(result) ? (result as OutboxRecord[]) : null;
      } catch (e) {
        console.warn(`[vapor-chamber] outbox: failed to load from indexedDB "${dbName}":`, e);
        return null;
      }
    },
    async save(records: OutboxRecord[]): Promise<void> {
      try { await run('readwrite', s => s.put(records, QUEUE_KEY)); }
      catch (e) { console.warn(`[vapor-chamber] outbox: failed to save to indexedDB "${dbName}":`, e); }
    },
    async clear(): Promise<void> {
      try { await run('readwrite', s => s.clear()); }
      catch (e) { console.warn(`[vapor-chamber] outbox: failed to clear indexedDB "${dbName}":`, e); }
    },
  };
}

// ---------------------------------------------------------------------------
// createOutbox
// ---------------------------------------------------------------------------

export type OutboxOptions = {
  /** Which actions to capture. Glob patterns supported: '*', 'cart*'. Default: all. */
  actions?: string[];
  /** Durable queue storage. Default: `localStorageOutbox()`. */
  storage?: OutboxStorage;
  /**
   * Connectivity probe, checked per dispatch and per replay step.
   * Default: `navigator.onLine` when a navigator exists, otherwise `true` (SSR).
   */
  isOnline?: () => boolean;
  /**
   * Listen for the window `'online'` event and `flush()` automatically once a
   * bus ref exists (via `install()`). Default: true. No timers, no polling —
   * the listener is removed by `dispose()`.
   */
  autoFlush?: boolean;
  /**
   * Derive the idempotency key stored on each record and replayed to the
   * backend. Default: `commandKey(action, target)` — the same convention the
   * `idempotent()` plugin uses, so both layers agree on what "the same
   * logical command" means.
   */
  key?: (cmd: Command) => string;
  /**
   * Max queued records — bounded memory. When exceeded, the OLDEST record is
   * dropped with a console warning. Default: 200.
   */
  maxQueue?: number;
};

/** The object returned by {@link createOutbox}. */
export type Outbox = {
  /**
   * The outbox plugin. Install OUTERMOST — before `idempotent()` and the
   * transport — so offline commands are captured before any wire work:
   * `bus.use(outbox.plugin, { priority: 200 })`.
   */
  plugin: AsyncPlugin;
  /** Convenience: `bus.use(plugin, { priority: 200 })` + keep the bus ref for `flush()` / auto-flush. */
  install(bus: AsyncCommandBus): void;
  /**
   * Replay the queue sequentially (strict FIFO). Each record is re-dispatched
   * through the full pipeline with its ORIGINAL idempotency key stamped on
   * `cmd.meta.idempotencyKey`, so the HTTP bridge sends the same
   * `Idempotency-Key` the backend may have already seen. The first failed
   * replay stops the flush — that record and everything after it stay queued.
   * Re-entrant calls join the in-progress flush.
   */
  flush(bus?: AsyncCommandBus): Promise<{ replayed: number; failed: number }>;
  /** Reactive queue depth — bindable in templates ("3 changes pending sync"). */
  pending: Signal<number>;
  /** Load the persisted queue from storage. Call once at startup, before the first flush. */
  hydrate(): Promise<void>;
  /** Drop every queued record (memory + storage). */
  clear(): Promise<void>;
  /** Remove the window `'online'` listener. Idempotent. */
  dispose(): void;
};

/**
 * createOutbox — offline outbox: queue commands durably while offline, replay
 * them in order on reconnect, deduplicate server-side via Idempotency-Key.
 *
 * While offline (or while queued records exist — later commands must not
 * overtake earlier ones), matching dispatches are intercepted before the
 * transport: the command is recorded, persisted, stamped with an idempotency
 * key, and resolved as `{ ok: true, value: { queued: true, id } }`. The
 * `'outboxQueued'` bus event fires with the record. On reconnect (window
 * `'online'` event, or a manual `flush()`), records replay sequentially
 * through the full pipeline with `meta.origin = 'replay'` and their original
 * idempotency keys, so the backend can reject any duplicate it already
 * applied. `'outboxFlushed'` fires with the `{ replayed, failed }` summary.
 *
 * Failure-safe: the first failed replay (an `ok: false` result or a throw)
 * stops the flush and keeps that record plus everything behind it queued —
 * order is never reshuffled, and the next flush retries from the same spot.
 *
 * SSR-safe: no window/navigator access at module load; the `'online'`
 * listener is only attached when a window exists and is removed by `dispose()`.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * const outbox = createOutbox({ actions: ['cart*', 'order*'] });
 * outbox.install(bus);                                   // outermost (priority 200)
 * bus.use(idempotent({ actions: ['order*'] }), { priority: 100 });
 * bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));
 *
 * await outbox.hydrate();                                // restore a previous session's queue
 * const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
 * if (result.ok && result.value?.queued) {
 *   toast(`Saved offline — ${outbox.pending.value} pending`);
 * }
 * // back online: the 'online' event flushes automatically (autoFlush: true)
 */
export function createOutbox(options: OutboxOptions = {}): Outbox {
  const {
    actions,
    storage = localStorageOutbox(),
    isOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
    autoFlush = true,
    key: keyFn,
    maxQueue = 200,
  } = options;

  const matchesActions = makeActionFilter(actions);
  const pending = signal(0);

  let queue: OutboxRecord[] = [];
  let busRef: AsyncCommandBus | null = null;
  let flushPromise: Promise<{ replayed: number; failed: number }> | null = null;
  /**
   * The record currently being re-dispatched by `flush()`. The plugin lets
   * exactly one matching command through per replay (claim-once), identified
   * by action + target identity — flush passes `record.target` by reference,
   * so a concurrent user dispatch of the same action can't steal the claim
   * (it queues behind instead, preserving order).
   */
  let currentReplay: { record: OutboxRecord; claimed: boolean } | null = null;

  async function saveQueue(): Promise<void> {
    try { await storage.save(queue.slice()); }
    catch (e) { console.warn('[vapor-chamber] outbox: failed to persist queue:', e); }
  }

  function enforceBound(): void {
    while (queue.length > maxQueue) {
      const dropped = queue.shift()!;
      console.warn(`[vapor-chamber] outbox: queue exceeded maxQueue (${maxQueue}); dropped the oldest record "${dropped.action}" (id ${dropped.id}). Raise maxQueue or flush more often.`);
    }
  }

  async function enqueue(cmd: Command): Promise<CommandResult> {
    const record: OutboxRecord = {
      id: genId(),
      action: cmd.action,
      target: cmd.target,
      payload: cmd.payload,
      key: keyFn ? keyFn(cmd) : commandKey(cmd.action, cmd.target),
      queuedAt: Date.now(),
    };
    queue.push(record);
    enforceBound();
    pending.value = queue.length;
    await saveQueue();
    // Stamp the key now so anything inspecting the result's command (listeners,
    // devtools) sees the same key the eventual replay will carry.
    if (cmd.meta) cmd.meta.idempotencyKey = record.key;
    busRef?.emit('outboxQueued', record);
    return { ok: true, value: { queued: true, id: record.id } };
  }

  const plugin: AsyncPlugin = (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();

    // Replay path — let the flush's own re-dispatch through, stamped with the
    // record's ORIGINAL key so the backend sees the same Idempotency-Key.
    const replay = currentReplay;
    if (replay !== null && !replay.claimed && cmd.action === replay.record.action && cmd.target === replay.record.target) {
      replay.claimed = true;
      if (cmd.meta) {
        cmd.meta.idempotencyKey = replay.record.key;
        // CommandMeta gains an optional `origin` field in a parallel workstream;
        // cast until the type lands so replays are distinguishable in handlers.
        (cmd.meta as any).origin = 'replay';
      }
      return next();
    }

    // Online with an empty queue: normal dispatch, untouched. Otherwise queue —
    // either we're offline, or earlier records exist (possibly mid-flush) and a
    // new command must not overtake them.
    if (isOnline() && queue.length === 0) return next();
    return enqueue(cmd);
  };

  async function runFlush(bus: AsyncCommandBus): Promise<{ replayed: number; failed: number }> {
    let replayed = 0;
    let failed = 0;
    // Strict order: one record at a time, head of the queue first. The record
    // stays queued until its replay succeeds, so commands dispatched DURING the
    // flush land behind it (the plugin sees a non-empty queue).
    while (queue.length > 0) {
      if (!isOnline()) break; // went offline mid-flush — leave the rest queued
      const record = queue[0];
      currentReplay = { record, claimed: false };
      let result: CommandResult;
      try {
        result = await bus.dispatch(record.action, record.target, record.payload);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      } finally {
        currentReplay = null;
      }
      if (result?.ok) {
        queue.shift();
        replayed++;
        pending.value = queue.length;
        await saveQueue();
      } else {
        // Stop: keep this record and everything behind it, in order.
        failed++;
        await saveQueue();
        break;
      }
    }
    const summary = { replayed, failed };
    bus.emit('outboxFlushed', summary);
    return summary;
  }

  function flush(bus?: AsyncCommandBus): Promise<{ replayed: number; failed: number }> {
    const target = bus ?? busRef;
    if (!target) {
      return Promise.reject(new Error('[vapor-chamber] outbox.flush(): no bus available. Call outbox.install(bus) first, or pass the bus: outbox.flush(bus).'));
    }
    if (flushPromise) return flushPromise; // re-entrant flush joins the in-progress one
    flushPromise = runFlush(target).finally(() => { flushPromise = null; });
    return flushPromise;
  }

  function install(bus: AsyncCommandBus): void {
    busRef = bus;
    bus.use(plugin, { priority: 200 });
  }

  async function hydrate(): Promise<void> {
    let loaded: OutboxRecord[] | null = null;
    try { loaded = await storage.load(); }
    catch (e) { console.warn('[vapor-chamber] outbox: failed to hydrate queue:', e); }
    if (Array.isArray(loaded) && loaded.length > 0) {
      // Persisted records predate anything queued this session — they go first.
      queue = loaded.concat(queue);
      enforceBound();
      pending.value = queue.length;
    }
  }

  async function clear(): Promise<void> {
    queue = [];
    pending.value = 0;
    try { await storage.clear(); }
    catch (e) { console.warn('[vapor-chamber] outbox: failed to clear storage:', e); }
  }

  // Window 'online' listener — attached once at creation (SSR-safe: only when a
  // window exists), removed by dispose(). No timers, no polling.
  let onlineHandler: (() => void) | null = null;
  if (autoFlush && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onlineHandler = () => { if (busRef) void flush(); };
    window.addEventListener('online', onlineHandler);
  }

  function dispose(): void {
    if (onlineHandler !== null && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', onlineHandler);
    }
    onlineHandler = null;
  }

  return { plugin, install, flush, pending, hydrate, clear, dispose };
}

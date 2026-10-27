/**
 * vapor-chamber - Offline outbox
 *
 * Hold commands durably while offline, replay them in order on reconnect,
 * and deduplicate server-side via the Idempotency-Key header.
 *
 * The outbox composes existing primitives:
 *   - a key per record (the record's id), stamped onto
 *     `cmd.meta.idempotencyKey` on every replay,
 *   - the HTTP transport, which forwards `meta.idempotencyKey` as an
 *     `Idempotency-Key` header so the backend can reject duplicate writes,
 *   - the store's state half (`_stateHalf`): the queue is state, saved by
 *     `saveTo` and shared across tabs by whole states (`_shareStates`).
 *
 * A bus option (`createAsyncCommandBus({ outbox })`): it wraps the transports
 * of the actions it covers, below every plugin, so no install order exists.
 */

import type { ActionScope, BusError, BusOutbox, Command, CommandResult, SendAt, Transport } from './command-bus';
import type { ActionFilter } from './action-filter';
import { Accepted } from './accepted';
import { countOption, delayOption, isDelay } from './bounds';
import { abortedResult, failureCondition, _failures, _inScope, _okResult, _errResult, ownerOf, _OUTBOX, _recordKeyed, _sendAt } from './command-bus';
import { _report } from './report';
import { createSleeper } from './scheduler';
import { signal } from './signal';
import type { Signal } from './signal';
import { _stateHalf, type StateHalf } from './store-base';
import { _plainRuntime } from './store/core';
import { saveTo, type PersistStorage } from './store-persist';
import { _hasTabs, _shareStates } from './store-share';


/** Lightweight unique record ID - timestamp + random suffix (same style as the WS transport). */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A queued command awaiting replay. JSON-serializable by design - `target` and
 * `payload` round-trip through the storage, so keep them plain data (no
 * functions, no DOM nodes) for actions routed through the outbox.
 */
export type OutboxRecord = {
  /** Unique record ID (distinct from the command's `meta.id`, which is re-stamped on replay). */
  id: string;
  /**
   * The tab that sends it: the one whose caller holds its `done`, or the one
   * that took it over when that tab closed. Read only by the outbox.
   */
  tab: string;
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
  /**
   * When the command was queued: an RFC 3339 timestamp in UTC, millisecond
   * precision (`new Date().toISOString()`, e.g. `2026-10-02T17:41:19.250Z`).
   * Text, not epoch ms, because the record crosses a boundary (storage, or a
   * backend a custom storage syncs to) and the text names its unit and zone.
   * The outbox never reads it; `Date.parse(record.queuedAt)` gives ms.
   */
  queuedAt: string;
};

/** The queue's state: its records, oldest first, and how many `clear()`s it has seen (one in any tab clears every tab). */
type QueueState = { records: OutboxRecord[]; clears: number };

// ---------------------------------------------------------------------------
// createOutbox
// ---------------------------------------------------------------------------

export type OutboxOptions = {
  /** Which actions to hold. Glob patterns supported: '*', 'cart*'. An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /**
   * The queue's name: the key it is saved under, the channel its tabs share
   * it on, and the prefix of its Web Locks. Default: `'vc:outbox'`. Two
   * outboxes on one page need two names.
   */
  name?: string;
  /**
   * Where the queue is saved, read when the outbox is created: a store's
   * `PersistStorage` (`localStorage`'s two methods, each may answer a
   * promise). Default: `localStorage`. `indexedDbStorage()` for IndexedDB.
   * `null`: this tab's memory only, not shared with other tabs.
   */
  storage?: PersistStorage | null;
  /**
   * Whether the app can send now, read on every send of a covered action.
   * Default: a flag the window's `online` and `offline` events keep, read
   * from `navigator.onLine` when the outbox is created; online with no window (SSR).
   */
  isOnline?: () => boolean;
  /**
   * Flush on the window's `'online'` event, and once the stored queue has
   * loaded while online. Default: true. No polling. One timer,
   * and only when a replay's answer declared a `Retry-After`: the outbox
   * flushes again then, no sooner than a second later. While the answer
   * repeats, the wait doubles (1 s, 2 s, 4 s, ...) up to 30 s; a longer
   * declared wait wins; a successful replay starts it over at 1 s.
   * `dispose()` removes the listeners and ends that wait.
   */
  autoFlush?: boolean;
  /**
   * Derive the idempotency key stored on each record and replayed to the
   * backend, sent as given. Default: the record's id, so each queued write is
   * its own request, and the header carries no command content
   * (Idempotency-Key draft-07 2.2). A stored record replays its stored key.
   * A key of unreserved characters (letters, digits, `-`, `_`, `.`, `~`) goes
   * out as it is. Any other key is percent-encoded on every send: about
   * 110 ns a command on an Apple M3, Node 24.21.0 (log 36.48).
   * tests/idempotency-key.test.ts.
   */
  key?: (cmd: Command) => string;
  /**
   * Max queued records - bounded memory. When exceeded, the OLDEST record is
   * dropped with a warning report, and its caller's `done` settles with
   * `outbox:exceeded:queue`. Default: 200.
   */
  maxSize?: number;
  /**
   * The longest, in ms, a command held this session waits to be sent. Past
   * it, the record is dropped and its caller's `done` settles with
   * `outbox:timeout:queue`. Default: none, it waits for its flush. A
   * `wsTransport`'s own outbox passes its reply timeout.
   */
  ttl?: number;
  /**
   * Whether a failed replay is worth trying again later. `true` keeps the
   * record at the head and stops the flush, so order is preserved and the
   * next flush retries from the same spot. `false` means the answer is final
   * (the server refused it, or a validator rejected it): the record is
   * dropped, its caller's `done` settles with the failure (a record no caller
   * waits on goes to `rejected`), and the flush moves on.
   *
   * Default: final only for a verdict on this command. From the SERVER, a 4xx
   * other than 401 / 419 (a session to renew), 408 (timeout) and 429 (rate
   * limit), as the response's status or as a problem's own `status` inside a
   * 2xx: the conditions `invalid`, `refused`, `missing`, `already`, `conflict`,
   * and only when the answer declared no `Retry-After`.
   * From the library, only `invalid`: it gives the same answer on every
   * flush. Everything else is kept: a 5xx, a problem with no status, a network
   * failure, and every other error the library raised (a handler not
   * registered yet), because dropping a queued command over a client-side
   * failure loses the user's data. Pass `() => true` to block on every
   * failure, or your own rule in your backend's codes (`error.code`).
   *
   * WHY IT EXISTS: if every failure blocked, one record the server refuses
   * would hold the whole queue for good - each flush re-sends it, gets the
   * same answer, and the records behind it never leave.
   */
  isRetryable?: (error: Error, record: OutboxRecord) => boolean;
};

/**
 * The default `isRetryable`: false only for a verdict on the command itself.
 * A `remote` failure is the server's verdict when RFC 9110 puts it on the
 * request (a 4xx: `invalid`, `refused`, `missing`, `already`, `conflict`). An
 * expired session (401, 419) reads `unauthenticated`, which is not a verdict:
 * the record replays after sign-in. A failure the library raised (any other
 * owner) is a verdict only when it is `invalid`. Every other such failure
 * keeps the record (a handler not registered yet). A server's own failure
 * (5xx) and a transient one keep it too. So does any answer that declares a
 * `Retry-After`: it says when to come back, which is not a verdict (a 409 for
 * a request still in progress).
 */
function outboxIsRetryable(error: Error): boolean {
  if (isDelay((error as BusError).context?.retryIn)) return true;
  const owner = ownerOf(error);
  const condition = failureCondition(error);
  if (owner !== undefined && owner !== 'remote') return condition !== 'invalid';
  return !VERDICTS.has(condition);
}
const VERDICTS = new Set(['invalid', 'refused', 'missing', 'already', 'conflict']);

/**
 * What one `flush()` did. `failed` is 0 or 1: a retryable failure stops the
 * flush. `rejected` counts records dropped as final (see `isRetryable`).
 */
export type OutboxFlushSummary = { replayed: number; failed: number; rejected: number };

/** A final refusal of a record no caller waits on (one a closed tab or a previous session queued). */
export type OutboxRejection = { record: OutboxRecord; error: Error };

/** The object returned by {@link createOutbox}. Pass it to `createAsyncCommandBus({ outbox })`. */
export type Outbox = {
  /**
   * Replay this tab's records sequentially (strict FIFO). Each record is sent
   * through its action's transport with its ORIGINAL idempotency key and
   * origin `'replay'`, not dispatched: no plugin or listener sees it, and a
   * store's `answer` applies. The first retryable failure stops the flush -
   * that record and everything after it stay queued. Re-entrant calls join
   * the flush in progress.
   */
  flush(): Promise<OutboxFlushSummary>;
  /** Reactive queue depth, every tab's records - bindable in templates ("3 changes pending sync"). */
  pending: Signal<number>;
  /** Final refusals of records no caller waits on (a closed tab's, a previous session's). */
  rejected: Signal<OutboxRejection[]>;
  /** Drop every queued record, in every tab sharing the queue. A waiting `done` settles with `outbox:aborted:clear`. */
  clear(): Promise<void>;
  /** Remove the window listeners, end a Retry-After wait, release this tab's locks. Idempotent; the bus's `dispose()` runs it. */
  dispose(): void;
  /** @internal The bus's half: `createAsyncCommandBus({ outbox })` calls it once. */
  readonly [_OUTBOX]: BusOutbox;
};

/** Sends a record at the work step, through the bus the outbox is on. */
type SendNow = (action: string, target: unknown, payload: unknown, key: string) => Promise<CommandResult>;

/** A command this tab holds: its caller's settle, and its ttl timer. */
type Held = { action: string; settle: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> | undefined };

/** A replay is never held twice: it goes to its transport, which refuses it while it cannot send. */
const replayed = (cmd: Command): boolean => cmd.meta?.origin === 'replay';

const fail = _failures('outbox');

/** The command another tab's queue is written under: no reducer, so persist's replay keeps it. */
const RECEIVED = { action: '' };

/** What an outbox write is a step of, for persist's replay of a write made before its read landed. */
const QUEUED = { target: undefined };

/**
 * createOutbox - offline outbox: hold commands durably while offline, replay
 * them in order on reconnect, deduplicate server-side via Idempotency-Key.
 *
 * The bus takes it as an option and wraps the transports of the actions it
 * covers, decided once per action, so any other action pays nothing. While
 * offline, while the stored queue loads, or while this tab's records wait (a
 * later command must not overtake them), a covered command is held:
 * recorded, saved, stamped with its key, and answered `{ ok: true, value }`
 * with `value` an `Accepted` whose `done` settles with the replay's result.
 * On reconnect (the window's `'online'` event, or `flush()`), records go out
 * one at a time through their transports. A retryable failure stops the
 * flush and keeps the order; a final one drops the record and moves on.
 *
 * The queue is state on a store's state half: saved under `name`, and in a
 * page shared with the other tabs of the origin (`shareTabs`). Sending is
 * the tab's that dispatched, where its caller waits: each tab sends only its
 * own records. Each tab holds the Web Lock `vapor-chamber:outbox:<name>:tab:<id>`
 * for its life and waits on the lock of every other tab named in the queue.
 * When a tab closes, the first tab waiting takes its lock over and sends its
 * records: no record is sent by two tabs, and none waits for a reload. A
 * record taken over has no caller here: its final verdict goes to `rejected`.
 * tests/outbox-tabs.test.ts.
 *
 * SSR-safe: no window access at module load; the listeners are only attached
 * when a window exists, and `dispose()` removes them.
 *
 * @example
 * const outbox = createOutbox({ actions: ['cart*', 'order*'] });
 * const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
 * const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
 * if (result.ok && result.value instanceof Accepted) {
 *   toast(`Saved offline - ${outbox.pending.value} pending`);
 *   const end = await result.value.done; // the server's answer, once sent
 * }
 */
export function createOutbox(options: OutboxOptions = {}): Outbox {
  const {
    actions,
    actionFilter,
    name = 'vc:outbox',
    storage,
    autoFlush = true,
    key: keyFn,
    maxSize: rawMaxSize = 200,
    isRetryable = outboxIsRetryable,
  } = options;

  // `records.length > maxSize` gates EVICTION, so a NaN bound would never fire
  // and the cap would silently vanish. ../bounds owns that rule, and it falls
  // back to the documented 200 rather than to 0:
  // an outbox that holds nothing while offline LOSES the commands it exists to
  // hold. A negative bound clamps to 0.
  const maxSize = countOption(rawMaxSize, 200);
  const ttl = options.ttl !== undefined && options.ttl > 0 ? delayOption(options.ttl, 0) : 0;

  // This tab, and the tabs whose records it sends: its own id, and each tab
  // whose lock it took over. Tabs exist where the queue is saved and shared,
  // in a page or worker with Web Locks; elsewhere every record is this tab's.
  const durable = storage !== null;
  const found = durable && _hasTabs() && typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const locks = found != null && typeof found.request === 'function' ? found : undefined;
  const tab = genId();
  const mine = new Set<string>([tab]);
  const own = (r: OutboxRecord): boolean => locks === undefined || mine.has(r.tab);
  const tabLock = (id: string): string => `vapor-chamber:outbox:${name}:tab:${id}`;

  // The queue on a state half: no registration, nothing on any bus. A tab's
  // queue is written as it arrives, kept for persist's replay while the
  // stored queue loads. `half` is read when a write runs, after it is set.
  let half!: StateHalf<QueueState>;
  half = _stateHalf<QueueState>(_plainRuntime, {
    id: name,
    state: () => ({ records: [], clears: 0 }),
    persist: durable ? saveTo<QueueState>({ key: name, storage: storage ?? undefined, validate: (s) => Array.isArray(s?.records) && typeof s.clears === 'number' }) : undefined,
    share: locks !== undefined ? _shareStates<QueueState>(name) : undefined,
  }, {
    write: (cmd, f) => (half.cell.value = f(half.cell.value, cmd.target, cmd.payload)),
    land: () => {},
    put: (next) => {
      const kept = merged(next);
      half.hooks?.held?.(RECEIVED, kept);
      half.cell.value = kept;
    },
  });
  const records = (): OutboxRecord[] => half.cell.value.records;
  // Every outbox write: a reducer of the queue, replayed on the stored queue
  // when it lands, so this session's records go after it.
  const update = (f: (s: QueueState) => QueueState): void => {
    const keep = half.hooks?.keep;
    if (keep) keep(f)(QUEUED);
    else half.cell.value = f(half.cell.value);
  };
  const without = (ids: Set<string>) => (s: QueueState): QueueState => ({ records: s.records.filter((r) => !ids.has(r.id)), clears: s.clears });

  /**
   * Another tab's queue, as this tab takes it. Tabs share the queue as a whole
   * state (`_shareStates`), so a queue written before this tab's change
   * reached the sender lacks it. Each tab is the one authority for its
   * own records (`record.tab`): the merge takes the other tabs' records from
   * the sender and this tab's own as this tab holds them. Equal, the received
   * object is kept and nothing echoes. Different, it is not the shared state,
   * so it goes back out and the sender learns this tab's records. A higher
   * `clears` drops this tab's own records too (a `clear()` in any tab); a lower
   * one is a queue from before a clear this tab has, so the current state stays.
   * tests/outbox-tabs.test.ts.
   */
  function merged(next: QueueState): QueueState {
    const current = half.cell.value;
    if (next.clears < current.clears) return current;
    const mineNow = next.clears > current.clears ? [] : current.records.filter(own);
    const left = new Set(mineNow.map((r) => r.id));
    const records: OutboxRecord[] = [];
    let same = true;
    for (const r of next.records) {
      if (!own(r)) records.push(r);
      else if (left.delete(r.id)) records.push(r);
      else same = false;
    }
    if (left.size !== 0) {
      same = false;
      for (const r of mineNow) if (left.has(r.id)) records.push(r);
    }
    return same ? next : { records, clears: next.clears };
  }

  const pending = signal(records().length);
  const rejected = signal<OutboxRejection[]>([]);
  // The callers this tab holds, by record id.
  const held = new Map<string, Held>();
  // How many records this tab sends: while any wait, a covered send is held behind them.
  let waiting = 0;

  // Until the stored queue lands, every covered send is held behind it.
  let loading = half.ready !== null;
  // The flag the window's events keep, unless the app declares `isOnline`.
  let online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  const isOnline = options.isOnline ?? ((): boolean => online);
  // The scheduler's waits, for a flush the answer asked to come back for, and
  // the last one scheduled (ms; 0 after a successful replay), which the next
  // one doubles.
  const waits = createSleeper();
  let backoff = 0;
  let sendNow: SendNow | null = null;
  let flushPromise: Promise<OutboxFlushSummary> | null = null;
  // The record being sent: it is past waiting, so its caller hears its send's
  // own answer, never a `clear()` or a ttl that claims it was not sent.
  let inFlight: string | null = null;

  // Tab locks: this tab's, held for its life, and a wait on each other tab
  // named in the queue. A wait granted means that tab closed: its records are
  // this tab's now. `dispose()` releases what is held and ends the waits.
  const releases: Array<() => void> = [];
  const ending = new AbortController();
  // Each other tab named in the queue: the moment this tab takes its lock.
  const adopted = new Map<string, Promise<void>>();
  // The other tabs whose lock was held at the last flush: open, so their records are theirs.
  const live = new Set<string>();
  const lockTab = (id: string, granted?: () => void): Promise<void> =>
    new Promise<void>((took) => {
      void locks!.request(tabLock(id), { signal: ending.signal }, () => {
        if (granted) granted();
        took();
        return new Promise<void>((release) => { releases.push(release); });
      }).then(undefined, () => {});
    });
  if (locks !== undefined) void lockTab(tab);
  const watchTabs = (list: OutboxRecord[]): void => {
    for (const r of list) {
      if (mine.has(r.tab) || adopted.has(r.tab)) continue;
      const other = r.tab;
      adopted.set(other, lockTab(other, () => {
        mine.add(other);
        live.delete(other);
        // Its records are this tab's own now, under this tab's bound.
        enforceBound();
        count(records());
        maybeFlush();
      }));
    }
  };
  // Before a flush: which other tabs are open. A tab whose lock nobody holds
  // is this tab's as soon as its wait is granted: the flush waits for it.
  const lockPrefix = tabLock('');
  async function resolveTabs(): Promise<void> {
    const { held: taken = [] } = await locks!.query();
    live.clear();
    for (const l of taken) {
      const other = l.name?.startsWith(lockPrefix) ? l.name.slice(lockPrefix.length) : undefined;
      if (other !== undefined && !mine.has(other)) live.add(other);
    }
    for (const [other, took] of adopted) if (!mine.has(other) && !live.has(other)) await took;
    count(records());
  }

  // Each write of the queue: the depth, this tab's share, a wait on each new
  // tab named, and a caller whose record another tab dropped (its `clear()`,
  // its bound) hears it.
  // A record of a tab not yet known to be open counts too: it may be a closed
  // tab's or a previous session's, so a new command waits behind it.
  function count(list: OutboxRecord[]): void {
    let n = 0;
    for (const r of list) if (own(r) || !live.has(r.tab)) n++;
    waiting = n;
  }
  function onRecords(list: OutboxRecord[]): void {
    pending.value = list.length;
    count(list);
    if (locks !== undefined) watchTabs(list);
    if (held.size === 0) return;
    const present = new Set(list.map((r) => r.id));
    for (const [id, h] of held) {
      if (present.has(id) || id === inFlight) continue;
      held.delete(id);
      clearTimeout(h.timer);
      h.settle(_errResult(fail('aborted:clear', `Another tab dropped "${h.action}" before it was sent.`, { action: h.action })));
    }
  }
  half.onField('records', (list) => { onRecords(list as OutboxRecord[]); });
  count(records());
  if (locks !== undefined) watchTabs(records());

  /**
   * Takes a held caller out, its timer cleared, before this tab writes its
   * record away: the write's field event then finds nothing of this tab's to
   * call dropped by another tab. Undefined when no caller here waits on it.
   */
  function take(id: string): Held | undefined {
    const h = held.get(id);
    if (h === undefined) return undefined;
    held.delete(id);
    clearTimeout(h.timer);
    return h;
  }

  /**
   * Drops this tab's own records oldest-first down to the bound; a dropped
   * caller's `done` settles. Returns how many. Own records only: another tab's
   * owner would put an evicted record back (see `merged`).
   */
  function enforceBound(): number {
    const list = records().filter(own);
    const over = list.length - maxSize;
    if (over <= 0) return 0;
    const gone = new Set<string>();
    const callers: Array<Held | undefined> = [];
    for (let i = 0; i < over; i++) {
      gone.add(list[i].id);
      callers.push(take(list[i].id));
    }
    update(without(gone));
    for (let i = 0; i < over; i++) {
      const record = list[i];
      _report('warn', 'outbox:exceeded:queue', `the queue exceeded maxSize (${maxSize}), so the oldest record "${record.action}" (id ${record.id}) was dropped. Raise maxSize or flush more often.`, undefined, { action: record.action, id: record.id, maxSize });
      callers[i]?.settle(_errResult(fail('exceeded:queue', `The outbox dropped "${record.action}": more than ${maxSize} records were held.`, { action: record.action, context: { maxSize } })));
    }
    return over;
  }

  /** Hold `cmd`: a record, saved; its answer an `Accepted` whose `done` is the replay's result. */
  async function holdCommand(cmd: Command): Promise<CommandResult> {
    // Aborted already: its caller is gone, so nothing is held for it.
    if (cmd.signal?.aborted) return abortedResult(cmd.action, cmd.signal);
    const id = genId();
    const record: OutboxRecord = {
      id,
      tab,
      action: cmd.action,
      target: cmd.target,
      payload: cmd.payload,
      // One record, one key: two offline writes are two requests.
      key: keyFn ? keyFn(cmd) : id,
      queuedAt: new Date().toISOString(),
    };
    let settle!: (r: CommandResult) => void;
    const done = new Promise<CommandResult>((resolve) => { settle = resolve; });
    // One literal, the timer in it (docs/V8-RULES.md rule 2).
    const h: Held = { action: cmd.action, settle, timer: ttl !== 0 ? setTimeout(() => { expire(id, record.action); }, ttl) : undefined };
    held.set(id, h);
    update((s) => ({ records: [...s.records, record], clears: s.clears }));
    enforceBound();
    // Stamped now, so anything inspecting the result's command (listeners,
    // devtools) sees the key the replay will carry. A held command came through
    // a dispatch, where stampMeta always runs: `meta!` is sound.
    _recordKeyed(cmd, record.key);
    return _okResult(new Accepted(() => done));
  }

  const scope = { actions, actionFilter };
  // Each transport's wrapper, and back.
  const wrappers = new Map<Transport, Transport>();
  const inners = new Map<Transport, Transport>();
  const unwrap = (t: Transport): Transport => inners.get(t) ?? t;
  /**
   * The send of a covered action: held while it must wait, else the
   * transport's own. A transport that can be unable to send (a socket down)
   * says so with `isConnected`, read when the wrapper is built, so one that
   * cannot (HTTP) pays nothing.
   */
  const holding = (inner: Transport): Transport => {
    const connected = inner.isConnected;
    return {
      id: inner.id,
      localFallback: inner.localFallback === true,
      send: connected === undefined
        ? (cmd, local) => ((loading || waiting !== 0 || !isOnline()) && !replayed(cmd) ? holdCommand(cmd) : inner.send(cmd, local))
        : (cmd, local) => ((loading || waiting !== 0 || !isOnline() || !connected.call(inner)) && !replayed(cmd) ? holdCommand(cmd) : inner.send(cmd, local)),
    };
  };

  /** Drops a held command past its ttl: its caller hears it. */
  function expire(id: string, action: string): void {
    if (id === inFlight || !held.has(id)) return;
    const h = take(id) as Held;
    update(without(new Set([id])));
    h.settle(_errResult(fail('timeout:queue', `"${action}" waited more than ${ttl} ms to be sent.`, { action, context: { ttl } })));
  }

  async function runFlush(send: SendNow): Promise<OutboxFlushSummary> {
    let replayedCount = 0;
    let failed = 0;
    let dropped = 0;
    // Strict order: one record at a time, this tab's oldest first. The record
    // stays queued until its replay succeeds, so commands sent DURING the
    // flush are held behind it.
    for (;;) {
      if (!isOnline()) break; // went offline mid-flush - leave the rest queued
      const record = records().find(own);
      if (record === undefined) break;
      const id = record.id;
      inFlight = id;
      const result = await send(record.action, record.target, record.payload, record.key);
      inFlight = null;
      // Cleared while it was sent: its caller hears what the send answered.
      if (!records().some((r) => r.id === id)) {
        take(id)?.settle(result);
        continue;
      }
      if (result.ok) {
        const h = take(id);
        update(without(new Set([id])));
        replayedCount++;
        backoff = 0;
        h?.settle(result);
        continue;
      }
      // A hand-written transport can answer `ok: false` with no error.
      const error = (result.error as Error | undefined) ?? new Error('Unknown error');
      if (!isRetryable(error, record)) {
        // Final: the answer will not change, so keeping it would block every
        // record behind it on every flush. Drop it, say which, move on.
        dropped++;
        const h = take(id);
        update(without(new Set([id])));
        if (h !== undefined) h.settle(result);
        else rejected.value = [...rejected.value, { record, error }];
        continue;
      }
      // Retryable: keep this record and everything behind it, in order. When
      // the answer declared when to come back (a Retry-After), the scheduler
      // flushes again then; otherwise the next 'online' or flush() does.
      // Never sooner than a second later: a `Retry-After: 0` would re-flush at
      // once, get the same answer and re-flush again, with no time passing
      // between requests. While the answer repeats the wait doubles, capped at
      // 30 s: a backend busy for ten minutes is asked 24 times, not 601, and
      // the record still drains within 30 s of it recovering. A declared wait
      // longer than the schedule wins (Retry-After is a minimum, RFC 9110). A
      // successful replay resets it. A new wait replaces a pending one, so a
      // flush() or 'online' during the wait cannot start a second timer.
      // (tests/wire-contract.test.ts)
      failed++;
      const retryIn = (error as BusError).context?.retryIn;
      if (autoFlush && isDelay(retryIn)) {
        backoff = Math.max(retryIn, Math.min(30_000, Math.max(backoff * 2, 1000)));
        waits.wakeAll();
        void waits.sleep(delayOption(backoff, 1000)).then((due) => { if (due) void flush(); });
      }
      break;
    }
    return { replayed: replayedCount, failed, rejected: dropped };
  }

  function flush(): Promise<OutboxFlushSummary> {
    if (sendNow === null) {
      return Promise.reject(new Error('[vapor-chamber] outbox.flush(): the outbox is on no bus. Pass it to createAsyncCommandBus({ outbox }).'));
    }
    if (flushPromise) return flushPromise; // re-entrant flush joins the in-progress one
    const send = sendNow;
    flushPromise = (locks !== undefined ? resolveTabs().then(() => runFlush(send)) : runFlush(send)).finally(() => { flushPromise = null; });
    return flushPromise;
  }

  /** Flush on its own when it may: on a bus, loaded, online, something of this tab's held. */
  function maybeFlush(): void {
    if (autoFlush && sendNow !== null && !loading && waiting !== 0 && isOnline()) void flush();
  }

  // The stored queue, read when the half is made: at once from a sync storage
  // (the default, localStorage), else when it lands. Its records predate
  // anything held this session, so they go first (persist replays this
  // session's writes on it). A queue loaded over the bound is trimmed.
  if (half.ready !== null) {
    void half.ready.then(() => {
      loading = false;
      enforceBound();
      onRecords(records());
      maybeFlush();
    });
  } else {
    enforceBound();
  }

  async function clear(): Promise<void> {
    const left = [...held];
    for (const [id, h] of left) {
      if (id === inFlight) continue;
      held.delete(id);
      clearTimeout(h.timer);
    }
    // Every tab's records: the raised count tells the others to drop their own.
    update((s) => ({ records: [], clears: s.clears + 1 }));
    for (const [id, h] of left) {
      if (id !== inFlight) h.settle(_errResult(fail('aborted:clear', `outbox.clear() dropped "${h.action}" before it was sent.`, { action: h.action })));
    }
  }

  // Window listeners - attached once at creation when the flag or autoFlush
  // needs them (SSR-safe: only when a window exists), removed once by
  // dispose(). No polling; the one timer is the Retry-After wait in runFlush.
  const onOnline = (): void => { online = true; maybeFlush(); };
  const onOffline = (): void => { online = false; };
  let win = (options.isOnline === undefined || autoFlush) && typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  win?.addEventListener('online', onOnline);
  win?.addEventListener('offline', onOffline);

  function dispose(): void {
    waits.wakeAll();
    win?.removeEventListener('online', onOnline);
    win?.removeEventListener('offline', onOffline);
    win = null;
    ending.abort();
    for (const release of releases.splice(0)) release();
    half.dispose();
  }

  return {
    flush, pending, rejected, clear, dispose,
    [_OUTBOX]: {
      // An action it covers resolves to its transport's wrapper, one per
      // transport; the scope read by the bus's one reader.
      adapt: (action, transport) => {
        if (!_inScope(scope, action)) return transport;
        let w = wrappers.get(transport);
        if (w === undefined) {
          wrappers.set(transport, (w = holding(transport)));
          inners.set(w, transport);
        }
        return w;
      },
      // A replay goes through the transport its wrapper holds: the wrapper would hold it again.
      // The async bus's state, sent by `_sendAt`; off an async bus, a transport's own send.
      attach: (bus) => {
        sendNow = typeof bus === 'function'
          ? (action, target, payload, key) => (bus as SendAt)(unwrap, action, target, payload, key)
          : (action, target, payload, key) => _sendAt(bus, unwrap, action, target, payload, key);
        maybeFlush();
      },
      // A transport can send again (a socket opened): flush what waits.
      opened: maybeFlush,
    },
  };
}

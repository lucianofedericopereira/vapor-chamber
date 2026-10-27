/**
 * vapor-chamber - Extra plugins
 *
 * cache, circuitBreaker, rateLimit, metrics
 *
 * These are optional, tree-shaken, and declared as parts (PluginParts) the bus places.
 *
 * ON THE DUPLICATION IN HERE, so it is not "cleaned up" a second time.
 *
 * Two pairs look extractable: the bounded eviction in `cache()` and
 * `idempotent()`, and the "compact when more than half the buffer is dead"
 * block in `rateLimit()` and `metrics()`. Both extractions were built,
 * measured and rejected.
 *
 * Shared `evictOldest` + `compactHead` helpers made the `.` ESM entry +66
 * bytes minified / +24 gzip. The generic parameters they need - an optional
 * remove callback, a container object for the head buffer - cost more than
 * the ~15 duplicated lines they save, because a minifier already handles
 * small repeated patterns well. Nothing else moved: these plugins are absent
 * from all three IIFE variants (`plugins.ts` re-exports only plugins-core and
 * plugins-io), so `check-size.mjs` cannot see them, and the treeshake
 * ceiling scenario does not include them either.
 *
 * The two evictions follow one rule: oldest first, down to the bound, after
 * the insert, so `idempotent({ maxSize: 0 })` remembers nothing
 * (tests/plugins-extra-gaps.test.ts). An extraction changes bytes only, on
 * the one entry that ships this code.
 */

import { MAX_TIMEOUT_MS, countOption } from './bounds';
import type { ActionScope, BaseBus, Command, CommandResult, Fail, PluginParts, WorkTicket } from './command-bus';
import type { ActionFilter } from './action-filter';
import { abortedResult, commandKey, _groupsAt, _isBug, _isSyncBus, _setHub, _errResult, _isLibraryAction, _keyed } from './command-bus';
import { _failures, _isCancel } from './failure';
import { freezeCached } from './freeze';
import { _combineSignals, _groupHub } from './http';


// ---------------------------------------------------------------------------
// cache - memoize query results with TTL
// ---------------------------------------------------------------------------

export type CacheOptions = {
  /** Cache TTL in milliseconds. Default: 30_000 (30s). */
  ttl?: number;
  /** Max entries in the cache. Default: 100. LRU eviction. */
  maxSize?: number;
  /** Which actions to cache. Glob patterns supported. An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /** Custom cache key. Default: commandKey(action, target). */
  key?: (cmd: Command) => string;
};

/**
 * cache - memoize handler results by (action, target) key.
 * Use with `query()` for read-only commands. The plugin intercepts the
 * dispatch/query pipeline and returns the cached result if fresh.
 *
 * @example
 * bus.use(cache({ ttl: 60_000, actions: ['getUser*'] }));
 * bus.query('getUser', { id: 42 }); // handler runs
 * bus.query('getUser', { id: 42 }); // cache hit, handler skipped
 */
export function cache(options: CacheOptions = {}): PluginParts & {
  /** Clear the entire cache. */
  clear(): void;
  /** Current cache size. */
  size(): number;
} {
  const { ttl: rawTtl = 30_000, maxSize: rawMaxSize = 100, actions, key: keyFn } = options;
  // Fails CLOSED rather than open (`expiresAt > now` gates SERVING, so NaN just
  // never serves), but routed through ../bounds anyway: a cache that silently
  // stops caching is still a bad option behaving as something other than the
  // documented default.
  const ttl = countOption(rawTtl, 30_000, 0, MAX_TIMEOUT_MS);
  // Clamped: a negative `maxSize` would make a `while (store.size > maxSize)`
  // eviction loop true against an EMPTY store and hang the process on the
  // first eviction. The NaN half lives in ../bounds, along with the reason a
  // bare `| 0` is not enough: it maps `Infinity` to 0, so asking for an
  // unbounded cache would get one that stores nothing.
  const maxSize = countOption(rawMaxSize, 100);

  // LRU-style cache: Map preserves insertion order, we move accessed entries to end
  const store = new Map<string, { result: CommandResult; expiresAt: number; action: string }>();

  // The reads in flight. An invalidation that lands while one runs marks its
  // ticket stale, and a stale read answers its own caller but is not stored:
  // its answer is from before the write the invalidation stands for. Held only
  // while a read runs, so the set is bounded by the reads in flight. The HTTP
  // client's cache closes the same window the same way (http-cache.ts, `read`).
  const tickets = new Set<{ key: string; stale: boolean; action: string }>();
  function markStale(match: (t: { key: string; action: string }) => boolean): void {
    for (const t of tickets) if (match(t)) t.stale = true;
  }

  // A `$` command takes the default key, which holds its `$` name, so a custom
  // key never lands it on an app's entry (log s35.182).
  function getKey(cmd: Command): string {
    return keyFn && !_isLibraryAction(cmd.action) ? keyFn(cmd) : commandKey(cmd.action, cmd.target);
  }

  function evictIfNeeded(): void {
    // Walk insertion order and stop at the bound. Bounding the ITERATION
    // cannot spin, where `while (store.size > maxSize)` can: under a negative
    // bound the condition stays true once the store is empty.
    // (Deleting the current key mid-iteration is well-defined for a Map.)
    for (const key of store.keys()) {
      if (store.size <= maxSize) break;
      store.delete(key); // oldest first
    }
  }

  function store_(k: string, r: CommandResult, action: string): void {
    // Every later hit gets this exact object back - see freeze.ts.
    store.set(k, { result: freezeCached(r), expiresAt: Date.now() + ttl, action });
    evictIfNeeded();
  }

  // The key `reuse` computed, so `begin` on the same command builds none.
  let lastCmd: Command | undefined;
  let lastKey = '';
  const keyOf = (cmd: Command): string => (cmd === lastCmd ? lastKey : getKey(cmd));

  // Two steps (PluginParts): `reuse` answers a fresh entry, so a hit never
  // reaches a limit or the work; `begin` opens the read's ticket, and its
  // `landed` stores a success.
  return {
    id: 'cache',
    actions,
    actionFilter: options.actionFilter,
    // A group goes (RegisterOptions.cacheGroups, from any source): the results of
    // its actions are dropped and their reads in flight not stored. The bus's
    // hub, or this reader's own on a bus with none. tests/cache-groups-hub.test.ts.
    attach(bus: BaseBus): () => void {
      const g = _groupsAt(bus);
      const hub = g.hub ?? _setHub(g, _groupHub());
      return hub.onInvalidateGroup((group) => {
        const joins = (t: { action: string }): boolean => g.members.get(t.action)?.includes(group) === true;
        for (const [k, entry] of store) if (joins(entry)) store.delete(k);
        markStale(joins);
      });
    },
    reuse(cmd: Command): CommandResult | undefined {
      const k = getKey(cmd);
      const cached = store.get(k);
      if (cached && cached.expiresAt > Date.now()) {
        lastCmd = undefined;
        // Move to end for LRU
        store.delete(k);
        store.set(k, cached);
        return cached.result;
      }
      lastCmd = cmd;
      lastKey = k;
      return undefined;
    },
    begin(cmd: Command): WorkTicket {
      const k = keyOf(cmd);
      lastCmd = undefined;
      store.delete(k);
      const action = cmd.action;
      const ticket = {
        key: k, stale: false, action,
        landed(result: CommandResult): void {
          tickets.delete(ticket);
          // A $ command (a reset, an undo) is a state change: never stored, so
          // never answered from here (log s35.150). An overtaken read is not
          // stored either (see `tickets`).
          if (result.ok && !ticket.stale && !_isLibraryAction(action)) store_(k, result, action);
        },
      };
      tickets.add(ticket);
      return ticket;
    },
    // An undone command's answer is stale: its redo runs (log s35.181).
    forget(cmd: Command): void { const k = getKey(cmd); store.delete(k); markStale((t) => t.key === k); },
    clear(): void { store.clear(); markStale(() => true); },
    size(): number { return store.size; },
  };
}

// ---------------------------------------------------------------------------
// circuitBreaker - trip after N consecutive failures, reject fast
// ---------------------------------------------------------------------------

export type CircuitBreakerOptions = {
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  threshold?: number;
  /** Time in ms the circuit stays open before trying half-open. Default: 30_000. */
  resetTimeout?: number;
  /** Which actions to protect. Glob patterns. An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /** Called when circuit opens. */
  onOpen?: (action: string, failCount: number) => void;
  /** Called when circuit resets (half-open succeeds). */
  onClose?: (action: string) => void;
};

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * circuitBreaker - trips after N consecutive failures, rejects fast while open.
 *
 * @example
 * bus.use(circuitBreaker({ threshold: 3, resetTimeout: 10_000, actions: ['api*'] }));
 */
export function circuitBreaker(options: CircuitBreakerOptions = {}): PluginParts & {
  /** Get the current circuit state for an action. */
  getState(action: string): CircuitState;
  /** Manually reset a circuit. */
  reset(action: string): void;
} {
  const { threshold: rawThreshold = 5, resetTimeout: rawResetTimeout = 30_000, actions, onOpen, onClose } = options;
  // `failCount >= threshold` gates TRIPPING, so a NaN threshold left the
  // breaker closed through 20 consecutive failures - the guard silently absent
  // rather than loudly misconfigured. Floor of 1: a breaker that opens before
  // the first failure is not a breaker.
  const threshold = countOption(rawThreshold, 5, 1);
  const resetTimeout = countOption(rawResetTimeout, 30_000, 0, MAX_TIMEOUT_MS);

  const circuits = new Map<string, {
    state: CircuitState;
    failCount: number;
    openedAt: number;
  }>();

  function getCircuit(action: string) {
    let c = circuits.get(action);
    if (!c) { c = { state: 'closed', failCount: 0, openedAt: 0 }; circuits.set(action, c); }
    return c;
  }

  // The work's outcome, counted: a success closes, a real failure counts.
  function counted(cmd: Command, c: { state: CircuitState; failCount: number; openedAt: number }, result: CommandResult): void {
    if (result.ok) {
      if (c.state === 'half-open') {
        c.state = 'closed';
        c.failCount = 0;
        if (onClose) onClose(cmd.action);
      } else {
        c.failCount = 0;
      }
    } else if (!_isBug(result.error) && !_isCancel(result.error, cmd.signal)) {
      // A plugin that threw (converted by the runner) is a pipeline bug, not
      // the server failing - a redeploy fixes it, and letting three of them
      // lock the action out is the wrong failure mode. A cancel (supersede,
      // the caller's abort) is not the server failing either: Polly's breaker
      // skips OperationCanceledException. `_isCancel` reads every cancel: a
      // raw AbortError, the library's `aborted:` codes, and the caller's own
      // Error reason, which the bus returns as itself (failure.ts). Neither
      // counts nor resets the run of real failures. A backend's failure
      // counts, even one that lands after an abort.
      // tests/circuit-breaker-cancel.test.ts.
      // A failed half-open probe opens it again at once: left half-open,
      // every later dispatch went through (tests/circuit-breaker-half-open-fail.test.ts).
      c.failCount++;
      if (c.state === 'half-open' || (c.failCount >= threshold && c.state === 'closed')) {
        c.state = 'open';
        c.openedAt = Date.now();
        if (onOpen) onOpen(cmd.action, c.failCount);
      }
    }
  }

  // Two steps (PluginParts): `admit` refuses while open, so a refusal from a
  // limit or a rule is never counted; the ticket counts the work's outcome.
  return {
    id: 'circuitBreaker',
    actions,
    actionFilter: options.actionFilter,
    admit(cmd: Command, fail): CommandResult | undefined {
      const c = getCircuit(cmd.action);
      if (c.state !== 'open') return undefined;
      // Past resetTimeout -> half-open; before it, the refusal declares the
      // time left (`retryIn`), which the async bus's retry and the outbox wait for.
      const retryIn = resetTimeout - (Date.now() - c.openedAt);
      if (retryIn <= 0) {
        c.state = 'half-open';
        return undefined;
      }
      return _errResult(fail('limited:action', `Circuit breaker is open for "${cmd.action}". Retry in ${retryIn}ms.`, { action: cmd.action, context: { retryIn, resetTimeout, failCount: c.failCount } }));
    },
    begin(cmd: Command): WorkTicket {
      const c = getCircuit(cmd.action);
      return { landed: (result) => counted(cmd, c, result) };
    },
    getState(action: string): CircuitState {
      return getCircuit(action).state;
    },
    reset(action: string): void {
      circuits.delete(action);
    },
  };
}

// ---------------------------------------------------------------------------
// rateLimit - per-action rate limiting with sliding window
// ---------------------------------------------------------------------------

export type RateLimitOptions = {
  /** Max dispatches per window. Default: 10. */
  max?: number;
  /** Window size in milliseconds. Default: 1_000 (1 second). */
  window?: number;
  /** Which actions to rate limit. Glob patterns. An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
};

/**
 * rateLimit - per-action sliding window rate limiter.
 * Unlike a throttle (`pace`: one run per `wait` per action+target, the rest
 * rejected until it ends), rateLimit allows `max` per sliding window per action and
 * rejects the excess immediately.
 *
 * @example
 * bus.use(rateLimit({ max: 5, window: 1000, actions: ['api*'] }));
 */
export function rateLimit(options: RateLimitOptions = {}): PluginParts {
  const { actions } = options;
  // A NaN behaves like a missing option (bounds.ts); 0 keeps its meaning.
  const max = countOption(options.max, 10);
  const windowMs = countOption(options.window, 1_000, 0, MAX_TIMEOUT_MS);

  // Per-action sliding window: { timestamps[], head } - head index avoids O(n) shift()
  const windows = new Map<string, { ts: number[]; head: number }>();
  const windowOf = (action: string): { ts: number[]; head: number } => {
    let win = windows.get(action);
    if (!win) { win = { ts: [], head: 0 }; windows.set(action, win); }
    return win;
  };

  // Two steps (PluginParts): `admit` refuses a full window, a check that
  // takes nothing, and `begin` takes the slot, so a command another step or
  // rule refused never spends one (tests/work-steps.test.ts).
  const admit = (cmd: Command, fail: Fail): CommandResult | undefined => {

    const now = Date.now();
    const win = windowOf(cmd.action);

    // Advance head past expired timestamps - O(1) amortized
    const cutoff = now - windowMs;
    while (win.head < win.ts.length && win.ts[win.head] <= cutoff) win.head++;

    // Compact when more than half the array is dead entries
    if (win.head > 0 && win.head > win.ts.length / 2) {
      win.ts = win.ts.slice(win.head);
      win.head = 0;
    }

    const activeCount = win.ts.length - win.head;
    if (activeCount >= max) {
      // `max: 0` has no slot to free, so no wait to declare: a NaN `retryIn`
      // read as one, and the outbox re-flushed with no wait, forever
      // (tests/rate-limit-zero-retryin.test.ts).
      if (activeCount === 0) {
        return _errResult(fail('limited:action', `Rate limit for "${cmd.action}" is 0 per ${windowMs}ms.`, { action: cmd.action, context: { max, windowMs, currentCount: 0 } }));
      }
      // The oldest dispatch in the window frees a slot when it leaves it.
      const retryIn = win.ts[win.head] + windowMs - now;
      return _errResult(fail('limited:action', `Rate limit exceeded for "${cmd.action}": ${max} per ${windowMs}ms. Retry in ${retryIn}ms.`, { action: cmd.action, context: { retryIn, max, windowMs, currentCount: activeCount } }));
    }
    return undefined;
  };
  return {
    id: 'rateLimit',
    actions,
    actionFilter: options.actionFilter,
    admit,
    begin(cmd: Command): undefined { windowOf(cmd.action).ts.push(Date.now()); return undefined; },
  };
}

// ---------------------------------------------------------------------------
// metrics - lightweight telemetry collection
// ---------------------------------------------------------------------------

export type MetricsEntry = {
  action: string;
  ok: boolean;
  durationMs: number;
  timestamp: number;
};

export type MetricsOptions = {
  /** Max entries to keep. Default: 1000. Oldest evicted first. */
  maxSize?: number;
  /** Which actions to track. An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /** Called after each dispatch with the metrics entry. */
  onEntry?: (entry: MetricsEntry) => void;
};

/**
 * metrics - lightweight telemetry plugin.
 * Tracks dispatch count, success rate, and avg duration per action.
 * A `started` and a `settled` part (PluginParts): it times every outcome,
 * a rule's refusal and a query included, wherever it is installed. A
 * command that settles with no start (aborted before it started) records
 * 0 ms. tests/metrics-parts.test.ts.
 *
 * @example
 * const m = metrics({ maxSize: 500 });
 * bus.use(m);
 * console.log(m.summary());        // { cartAdd: { count: 42, avgMs: 1.2, errorRate: 0.02 } }
 * console.log(m.entries());         // raw entries
 */
export function metrics(options: MetricsOptions = {}): PluginParts & {
  /** Get all raw metric entries. */
  entries(): MetricsEntry[];
  /** Get a summary per action: count, avgMs, errorRate. */
  summary(): Record<string, { count: number; avgMs: number; errorRate: number }>;
  /** Clear all entries. */
  clear(): void;
} {
  const { maxSize: rawMaxSize = 1000, actions, onEntry } = options;
  // Measured at 1500 retained against a cap of 1000 with a NaN option.
  const maxSize = countOption(rawMaxSize, 1000);
  let data: MetricsEntry[] = [];
  let head = 0; // O(1) eviction - head index tracks first live entry

  /** Compact when more than half the array is dead entries. */
  function compactIfNeeded(): void {
    if (head > 0 && head > data.length / 2) {
      data = data.slice(head);
      head = 0;
    }
  }

  // The latest command's start in two fields, and the starts it covered in a
  // Map: a command that settles before the next one starts (every
  // unnested dispatch) never touches the Map. Set, get and delete keyed by a
  // fresh command cost a dispatch about 70 ns (log 36.105).
  let lastCmd: Command | undefined;
  let lastStart = 0;
  let starts: Map<Command, number> | null = null;

  return {
    id: 'metrics',
    actions,
    actionFilter: options.actionFilter,
    started(cmd: Command): void {
      if (lastCmd !== undefined) (starts ??= new Map()).set(lastCmd, lastStart);
      lastCmd = cmd;
      lastStart = performance.now();
    },
    settled(cmd: Command, result: CommandResult): void {
      let start: number | undefined;
      if (cmd === lastCmd) { start = lastStart; lastCmd = undefined; }
      else if (starts !== null) { start = starts.get(cmd); if (start !== undefined) starts.delete(cmd); }
      const duration = start === undefined ? 0 : performance.now() - start;
      const entry: MetricsEntry = {
        action: cmd.action,
        ok: result.ok,
        durationMs: Math.round(duration * 100) / 100,
        timestamp: Date.now(),
      };
      data.push(entry);
      // Evict oldest by advancing head - O(1)
      while ((data.length - head) > maxSize) head++;
      compactIfNeeded();
      if (onEntry) onEntry(entry);
    },
    entries(): MetricsEntry[] { return data.slice(head); },
    summary(): Record<string, { count: number; avgMs: number; errorRate: number }> {
      const map = new Map<string, { total: number; errors: number; sumMs: number }>();
      for (let i = head; i < data.length; i++) {
        const e = data[i];
        let s = map.get(e.action);
        if (!s) { s = { total: 0, errors: 0, sumMs: 0 }; map.set(e.action, s); }
        s.total++;
        if (!e.ok) s.errors++;
        s.sumMs += e.durationMs;
      }
      const out: Record<string, { count: number; avgMs: number; errorRate: number }> = {};
      map.forEach((s, action) => {
        out[action] = {
          count: s.total,
          avgMs: Math.round((s.sumMs / s.total) * 100) / 100,
          errorRate: Math.round((s.errors / s.total) * 1000) / 1000,
        };
      });
      return out;
    },
    clear(): void { data = []; head = 0; },
  };
}

// ---------------------------------------------------------------------------
// idempotent - collapse duplicate commands + stamp an idempotency key
// ---------------------------------------------------------------------------

export type IdempotentOptions = {
  /**
   * Derive a stable idempotency key from a command. Commands with the same key
   * are the same logical operation. Return `null`/`undefined` to skip a command.
   * Given, it is also the wire key, sent as given. Default:
   * `commandKey(action, [target, payload])`, or `commandKey(action, target)`
   * with no payload, kept local: the wire key is then the dispatch's
   * `meta.id`. A key of unreserved characters (letters, digits, `-`, `_`,
   * `.`, `~`) goes out as it is. Any other key is percent-encoded on every
   * send: about 110 ns a command on an Apple M3, Node 24.21.0 (log 36.48).
   * tests/idempotency-key.test.ts.
   */
  key?: (cmd: Command) => string | null | undefined;
  /**
   * How long (ms) a *completed* key is remembered for dedup - the window in
   * which a repeat (double-click, retry, reconnect replay) is collapsed to the
   * first result instead of hitting the handler/backend again. Default: 60_000.
   */
  ttl?: number;
  /** Restrict to specific actions (glob patterns). An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
  /**
   * Also stamp a wire key onto `cmd.meta.idempotencyKey` so transports forward
   * it (the HTTP transport sends it as an `Idempotency-Key` header): the `key`
   * option's value, else the dispatch's `meta.id`. A key already stamped (an
   * outbox replay's) stays. Default: true.
   */
  stampMeta?: boolean;
  /**
   * Max completed keys remembered at once - oldest is evicted first, so memory
   * stays bounded on long-lived buses with many distinct targets. Default: 500.
   */
  maxSize?: number;
};

/**
 * idempotent - make duplicate dispatches a no-op against the handler/backend.
 *
 * The client-side half of exactly-once delivery: it collapses repeats of the
 * same logical command - double-clicked Checkout, an auto-retry, a reconnect
 * that replays a queued action - so the handler (and the backend it calls) runs
 * **once**. Concurrent duplicates share the first in-flight promise; sequential
 * duplicates within `ttl` get the cached result. Failures are NOT cached, so a
 * genuine retry after an error still runs.
 *
 * Pairs with `register({ exclusive })` (orders same-key commands locally) and the HTTP
 * transport, which forwards the stamped `cmd.meta.idempotencyKey` as an
 * `Idempotency-Key` header so the backend runs a re-sent request once - the
 * wire half of exactly-once. That key is the dispatch's id, or the `key`
 * option's value: the content key stays in the browser. The transport is the
 * work, inside every plugin, so the key is stamped before the request is built.
 *
 * @example
 * const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/commands', csrf: true }) });
 * bus.use(idempotent({ actions: ['order*'] }));
 * // two rapid orderCreate dispatches -> one handler run, one backend write
 */
export function idempotent(options: IdempotentOptions = {}): PluginParts {
  const { key, ttl: rawTtl = 60_000, actions, stampMeta = true, maxSize: rawMaxSize = 500 } = options;
  // `now - cached.at < ttl` gates COLLAPSING a repeat, so a NaN window collapses
  // nothing and every duplicate re-executes - the dedupe guarantee silently
  // absent on a plugin whose entire purpose is that guarantee.
  const ttl = countOption(rawTtl, 60_000, 0, MAX_TIMEOUT_MS);
  // Clamped and floored exactly as `cache()` clamps `maxSize`, so the two
  // options mean the same number. Eviction runs down to the bound AFTER the
  // insert (`cache()`'s rule), so `maxSize: 0` remembers nothing. Bounded
  // through ../bounds, for the same reason as cache() above.
  const maxSize = countOption(rawMaxSize, 500);
  // key -> completed result (with timestamp); in-flight promises are in `inflight`.
  const done = new Map<string, { at: number; result: CommandResult }>();
  // A key's run, shared by every caller holding it: `live` counts the holders
  // with a signal still unaborted; one with no signal holds it until it lands.
  type Share = { run: Promise<CommandResult>; ctrl: AbortController | null; live: number; held: boolean };
  const inflight = new Map<string, Share>();

  // The caller's own view of a shared run: its own abort settles it at once,
  // and the run is cancelled only when no holder is left (the HTTP client's
  // joined-GET rule). tests/idempotent-own-abort.test.ts.
  function hold(share: Share, cmd: Command): Promise<CommandResult> {
    const signal = cmd.signal;
    if (!signal) { share.held = true; return share.run; }
    share.live++;
    return new Promise<CommandResult>((resolve, reject) => {
      const onAbort = (): void => {
        resolve(abortedResult(cmd.action, signal));
        if (--share.live === 0 && !share.held) share.ctrl?.abort(signal.reason);
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      // After this caller's abort, resolve and reject are no-ops.
      share.run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  // The local key: two commands with the same content are one logical
  // command, so the payload is in it. A `$` command takes the default key, as
  // in cache() (log s35.182).
  function getKey(cmd: Command): string | null | undefined {
    return key && !_isLibraryAction(cmd.action) ? key(cmd) : commandKey(cmd.action, cmd.payload === undefined ? cmd.target : [cmd.target, cmd.payload]);
  }

  // The key `reuse` computed (null to skip the command), so `begin` on the
  // same command builds none.
  let lastCmd: Command | undefined;
  let lastKey: string | null = null;

  /** A success remembered for `ttl`, oldest evicted first. */
  function remember(k: string, result: CommandResult): void {
    // Frozen for the same reason the `cache()` plugin freezes: every later
    // duplicate within `ttl` gets this exact object back, and the concurrent
    // duplicates sharing `run` already share it. A consumer that sorts the
    // list it was handed, or deletes a row optimistically, would rewrite what
    // every later dispatch reads.
    done.set(k, { at: Date.now(), result: freezeCached(result) });
    // Oldest first, down to the bound - `cache()`'s evictIfNeeded rule.
    // Bounding the ITERATION rather than looping on the size is what makes a
    // zero or negative bound terminate instead of spinning.
    for (const oldest of done.keys()) {
      if (done.size <= maxSize) break;
      done.delete(oldest);
    }
  }

  // Two steps (PluginParts): `reuse` answers a duplicate (the run in flight,
  // joined, or a remembered success), so a repeat never reaches a limit or
  // the work; `begin` opens the run every later duplicate joins.
  return {
    id: 'idempotent',
    actions,
    actionFilter: options.actionFilter,
    reuse(cmd: Command): CommandResult | Promise<CommandResult> | undefined {
      const raw = getKey(cmd);
      lastCmd = cmd;
      lastKey = raw == null ? null : String(raw);
      const k = lastKey;
      if (k === null) return undefined;
      // The wire key: an app's own key as given, else the dispatch's id. The
      // content key stays local (tests/idempotency-key.test.ts).
      if (stampMeta) _keyed(cmd.meta, key && !_isLibraryAction(cmd.action) ? k : undefined);
      const pending = inflight.get(k);
      if (pending) return hold(pending, cmd); // collapse concurrent duplicates
      const cached = done.get(k);
      if (cached) {
        if (Date.now() - cached.at < ttl) return cached.result; // collapse repeats within TTL
        done.delete(k); // expired - drop so the map doesn't retain stale results
      }
      return undefined;
    },
    begin(cmd: Command): WorkTicket | undefined {
      let k: string | null;
      if (cmd === lastCmd) k = lastKey;
      else { const raw = getKey(cmd); k = raw == null ? null : String(raw); }
      lastCmd = undefined;
      // A $ command (a reset, an undo) is a state change: never recorded,
      // never joined in flight, so a repeat runs (log s35.150, s35.182).
      if (k === null || _isLibraryAction(cmd.action)) return undefined;
      const key_ = k;
      // The run gets a signal of its own, aborted only once every holder has
      // aborted (see `hold`), so one caller cancelling never cancels another's.
      // Only a caller with a signal needs one: a run started without a signal
      // is held until it lands and never aborted, so it allocates none.
      const own = cmd.signal;
      const ctrl = own ? new AbortController() : null;
      let resolve!: (r: CommandResult) => void;
      const share: Share = { run: new Promise<CommandResult>((r) => { resolve = r; }), ctrl, live: 0, held: !own };
      inflight.set(key_, share);
      return {
        signal: ctrl?.signal,
        landed(result: CommandResult): void {
          inflight.delete(key_);
          // Cache only successes: a failed result is NOT remembered, so a
          // genuine retry runs again.
          if (result.ok) remember(key_, result);
          resolve(result);
        },
        // This caller's own view of the run: its abort settles it at once.
        answer: own ? hold(share, cmd) : undefined,
      };
    },
    // An undone command is no longer done: its redo runs (log s35.181).
    forget(cmd: Command): void {
      const raw = getKey(cmd);
      if (raw != null) done.delete(String(raw));
    },
  };
}

// ---------------------------------------------------------------------------
// supersede - auto-abort the previous in-flight dispatch for the same key
//
// A rapid second dispatch for the same logical slot silently cancels the
// stale in-flight one instead of racing it. vapor-chamber already threads
// `cmd.signal` all the way to `fetch()` (see transports.ts) - this plugin
// generalizes that existing wiring into automatic per-key cancellation
// instead of asking every caller to build and swap their own
// AbortController by hand.
// ---------------------------------------------------------------------------

export type SupersedeOptions = {
  /**
   * Derive the supersede key from a command. Commands resolving to the SAME
   * key auto-cancel their predecessor; different keys race independently.
   * Return `null`/`undefined` to skip superseding for that command.
   * Default: `commandKey(action, target)`: a newer dispatch on the same
   * target cancels the one in flight whatever its payload (a search box's
   * next keystroke). It includes the action name, so distinct actions never
   * collide and are never silently dropped by this plugin.
   */
  key?: (cmd: Command) => string | null | undefined;
  /** Restrict to specific actions (glob patterns). An {@link ActionScope}. */
  actions?: ActionScope;
  /** Selects actions by name, ANDed with `actions`: an {@link ActionFilter} (`createActionFilter`). Log s35.152. */
  actionFilter?: ActionFilter;
};

/**
 * supersede - auto-cancel the previous in-flight dispatch for the same key.
 *
 * Built for rapid-fire reads that can overwrite each other in flight - a
 * search box re-querying on every keystroke, a filter changing before the
 * previous fetch lands. Without it, a slow first response can arrive AFTER a
 * faster second one and clobber it with stale data. With it, the first
 * dispatch's AbortSignal fires the instant a second dispatch for the same key
 * starts - `httpTransport` forwards `cmd.signal` to `fetch()`, so the
 * stale request is genuinely cancelled, not merely ignored once it resolves.
 * With `batch`, it settles the stale command at once, drops it
 * from a batch not yet sent, and cancels a sent batch once every command in
 * it has aborted (tests/batching-abort.test.ts). A handler that passes `cmd.signal` to
 * `createHttpClient().get()` is cancelled the same way, even when its GET
 * joined one already in flight (see the client's `dedupe`).
 *
 * **Async bus only**: its `begin` step hands the bus the signal the work
 * runs under, which only a cancelable async dispatch carries.
 *
 * @example
 * const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
 * bus.use(supersede({ actions: ['productSearch'] }));
 * // three quick productSearch dispatches -> only the last one's response is
 * // ever awaited; the first two are aborted mid-flight, not just discarded
 */
export function supersede(options: SupersedeOptions = {}): PluginParts {
  const { key, actions } = options;
  const controllers = new Map<string, AbortController>();

  // A `begin` step (PluginParts): it runs after every limit admitted the
  // command, so a refused command never aborts the one in flight.
  return {
    id: 'supersede',
    actions,
    actionFilter: options.actionFilter,
    // A sync command lands before the next starts, so nothing is ever in
    // flight to supersede there: refused, never a silent no-op (tests/supersede.test.ts).
    attach(bus: BaseBus): void {
      if (_isSyncBus(bus)) throw _failures('supersede')('invalid:bus', 'supersede() needs an async bus: on a sync bus no command is in flight when the next starts.');
    },
    begin(cmd: Command): WorkTicket | undefined {
      const raw = key ? key(cmd) : commandKey(cmd.action, cmd.target);
      if (raw == null) return undefined;
      const k = String(raw);

      // Cancel this key's previous in-flight dispatch, if any.
      controllers.get(k)?.abort();

      const ctrl = new AbortController();
      controllers.set(k, ctrl);

      // With a caller's own signal, either one aborts the dispatch: one helper,
      // as the transports combine. Detached when the dispatch settles.
      const combined = cmd.signal ? _combineSignals(cmd.signal, ctrl.signal) : undefined;
      return {
        signal: combined?.signal ?? ctrl.signal,
        landed(): void {
          combined?.detach();
          // Only clear the map entry if we're still the current controller for
          // this key - a newer dispatch may already have replaced us.
          if (controllers.get(k) === ctrl) controllers.delete(k);
        },
      };
    },
  };
}

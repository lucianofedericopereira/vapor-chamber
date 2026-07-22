/**
 * vapor-chamber — Extra plugins
 *
 * cache, circuitBreaker, rateLimit, metrics
 *
 * These are optional, tree-shaken, and use only the public Plugin/AsyncPlugin types.
 */

import type { Command, CommandResult, Plugin, AsyncPlugin } from './command-bus';
import { matchesPattern, commandKey, BusError } from './command-bus';

function makeActionFilter(patterns: string[] | undefined): (action: string) => boolean {
  if (!patterns?.length) return () => true;
  return (action: string) => patterns.some(p => matchesPattern(p, action));
}

// ---------------------------------------------------------------------------
// cache — memoize query results with TTL
// ---------------------------------------------------------------------------

export type CacheOptions = {
  /** Cache TTL in milliseconds. Default: 30_000 (30s). */
  ttl?: number;
  /** Max entries in the cache. Default: 100. LRU eviction. */
  maxSize?: number;
  /** Which actions to cache. Glob patterns supported. Default: all. */
  actions?: string[];
  /** Custom cache key. Default: commandKey(action, target). */
  key?: (cmd: Command) => string;
};

/**
 * cache — memoize handler results by (action, target) key.
 * Use with `query()` for read-only commands. The plugin intercepts the
 * dispatch/query pipeline and returns the cached result if fresh.
 *
 * @example
 * bus.use(cache({ ttl: 60_000, actions: ['getUser*'] }));
 * bus.query('getUser', { id: 42 }); // handler runs
 * bus.query('getUser', { id: 42 }); // cache hit, handler skipped
 */
export function cache(options: CacheOptions = {}): Plugin & {
  /** Manually invalidate a cache entry. */
  invalidate(action: string, target?: any): void;
  /** Clear the entire cache. */
  clear(): void;
  /** Current cache size. */
  size(): number;
} {
  const { ttl = 30_000, maxSize = 100, actions, key: keyFn } = options;
  const matchesActions = makeActionFilter(actions);

  // LRU-style cache: Map preserves insertion order, we move accessed entries to end
  const store = new Map<string, { result: CommandResult; expiresAt: number }>();

  function getKey(cmd: Command): string {
    return keyFn ? keyFn(cmd) : commandKey(cmd.action, cmd.target);
  }

  function evictIfNeeded(): void {
    while (store.size > maxSize) {
      // Delete oldest (first inserted)
      const firstKey = store.keys().next().value;
      if (firstKey !== undefined) store.delete(firstKey);
    }
  }

  // Typed as any to work with both sync Plugin and AsyncPlugin signatures
  const plugin: any = (cmd: Command, next: () => any) => {
    if (!matchesActions(cmd.action)) return next();

    const k = getKey(cmd);
    const cached = store.get(k);
    if (cached && cached.expiresAt > Date.now()) {
      // Move to end for LRU
      store.delete(k);
      store.set(k, cached);
      return cached.result;
    }

    // Cache miss or expired
    store.delete(k);
    const result = next();

    // Handle async results (Promise from async bus)
    if (result && typeof result.then === 'function') {
      return result.then((r: CommandResult) => {
        if (r.ok) {
          store.set(k, { result: r, expiresAt: Date.now() + ttl });
          evictIfNeeded();
        }
        return r;
      });
    }

    if (result.ok) {
      store.set(k, { result, expiresAt: Date.now() + ttl });
      evictIfNeeded();
    }
    return result;
  };

  return Object.assign(plugin, {
    invalidate(action: string, target?: any): void {
      if (target !== undefined) {
        const k = commandKey(action, target);
        store.delete(k);
      } else {
        // Invalidate all entries for this action
        const keysToDelete: string[] = [];
        store.forEach((_v, k) => { if (k.startsWith(action + ':')) keysToDelete.push(k); });
        for (const k of keysToDelete) store.delete(k);
      }
    },
    clear(): void { store.clear(); },
    size(): number { return store.size; },
  });
}

// ---------------------------------------------------------------------------
// circuitBreaker — trip after N consecutive failures, reject fast
// ---------------------------------------------------------------------------

export type CircuitBreakerOptions = {
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  threshold?: number;
  /** Time in ms the circuit stays open before trying half-open. Default: 30_000. */
  resetTimeout?: number;
  /** Which actions to protect. Glob patterns. Default: all. */
  actions?: string[];
  /** Called when circuit opens. */
  onOpen?: (action: string, failCount: number) => void;
  /** Called when circuit resets (half-open succeeds). */
  onClose?: (action: string) => void;
};

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * circuitBreaker — trips after N consecutive failures, rejects fast while open.
 *
 * @example
 * bus.use(circuitBreaker({ threshold: 3, resetTimeout: 10_000, actions: ['api*'] }));
 */
export function circuitBreaker(options: CircuitBreakerOptions = {}): Plugin & {
  /** Get the current circuit state for an action. */
  getState(action: string): CircuitState;
  /** Manually reset a circuit. */
  reset(action: string): void;
} {
  const { threshold = 5, resetTimeout = 30_000, actions, onOpen, onClose } = options;
  const matchesActions = makeActionFilter(actions);

  // Per-action circuit state
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

  const plugin: Plugin = (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();

    const c = getCircuit(cmd.action);

    if (c.state === 'open') {
      // Check if reset timeout has elapsed → half-open
      if (Date.now() - c.openedAt >= resetTimeout) {
        c.state = 'half-open';
      } else {
        return { ok: false, value: undefined, error: new BusError('VC_PLUGIN_CIRCUIT_OPEN', `Circuit breaker is open for "${cmd.action}". Will retry after resetTimeout (${resetTimeout}ms).`, { emitter: 'plugin', severity: 'error', action: cmd.action, context: { resetTimeout, failCount: c.failCount } }) };
      }
    }

    const result = next();

    if (result.ok) {
      if (c.state === 'half-open') {
        c.state = 'closed';
        c.failCount = 0;
        if (onClose) onClose(cmd.action);
      } else {
        c.failCount = 0;
      }
    } else {
      c.failCount++;
      if (c.failCount >= threshold && c.state === 'closed') {
        c.state = 'open';
        c.openedAt = Date.now();
        if (onOpen) onOpen(cmd.action, c.failCount);
      }
    }

    return result;
  };

  return Object.assign(plugin, {
    getState(action: string): CircuitState {
      return getCircuit(action).state;
    },
    reset(action: string): void {
      circuits.delete(action);
    },
  });
}

// ---------------------------------------------------------------------------
// rateLimit — per-action rate limiting with sliding window
// ---------------------------------------------------------------------------

export type RateLimitOptions = {
  /** Max dispatches per window. Default: 10. */
  max?: number;
  /** Window size in milliseconds. Default: 1_000 (1 second). */
  window?: number;
  /** Which actions to rate limit. Glob patterns. Default: all. */
  actions?: string[];
};

/**
 * rateLimit — per-action sliding window rate limiter.
 * Unlike throttle (which delays execution), rateLimit rejects immediately
 * when the limit is exceeded.
 *
 * @example
 * bus.use(rateLimit({ max: 5, window: 1000, actions: ['api*'] }));
 */
export function rateLimit(options: RateLimitOptions = {}): Plugin {
  const { max = 10, window: windowMs = 1_000, actions } = options;
  const matchesActions = makeActionFilter(actions);

  // Per-action sliding window: { timestamps[], head } — head index avoids O(n) shift()
  const windows = new Map<string, { ts: number[]; head: number }>();

  return (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();

    const now = Date.now();
    let win = windows.get(cmd.action);
    if (!win) { win = { ts: [], head: 0 }; windows.set(cmd.action, win); }

    // Advance head past expired timestamps — O(1) amortized
    const cutoff = now - windowMs;
    while (win.head < win.ts.length && win.ts[win.head] <= cutoff) win.head++;

    // Compact when more than half the array is dead entries
    if (win.head > 0 && win.head > win.ts.length / 2) {
      win.ts = win.ts.slice(win.head);
      win.head = 0;
    }

    const activeCount = win.ts.length - win.head;
    if (activeCount >= max) {
      return { ok: false, value: undefined, error: new BusError('VC_PLUGIN_RATE_LIMITED', `Rate limit exceeded for "${cmd.action}": ${max} per ${windowMs}ms.`, { emitter: 'plugin', severity: 'error', action: cmd.action, context: { max, windowMs, currentCount: activeCount } }) };
    }

    win.ts.push(now);
    return next();
  };
}

// ---------------------------------------------------------------------------
// metrics — lightweight telemetry collection
// ---------------------------------------------------------------------------

export type MetricsEntry = {
  action: string;
  ok: boolean;
  durationMs: number;
  timestamp: number;
};

export type MetricsOptions = {
  /** Max entries to keep. Default: 1000. Oldest evicted first. */
  maxEntries?: number;
  /** Which actions to track. Default: all. */
  actions?: string[];
  /** Called after each dispatch with the metrics entry. */
  onEntry?: (entry: MetricsEntry) => void;
};

/**
 * metrics — lightweight telemetry plugin.
 * Tracks dispatch count, success rate, and avg duration per action.
 *
 * @example
 * const m = metrics({ maxEntries: 500 });
 * bus.use(m);
 * console.log(m.summary());        // { cartAdd: { count: 42, avgMs: 1.2, errorRate: 0.02 } }
 * console.log(m.entries());         // raw entries
 */
export function metrics(options: MetricsOptions = {}): Plugin & {
  /** Get all raw metric entries. */
  entries(): MetricsEntry[];
  /** Get a summary per action: count, avgMs, errorRate. */
  summary(): Record<string, { count: number; avgMs: number; errorRate: number }>;
  /** Clear all entries. */
  clear(): void;
} {
  const { maxEntries = 1000, actions, onEntry } = options;
  const matchesActions = makeActionFilter(actions);
  let data: MetricsEntry[] = [];
  let head = 0; // O(1) eviction — head index tracks first live entry

  /** Compact when more than half the array is dead entries. */
  function compactIfNeeded(): void {
    if (head > 0 && head > data.length / 2) {
      data = data.slice(head);
      head = 0;
    }
  }

  const plugin: Plugin = (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();

    const start = performance.now();
    const result = next();
    const duration = performance.now() - start;

    const entry: MetricsEntry = {
      action: cmd.action,
      ok: result.ok,
      durationMs: Math.round(duration * 100) / 100,
      timestamp: Date.now(),
    };

    data.push(entry);
    // Evict oldest by advancing head — O(1)
    while ((data.length - head) > maxEntries) head++;
    compactIfNeeded();
    if (onEntry) onEntry(entry);

    return result;
  };

  return Object.assign(plugin, {
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
  });
}

// ---------------------------------------------------------------------------
// serialize — per-key sequential processing for async commands
// ---------------------------------------------------------------------------

export type SerializeOptions = {
  /**
   * Derive the serialization key from a command. Commands resolving to the SAME
   * key run strictly one-at-a-time (FIFO); different keys run concurrently.
   * Return `null`/`undefined` to skip serialization for that command.
   * Default: `cmd.action` (each action serialized against itself).
   */
  key?: (cmd: Command) => string | number | null | undefined;
  /** Restrict to specific actions (glob patterns). Default: all. */
  actions?: string[];
  /**
   * Where the serialization lane lives.
   * - `'instance'` (default): a per-bus in-memory FIFO queue. Same-key commands
   *   serialize within THIS bus instance only.
   * - `'cross-tab'`: use the Web Locks API (`navigator.locks`) so same-key
   *   commands serialize across every tab / window of the same origin — true
   *   browser-arbitrated mutual exclusion, no custom transport. Automatically
   *   falls back to the `'instance'` queue when `navigator.locks` is unavailable
   *   (SSR, older browsers, or workers without the API).
   */
  scope?: 'instance' | 'cross-tab';
  /** Web Locks name prefix used in `'cross-tab'` mode. Default: `'vapor-chamber:serialize'`. */
  lockPrefix?: string;
};

/**
 * serialize — guarantee that async commands sharing a key never overlap.
 *
 * **Async bus only.** Sync handlers run to completion synchronously and cannot
 * interleave, so serialization is meaningless there (and would turn a sync
 * dispatch into a Promise). Register on `createAsyncCommandBus`.
 *
 * Prevents read-modify-write races on a shared resource: two `accountWithdraw`
 * for the same account, rapid `cartCheckout` clicks, or any handler where a
 * second dispatch must observe the first one's committed effect. This is
 * distinct from in-flight request dedup (which collapses *identical* requests) —
 * serialize queues *distinct* same-key commands so they apply in order.
 *
 * Failure-safe: a rejected/failed command does NOT stall its lane — the next
 * same-key command proceeds regardless of the previous outcome. Per-key entries
 * are reclaimed once a lane drains, so the map never grows unbounded.
 *
 * `scope: 'cross-tab'` extends serialization across tabs via the Web Locks API:
 * `navigator.locks.request` queues same-name requests FIFO across all same-origin
 * contexts and releases the lock when the handler settles (even on throw), so the
 * failure-safety guarantee holds across tabs too. Degrades to per-instance when
 * the API is absent.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * bus.use(serialize({ key: (cmd) => cmd.target.accountId, actions: ['account*'] }));
 * // withdrawals for the same account now run strictly in order;
 * // different accounts still run concurrently
 *
 * @example
 * // serialize across every tab of the same origin:
 * bus.use(serialize({ scope: 'cross-tab', key: (cmd) => cmd.target.accountId }));
 */
export function serialize(options: SerializeOptions = {}): AsyncPlugin {
  const { key, actions, scope = 'instance', lockPrefix = 'vapor-chamber:serialize' } = options;
  const matchesActions = makeActionFilter(actions);
  const crossTab = scope === 'cross-tab';
  // Per-key tail of the in-flight chain (default mode AND cross-tab fallback).
  // Stored promises never reject (errors swallowed), so chaining the next
  // same-key command onto them is safe.
  const tails = new Map<string, Promise<unknown>>();

  function inMemory(k: string, next: () => CommandResult | Promise<CommandResult>) {
    const prev = tails.get(k) ?? Promise.resolve();
    // Run after the previous same-key command settles — success OR failure both
    // release the lane, so one rejection can't deadlock the queue.
    const run = prev.then(() => next(), () => next());
    // The stored tail must never reject; the next command chains onto it.
    const tail = run.then(() => {}, () => {});
    tails.set(k, tail);
    // Reclaim the entry once this lane drains with nothing queued behind it.
    tail.then(() => { if (tails.get(k) === tail) tails.delete(k); });
    return run;
  }

  return (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();
    const raw = key ? key(cmd) : cmd.action;
    if (raw == null) return next();
    const k = String(raw);

    if (crossTab) {
      // Web Locks queues same-name requests FIFO across all tabs and releases on
      // settle (incl. throw). Read lazily so detection isn't bound to plugin
      // construction order. Falls back to the in-memory lane when unavailable.
      const locks = (globalThis as any).navigator?.locks;
      if (locks && typeof locks.request === 'function') {
        return locks.request(`${lockPrefix}:${k}`, () => next());
      }
    }
    return inMemory(k, next);
  };
}

// ---------------------------------------------------------------------------
// idempotent — collapse duplicate commands + stamp an idempotency key
// ---------------------------------------------------------------------------

export type IdempotentOptions = {
  /**
   * Derive a stable idempotency key from a command. Commands with the same key
   * are the same logical operation. Return `null`/`undefined` to skip a command.
   * Default: `commandKey(action, target)` (action + stable JSON of target).
   */
  key?: (cmd: Command) => string | null | undefined;
  /**
   * How long (ms) a *completed* key is remembered for dedup — the window in
   * which a repeat (double-click, retry, reconnect replay) is collapsed to the
   * first result instead of hitting the handler/backend again. Default: 60_000.
   */
  ttl?: number;
  /** Restrict to specific actions (glob patterns). Default: all. */
  actions?: string[];
  /**
   * Also stamp the key onto `cmd.meta.idempotencyKey` so transports forward it
   * (the HTTP bridge sends it as an `Idempotency-Key` header). Default: true.
   */
  stampMeta?: boolean;
  /**
   * Max completed keys remembered at once — oldest is evicted first, so memory
   * stays bounded on long-lived buses with many distinct targets. Default: 500.
   */
  maxKeys?: number;
};

/**
 * idempotent — make duplicate dispatches a no-op against the handler/backend.
 *
 * The client-side half of exactly-once delivery: it collapses repeats of the
 * same logical command — double-clicked Checkout, an auto-retry, a reconnect
 * that replays a queued action — so the handler (and the backend it calls) runs
 * **once**. Concurrent duplicates share the first in-flight promise; sequential
 * duplicates within `ttl` get the cached result. Failures are NOT cached, so a
 * genuine retry after an error still runs.
 *
 * Pairs with `serialize` (orders same-key commands locally) and with the HTTP
 * bridge, which forwards the stamped `cmd.meta.idempotencyKey` as an
 * `Idempotency-Key` header so the backend can reject the duplicate write too —
 * the wire half of exactly-once. Register `idempotent` at a HIGHER priority than
 * the transport so the key is stamped before the request is built.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * bus.use(idempotent({ actions: ['order*'] }), { priority: 100 }); // outermost
 * bus.use(createHttpBridge({ endpoint: '/commands', csrf: true }));
 * // two rapid orderCreate dispatches → one handler run, one backend write
 */
export function idempotent(options: IdempotentOptions = {}): AsyncPlugin {
  const { key, ttl = 60_000, actions, stampMeta = true, maxKeys = 500 } = options;
  const matchesActions = makeActionFilter(actions);
  // key → completed result (with timestamp) OR the in-flight promise.
  const done = new Map<string, { at: number; result: CommandResult }>();
  const inflight = new Map<string, Promise<CommandResult>>();

  return (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();
    const raw = key ? key(cmd) : commandKey(cmd.action, cmd.target);
    if (raw == null) return next();
    const k = String(raw);

    if (stampMeta && cmd.meta) cmd.meta.idempotencyKey = k;

    const pending = inflight.get(k);
    if (pending) return pending; // collapse concurrent duplicates

    const cached = done.get(k);
    const now = Date.now();
    if (cached) {
      if (now - cached.at < ttl) return cached.result; // collapse repeats within TTL
      done.delete(k); // expired — drop so the map doesn't retain stale results
    }

    const run = Promise.resolve(next()).then(
      (result) => {
        inflight.delete(k);
        // Cache only successes. A failed result (resolved errResult, ok:false)
        // is NOT cached so a genuine retry runs again.
        if (result?.ok) {
          if (done.size >= maxKeys) {
            const oldest = done.keys().next().value;
            if (oldest !== undefined) done.delete(oldest);
          }
          done.set(k, { at: Date.now(), result });
        }
        return result;
      },
      (err) => {
        inflight.delete(k); // thrown/rejected — also not cached
        throw err;
      },
    );
    inflight.set(k, run);
    return run;
  };
}

// ---------------------------------------------------------------------------
// supersede — auto-abort the previous in-flight dispatch for the same key
//
// A rapid second dispatch for the same logical slot silently cancels the
// stale in-flight one instead of racing it. vapor-chamber already threads
// `cmd.signal` all the way to `fetch()` (see transports.ts) — this plugin
// generalizes that existing wiring into automatic per-key cancellation
// instead of asking every caller to build and swap their own
// AbortController by hand.
// ---------------------------------------------------------------------------

export type SupersedeOptions = {
  /**
   * Derive the supersede key from a command. Commands resolving to the SAME
   * key auto-cancel their predecessor; different keys race independently.
   * Return `null`/`undefined` to skip superseding for that command.
   * Default: `commandKey(action, target)` — same default `idempotent` uses,
   * which already includes the action name, so distinct actions never
   * collide and are never silently dropped by this plugin.
   */
  key?: (cmd: Command) => string | null | undefined;
  /** Restrict to specific actions (glob patterns). Default: all. */
  actions?: string[];
};

/**
 * supersede — auto-cancel the previous in-flight dispatch for the same key.
 *
 * Built for rapid-fire reads that can overwrite each other in flight — a
 * search box re-querying on every keystroke, a filter changing before the
 * previous fetch lands. Without it, a slow first response can arrive AFTER a
 * faster second one and clobber it with stale data. With it, the first
 * dispatch's AbortSignal fires the instant a second dispatch for the same key
 * starts — `createHttpBridge` / `createBatchingHttpBridge` already forward
 * `cmd.signal` to `fetch()`, so the stale request is genuinely cancelled, not
 * merely ignored once it resolves.
 *
 * **Async bus only** — mutates `cmd.signal` before the rest of the pipeline
 * runs, which is only meaningful for cancelable async dispatches.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * bus.use(supersede({ actions: ['productSearch'] }));
 * bus.use(createHttpBridge({ endpoint: '/api/vc' }));
 * // three quick productSearch dispatches → only the last one's response is
 * // ever awaited; the first two are aborted mid-flight, not just discarded
 */
export function supersede(options: SupersedeOptions = {}): AsyncPlugin {
  const { key, actions } = options;
  const matchesActions = makeActionFilter(actions);
  const controllers = new Map<string, AbortController>();

  return (cmd, next) => {
    if (!matchesActions(cmd.action)) return next();
    const raw = key ? key(cmd) : commandKey(cmd.action, cmd.target);
    if (raw == null) return next();
    const k = String(raw);

    // Cancel this key's previous in-flight dispatch, if any.
    controllers.get(k)?.abort();

    const ctrl = new AbortController();
    controllers.set(k, ctrl);

    // Merge with any caller-supplied signal — same AbortSignal.any-with-
    // fallback pattern used throughout transports.ts.
    cmd.signal = cmd.signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([cmd.signal, ctrl.signal]) : ctrl.signal)
      : ctrl.signal;

    const result = Promise.resolve(next());
    result.finally(() => {
      // Only clear the map entry if we're still the current controller for
      // this key — a newer dispatch may already have replaced us.
      if (controllers.get(k) === ctrl) controllers.delete(k);
    });
    return result;
  };
}

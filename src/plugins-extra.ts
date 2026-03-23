/**
 * vapor-chamber — Extra plugins
 *
 * cache, circuitBreaker, rateLimit, metrics
 *
 * These are optional, tree-shaken, and use only the public Plugin/AsyncPlugin types.
 */

import type { Command, CommandResult, Plugin, AsyncPlugin } from './command-bus';
import { matchesPattern, commandKey, BusError } from './command-bus';

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

  // LRU-style cache: Map preserves insertion order, we move accessed entries to end
  const store = new Map<string, { result: CommandResult; expiresAt: number }>();

  function getKey(cmd: Command): string {
    return keyFn ? keyFn(cmd) : commandKey(cmd.action, cmd.target);
  }

  function matchesActions(action: string): boolean {
    if (!actions || actions.length === 0) return true;
    return actions.some(p => matchesPattern(p, action));
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

  // Per-action circuit state
  const circuits = new Map<string, {
    state: CircuitState;
    failCount: number;
    openedAt: number;
  }>();

  function matchesActions(action: string): boolean {
    if (!actions || actions.length === 0) return true;
    return actions.some(p => matchesPattern(p, action));
  }

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

  // Per-action sliding window: { timestamps[], head } — head index avoids O(n) shift()
  const windows = new Map<string, { ts: number[]; head: number }>();

  function matchesActions(action: string): boolean {
    if (!actions || actions.length === 0) return true;
    return actions.some(p => matchesPattern(p, action));
  }

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
  let data: MetricsEntry[] = [];
  let head = 0; // O(1) eviction — head index tracks first live entry

  function matchesActions(action: string): boolean {
    if (!actions || actions.length === 0) return true;
    return actions.some(p => matchesPattern(p, action));
  }

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

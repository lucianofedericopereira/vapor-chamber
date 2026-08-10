/**
 * vapor-chamber — HTTP response cache + request deduplication
 *
 * Internal module used by createHttpClient. Not exported publicly.
 *
 * Cache entries carry a fresh window (`freshUntil`) and, when a caller opts
 * into `cache.staleTtl`, a longer stale window (`staleUntil >= freshUntil`).
 * Inside `freshUntil` → a fresh hit (no fetch). Between the two → a stale
 * hit: served instantly while the caller attaches a background revalidation
 * (see http.ts). Past `staleUntil` → a miss, but the entry is NOT deleted —
 * `getAny` still finds it as a last resort for `cache.serveStaleOnError`.
 * Only LRU size pressure or an explicit `invalidate` removes it.
 *
 * PER-CLIENT, NOT MODULE-GLOBAL. Both maps used to be module-level, so every
 * `createHttpClient()` shared one cache and one dedupe map. That read as an
 * isolated instance while behaving as a global, and under concurrent SSR it
 * was a correctness hazard: the cache key is `responseType:fullUrl` with no
 * auth/header/cookie dimension, so user A's authenticated payload answered
 * user B's identical URL, and two concurrent requests for different users
 * collapsed into one in-flight promise. A fresh bus per request (whitepaper
 * §14.2) did not give a fresh HTTP cache — now a fresh client does. This is
 * the same factory-closure shape the bus-level `cache()` plugin already uses.
 */

import { freezeCached } from './freeze';

// ---------------------------------------------------------------------------
// LRU Response Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_SIZE = 50;
const CACHE_DEFAULT_TTL = 30_000; // 30 seconds

type CacheEntry = { data: any; freshUntil: number; staleUntil: number };

export type CacheHit = { data: any; stale: boolean };

const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Regex metacharacters — escaped so a string pattern matches literally. */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

export type ResponseCache = {
  /** A fresh or stale hit; `null` on a plain miss. Never deletes on read. */
  get(key: string): CacheHit | null;
  /** Last-resort lookup for `cache.serveStaleOnError` — ignores freshness, never evicts. */
  getAny(key: string): CacheEntry | null;
  set(key: string, data: any, ttl?: number, staleTtl?: number): void;
  clear(): void;
  invalidate(pattern: string | RegExp): void;
  getInflight(key: string): Promise<any> | undefined;
  setInflight(key: string, promise: Promise<any>): void;
};

/** One cache + one dedupe map, owned by exactly one HTTP client. */
export function createResponseCache(): ResponseCache {
  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<any>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;

      const now = Date.now();
      if (now >= entry.staleUntil) return null; // expired past any stale window — retained, not a hit

      // LRU: move to end (most recently used)
      entries.delete(key);
      entries.set(key, entry);
      return { data: entry.data, stale: now >= entry.freshUntil };
    },

    getAny(key) {
      return entries.get(key) ?? null;
    },

    set(key, data, ttl = CACHE_DEFAULT_TTL, staleTtl = 0) {
      // Evict oldest (first item) if at max size
      if (entries.size >= CACHE_MAX_SIZE) {
        const firstKey = entries.keys().next().value;
        /* v8 ignore next -- defensive: size >= CACHE_MAX_SIZE (>0) already guarantees a first key */
        if (firstKey !== undefined) entries.delete(firstKey);
      }
      // Shared by every later hit — see freeze.ts.
      freezeCached(data);
      const now = Date.now();
      entries.set(key, { data, freshUntil: now + ttl, staleUntil: now + ttl + staleTtl });
    },

    clear() {
      entries.clear();
      // Deliberately NOT clearing `inflight`: those promises are already
      // attached to callers, and dropping the map entry only disables dedupe
      // for requests that are still on the wire.
    },

    invalidate(pattern) {
      // A STRING IS A LITERAL SUBSTRING, not a pattern. `new RegExp(pattern)`
      // on a plain string threw on this library's own output — `buildFullUrl`
      // serializes arrays as `ids[0]=`, so a cache key contains a literal `[`
      // and compiling it is `SyntaxError: unterminated character class` — and
      // was silently wrong on ordinary URLs (`?` is a quantifier, so
      // '/api/products?page=1' matched '/api/product' + anything). The
      // `string | RegExp` signature reads as "substring or pattern"; this
      // makes the implementation agree. Regex semantics remain available
      // through the RegExp overload.
      let regex: RegExp;
      if (pattern instanceof RegExp) {
        regex = pattern;
      } else {
        if (DEV && (pattern.startsWith('^') || pattern.endsWith('$'))) {
          console.warn(
            `[vapor-chamber] invalidateCache("${pattern}") — strings are matched as literal ` +
              'substrings, so anchors are matched literally too. Pass a RegExp for pattern semantics.',
          );
        }
        regex = new RegExp(pattern.replace(REGEX_METACHARS, '\\$&'));
      }
      const keysToDelete: string[] = [];
      for (const key of entries.keys()) {
        // Keys are `responseType:fullUrl` — match user patterns against the URL
        // part so anchored patterns like /^\/api/ keep working.
        const url = key.slice(key.indexOf(':') + 1);
        if (regex.test(url)) keysToDelete.push(key);
      }
      for (const key of keysToDelete) entries.delete(key);
    },

    getInflight(key) {
      return inflight.get(key);
    },

    setInflight(key, promise) {
      inflight.set(key, promise);
      // Auto-cleanup on resolve or reject
      promise.finally(() => inflight.delete(key)).catch(() => {});
    },
  };
}

export { CACHE_DEFAULT_TTL };

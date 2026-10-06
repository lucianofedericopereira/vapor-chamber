/**
 * vapor-chamber - HTTP response cache + request deduplication
 *
 * Internal module used by createHttpClient. Not exported publicly.
 *
 * Cache entries carry a fresh window (`freshUntil`) and, when a caller opts
 * into `cache.staleTtl`, a longer stale window (`staleUntil >= freshUntil`).
 * Inside `freshUntil` -> a fresh hit (no fetch). Between the two -> a stale
 * hit: served instantly while the caller attaches a background revalidation
 * (see http.ts). Past `staleUntil` -> a miss, but the entry is NOT deleted -
 * `getAny` still finds it as a last resort for `cache.serveStaleOnError`.
 * Only LRU size pressure or an explicit `invalidate` removes it.
 *
 * PER-CLIENT, NOT MODULE-GLOBAL. The cache key is `responseType:fullUrl` with
 * no auth/header/cookie dimension, so under concurrent SSR a shared map lets
 * user A's authenticated payload answer user B's identical URL, and collapses
 * two users' concurrent requests into one in-flight promise. A fresh client
 * per request (whitepaper section 12.2) is a fresh cache - the same
 * factory-closure shape the bus-level `cache()` plugin uses.
 */

import { DEV } from './dev';
import { freezeCached } from './freeze';

// ---------------------------------------------------------------------------
// LRU Response Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_SIZE = 50;
const CACHE_DEFAULT_TTL = 30_000; // 30 seconds

type CacheEntry = { data: any; freshUntil: number; staleUntil: number };

export type CacheHit = { data: any; stale: boolean };

/** See ResponseCache.read. */
export type ReadTicket = { url: string; stale: boolean };

/** Regex metacharacters - escaped so a string pattern matches literally. */
export const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

export type ResponseCache = {
  /** A fresh or stale hit; `null` on a plain miss. Never deletes on read. */
  get(key: string): CacheHit | null;
  /** Last-resort lookup for `cache.serveStaleOnError` - ignores freshness, never evicts. */
  getAny(key: string): CacheEntry | null;
  set(key: string, data: any, ttl?: number, staleTtl?: number): void;
  clear(): void;
  /** Drop the entries and in-flight reads whose URL matches, and mark the
   *  matching `read` tickets stale. A function is the client's own match for
   *  a write: its URL and the URIs its answer names. */
  invalidate(pattern: string | RegExp | ((url: string) => boolean)): void;
  /** A cacheable read going on the wire. A read across an invalidation of ITS
   *  URL may carry the value from before it, so `invalidate` marks its ticket;
   *  an invalidation of another URL leaves it alone. */
  read(url: string): ReadTicket;
  /** The read landed or failed: forget the ticket. True when it may be stored. */
  done(ticket: ReadTicket): boolean;
  getInflight(key: string): Promise<any> | undefined;
  /** A read others may join; `url` is what an invalidation matches. */
  setInflight(key: string, promise: Promise<any>, url: string): void;
  /** Stop new callers joining `promise` (its last holder aborted). Only its
   *  own entry: after an invalidation the key may hold a newer read. */
  dropInflight(key: string, promise: Promise<any>): void;
};

/** One cache + one dedupe map, owned by exactly one HTTP client. */
export function createResponseCache(): ResponseCache {
  const entries = new Map<string, CacheEntry>();
  // The URL beside each read: an invalidation matches it, never a parse of the key.
  const inflight = new Map<string, { promise: Promise<any>; url: string }>();
  const reads = new Set<ReadTicket>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;

      const now = Date.now();
      // WRITTEN AS THE NEGATED `<`, NOT `>=`, and that is the whole guard. A
      // NaN window (`cache: { ttl: Number(badConfig) }`) makes `now + ttl` NaN,
      // and EVERY comparison against NaN is false - so `now >= staleUntil` said
      // "not expired" forever and the entry was served for the life of the page,
      // never stale, never evicted. Negating a `<` inverts which way the unknown
      // falls: an entry whose window cannot be compared is treated as expired.
      // Cheaper than clamping at every call site, and it covers a NaN arriving
      // from anywhere - see ../bounds for the direction rule.
      if (!(now < entry.staleUntil)) return null; // expired past any stale window - retained, not a hit

      // LRU: move to end (most recently used)
      entries.delete(key);
      entries.set(key, entry);
      return { data: entry.data, stale: now >= entry.freshUntil };
    },

    getAny(key) {
      return entries.get(key) ?? null;
    },

    set(key, data, ttl = CACHE_DEFAULT_TTL, staleTtl = 0) {
      // Evict the oldest (first) entry at max size; there is one, since the
      // size is at least CACHE_MAX_SIZE.
      if (entries.size >= CACHE_MAX_SIZE) entries.delete(entries.keys().next().value as string);
      // Shared by every later hit - see freeze.ts.
      freezeCached(data);
      const now = Date.now();
      entries.set(key, { data, freshUntil: now + ttl, staleUntil: now + ttl + staleTtl });
    },

    clear() {
      // An invalidation of everything, by the same rule as `invalidate`: a
      // read on the wire may answer from before, so it is not stored and a
      // later read does not join it. Its callers keep their promise.
      entries.clear();
      inflight.clear();
      for (const r of reads) r.stale = true;
    },

    invalidate(pattern) {
      // A STRING IS A LITERAL SUBSTRING, not a pattern. `new RegExp(pattern)`
      // on a plain string threw on this library's own output - `buildFullUrl`
      // serializes arrays as `ids[0]=`, so a cache key contains a literal `[`
      // and compiling it is `SyntaxError: unterminated character class` - and
      // was silently wrong on ordinary URLs (`?` is a quantifier, so
      // '/api/products?page=1' matched '/api/product' + anything). The
      // `string | RegExp` signature reads as "substring or pattern"; this
      // makes the implementation agree. Regex semantics remain available
      // through the RegExp overload.
      let matches: (url: string) => boolean;
      if (typeof pattern === 'function') {
        matches = pattern;
      } else {
        let regex: RegExp;
        if (pattern instanceof RegExp) {
          regex = pattern;
        } else {
          if (DEV && (pattern.startsWith('^') || pattern.endsWith('$'))) {
            console.warn(
              `[vapor-chamber] invalidateCache("${pattern}") - strings are matched as literal ` +
                'substrings, so anchors are matched literally too. Pass a RegExp for pattern semantics.',
            );
          }
          regex = new RegExp(pattern.replace(REGEX_METACHARS, '\\$&'));
        }
        matches = (url) => regex.test(url);
      }
      for (const r of reads) if (matches(r.url)) r.stale = true;
      const keysToDelete: string[] = [];
      for (const key of entries.keys()) {
        // Keys are `responseType:fullUrl` - match user patterns against the URL
        // part so anchored patterns like /^\/api/ keep working.
        const url = key.slice(key.indexOf(':') + 1);
        if (matches(url)) keysToDelete.push(key);
      }
      for (const key of keysToDelete) entries.delete(key);
      // A read made after this must not join one already on the wire, which
      // may answer from before. Its callers keep their promise; only the
      // joining stops. Matched on the read's URL: the dedupe key also holds
      // the request's headers (tests/http-write-stops-join.test.ts).
      for (const [key, read] of inflight) if (matches(read.url)) inflight.delete(key);
    },

    read(url) {
      const ticket = { url, stale: false };
      reads.add(ticket);
      return ticket;
    },

    done(ticket) {
      reads.delete(ticket);
      return !ticket.stale;
    },

    getInflight(key) {
      return inflight.get(key)?.promise;
    },

    setInflight(key, promise, url) {
      inflight.set(key, { promise, url });
      // Auto-cleanup on resolve or reject. Only its own entry: after an
      // invalidation the key may hold a newer read.
      promise.finally(() => inflight.get(key)?.promise === promise && inflight.delete(key)).catch(() => {});
    },

    dropInflight(key, promise) {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    },
  };
}

export { CACHE_DEFAULT_TTL };

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
 * Only LRU size pressure, an invalidation (a write, a group), `clearCache()`
 * or a `no-store` answer removes it.
 *
 * PER-CLIENT, NOT MODULE-GLOBAL. The cache key holds the request's headers
 * (Authorization, Accept-Language) but not cookies, so under concurrent SSR a
 * shared map lets
 * user A's authenticated payload answer user B's identical URL, and collapses
 * two users' concurrent requests into one in-flight promise. A fresh client
 * per request (whitepaper section 12.2) is a fresh cache - the same
 * factory-closure shape the bus-level `cache()` plugin uses.
 */

import { freezeCached } from './freeze';

// ---------------------------------------------------------------------------
// LRU Response Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_SIZE = 50;
const CACHE_DEFAULT_TTL = 30_000; // 30 seconds

type CacheEntry = { data: any; freshUntil: number; staleUntil: number; url: string };

export type CacheHit = { data: any; stale: boolean };

/** See ResponseCache.read. */
export type ReadTicket = { url: string; stale: boolean };

export type ResponseCache = {
  /** A fresh or stale hit; `null` on a plain miss. Never deletes on read. */
  get(key: string): CacheHit | null;
  /** Last-resort lookup for `cache.serveStaleOnError` - ignores freshness, never evicts. */
  getAny(key: string): CacheEntry | null;
  /** `url` is what an invalidation matches: the key also holds the request's headers. */
  set(key: string, data: any, ttl?: number, staleTtl?: number, url?: string): void;
  clear(): void;
  /** Drop the entries and in-flight reads whose URL `matches`, and mark the
   *  matching `read` tickets stale: a write's URL and the URIs its answer
   *  names (RFC 9111 4.4). */
  invalidate(matches: (url: string) => boolean): void;
  /** Drop the entries whose stored response `inGroup` says yes to (RFC 9875
   *  groups). A read on the wire has groups nobody knows yet: every one is
   *  marked not to be stored and no longer joined. A fetch, never stale data. */
  invalidateStored(inGroup: (response: any) => boolean): void;
  /** Forget one entry: its response said `no-store`. */
  drop(key: string): void;
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

    // No `url`: a `responseType:url` key, its URL the part after the first ':'.
    set(key, data, ttl = CACHE_DEFAULT_TTL, staleTtl = 0, url = key.slice(key.indexOf(':') + 1)) {
      // Evict the oldest (first) entry at max size; there is one, since the
      // size is at least CACHE_MAX_SIZE.
      if (entries.size >= CACHE_MAX_SIZE) entries.delete(entries.keys().next().value as string);
      // Shared by every later hit - see freeze.ts.
      freezeCached(data);
      const now = Date.now();
      entries.set(key, { data, freshUntil: now + ttl, staleUntil: now + ttl + staleTtl, url });
    },

    clear() {
      // An invalidation of everything, by the same rule as `invalidate`: a
      // read on the wire may answer from before, so it is not stored and a
      // later read does not join it. Its callers keep their promise.
      entries.clear();
      inflight.clear();
      for (const r of reads) r.stale = true;
    },

    invalidate(matches) {
      for (const r of reads) if (matches(r.url)) r.stale = true;
      const keysToDelete: string[] = [];
      // Matched on the entry's URL, never a parse of its key: the key also
      // holds the request's headers (tests/http-cache-headers.test.ts).
      for (const [key, entry] of entries) if (matches(entry.url)) keysToDelete.push(key);
      for (const key of keysToDelete) entries.delete(key);
      // A read made after this must not join one already on the wire, which
      // may answer from before. Its callers keep their promise; only the
      // joining stops. Matched on the read's URL: the dedupe key also holds
      // the request's headers (tests/http-write-stops-join.test.ts).
      for (const [key, read] of inflight) if (matches(read.url)) inflight.delete(key);
    },

    invalidateStored(inGroup) {
      for (const [key, entry] of entries) if (inGroup(entry.data)) entries.delete(key);
      inflight.clear();
      for (const r of reads) r.stale = true;
    },

    drop(key) {
      entries.delete(key);
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

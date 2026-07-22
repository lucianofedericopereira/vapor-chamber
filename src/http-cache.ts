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
 * `getCachedAny` still finds it as a last resort for `cache.serveStaleOnError`.
 * Only LRU size pressure or an explicit `invalidateCacheByPattern` removes it.
 */

// ---------------------------------------------------------------------------
// LRU Response Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_SIZE = 50;
const CACHE_DEFAULT_TTL = 30_000; // 30 seconds

type CacheEntry = { data: any; freshUntil: number; staleUntil: number };

export type CacheHit = { data: any; stale: boolean };

const _cache = new Map<string, CacheEntry>();

/** A fresh or stale hit; `null` on a plain miss. Never deletes on read. */
export function getCached(key: string): CacheHit | null {
  const entry = _cache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (now >= entry.staleUntil) return null; // expired past any stale window — retained, not a hit

  // LRU: move to end (most recently used)
  _cache.delete(key);
  _cache.set(key, entry);
  return { data: entry.data, stale: now >= entry.freshUntil };
}

/** Last-resort lookup for `cache.serveStaleOnError` — ignores freshness entirely, never evicts. */
export function getCachedAny(key: string): CacheEntry | null {
  return _cache.get(key) ?? null;
}

export function setCache(key: string, data: any, ttl: number = CACHE_DEFAULT_TTL, staleTtl = 0): void {
  // Evict oldest (first item) if at max size
  if (_cache.size >= CACHE_MAX_SIZE) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  const now = Date.now();
  _cache.set(key, { data, freshUntil: now + ttl, staleUntil: now + ttl + staleTtl });
}

export function clearAllCache(): void {
  _cache.clear();
}

export function invalidateCacheByPattern(pattern: string | RegExp): void {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const keysToDelete: string[] = [];
  for (const key of _cache.keys()) {
    // Keys are `responseType:fullUrl` — match user patterns against the URL
    // part so anchored patterns like /^\/api/ keep working.
    const url = key.slice(key.indexOf(':') + 1);
    if (regex.test(url)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) _cache.delete(key);
}

export { CACHE_DEFAULT_TTL };

// ---------------------------------------------------------------------------
// Request Deduplication (in-flight GET tracking)
// ---------------------------------------------------------------------------

const _inflight = new Map<string, Promise<any>>();

export function getInflight(key: string): Promise<any> | undefined {
  return _inflight.get(key);
}

export function setInflight(key: string, promise: Promise<any>): void {
  _inflight.set(key, promise);
  // Auto-cleanup on resolve or reject
  promise.finally(() => _inflight.delete(key)).catch(() => {});
}

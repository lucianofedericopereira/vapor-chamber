/**
 * vapor-chamber — HTTP response cache + request deduplication
 *
 * Internal module used by createHttpClient. Not exported publicly.
 */

// ---------------------------------------------------------------------------
// LRU Response Cache
// ---------------------------------------------------------------------------

const CACHE_MAX_SIZE = 50;
const CACHE_DEFAULT_TTL = 30_000; // 30 seconds

type CacheEntry = { data: any; expires: number };

const _cache = new Map<string, CacheEntry>();

export function getCached(key: string): any | null {
  const entry = _cache.get(key);
  if (entry && Date.now() < entry.expires) {
    // LRU: move to end (most recently used)
    _cache.delete(key);
    _cache.set(key, entry);
    return entry.data;
  }
  if (entry) _cache.delete(key);
  return null;
}

export function setCache(key: string, data: any, ttl: number = CACHE_DEFAULT_TTL): void {
  // Evict oldest (first item) if at max size
  if (_cache.size >= CACHE_MAX_SIZE) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
  _cache.set(key, { data, expires: Date.now() + ttl });
}

export function clearAllCache(): void {
  _cache.clear();
}

export function invalidateCacheByPattern(pattern: string | RegExp): void {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const keysToDelete: string[] = [];
  for (const key of _cache.keys()) {
    if (regex.test(key)) keysToDelete.push(key);
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

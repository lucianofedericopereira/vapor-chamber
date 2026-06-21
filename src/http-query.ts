/**
 * vapor-chamber — URL builder + query params
 *
 * Internal module used by createHttpClient. Not exported publicly.
 * SSR-safe: guards typeof window for URL constructor origin.
 */

/**
 * Build a full URL from path, optional baseURL, and optional query params.
 *
 * Handles: scalar values, arrays (`key[0]`), nested objects (`key[subkey]`),
 * null/undefined filtering.
 */
export function buildFullUrl(
  url: string,
  baseURL?: string,
  params?: Record<string, unknown>,
): string {
  // Apply baseURL to relative paths
  if (baseURL && !url.startsWith('http')) {
    const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const path = url.startsWith('/') ? url : '/' + url;
    url = base + path;
  }

  // Append query params
  if (params && Object.keys(params).length > 0) {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const urlObj = new URL(url, url.startsWith('http') ? undefined : origin);

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        value.forEach((v, i) => { urlObj.searchParams.append(`${key}[${i}]`, String(v)); });
      } else if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          urlObj.searchParams.append(`${key}[${k}]`, String(v));
        }
      } else {
        urlObj.searchParams.set(key, String(value));
      }
    }

    url = urlObj.toString();
  }

  return url;
}

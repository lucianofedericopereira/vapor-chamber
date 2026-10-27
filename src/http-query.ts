/**
 * vapor-chamber - URL builder + query params
 *
 * Internal module used by createHttpClient. Not exported publicly.
 * SSR-safe: guards typeof window for URL constructor origin.
 */

/**
 * Is this an absolute http(s) URL, as opposed to a path to hang off baseURL?
 *
 * A bare `startsWith('http')` test is also true of a RELATIVE path whose first
 * segment begins with those four letters (`httpbin/get`, `http-logs`), which
 * would silently drop the baseURL, or with params make `new URL(...)` throw a
 * bare "Invalid URL" TypeError. The scheme is also case-insensitive
 * (`HTTPS://host` is absolute), so the test is a case-insensitive regex.
 */
const ABSOLUTE_HTTP = /^https?:\/\//i;

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
  if (baseURL && !ABSOLUTE_HTTP.test(url)) {
    const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const path = url.startsWith('/') ? url : '/' + url;
    url = base + path;
  }

  // Append query params
  if (params && Object.keys(params).length > 0) {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const urlObj = new URL(url, ABSOLUTE_HTTP.test(url) ? undefined : origin);

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

/**
 * vapor-chamber/router-fetch - the in-box, plain-JSON loader preset.
 *
 * The batteries-included preset and reference implementation of the loader SPI:
 * `load` URL templates are interpolated and fetched through vapor-chamber's own
 * HttpClient - the JSON body (`response.data`) is the loader result as-is, no
 * envelope, no paginator assumptions. Works against any backend. Built on
 * `createHttpClient()` rather than a hand-rolled fetch(), so it inherits the
 * same retry/timeout/CSRF handling as the rest of vapor-chamber; a custom
 * preset can do the same by importing the SPI from `vapor-chamber/router`.
 *
 *   createRouter({ routes, loaders: fetchLoaders() })
 */

import { type HttpClient, type HttpRequestConfig, _groupsOf, createHttpClient } from '../http';
import { type LoaderHandlers, interpolateLoad, routerError } from '../router/index';

/** Fresh/stale windows for a cached loader read - the http client's own shape. */
export type LoaderCache = { ttl?: number; staleTtl?: number; serveStaleOnError?: boolean };

export type FetchLoadersOptions = {
  /** Extra headers on every loader request. */
  headers?: Record<string, string>;
  /**
   * The client loader reads go through. Default: the router's (its `http`
   * option), so they share the app's one client, else a fresh client when the
   * router has none.
   */
  http?: HttpClient;
  /**
   * Cache loader reads through the http client's LRU. Default: **false** -
   * opt-in, like every other cache in this library.
   *
   * `true` uses the client's default TTL. The object form opens the same
   * fresh/stale windows the client already implements: `staleTtl` serves a
   * past-fresh entry instantly and revalidates in the background (`router.isRevalidating`
   * is true while it does - the flag lives on the router, not on the snapshot,
   * which is only `{ location, render, data }`), `serveStaleOnError` falls back
   * to a retained entry when a read fails transiently.
   *
   * Per-record override: a route row's `meta.cache` wins over this default, so
   * a reference-data row and a live-inventory row can differ:
   *
   *   { name: 'countries', load: '/api/countries', meta: { cache: { ttl: 3_600_000 } } }
   *   { name: 'stock',     load: '/api/stock',     meta: { cache: false } }
   */
  cache?: boolean | LoaderCache;
};

/** `meta.cache` on the row wins; otherwise the preset default. */
function resolveCache(
  recordMeta: Record<string, unknown> | undefined,
  fallback: boolean | LoaderCache | undefined,
): boolean | LoaderCache | undefined {
  const override = recordMeta?.cache;
  if (override === undefined) return fallback;
  return override as boolean | LoaderCache;
}

export function fetchLoaders(options: FetchLoadersOptions = {}): LoaderHandlers {
  const headers = options.headers;
  // Built at the first read that has no client from the options or the router.
  let own: HttpClient | undefined;
  return {
    url: async (template, location, record, signal, ctx) => {
      const http = options.http ?? ctx?.http ?? (own ??= createHttpClient());
      const url = interpolateLoad(template, location, record.queryDefs);
      const cache = resolveCache(record.meta, options.cache);
      try {
        // Only pass `cache` when it was asked for - an explicit `cache:
        // undefined` is indistinguishable from absent to the client, but
        // keeping the config minimal keeps the miss path free of the key. A
        // refresh asks the server before any stored copy is used, the
        // client's and the browser's (`cacheMode`): the data is known to be
        // out of date.
        const config: HttpRequestConfig = { signal, headers };
        if (cache !== undefined) config.cache = cache;
        if (ctx?.refresh) config.cacheMode = 'no-cache';
        const response = await http.get(url, config);
        // The read's groups (RFC 9875): a write naming one refreshes this record.
        const groups = response.headers?.['cache-groups'];
        if (groups !== undefined) ctx?.cacheGroups(_groupsOf(groups));
        // Stale-while-revalidate: this value is real data from a past-fresh
        // entry, so the navigation commits on it immediately. Hand the
        // background refresh to the engine - otherwise it would land in the
        // HTTP cache and the page would keep the stale copy until the next
        // navigation. `ctx` is optional for hand-written handlers.
        if (response.stale && response.revalidation) {
          ctx?.revalidate(response.revalidation.then((fresh) => fresh.data));
        }
        return response.data;
      } catch (cause) {
        // runLoaders (vapor-chamber-router core) already reclassifies this as
        // `aborted:navigation` when `signal` is the one that aborted - no need to
        // special-case AbortError here, just attach the cause either way.
        throw routerError('failed:loader', `loader request failed for "${url}": ${(cause as Error).message}`, {
          to: location,
          cause,
        });
      }
    },
  };
}

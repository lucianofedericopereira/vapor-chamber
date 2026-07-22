/**
 * vapor-chamber/router-fetch — the in-box, plain-JSON loader preset.
 *
 * The batteries-included preset and reference implementation of the loader SPI:
 * `load` URL templates are interpolated and fetched through vapor-chamber's own
 * HttpClient — the JSON body (`response.data`) is the loader result as-is, no
 * envelope, no paginator assumptions. Works against any backend. Built on
 * `createHttpClient()` rather than a hand-rolled fetch(), so it inherits the
 * same retry/timeout/CSRF handling as the rest of vapor-chamber; a custom
 * preset can do the same by importing the SPI from `vapor-chamber/router`.
 *
 *   createRouter({ routes, loaders: fetchLoaders() })
 */

import { type HttpClient, createHttpClient } from '../http';
import { type LoaderHandlers, interpolateLoad, routerError } from '../router/index';

export type FetchLoadersOptions = {
  /** Extra headers on every loader request. */
  headers?: Record<string, string>;
  /** vapor-chamber http client override (tests, a pre-configured instance). Default: fresh client. */
  http?: HttpClient;
};

export function fetchLoaders(options: FetchLoadersOptions = {}): LoaderHandlers {
  const http = options.http ?? createHttpClient({ headers: options.headers });
  return {
    url: async (template, location, record, signal) => {
      const url = interpolateLoad(template, location, record.queryDefs);
      try {
        const response = await http.get(url, { signal });
        return response.data;
      } catch (cause) {
        // runLoaders (vapor-chamber-router core) already reclassifies this as
        // 'cancelled' when `signal` is the one that aborted — no need to
        // special-case AbortError here, just attach the cause either way.
        throw routerError('load_failed', `loader request failed for "${url}": ${(cause as Error).message}`, {
          to: location,
          cause,
        });
      }
    },
  };
}

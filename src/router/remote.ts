/**
 * vapor-chamber/router/remote - the router's http-backed features.
 *
 * Sibling to `./vdom` and `./vapor`, and named the same way: for what it costs.
 * Importing from here opts into the chamber http client (CSRF, interceptors,
 * retry, cache); `vapor-chamber/router` on its own never reaches it.
 *
 *   import { createRouter } from 'vapor-chamber/router';       // no http
 *   import { routerHttp } from 'vapor-chamber/router/remote';  // + http client
 *
 * WHY THIS IS A SUBPATH AND NOT A DEFAULT
 *
 * Two router features need to make a request: loading a `{ url }` route table,
 * and fetching a blade row's HTML. Both are optional, and the primary
 * documented setup - a generated route module with no blade rows - uses
 * neither. A client built by the router would cost every consumer 8.5 KB raw /
 * 3.4 KB brotli (v1.18.0), about a quarter of the subpath, for code most apps never
 * execute; a dynamic `import()` would still charge a bundler that does not code
 * split. An import graph is the honest place to express "this costs extra",
 * as `./vdom` and `./vapor` already do.
 *
 * The router core takes these as ORDINARY OPTIONS. Nothing here is
 * privileged: `http` accepts any `HttpClient`, and `fetchBlade` accepts any
 * `(href) => Promise<string>`. These two helpers exist so the common case
 * stays two lines, not because the router requires them.
 */

import { _withDefaults, createHttpClient } from '../http';
import type { HttpClient, HttpRequestConfig } from '../http';

export type RouterHttpOptions = Partial<HttpRequestConfig> & {
  /** The app's client: the result sends through it, one cache and one set of interceptors. Default: a fresh client. */
  http?: HttpClient;
};

/**
 * The chamber http client with an `X-Vapor-Router` marker header, so a backend
 * can tell router traffic from command traffic. Everything else is the client's
 * own default, and any option you pass wins. With `http`, the app's client
 * marked: its cache, in-flight reads and interceptors, shared
 * (tests/router/one-client.test.ts).
 */
export function routerHttp(options: RouterHttpOptions = {}): HttpClient {
  const { http, ...config } = options;
  const defaults = { ...config, headers: { 'X-Vapor-Router': '1', ...config.headers } };
  return http ? _withDefaults(http, defaults) : createHttpClient(defaults);
}

export type BladeFetcherOptions = {
  /** The client blade rows are fetched through. Default: the router's (its
   *  `http` option) marked as router traffic, else a fresh `routerHttp()`. */
  http?: HttpClient;
  /** Selector extracted from the fetched HTML. Default: 'main'. */
  bladeRoot?: string;
};

/**
 * Fetch a blade row's HTML and return the fragment inside `bladeRoot`.
 *
 * Goes through the chamber http client rather than bare `fetch`, so it
 * inherits timeout, retry, the session-expired hook and error mapping - which
 * is the whole reason this is worth shipping instead of leaving every app to
 * hand-roll a DOMParser call.
 */
export function bladeFetcher(options: BladeFetcherOptions = {}): (href: string, http?: HttpClient) => Promise<string> {
  const bladeRoot = options.bladeRoot ?? 'main';
  // The router's client marked, or a fresh `routerHttp()` when it has none:
  // built at the first fetch, again only when the router's client changes.
  let routerClient: HttpClient | undefined;
  let marked: HttpClient | undefined;
  return async (href, router) => {
    if (!options.http && (marked === undefined || router !== routerClient)) {
      routerClient = router;
      marked = routerHttp({ http: router });
    }
    const http = options.http ?? (marked as HttpClient);
    const response = await http.get<string>(href, {
      responseType: 'text',
      headers: { Accept: 'text/html' },
    });
    // No DOM to parse with (SSR, a worker): hand back the document as fetched
    // rather than throwing - the caller asked for HTML and gets HTML.
    if (typeof DOMParser === 'undefined') return response.data;
    const doc = new DOMParser().parseFromString(response.data, 'text/html');
    return (doc.querySelector(bladeRoot) ?? doc.body).innerHTML;
  };
}

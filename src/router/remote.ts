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
 * neither. The router used to build the client itself, so every consumer paid
 * for it: measured at 8.5 KB raw / 3.4 KB brotli, about a quarter of the
 * subpath, for code most apps never execute.
 *
 * Deferring it behind a dynamic `import()` fixed the startup cost but left it
 * in the graph, which still charges consumers whose bundler does not code
 * split, and left `createRouter` deciding a dependency on its caller's behalf.
 * An import graph is the honest place to express "this costs extra", and the
 * router already says so twice with `./vdom` and `./vapor`.
 *
 * The router core now takes these as ORDINARY OPTIONS. Nothing here is
 * privileged: `http` accepts any `HttpClient`, and `fetchBlade` accepts any
 * `(href) => Promise<string>`. These two helpers exist so the common case
 * stays two lines, not because the router requires them.
 */

import { createHttpClient } from '../http';
import type { HttpClient, HttpRequestConfig } from '../http';

/**
 * The chamber http client, configured the way the router used to configure its
 * own: an `X-Vapor-Router` marker header so a backend can tell router traffic
 * from command traffic. Everything else is the client's own default, and any
 * option you pass wins.
 */
export function routerHttp(options: Partial<HttpRequestConfig> = {}): HttpClient {
  return createHttpClient({
    ...options,
    headers: { 'X-Vapor-Router': '1', ...options.headers },
  });
}

export type BladeFetcherOptions = {
  /** Reuse an existing client (the one you passed as `http`, typically) rather
   *  than building a second one. Default: a fresh `routerHttp()`. */
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
export function bladeFetcher(options: BladeFetcherOptions = {}): (href: string) => Promise<string> {
  const http = options.http ?? routerHttp();
  const bladeRoot = options.bladeRoot ?? 'main';
  return async (href) => {
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

/**
 * vapor-chamber - HTTP error classification
 *
 * Two named rules with one owner, so the places that ask cannot drift:
 *
 * - `isRetryableStatus(status)` - may a request that got this status be sent
 *   again? 408, 429 and every 5xx. Both request loops in `http.ts` use it, and
 *   so does `retry()`'s default predicate (`plugins-io.ts`) for errors that
 *   carry a status - which is what stops `retry()` re-sending a 422 the HTTP
 *   layer itself refused to re-send (tests/retry-bridge-path.test.ts).
 * - `classifyError(error)` - can a retained cache entry stand in for this
 *   failure (`cache.serveStaleOnError`), and may the loops' catch path retry
 *   it? A timeout, a network failure (no response at all), or a 5xx.
 *
 * They differ on 408 and 429, deliberately: both are retried (the server asks
 * the client to come back, and `Retry-After` is honoured on 429), but neither
 * is "transient" to classifyError, so `serveStaleOnError` does not serve stale
 * data for them. Every other 4xx is a business/client error under both rules.
 *
 * This header used to say a 4xx is "never transient, no matter how tempting it
 * is to retry a flaky-looking 429", while `http.ts` retried 429 through its own
 * status list the whole time - two rules, one of them unnamed. Now both are
 * named here.
 */

import type { HttpError } from './http';

/** 408, 429 and every 5xx: statuses a request may be sent again for. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export type ErrorClassification = {
  /** Retry/stale-serve eligible: timeout, network (no response), or 5xx. */
  transient: boolean;
};

export function classifyError(error: unknown): ErrorClassification {
  const err = error as Partial<HttpError> | null | undefined;
  const timeout = err?.name === 'TimeoutError';
  const status = err?.response?.status;
  return { transient: timeout || status === undefined || status >= 500 };
}

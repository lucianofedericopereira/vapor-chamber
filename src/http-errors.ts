/**
 * vapor-chamber — HTTP error classification
 *
 * The single, named "is this worth retrying / can a cached response stand
 * in for it" rule, extracted so `http.ts`'s retry loop and `cache.serveStaleOnError`
 * can't drift on what counts as transient — a timeout, a network failure (no
 * response at all), or a 5xx. A 4xx is a business/client error and is never
 * transient, no matter how tempting it is to retry a flaky-looking 429.
 */

import type { HttpError } from './http';

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

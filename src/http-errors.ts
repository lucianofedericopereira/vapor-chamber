/**
 * vapor-chamber - the HTTP contract. What a status declares
 * (`conditionOfStatus`, and `failureCondition` for any failure) lives in the
 * core, next to the condition vocabulary: the async bus's retry reads it.
 *
 * - `isRetryableStatus(status)` - may a request that got this status be sent
 *   again? 408, 429 and every 5xx, the set the AWS SDKs and the .NET standard
 *   resilience handler retry. The HTTP client's loops use it, and honour
 *   `Retry-After` on any status.
 * - `ProblemDetails` - the failure's shape at the boundary (RFC 9457): what a
 *   backend answers, and what the HTTP client's `safe` helpers return.
 * - `classifyError(error)` - can a retained cache entry stand in for this
 *   failure (`cache.serveStaleOnError`), RFC 9111's stale-if-error: a timeout,
 *   no response at all, or a 5xx. A different question from a retry, so a
 *   different rule.
 */

import type { HttpError } from './http';

/**
 * An RFC 9457 problem with the members the contract uses: `status` (for a
 * batched result, the command's own), `code` (the identity), `detail` (the
 * sentence), `errors` (where, `/payload/<field>`), and any parameters as
 * extensions. `type` and `title` are not part of the contract.
 */
export type ProblemDetails = {
  status?: number;
  code?: string;
  detail?: string;
  errors?: ReadonlyArray<{ pointer: string; detail: string }>;
  [param: string]: unknown;
};

/** 408, 429 and every 5xx: statuses a request may be sent again for (AWS SDK and .NET defaults). */
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

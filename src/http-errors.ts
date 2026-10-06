/**
 * vapor-chamber - the HTTP contract. What a status declares
 * (`conditionOfStatus`, and `failureCondition` for any failure) lives in the
 * core, next to the condition vocabulary: the async bus's retry reads it.
 *
 * - `isRetryableStatus(status)` - may a request that got this status be sent
 *   again? 408, 429 and every 5xx, the set the AWS SDKs and the .NET standard
 *   resilience handler retry. The HTTP client's loops use it. A declared
 *   wait (`Retry-After`) sets when, never whether.
 * - `ProblemDetails` - the failure's shape at the boundary (RFC 9457): what a
 *   backend answers, and what the HTTP client's `safe` helpers return.
 * - `classifyError(error)` - can a retained cache entry stand in for this
 *   failure (`cache.serveStaleOnError`), RFC 9111's stale-if-error: a timeout,
 *   no response at all, or a 5xx. A different question from a retry, so a
 *   different rule.
 */

import { BusError, conditionOf, conditionOfStatus, retryClass } from './failure';

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

/**
 * The backend's RFC 9457 problem behind a failure, or `undefined` when no
 * backend answered. Walks the `cause` chain (a router failure's cause, a
 * plugin's wrap), so a consumer reads it once instead of digging (plan 8d.2):
 * a `remote:` failure (from the http client or a bridge, the same failure
 * since log s35.131) gives its problem members. Log s35.121.
 *
 * @example
 * const error = await router.push('/orders/7');
 * if (problemOf(error)?.code === 'order_not_found') showNotFound();
 */
export function problemOf(error: unknown): ProblemDetails | undefined {
  let e = error as { name?: unknown; code?: unknown; message?: string; context?: Record<string, unknown>; cause?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 8; depth++, e = e.cause as typeof e) {
    if (e.name === 'BusError' && typeof e.code === 'string' && e.code.startsWith('remote:')) {
      // A `remote:` failure always carries the problem's members as context.
      const { retryIn: _retryIn, ...members } = e.context as Record<string, unknown>;
      return { ...members, detail: e.message } as ProblemDetails;
    }
  }
  return undefined;
}

/**
 * May a request answered with this status be sent again? The one retry rule
 * (`retryClass`) read through the status table: 408, 429 and every 5xx. A
 * transient one (408, 429, 503) for any request, an uncertain one (500, 502,
 * 504, ...) only for an identified request. Log s35.131, s35.162.
 */
export function isRetryableStatus(status: number): boolean {
  return retryClass(undefined, conditionOfStatus(status)) !== 'final';
}

export type ErrorClassification = {
  /** Stale-serve eligible: no answer (a timeout, no response) or a server failure (5xx). */
  transient: boolean;
};

/**
 * May a retained response stand in for this failure (`serveStaleOnError`)?
 * Only when the server gave no answer or failed itself: a 5xx, a timeout, no
 * response. Not a retry rule - a 408 or a 429 is re-sent but not served stale,
 * and an abort is the caller's. Anything that is not the client's failure
 * reads as no response, as before.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (!(error instanceof BusError)) return { transient: true };
  const status = error.context?.status;
  if (typeof status === 'number') return { transient: status >= 500 };
  const condition = conditionOf(error);
  return { transient: condition === 'timeout' || condition === 'lost' };
}

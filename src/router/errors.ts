/**
 * vapor-chamber-router - the single error taxonomy.
 *
 * Mirrors vapor-chamber's HttpError convention: a plain Error narrowed by
 * `name`, with a machine-readable snake_case `code` (same style as the
 * Laravel `{ ok: false, error, code }` responses), the target location, and
 * the original `cause`. Handlers switch on `code`, never message text.
 *
 * This is ALSO the navigation result: `navigate()` resolves to
 * `RouterError | null` - null means committed. Refusals that are normal flow
 * ('aborted' by a guard, 'cancelled' by a newer navigation) are returned to
 * the caller but NOT dispatched to onError.
 */

import type { RouteLocation } from './types';

export type RouterErrorCode =
  // navigation flow
  | 'unmatched'
  | 'aborted'
  | 'cancelled'
  | 'not_ready'
  | 'unknown_route_name'
  // A guard redirect chain that never settles. Deliberately NOT in
  // HARD_NAV_CODES: handing the URL to the server cannot fix a guard bug.
  | 'redirect_loop'
  // route table
  | 'duplicate_route'
  | 'unknown_parent'
  // A parent chain that loops back on itself. Its own code and not a flavour of
  // `unknown_parent`, because every parent in the cycle resolves fine - the
  // defect is the shape, not a missing row.
  | 'cyclic_parent'
  | 'missing_param'
  | 'bad_menu_row'
  | 'invalid_path'
  | 'invalid_routes_payload'
  | 'routes_load_failed'
  | 'inline_routes_missing'
  // render/data resolution
  | 'component_missing'
  | 'component_load_failed'
  | 'load_failed'
  | 'blade_unconfigured'
  // `routes: { url }` with no http client supplied. Sibling of
  // blade_unconfigured: both name an optional feature whose dependency the
  // router deliberately does not build for you (vapor-chamber/router/remote).
  | 'http_unconfigured'
  | 'blade_fetch_failed'
  // render mode - raised by the Vapor outlet only (src/router/vapor.ts), which
  // refuses a non-Vapor component rather than silently restoring interop.
  | 'mode_mismatch'
  // composable or outlet used with no router installed. The one failure in
  // this router that used to throw a bare Error, i.e. the one a handler could
  // not switch on. Message text is unchanged from that Error.
  | 'no_router';

export type RouterError = Error & {
  name: 'RouterError';
  code: RouterErrorCode;
  /** Target location of the navigation that failed, when applicable. */
  to?: RouteLocation;
};

export function routerError(
  code: RouterErrorCode,
  message: string,
  extra: { to?: RouteLocation; cause?: unknown } = {},
): RouterError {
  const error = new Error(
    `[vapor-chamber-router] ${message}`,
    extra.cause !== undefined ? { cause: extra.cause } : undefined,
  ) as RouterError;
  error.name = 'RouterError';
  error.code = code;
  if (extra.to) error.to = extra.to;
  return error;
}

export function isRouterError(error: unknown, code?: RouterErrorCode): error is RouterError {
  return (
    error instanceof Error &&
    error.name === 'RouterError' &&
    (code === undefined || (error as RouterError).code === code)
  );
}

/** Codes where the server gets the last word: the default onError handler
 *  hard-navigates - an unmatched URL renders server-side, and a failed lazy
 *  chunk (stale hashes after a deploy) recovers via a full page load. */
export const HARD_NAV_CODES: ReadonlySet<RouterErrorCode> = new Set([
  'unmatched',
  'component_load_failed',
  'blade_fetch_failed',
]);

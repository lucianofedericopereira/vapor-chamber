/**
 * vapor-chamber-router - the single error taxonomy.
 *
 * Every router failure is the core's `BusError` (src/failure.ts, which keeps
 * the bus out of the router's graph, plan 8d), coded `router:condition:subject`
 * (shape rules 2 and 3) and listed in ERROR_CODE_REGISTRY. Handlers switch on
 * `code` or read the condition with `conditionOf`, never the message text; the
 * navigation target is `context.to`, the original error `cause`. Only `failed`
 * keeps a stack (plan 8d.1), as everywhere in the library.
 *
 * This is ALSO the navigation result: `navigate()` resolves to
 * `RouterError | null` - null means committed. Refusals that are normal flow
 * (`refused:guard`, `aborted:navigation`) are returned to the caller but NOT
 * dispatched to onError.
 */

import { BusError, _failures } from '../failure';
import type { RouteLocation } from './types';

/** What a raise site passes: `condition:subject`. The owner, `router`, is this module's. */
export type RouterFailCode =
  // navigation flow
  | 'missing:route'
  | 'refused:guard'
  | 'aborted:navigation'
  | 'missing:routes'
  | 'missing:record'
  // A guard redirect chain that never settles. Deliberately NOT in
  // HARD_NAV_CODES: handing the URL to the server cannot fix a guard bug.
  | 'exceeded:redirects'
  // A guard that threw: a bug in app code, so not a hard navigation either.
  | 'failed:guard'
  // A supplied history that threw writing the URL; not a hard navigation.
  | 'failed:history'
  // route table
  | 'already:route'
  | 'missing:parent'
  // A parent chain that loops back on itself. Its own code and not a flavour of
  // `missing:parent`, because every parent in the cycle resolves fine - the
  // defect is the shape, not a missing row.
  | 'invalid:parent'
  | 'missing:param'
  | 'invalid:menu'
  | 'invalid:path'
  // A routes payload off-protocol (not JSON, no routes array): it always comes
  // from the server, the fetched table or the page it rendered.
  | 'unexpected:routes'
  | 'failed:routes'
  | 'missing:inline'
  // reload() with no `{ url }` routes source: a usage mistake, not a failed load.
  | 'missing:url'
  // render/data resolution
  | 'missing:component'
  | 'failed:component'
  | 'failed:loader'
  // A `load` no handler serves: no preset registered, nothing was tried.
  | 'missing:loader'
  | 'missing:fetchBlade'
  // `routes: { url }` with no http client supplied. Sibling of
  // missing:fetchBlade: both name an optional feature whose dependency the
  // router deliberately does not build for you (vapor-chamber/router/remote).
  | 'missing:http'
  | 'failed:blade'
  // render mode - raised by the Vapor outlet only (src/router/vapor.ts), which
  // refuses a non-Vapor component rather than silently restoring interop.
  | 'invalid:component'
  // composable or outlet used with no router installed.
  | 'missing:router';

/** A whole router code, `router:condition:subject`. */
export type RouterErrorCode = `router:${RouterFailCode}`;

/** A router failure: the core's BusError, with the navigation target in `context.to`. */
export type RouterError = BusError & { readonly code: RouterErrorCode; readonly context?: { to?: RouteLocation } };

const fail = _failures('router');

export function routerError(
  code: RouterFailCode,
  message: string,
  extra: { to?: RouteLocation; cause?: unknown } = {},
): RouterError {
  return fail(code, message, { context: extra.to === undefined ? undefined : { to: extra.to }, cause: extra.cause }) as RouterError;
}

export function isRouterError(error: unknown, code?: RouterErrorCode): error is RouterError {
  return error instanceof BusError && (code === undefined ? error.code.startsWith('router:') : error.code === code);
}

/** Codes where the server gets the last word, plan 8d.2's rule: a route,
 *  component or server HTML that is missing or failed. The default onError
 *  handler hard-navigates - an unmatched URL renders server-side, a failed
 *  lazy chunk (stale hashes after a deploy) recovers via a full page load.
 *  tests/router/router-codes.test.ts holds it to the rule over the registry. */
export const HARD_NAV_CODES: ReadonlySet<RouterErrorCode> = new Set<RouterErrorCode>([
  'router:missing:route',
  'router:missing:component',
  'router:failed:component',
  'router:failed:blade',
]);

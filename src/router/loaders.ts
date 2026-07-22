/**
 * vapor-chamber/router — the loader SPI.
 *
 * The router core knows WHEN data loads (on navigation, abort-on-supersede,
 * two-phase committed onto the snapshot; on query-only changes, refetch of
 * affected loaders only). It does NOT know HOW: that's a preset's job,
 * resolved from the route row's `load` string —
 *
 *   registered prefix wins:   "rows:products"        → handlers.prefixes['rows:']
 *   otherwise a URL template: "/api/x?page={page}"   → handlers.url
 *
 * In-box preset: `vapor-chamber/router-fetch` (plain JSON backends). Any other
 * backend convention is a preset returning LoaderHandlers. A load with no
 * matching handler is a coded 'load_failed'.
 */

import { isRouterError, routerError } from './errors';
import type { QueryParamDef, RouteLocation, TableRecord } from './types';
import { decodeQueryParam } from './url';

/** Handles `load` values under a registered prefix
 *  ('rows:products' → ref 'products'). */
export type PrefixHandler = (
  ref: string,
  location: RouteLocation,
  record: TableRecord,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

/** Handles plain URL-template `load` values. Receives the RAW template —
 *  interpolation (interpolateLoad) is the handler's choice. */
export type UrlHandler = (
  template: string,
  location: RouteLocation,
  record: TableRecord,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export type LoaderHandlers = {
  prefixes?: Record<string, PrefixHandler>;
  url?: UrlHandler;
  /** Decide whether a query-only change in `changedKeys` requires this
   *  record's loader to refetch. Default (`defaultAffects`): a prefix/row-source
   *  loader depends on its declared query params plus `page`/`per_page`/`sort`;
   *  a URL template depends only on the `{placeholders}` it mentions. Resolved
   *  once at `createRouter` — override for a preset with different query
   *  semantics. */
  affects?: (record: TableRecord, changedKeys: readonly string[]) => boolean;
};

/** Fill `{placeholders}` from path params first, then typed query params
 *  (declared defaults apply — `{page}` is `1` when absent), else ''. */
export function interpolateLoad(
  template: string,
  location: RouteLocation,
  queryDefs: Record<string, QueryParamDef>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const param = location.params[key];
    if (param !== undefined) return encodeURIComponent(String(param));
    const typed = decodeQueryParam(location.query[key], queryDefs[key] ?? {});
    if (typed === undefined || typed === null) return '';
    return Array.isArray(typed)
      ? typed.map((v) => encodeURIComponent(String(v))).join(',')
      : encodeURIComponent(String(typed));
  });
}

function matchPrefix(template: string, handlers: LoaderHandlers): [string, PrefixHandler] | null {
  const prefixes = handlers.prefixes;
  if (!prefixes) return null;
  for (const prefix of Object.keys(prefixes)) {
    if (template.startsWith(prefix)) return [prefix, prefixes[prefix] as PrefixHandler];
  }
  return null;
}

/** Run every loader in a record chain. Results keyed by record name;
 *  failures throw coded RouterErrors (cause attached, abort → 'cancelled'). */
export async function runLoaders(
  handlers: LoaderHandlers,
  records: readonly TableRecord[],
  location: RouteLocation,
  signal: AbortSignal,
): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>();
  await Promise.all(
    records.map(async (record) => {
      const template = record.load as string;
      const prefixed = matchPrefix(template, handlers);
      try {
        if (prefixed) {
          results.set(record.name, await prefixed[1](template.slice(prefixed[0].length), location, record, signal));
        } else if (handlers.url) {
          results.set(record.name, await handlers.url(template, location, record, signal));
        } else {
          throw routerError('load_failed', `no loader handler for "${template}" — register a preset`, {
            to: location,
          });
        }
      } catch (cause) {
        if (signal.aborted) throw routerError('cancelled', `load aborted for "${record.name}"`, { to: location });
        throw isRouterError(cause)
          ? cause
          : routerError('load_failed', `loader failed for "${record.name}" (${template})`, { to: location, cause });
      }
    }),
  );
  return results;
}

/** Default affect policy: does a change in `keys` require this record's loader
 *  to refetch? Prefix-handled (row-source) loaders receive the whole location,
 *  so they depend on every declared query param plus `page`/`per_page`/`sort`;
 *  URL templates depend only on the placeholders they mention. Override via
 *  `LoaderHandlers.affects`. */
export function defaultAffects(record: TableRecord, keys: readonly string[], handlers: LoaderHandlers): boolean {
  const template = record.load as string;
  if (matchPrefix(template, handlers)) {
    return keys.some((key) => key in record.queryDefs || key === 'page' || key === 'per_page' || key === 'sort');
  }
  return keys.some((key) => template.includes(`{${key}}`));
}

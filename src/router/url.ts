/**
 * vapor-chamber-router — URL/query layer. Pure string/data functions.
 *
 * Query params are STATE, not navigation (ARCHITECTURE.md §3): the typed
 * codec here backs the engine's query fast path and useQueryParam.
 */

import type { QueryParamDef, QueryValues } from './types';

/** Parse a search string ('?a=1&b=2', leading '?' optional) into QueryValues.
 *  Repeated keys collect into arrays. '+' decodes to space. */
export function parseQuery(search: string): QueryValues {
  const query: QueryValues = {};
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return query;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeQueryPart(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : decodeQueryPart(pair.slice(eq + 1));
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

/** Stringify QueryValues WITHOUT the leading '?'. null/undefined entries are
 *  skipped; arrays emit repeated keys. */
export function stringifyQuery(query: QueryValues | Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    const encodedKey = encodeQueryPart(key);
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === null || v === undefined) continue;
      parts.push(v === '' ? encodedKey : `${encodedKey}=${encodeQueryPart(String(v))}`);
    }
  }
  return parts.join('&');
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

function encodeQueryPart(part: string): string {
  // encodeURIComponent, relaxed for characters safe inside a query that keep
  // URLs readable.
  return encodeURIComponent(part).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
}

/** Decode one raw query value through its declaration; falls back to
 *  `def.default` when absent or failing the cast. */
export function decodeQueryParam(raw: string | string[] | undefined, def: QueryParamDef): unknown {
  const type = def.type ?? 'string';
  if (type === 'array') {
    if (raw === undefined) return def.default ?? [];
    return Array.isArray(raw) ? raw : [raw];
  }
  const scalar = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (scalar === undefined) return def.default;
  switch (type) {
    case 'int': {
      const n = Number.parseInt(scalar, 10);
      return Number.isNaN(n) ? def.default : n;
    }
    case 'bool': {
      if (scalar === '1' || scalar === 'true') return true;
      if (scalar === '0' || scalar === 'false') return false;
      return def.default;
    }
    default:
      return scalar;
  }
}

/** Encode a typed value for the URL. Returns null when the key should be
 *  DROPPED — values equal to the declared default never pollute the URL. */
export function encodeQueryParam(value: unknown, def: QueryParamDef): string | string[] | null {
  if (value === null || value === undefined) return null;
  if ((def.type ?? 'string') === 'array') {
    const arr = (Array.isArray(value) ? value : [value]).map(String);
    if (Array.isArray(def.default) && sameStringArray(arr, def.default.map(String))) return null;
    return arr.length ? arr : null;
  }
  if (def.default !== undefined && value === def.default) return null;
  if (value === true) return '1';
  if (value === false) return '0';
  return String(value);
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Shared active/exact semantics for a link target against the current path —
 * `data-active` stamping (dom.ts) and useMenu() both go through here, so a
 * Blade-rendered menu and a Vue-rendered menu can never disagree.
 * Trailing-slash tolerant. exact = same path; active = exact or path prefix
 * ('/' is never a prefix-active catch-all).
 */
export function pathActivity(targetPath: string, currentPath: string): { active: boolean; exact: boolean } {
  const target = targetPath.replace(/\/$/, '') || '/';
  const current = currentPath.replace(/\/$/, '') || '/';
  const exact = target === current;
  return { exact, active: exact || (target !== '/' && current.startsWith(`${target}/`)) };
}

/**
 * How a query write lands in browser history. Ladder (first hit wins):
 *   1. explicit per-call override
 *   2. the route's declaration
 *   3. convention: `page` pushes (back steps through pages), everything else
 *      (filters, sort, search…) replaces.
 */
export function resolveQueryHistory(
  key: string,
  def: QueryParamDef | undefined,
  override?: 'push' | 'replace',
): 'push' | 'replace' {
  return override ?? def?.history ?? (key === 'page' ? 'push' : 'replace');
}

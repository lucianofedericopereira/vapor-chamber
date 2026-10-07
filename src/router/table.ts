/**
 * vapor-chamber-router - the route table.
 *
 * Rows (generator-emitted, server-sorted by priority) -> compiled table.
 * Everything static is precomputed here once: parent chain, renderable
 * chain, load chain, merged query defs, name map. Hot paths never derive.
 *
 * The generator is trusted - duplicate-name / unknown-parent validation runs
 * in dev only; production assumes well-formed rows the same way it assumes a
 * valid migration.
 */

import { DEV } from '../dev';
import { freezeDeep } from '../freeze';
import { routerError } from './errors';
import type { ParamType, RouteParams, RouteRecord, Segment, TableRecord } from './types';

export type RouteTable = {
  records: readonly TableRecord[];
  /** Resolve a path as in the URL (no query/hash) to the first matching
   *  record; captured params come back decoded. */
  resolve: (path: string) => { record: TableRecord; params: RouteParams } | null;
  getRecord: (name: string) => TableRecord | undefined;
  /** Interpolate params into a record's pattern. */
  buildPath: (record: TableRecord, params?: RouteParams) => string;
};

const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(\(([^)]+)\))?(\?)?$/;

/**
 * What a typed param matches when the row gives no regex of its own. A value
 * that does not fit the type does not match the row, so the URL falls through
 * to the next row (or to unmatched, and the server): `/products/7x` is never
 * product 7, and an `int` param is never handed over as a string.
 */
const TYPE_PATTERN: Partial<Record<ParamType, string>> = { int: '-?\\d+', bool: '(?:1|0|true|false)' };

/**
 * Render a compiled record's segments into a path, or report the first
 * required param the caller failed to supply.
 *
 * Shared because there are exactly two callers and they differ only in what a
 * missing param MEANS: `buildPath` throws (a link the app asked for and cannot
 * build is a bug), while breadcrumb projection yields a non-linking crumb (an
 * ancestor the current URL simply cannot address is normal). Keeping one copy
 * of the walk keeps route-URL construction from drifting between the two -
 * which in a router is precisely where a subtle mismatch would hide.
 */
export function renderSegments(
  segments: readonly Segment[],
  params: RouteParams,
): { path: string; missing?: undefined } | { path?: undefined; missing: string } {
  let path = '';
  for (const segment of segments) {
    if (segment.kind === 'static') {
      path += `/${segment.value}`;
      continue;
    }
    if (segment.kind === 'splat') {
      const value = params.pathMatch;
      if (value !== undefined && value !== '') path += `/${String(value)}`;
      continue;
    }
    const value = params[segment.name];
    if (value === undefined) {
      if (segment.optional) continue;
      return { missing: segment.name };
    }
    path += `/${encodeURIComponent(String(value))}`;
  }
  return { path: path || '/' };
}

/** Compile one path pattern into segments + a matching RegExp; a typed param
 *  with no regex of its own matches its type's pattern. */
export function compilePath(path: string, paramTypes: Readonly<Record<string, ParamType>> = {}): {
  segments: Segment[];
  re: RegExp;
  keys: string[];
} {
  const segments: Segment[] = [];
  const keys: string[] = [];
  let source = '^';
  for (const raw of path.replace(/^\//, '').split('/')) {
    if (raw === '') continue; // root path or duplicate slashes
    if (raw === '*') {
      segments.push({ kind: 'splat' });
      keys.push('pathMatch');
      source += '(?:/(.*))?';
      continue;
    }
    const m = PARAM_RE.exec(raw);
    if (m) {
      const name = m[1] as string;
      const type = paramTypes[name];
      const pattern = m[3] ?? (type && TYPE_PATTERN[type]) ?? '[^/]+';
      const optional = m[4] === '?';
      segments.push({ kind: 'param', name, pattern, optional });
      keys.push(name);
      source += optional ? `(?:/(${pattern}))?` : `/(${pattern})`;
    } else {
      // A segment that opens with ':' was unambiguously meant to be a param.
      // Falling through to `static` compiles it to a LITERAL - the row then
      // matches only a URL containing the typo itself, i.e. never. That is a
      // silent dead route whose only symptom is a 404 somewhere else, so in
      // dev it is an error, not a shrug. (`/:name*` is the common one: the
      // splat syntax here is a bare `/*`, or `:name(.*)` to capture it.)
      if (DEV && raw.startsWith(':')) {
        throw routerError(
          'invalid:path',
          `route path segment ":${raw.slice(1)}" in "${path}" is not a valid param - supported forms are :name, :name(regex), :name? and a trailing /* splat. As written it compiles to a literal segment and the route can never match.`,
        );
      }
      segments.push({ kind: 'static', value: raw });
      source += `/${escapeRegExp(raw)}`;
    }
  }
  source += '/?$';
  return { segments, re: new RegExp(source, 'i'), keys };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+*?^${}()[\]/\\|]/g, '\\$&');
}

/** A matched segment as its declared type, or undefined when it does not fit
 *  (a row's own regex can admit more than its type): the row then does not
 *  match, as with the type's default pattern. */
function castParam(value: string, type: ParamType | undefined): string | number | boolean | undefined {
  switch (type) {
    case 'int':
      return /^-?\d+$/.test(value) ? Number(value) : undefined;
    case 'bool': {
      const flag = value.toLowerCase();
      return flag === '1' || flag === 'true' ? true : flag === '0' || flag === 'false' ? false : undefined;
    }
    default:
      return value;
  }
}

export function createRouteTable(rows: readonly RouteRecord[]): RouteTable {
  const records: TableRecord[] = [];
  const byName = new Map<string, TableRecord>();

  // Pass 1 - compile rows.
  for (const row of rows) {
    if (DEV && byName.has(row.name)) {
      throw routerError('already:route', `duplicate route name "${row.name}"`);
    }
    // One value for both reads: a table from JSON or a database carries `null`.
    const paramTypes = row.params ?? {};
    const record: TableRecord = {
      name: row.name,
      path: row.path,
      parent: null,
      component: row.component ?? null,
      blade: row.blade === true,
      group: !row.component && row.blade !== true,
      load: row.load ?? null,
      paramTypes,
      meta: row.meta ?? {},
      chain: [],
      renderChain: [],
      loadChain: [],
      queryDefs: {},
      ...compilePath(row.path, paramTypes),
    };
    // `meta` is the ROW's object, and the table hands the same one to every
    // consumer for the router's whole life: `location.meta` is it, so are
    // `MenuItem.meta` and `Breadcrumb.meta`. A component that stashes a
    // computed title on `route.meta` therefore rewrites the table. Frozen as
    // ../freeze freezes the shared caches - dev-only, like them: the mutation
    // throws where it happens, and production pays nothing.
    if (DEV) freezeDeep(record.meta);
    records.push(record);
    byName.set(record.name, record);
  }

  // Pass 2 - link parents.
  rows.forEach((row, i) => {
    if (!row.parent) return;
    const parent = byName.get(row.parent);
    if (!parent) {
      if (DEV) {
        throw routerError('missing:parent', `route "${row.name}" references unknown parent "${row.parent}"`);
      }
      return;
    }
    (records[i] as TableRecord).parent = parent;
  });

  // Pass 3 - precompute chains + merged query defs (leaf wins).
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  for (const record of records) {
    const chain: TableRecord[] = [];
    // A cyclic parent chain (`a.parent = b`, `b.parent = a`) would spin a
    // `for (; r; r = r.parent)` walk FOREVER, synchronously, on the main
    // thread: no error, no stack, the tab locks.
    //
    // Every other malformed-table case in this file is loud in dev and lenient
    // in prod, and a hang is the one failure where that split matters most:
    // dev gets the diagnosis, and production still has to survive rows it did
    // not validate, because a frozen tab cannot even hard-navigate away.
    // Stopping at the repeat leaves a truncated chain - a wrong page beats no
    // page at all.
    const seen = new Set<TableRecord>();
    for (let r: TableRecord | null = record; r && !seen.has(r); r = r.parent) {
      seen.add(r);
      chain.unshift(r);
    }
    if (DEV && chain[0]?.parent) {
      throw routerError(
        'invalid:parent',
        `route "${record.name}" has a cyclic parent chain (${chain.map((r) => r.name).join(' -> ')} -> ${chain[0].parent.name}) - a route cannot be its own ancestor`,
      );
    }
    (record as { chain: readonly TableRecord[] }).chain = Object.freeze(chain);
    (record as { renderChain: readonly TableRecord[] }).renderChain = Object.freeze(
      chain.filter((r) => r.component || r.blade),
    );
    (record as { loadChain: readonly TableRecord[] }).loadChain = Object.freeze(chain.filter((r) => r.load));
    const queryDefs: TableRecord['queryDefs'] = {};
    for (const link of chain) Object.assign(queryDefs, rowByName.get(link.name)?.query);
    (record as { queryDefs: TableRecord['queryDefs'] }).queryDefs = queryDefs;
  }

  // Fully-static rows resolved by map instead of by regex scan.
  //
  // Safe only where it cannot jump the queue: resolve() returns the FIRST
  // matching row in server-priority order, so a static row is admitted only
  // when no EARLIER parameterised row also matches its path. `/products/new`
  // sitting behind `/products/:id` therefore stays on the scan and keeps
  // matching `:id`, exactly as before.
  //
  // Groups never match a URL, so they neither enter the map nor block anyone.
  const staticByPath = new Map<string, TableRecord>();
  {
    const blockers: TableRecord[] = [];
    for (const record of records) {
      if (record.group) continue;
      if (!record.segments.every((segment) => segment.kind === 'static')) {
        blockers.push(record);
        continue;
      }
      const path = renderSegments(record.segments, {}).path as string;
      if (blockers.some((blocker) => blocker.re.test(path))) continue;
      const key = staticKey(path);
      if (!staticByPath.has(key)) staticByPath.set(key, record);
    }
  }

  function resolve(path: string): { record: TableRecord; params: RouteParams } | null {
    // Mirrors the scan's matching rules: the compiled RegExp is
    // case-insensitive and tolerates one trailing slash.
    const exact = staticByPath.get(staticKey(path));
    if (exact) return { record: exact, params: {} };

    scan: for (const record of records) {
      if (record.group) continue; // pure groups never match a URL themselves
      const m = record.re.exec(path);
      if (!m) continue;
      const params: RouteParams = {};
      for (let i = 0; i < record.keys.length; i++) {
        const key = record.keys[i] as string;
        const raw = m[i + 1];
        if (raw === undefined) continue; // optional param not present
        if (key === 'pathMatch') {
          params[key] = raw;
          continue;
        }
        const value = castParam(decodePathPart(raw), record.paramTypes[key]);
        if (value === undefined) continue scan; // does not fit its type: not this row
        params[key] = value;
      }
      return { record, params };
    }
    return null;
  }

  function buildPath(record: TableRecord, params: RouteParams = {}): string {
    const rendered = renderSegments(record.segments, params);
    if (rendered.missing !== undefined) {
      throw routerError('missing:param', `missing param "${rendered.missing}" for route "${record.name}"`);
    }
    return rendered.path;
  }

  return { records, resolve, getRecord: (name) => byName.get(name), buildPath };
}

/** Map key for a static path: case-folded, at most one trailing slash, '/' kept. */
function staticKey(path: string): string {
  const lower = path.toLowerCase();
  return lower.length > 1 ? lower.replace(/\/$/, '') : lower;
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * vapor-chamber-router — the route table.
 *
 * Rows (generator-emitted, server-sorted by priority) → compiled table.
 * Everything static is precomputed here once: parent chain, renderable
 * chain, load chain, merged query defs, name map. Hot paths never derive.
 *
 * The generator is trusted — duplicate-name / unknown-parent validation runs
 * in dev only; production assumes well-formed rows the same way it assumes a
 * valid migration.
 */

import { routerError } from './errors';
import type { ParamType, RouteParams, RouteRecord, Segment, TableRecord } from './types';

export type RouteTable = {
  records: readonly TableRecord[];
  /** Resolve a decoded path (no query/hash) to the first matching record. */
  resolve: (path: string) => { record: TableRecord; params: RouteParams } | null;
  getRecord: (name: string) => TableRecord | undefined;
  /** Interpolate params into a record's pattern. */
  buildPath: (record: TableRecord, params?: RouteParams) => string;
};

const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(\(([^)]+)\))?(\?)?$/;

/** Compile one path pattern into segments + a matching RegExp. */
/**
 * Render a compiled record's segments into a path, or report the first
 * required param the caller failed to supply.
 *
 * Shared because there are exactly two callers and they differ only in what a
 * missing param MEANS: `buildPath` throws (a link the app asked for and cannot
 * build is a bug), while breadcrumb projection yields a non-linking crumb (an
 * ancestor the current URL simply cannot address is normal). Keeping one copy
 * of the walk keeps route-URL construction from drifting between the two —
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

export function compilePath(path: string): {
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
      const pattern = m[3] ?? '[^/]+';
      const optional = m[4] === '?';
      segments.push({ kind: 'param', name, pattern, optional });
      keys.push(name);
      source += optional ? `(?:/(${pattern}))?` : `/(${pattern})`;
    } else {
      // A segment that opens with ':' was unambiguously meant to be a param.
      // Falling through to `static` compiles it to a LITERAL — the row then
      // matches only a URL containing the typo itself, i.e. never. That is a
      // silent dead route whose only symptom is a 404 somewhere else, so in
      // dev it is an error, not a shrug. (`/:name*` is the common one: the
      // splat syntax here is a bare `/*`, or `:name(.*)` to capture it.)
      if (DEV && raw.startsWith(':')) {
        throw routerError(
          'invalid_path',
          `route path segment ":${raw.slice(1)}" in "${path}" is not a valid param — supported forms are :name, :name(regex), :name? and a trailing /* splat. As written it compiles to a literal segment and the route can never match.`,
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

function castParam(value: string, type: ParamType | undefined): string | number | boolean {
  switch (type) {
    case 'int': {
      const n = Number.parseInt(value, 10);
      return Number.isNaN(n) ? value : n;
    }
    case 'bool':
      return value === '1' || value === 'true';
    default:
      return value;
  }
}

export function createRouteTable(rows: readonly RouteRecord[]): RouteTable {
  const records: TableRecord[] = [];
  const byName = new Map<string, TableRecord>();

  // Pass 1 — compile rows.
  for (const row of rows) {
    if (DEV && byName.has(row.name)) {
      throw routerError('duplicate_route', `duplicate route name "${row.name}"`);
    }
    const record: TableRecord = {
      name: row.name,
      path: row.path,
      parent: null,
      component: row.component ?? null,
      blade: row.blade === true,
      group: !row.component && row.blade !== true,
      load: row.load ?? null,
      paramTypes: row.params ?? {},
      meta: row.meta ?? {},
      chain: [],
      renderChain: [],
      loadChain: [],
      queryDefs: {},
      ...compilePath(row.path),
    };
    records.push(record);
    byName.set(record.name, record);
  }

  // Pass 2 — link parents.
  rows.forEach((row, i) => {
    if (!row.parent) return;
    const parent = byName.get(row.parent);
    if (!parent) {
      if (DEV) {
        throw routerError('unknown_parent', `route "${row.name}" references unknown parent "${row.parent}"`);
      }
      return;
    }
    (records[i] as TableRecord).parent = parent;
  });

  // Pass 3 — precompute chains + merged query defs (leaf wins).
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  for (const record of records) {
    const chain: TableRecord[] = [];
    for (let r: TableRecord | null = record; r; r = r.parent) chain.unshift(r);
    (record as { chain: readonly TableRecord[] }).chain = Object.freeze(chain);
    (record as { renderChain: readonly TableRecord[] }).renderChain = Object.freeze(
      chain.filter((r) => r.component || r.blade),
    );
    (record as { loadChain: readonly TableRecord[] }).loadChain = Object.freeze(chain.filter((r) => r.load));
    const queryDefs: TableRecord['queryDefs'] = {};
    for (const link of chain) Object.assign(queryDefs, rowByName.get(link.name)?.query);
    (record as { queryDefs: TableRecord['queryDefs'] }).queryDefs = queryDefs;
  }

  function resolve(path: string): { record: TableRecord; params: RouteParams } | null {
    for (const record of records) {
      if (record.group) continue; // pure groups never match a URL themselves
      const m = record.re.exec(path);
      if (!m) continue;
      const params: RouteParams = {};
      record.keys.forEach((key, i) => {
        const raw = m[i + 1];
        if (raw === undefined) return; // optional param not present
        params[key] = key === 'pathMatch' ? raw : castParam(decodePathPart(raw), record.paramTypes[key]);
      });
      return { record, params };
    }
    return null;
  }

  function buildPath(record: TableRecord, params: RouteParams = {}): string {
    const rendered = renderSegments(record.segments, params);
    if (rendered.missing !== undefined) {
      throw routerError('missing_param', `missing param "${rendered.missing}" for route "${record.name}"`);
    }
    return rendered.path;
  }

  return { records, resolve, getRecord: (name) => byName.get(name), buildPath };
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

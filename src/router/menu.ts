/**
 * vapor-chamber-router — menu + breadcrumb projections of the route table.
 *
 * The table already carries everything a navigation UI needs; these builders
 * only project it — nothing here is authored client-side:
 *   · `meta.menu` (an INTEGER — the server-owned menu position; row order in
 *     the table is match-specificity order, so the menu has its own column)
 *     marks a row as a menu entry. Menu rows need `meta.title` (an i18n key —
 *     translating is the view's job) and a static path: a required `:param`
 *     has no fixed href and is rejected. Group rows may be menued too — they
 *     become href-less section nodes.
 *   · Nesting follows the parent chain: an entry's menu parent is its nearest
 *     menued ancestor.
 *   · Permission filtering is the SERVER's job (visibleTo before delivery) —
 *     what the table holds is what the user may see, so the projection is
 *     permission-correct by construction.
 *   · active/exact use pathActivity — the SAME semantics as `data-active`
 *     stamping, so Blade menus and Vue menus always agree.
 *
 * Like table validation, the menu contract is enforced loudly in dev (and, by
 * convention, by the route generator at export); production trusts the
 * generator.
 */

import { routerError } from './errors';
import type { RouteLocation, RouteParams, TableRecord } from './types';
import { renderSegments } from './table';
import { pathActivity } from './url';

export type MenuItem = {
  name: string;
  /** `meta.title` — an i18n KEY; translate in the view. */
  title: string;
  /** Absolute href (base included) — null for group rows (section nodes). */
  href: string | null;
  meta: Record<string, unknown>;
  /** Same semantics as data-active stamping; a parent also lights up when
   *  any of its children is active. */
  active: boolean;
  exactActive: boolean;
  children: readonly MenuItem[];
};

export type Breadcrumb = {
  name: string;
  /** `meta.title` — an i18n KEY; translate in the view. */
  title: string;
  /** Absolute href; null when the crumb is not a link target (group rows,
   *  ancestors whose params the current location cannot supply). */
  href: string | null;
  /** True on the last crumb — the page being shown. */
  current: boolean;
  meta: Record<string, unknown>;
};

const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Rows flagged `meta.menu`, position-sorted, nested by nearest menued
 *  ancestor, active-stamped against `currentPath`. */
export function buildMenu(records: readonly TableRecord[], currentPath: string, base = ''): MenuItem[] {
  const menued = records.filter((record) => record.meta.menu !== undefined);
  if (DEV) {
    for (const record of menued) {
      if (typeof record.meta.menu !== 'number') {
        throw routerError('bad_menu_row', `route "${record.name}": meta.menu must be a number (the menu position)`);
      }
      if (typeof record.meta.title !== 'string') {
        throw routerError('bad_menu_row', `menu route "${record.name}" needs meta.title (an i18n key)`);
      }
    }
  }

  const inMenu = new Set(menued);
  const sorted = [...menued].sort((a, b) => Number(a.meta.menu) - Number(b.meta.menu));
  const childrenOf = new Map<TableRecord | null, TableRecord[]>();
  for (const record of sorted) {
    const parent = menuParentOf(record, inMenu);
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(record);
    else childrenOf.set(parent, [record]);
  }

  const build = (record: TableRecord): MenuItem => {
    const children = (childrenOf.get(record) ?? []).map(build);
    const path = record.group ? null : menuPath(record);
    const { active, exact } = path === null ? { active: false, exact: false } : pathActivity(path, currentPath);
    return {
      name: record.name,
      title: String(record.meta.title),
      href: path === null ? null : base + path,
      meta: record.meta,
      active: active || children.some((child) => child.active),
      exactActive: exact,
      children,
    };
  };
  return (childrenOf.get(null) ?? []).map(build);
}

/** The current route's parent chain, filtered to rows with a `meta.title`,
 *  root-first — the page itself is the last crumb. */
export function buildBreadcrumbs(location: RouteLocation, base = ''): Breadcrumb[] {
  const titled = location.matched.filter((record) => typeof record.meta.title === 'string');
  return titled.map((record, index) => ({
    name: record.name,
    title: String(record.meta.title),
    href: record.group ? null : crumbHref(record, location.params, base),
    current: index === titled.length - 1,
    meta: record.meta,
  }));
}

/** Nearest ancestor (excluding the record itself) that is also menued. */
function menuParentOf(record: TableRecord, inMenu: ReadonlySet<TableRecord>): TableRecord | null {
  for (let i = record.chain.length - 2; i >= 0; i--) {
    const ancestor = record.chain[i] as TableRecord;
    if (inMenu.has(ancestor)) return ancestor;
  }
  return null;
}

/** A menu row's target path: its static segments (optional params and splats
 *  simply drop). A required param is a table defect — menus are static
 *  navigation — loud in dev; Routes::validate rejects it at export. */
function menuPath(record: TableRecord): string {
  let path = '';
  for (const segment of record.segments) {
    if (segment.kind === 'static') {
      path += `/${segment.value}`;
    } else if (DEV && segment.kind === 'param' && !segment.optional) {
      throw routerError(
        'bad_menu_row',
        `menu route "${record.name}" has a required param ":${segment.name}" — menu rows must be static`,
      );
    }
  }
  return path || '/';
}

/** Like table.buildPath, but a projection: an ancestor needing a param the
 *  current location doesn't carry yields a non-linking crumb, not an error. */
function crumbHref(record: TableRecord, params: RouteParams, base: string): string | null {
  const rendered = renderSegments(record.segments, params);
  // A projection, not a demand: an ancestor needing a param the current
  // location cannot supply becomes a non-linking crumb rather than an error.
  return rendered.missing !== undefined ? null : base + rendered.path;
}

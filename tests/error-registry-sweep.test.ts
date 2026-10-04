/**
 * `ERROR_CODE_REGISTRY` calls itself "the single source of truth" for the
 * library's codes. This sweep checks that against what the source MINTS.
 *
 * Since the owner-by-wiring shape (docs/plan-failures-and-contract.md 4.5) a
 * failure is built by a `fail`-shaped call whose first argument is a literal
 * `'condition:subject'`, so "which site mints this?" - the question the old
 * union sweep could not ask - is a scan. Both sides come from source: the
 * literals out of `src/`, the rows out of the exported registry. A code minted
 * with no row fails; so does a row nothing mints, unless it is one of the codes
 * declared on purpose and never raised (listed below, each with its reason).
 *
 * The owner half is not scanned: it is the wiring's, not the site's. A row is
 * matched on its `condition:subject`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { it } from '../src/vitest';
import { ERROR_CODE_REGISTRY } from '../src/schema';

const SRC = join(import.meta.dirname, '..', 'src');
// The vocabulary, read from the `Condition` type itself: a copy here went stale
// when `conflict` and `unauthenticated` joined it, and a site minting either
// would have been skipped by the scan without a word.
const VOCABULARY = [...(/export type Condition =([^;]*);/.exec(readFileSync(join(SRC, 'failure.ts'), 'utf8'))?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
const CONDITIONS = VOCABULARY.join('|');

/**
 * Declared, catalogued and minted by no site - each for a stated reason, so
 * adding one is a decision rather than a way to silence this sweep.
 */
const DECLARED_NOT_MINTED: Record<string, string> = {
  'failed:handler': "a handler's throw reaches result.error raw (plan settled item 10)",
  'already:handler': 'the overwrite notice is a DEV console line',
  'failed:hook': 'an after-hook throw is logged, not returned',
  'failed:listener': 'a listener throw is logged, not returned',
  'failed:step': 'workflow codes: declared for the workflow module',
  'failed:compensation': 'workflow codes: declared for the workflow module',
  'unknown:error': 'the fallback a reader classifies into, never raised',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Every `'condition:subject'` literal passed as a code, comments stripped. */
function minted(): Set<string> {
  const found = new Set<string>();
  const literal = new RegExp(`(?:fail|refuse|Fail|transportError|routerError|\\))\\(\\s*'((?:${CONDITIONS}):[a-zA-Z]+)'`, 'g');
  for (const file of sourceFiles(SRC)) {
    // Line comments first: a `/*` inside one (table.ts writes the splat as
    // `/*`) would otherwise open a block that swallows the code after it.
    const text = readFileSync(file, 'utf8').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(literal)) found.add(m[1]);
  }
  return found;
}

const suffix = (code: string) => code.split(':').slice(1).join(':');

describe('error-code registry sweep', () => {
  const codes = minted();
  const rows = new Set(ERROR_CODE_REGISTRY.map((e) => suffix(e.code)));

  it('finds the mint sites and reads the registry', () => {
    // A guard on the scan itself: an empty set would pass every check below.
    expect(codes.size).toBeGreaterThan(10);
    expect(ERROR_CODE_REGISTRY.length).toBeGreaterThan(10);
    // And on the vocabulary read: the type, all fourteen words.
    expect(VOCABULARY).toHaveLength(14);
    expect(VOCABULARY).toEqual(expect.arrayContaining(['conflict', 'unauthenticated', 'lost']));
  });

  it('every minted code has a registry row', () => {
    const missing = [...codes].filter((c) => !rows.has(c));
    expect(missing, 'minted with no catalogue row').toEqual([]);
  });

  it('every registry row is minted, or declared-not-minted on purpose', () => {
    const orphans = [...rows].filter((c) => !codes.has(c) && !(c in DECLARED_NOT_MINTED));
    expect(orphans, 'catalogued but raised by nothing').toEqual([]);
  });

  it('a declared-not-minted code is really not minted', () => {
    const nowMinted = Object.keys(DECLARED_NOT_MINTED).filter((c) => codes.has(c));
    expect(nowMinted, 'now minted: remove it from DECLARED_NOT_MINTED').toEqual([]);
  });

  it('the DEV vocabulary check in BusError lists exactly the Condition type', () => {
    // The one runtime copy of the vocabulary (a type is gone at runtime).
    const text = readFileSync(join(SRC, 'failure.ts'), 'utf8');
    const words = /DEV && !\/\^\(([a-z|]+)\):/.exec(text)?.[1].split('|') ?? [];
    expect([...words].sort()).toEqual([...VOCABULARY].sort());
  });

  // The router owns its codes under its own name (shape rule 3), so its
  // sweep is owner-exact: every `routerError` literal has a `router:` row and
  // every `router:` row is raised, and no plain Error is built in its sources
  // (log s35.108).
  it('the router: every code it mints is a router: row, every router: row is minted', () => {
    const own = new Set<string>();
    const literal = new RegExp(`routerError\\(\\s*'((?:${CONDITIONS}):[a-zA-Z]+)'`, 'g');
    const files = [...sourceFiles(join(SRC, 'router')), ...sourceFiles(join(SRC, 'router-fetch'))];
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(literal)) own.add(`router:${m[1]}`);
    const routerRows = ERROR_CODE_REGISTRY.map((e) => e.code).filter((c) => c.startsWith('router:'));
    expect([...own].sort()).toEqual(routerRows.sort());
  });

  it('the router builds no plain Error', () => {
    const files = [...sourceFiles(join(SRC, 'router')), ...sourceFiles(join(SRC, 'router-fetch'))];
    const plain = files.filter((file) => /new (?:Type|Range)?Error\(/.test(readFileSync(file, 'utf8').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '')));
    expect(plain, 'a router failure is routerError, coded').toEqual([]);
  });

  it('no code is registered twice', () => {
    const all = ERROR_CODE_REGISTRY.map((e) => e.code);
    expect(all.length).toBe(new Set(all).size);
  });
});

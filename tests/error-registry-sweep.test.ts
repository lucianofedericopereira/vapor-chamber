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
const CONDITIONS = 'missing|already|invalid|refused|limited|timeout|lost|aborted|exceeded|failed|unexpected|unknown';

/**
 * Declared, catalogued and minted by no site - each for a stated reason, so
 * adding one is a decision rather than a way to silence this sweep.
 */
const DECLARED_NOT_MINTED: Record<string, string> = {
  'failed:handler': "a handler's throw reaches result.error raw (plan settled item 10)",
  'invalid:name': 'the naming check throws a plain Error at register()',
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
  const literal = new RegExp(`(?:fail|refuse|Fail|transportError|\\))\\(\\s*'((?:${CONDITIONS}):[a-z]+)'`, 'g');
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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

  it('no code is registered twice', () => {
    const all = ERROR_CODE_REGISTRY.map((e) => e.code);
    expect(all.length).toBe(new Set(all).size);
  });
});

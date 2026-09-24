/**
 * `ERROR_CODE_REGISTRY` calls itself "the single source of truth" and "the
 * complete registry of all BusError codes". Nothing checked either claim.
 *
 * WHY THIS FILE EXISTS. v1.23.0 added five codes to `BusErrorCode`, and the only
 * thing that would have caught a missing registry row was somebody remembering
 * to add one. The registry is what `getErrorEntry(code).fix` reads and what
 * `describeErrorCodes()` prints into an LLM system prompt, so a code with no row
 * is an error the library can emit and cannot explain - and it fails silently,
 * with `getErrorEntry` returning `undefined` at the moment a developer most
 * wants an answer.
 *
 * BOTH SIDES COME FROM SOURCE, which is what makes this a sweep rather than a
 * list to maintain. The codes are parsed out of the `BusErrorCode` union in
 * `src/command-bus.ts`; the rows are read from the exported registry. There is
 * no allowlist, nothing to update on a rename, and no judgement call - add a
 * code without a row, or a row without a code, and this fails immediately.
 *
 * It is a test rather than a `scripts/check-*.mjs` for the reason the other two
 * sweeps are: it needs the module's runtime value, and `tests/` is where
 * `dict-sweep` and `settled-sweep` already live.
 *
 * WHAT IT DOES NOT CATCH, stated because this session found one. A code can be
 * declared, registered, marked retryable and emitted by NOTHING -
 * `VC_CORE_HANDLER_THREW` is exactly that, and it passes here because it is
 * present on both sides. Catching that needs a third question ("which site mints
 * this?") and an allowlist for the codes deliberately never minted, which is a
 * different and costlier kind of check.
 */

import { describe, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '../src/vitest';
import { ERROR_CODE_REGISTRY } from '../src/schema';

const BUS = join(import.meta.dirname, '..', 'src', 'command-bus.ts');

/**
 * Comments out, string literals KEPT - the inverse of what `dict-sweep` needs.
 * The codes are the literals, and the union's own trailing comments name several
 * of them in prose (the `VC_CORE_HANDLER_THREW` note quotes it twice), so
 * scanning the raw text would collect a code per mention.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead + ' ');
}

/**
 * The `BusErrorCode` union's members, in declaration order.
 *
 * Bounded by the declaration rather than by the file: `RETRYABLE_CODES` sits 70
 * lines below and is a set of the same strings, so a file-wide scan would report
 * every code as declared whether the union listed it or not - which is the one
 * result this must never produce.
 */
function declaredCodes(): string[] {
  const source = withoutComments(readFileSync(BUS, 'utf8'));
  const start = source.indexOf('export type BusErrorCode =');
  if (start === -1) throw new Error('BusErrorCode declaration not found in src/command-bus.ts');
  const end = source.indexOf(';', start);
  if (end === -1) throw new Error('BusErrorCode declaration has no terminator');
  return [...source.slice(start, end).matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]);
}

describe('error-code registry sweep', () => {
  const declared = declaredCodes();
  const registered = ERROR_CODE_REGISTRY.map((e) => e.code as string);

  /**
   * The control, and it is not decoration. A parse that collects nothing makes
   * every assertion below vacuously true, which is the failure mode the repo's
   * other sweeps were each written with once - `check-ascii` reported a clean
   * tree while 48 arrows sat in 15 files. The floor is deliberately loose: it
   * asserts the parse WORKED, not how many codes there happen to be, so adding
   * or removing one does not edit this file.
   */
  it('parses the union and reads the registry', () => {
    expect(declared.length, 'no codes parsed out of the BusErrorCode union').toBeGreaterThan(10);
    expect(registered.length, 'no rows read from ERROR_CODE_REGISTRY').toBeGreaterThan(10);
    // Every parsed code looks like one. A loose regex that swept up an unrelated
    // SCREAMING_CASE literal would inflate the count above and pass.
    for (const code of declared) expect(code, 'parsed a non-VC literal').toMatch(/^VC_/);
  });

  it('every declared BusErrorCode has a registry row', () => {
    const missing = declared.filter((code) => !registered.includes(code));
    expect(missing, 'declared in BusErrorCode with no ERROR_CODE_REGISTRY entry - getErrorEntry() returns undefined for these').toEqual([]);
  });

  it('every registry row is a declared BusErrorCode', () => {
    const extra = registered.filter((code) => !declared.includes(code));
    expect(extra, 'in ERROR_CODE_REGISTRY but not in the BusErrorCode union - a stale row, or a typo in one of the two').toEqual([]);
  });

  it('no code is registered twice', () => {
    const seen = new Set<string>();
    const duplicates = registered.filter((code) => !seen.add(code));
    expect(duplicates, 'duplicate ERROR_CODE_REGISTRY rows - getErrorEntry() returns whichever comes first').toEqual([]);
  });
});

/**
 * ARMING RUN, so this is not a check nobody has watched fail.
 *
 * Each direction was confirmed by hand before the file was committed:
 *
 *   - a code added to the union with no row      -> "every declared BusErrorCode
 *     has a registry row" fails and names it.
 *   - a row whose code is not in the union       -> "every registry row is a
 *     declared BusErrorCode" fails and names it.
 *   - the union's `export type BusErrorCode =`   -> `declaredCodes()` throws
 *     renamed                                      rather than returning [],
 *                                                  so a moved declaration cannot
 *                                                  read as a clean sweep.
 *
 * The third is the one worth keeping in mind on a refactor: this file finds the
 * union by its exact declaration text.
 */

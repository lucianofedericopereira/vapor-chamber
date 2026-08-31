/**
 * check-line-citations - reject source-line numbers in test titles.
 *
 * A title like `it('drops the oldest queued message on maxQueueSize overflow
 * (308-313)')` is a pointer to a line that moves the moment anything above it
 * shifts, and nothing checks it. Measured before this guard existed: 391 such
 * citations across tests and comments, and a spot check found `(308-313)`
 * pointing at unrelated code in a different function - while a neighbouring
 * one was still correct. That mix is worse than none, because you cannot tell
 * which to trust without verifying every one.
 *
 * The title already says what the test covers; the line number adds nothing
 * that survives a refactor.
 *
 * Genuine domain values are allowed via ALLOW below - HTTP status codes are the
 * real case (`(422)`, `(500)`), since those match the response the test builds.
 *
 * Run: node scripts/check-line-citations.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = new Set([
  'serves the retained entry on a transient failure (500)',
  'does NOT mask a business error (422)',
]);

/**
 * `it`/`describe`, in every shape the suite actually writes them.
 *
 * The first version matched only `it('...')` with SINGLE quotes and no method
 * chain, which left 73 of 2,524 titles unguarded (measured): 47 written with
 * double quotes or backticks, and 26 behind `it.each(rows)(...)`,
 * `it.skipIf(cond)(...)` or `it.todo(...)` - where the title sits after a
 * `)(`, so an anchor on `it(` never reaches it. None carried a citation at the
 * time, so this closes a latent hole rather than fixing a live miss; a guard
 * with a 3% blind spot still reports OK, which is the part worth removing.
 *
 * Groups: 1 = the quote character (back-referenced to close the string),
 * 2 = the title, 3 = the digits.
 */
const CITATION =
  /\b(?:it|describe)(?:\.\w+)?\s*\((?:[^()]*\)\s*\()?\s*(['"`])((?:(?!\1).)*\((\d{2,4}(?:\s*[-,]\s*\d{2,4})*)\))\1/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk('tests')) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CITATION)) {
      if (ALLOW.has(m[2])) continue;
      offenders.push(`${file}:${i + 1}  ${m[2]}`);
    }
  });
}

if (offenders.length) {
  console.error(
    `line-citations: ${offenders.length} test title(s) cite a source line number.\n` +
    'Line numbers go stale silently - describe the behaviour instead.\n' +
    'If the number is a genuine domain value (an HTTP status), add the title to ALLOW.\n',
  );
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('line-citations: OK (no source-line numbers in test titles)');

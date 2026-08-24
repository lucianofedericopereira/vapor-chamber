/**
 * check-line-citations — reject source-line numbers in test titles.
 *
 * A title like `it('drops the oldest queued message on maxQueueSize overflow
 * (308-313)')` is a pointer to a line that moves the moment anything above it
 * shifts, and nothing checks it. Measured before this guard existed: 391 such
 * citations across tests and comments, and a spot check found `(308-313)`
 * pointing at unrelated code in a different function — while a neighbouring
 * one was still correct. That mix is worse than none, because you cannot tell
 * which to trust without verifying every one.
 *
 * The title already says what the test covers; the line number adds nothing
 * that survives a refactor.
 *
 * Genuine domain values are allowed via ALLOW below — HTTP status codes are the
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

const CITATION = /\b(?:it|describe)\(\s*'([^']*\((\d{2,4}(?:\s*[-,]\s*\d{2,4})*)\))'/g;

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
      if (ALLOW.has(m[1])) continue;
      offenders.push(`${file}:${i + 1}  ${m[1]}`);
    }
  });
}

if (offenders.length) {
  console.error(
    `line-citations: ${offenders.length} test title(s) cite a source line number.\n` +
    'Line numbers go stale silently — describe the behaviour instead.\n' +
    'If the number is a genuine domain value (an HTTP status), add the title to ALLOW.\n',
  );
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('line-citations: OK (no source-line numbers in test titles)');

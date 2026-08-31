/**
 * check-ascii - reject typographic non-ASCII in project text.
 *
 * Owner's style rule (2026-08-28): no em dashes anywhere in the project, and
 * with them the rest of the typographic set (en dash, arrows, ellipsis, times
 * sign, curly quotes). Two reasons, in order:
 *
 * 1. Style: prose reads fine with commas, colons and parentheses; the
 *    typography adds nothing the words do not.
 * 2. Bytes, stated honestly: esbuild's default charset ("ascii") escapes each
 *    such character in a SHIPPED STRING to a 6-byte \uXXXX sequence. Measured
 *    across every dist entry by substituting and recompressing: 245 B raw /
 *    ~95 B compressed total. Comments cost nothing in bundles (minification
 *    strips them) but do ship in the npm tarball, since "files" includes src/
 *    (~6 KB uncompressed at the time this rule landed). Small, real, and not
 *    the primary reason - the rule is the primary reason.
 *
 * Replacements: em/en dash -> comma, colon, parenthetical, or " - ";
 * arrow -> "->"; ellipsis -> "..."; times -> "x"; curly quotes -> straight.
 *
 * dist/ is not scanned: it is generated, and a clean src regenerates it clean.
 * node_modules/ and coverage/ are not ours. Genuine exceptions (verbatim
 * upstream quotes that must stay byte-exact) go in ALLOW below with a reason.
 *
 * Run: node scripts/check-ascii.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'tests', 'scripts', 'docs', 'examples', '.github'];
const ROOT_FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SECURITY.md',
  'vitest.config.ts',
  'vitest.vapor.config.ts',
  'tsconfig.json',
  'tsconfig.typecheck.json',
  'typedoc.json',
  'biome.json',
  'package.json',
];
const EXTENSIONS = ['.ts', '.js', '.mjs', '.md', '.json', '.vue', '.yml', '.yaml', '.html'];
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist']);

/** file-path substring -> reason. Empty on purpose; earn every entry. */
const ALLOW = new Map();

// Written as \u escapes, not literal characters, so this file (which defines
// the forbidden set) stays ASCII itself.
//
// The second group is INVISIBLE characters, added after a zero-width space was
// found doing real work in three files: it was being used to escape a
// block-comment terminator inside a docblock (`@__PURE__` annotations in
// build.mjs, the vite-ignore note in vite-hmr.ts, and - while writing the guard
// that found them - check-doc-claims.mjs itself). The trick works, and that is
// the problem: the character is undetectable by eye, survives copy-paste into
// a consumer's code, and this set previously had no opinion about it while
// banning an em dash. Rephrasing so the terminator is never written costs
// nothing and leaves the source honest. NBSP and the BOM ride along for the
// same reason - all three break things while looking like nothing.
//
// The zero-width JOINERS (U+200C/U+200D) are deliberately NOT in the set.
// Biome's noMisleadingCharacterClass rejects them in a character class - a
// joiner is half of a grapheme, so matching one alone is not a well-defined
// thing to do - and unlike the others they carry real meaning in scripts that
// need them. The rule caught that in the first draft of this addition, which
// is the lint doing exactly its job.
//
// The ARROW family is the third group, and it went in after this guard reported
// a completed sweep while 48 arrows sat in 15 files, three of them in shipped
// `src`. The set held the RIGHTWARDS arrow alone, so a rule stated as "no
// arrows" was enforced as "no rightwards arrow" and every other direction
// walked through: 29 leftwards, 9 left-right, 6 double-rightwards, plus up,
// down and the hooked pair. Same shape as check-line-citations being blind to
// 73 of 2524 test titles - a guard is worth exactly its alphabet, and a narrow
// one reads as a clean sweep. Each replacement is an ASCII digraph saying the
// same thing (`<-`, `->`, `<->`, `=>`), which is why the omission stayed
// invisible: nothing was lost by not having them.
const OFFENDERS =
  /[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00d7\u200b\u2060\ufeff\u00a0\u2190\u2191\u2192\u2193\u2194\u21a9\u21aa\u21d2]/;
const NAME = {
  '\u2013': 'en-dash',
  '\u2014': 'em-dash',
  '\u2018': 'curly-quote',
  '\u2019': 'curly-quote',
  '\u201c': 'curly-quote',
  '\u201d': 'curly-quote',
  '\u2026': 'ellipsis',
  '\u00d7': 'times-sign',
  '\u200b': 'zero-width-space',
  '\u2060': 'word-joiner',
  '\ufeff': 'byte-order-mark',
  '\u00a0': 'non-breaking-space',
  '\u2190': 'arrow (use <-)',
  '\u2191': 'arrow (use ^)',
  '\u2192': 'arrow (use ->)',
  '\u2193': 'arrow (use v)',
  '\u2194': 'arrow (use <->)',
  '\u21a9': 'arrow (use <-)',
  '\u21aa': 'arrow (use ->)',
  '\u21d2': 'arrow (use =>)',
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = [
  ...ROOTS.flatMap((root) => walk(root)),
  ...ROOT_FILES.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  }),
];

const hits = [];
for (const file of files) {
  if ([...ALLOW.keys()].some((substring) => file.includes(substring))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = line.match(OFFENDERS);
    if (match) {
      const count = [...line].filter((ch) => OFFENDERS.test(ch)).length;
      hits.push(`${file}:${index + 1}  ${NAME[match[0]]}${count > 1 ? ` (+${count - 1} more on this line)` : ''}`);
    }
  });
}

if (hits.length) {
  console.error(
    `ascii: ${hits.length} line(s) carry typographic non-ASCII.\n` +
      'House rule: plain ASCII in prose and strings. Replacements: dash -> comma/colon/" - ", ' +
      'arrow -> "->", ellipsis -> "...", times -> "x", curly quotes -> straight.\n' +
      'A verbatim upstream quote that must stay byte-exact goes in ALLOW with a reason.\n',
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`ascii: OK (${files.length} files, no typographic non-ASCII)`);

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
import { join, sep } from 'node:path';

const ROOTS = ['src', 'tests', 'scripts', 'docs', 'examples', '.github', 'assets'];
const ROOT_FILES = [
  'index.html',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SECURITY.md',
  'vitest.config.ts',
  'vitest.vapor.config.ts',
  'tsconfig.json',
  'tsconfig.typecheck.json',
  'biome.json',
  'package.json',
];
const EXTENSIONS = ['.ts', '.js', '.mjs', '.md', '.json', '.vue', '.yml', '.yaml', '.html', '.css'];
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist']);

/**
 * file-path substring -> reason. Earn every entry.
 *
 * The first one took a while to earn. Four console glyphs were deliberate but
 * uncontrolled: this guard's alphabet did not include them, so it reported a
 * clean sweep while they sat in SHIPPED strings in three modules - one of them
 * `logger()`, which is in all three IIFE variants. Same shape as the arrow
 * family below, which went in after a "completed" sweep left 48 arrows in 15
 * files.
 *
 * Collecting them in one module inverts that: NON_ASCII below fails EVERY other
 * file under `src/`, whatever the character, so the exception is one reviewable
 * path rather than a rule nobody enforced.
 */
const ALLOW = new Map([
  ['src/glyphs.ts', 'the project\'s only non-ASCII characters, by design - see that file'],
]);

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

/**
 * `src/` IS HELD TO PLAIN ASCII, not to a list.
 *
 * Everywhere else this guard bans an alphabet, and an alphabet is a list of the
 * characters somebody thought of. That list has now been wrong three times: the
 * arrows (48 of them, in 15 files, after a "completed" sweep), the console
 * glyphs (four, in shipped strings), and then a census that found 9,300 more
 * characters it had no opinion about at all - box drawing, bullets, section
 * signs, math symbols, emoji.
 *
 * The third time is enough. Inside `src/` the rule inverts: everything above
 * U+007F fails, and `src/glyphs.ts` is the one file allowed to hold a character
 * - every other module imports the const from it rather than typing the glyph.
 * There is nothing left to enumerate and nothing left to forget.
 *
 * The wider tree keeps the alphabet. Box-drawing rules in test files and status
 * markers in a README are not a cost - `src` is what ships in dist, and it is
 * the only place a stray character can reach a consumer's bundle.
 */
// Written as the complement range rather than `[^\x00-\x7f]` because a negated
// class of control characters is exactly what noControlCharactersInRegex
// rejects, and it is right to: the interesting set is "above ASCII", not "not
// a control character". Surrogate pairs are inside this range, so astral
// characters (emoji) match on their lead unit.
const NON_ASCII = /[\u0080-\uffff]/;
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
  '\u2713': 'glyph (import from src/glyphs.ts)',
  '\u2717': 'glyph (import from src/glyphs.ts)',
  '\u26a0': 'glyph (import from src/glyphs.ts)',
  '\u26a1': 'glyph (import from src/glyphs.ts)',
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
  // src/ is held to plain ASCII; everywhere else, to the alphabet.
  const inSrc = file.startsWith(`src${sep}`) || file.startsWith('src/');
  const banned = inSrc ? NON_ASCII : OFFENDERS;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = line.match(banned);
    if (match) {
      const count = [...line].filter((ch) => banned.test(ch)).length;
      // src/ bans everything above U+007F, so the offender is often a character
      // NAME has never heard of. Fall back to the codepoint: "U+2022" is a
      // usable thing to search for, and `undefined` is not.
      const what = NAME[match[0]] ?? `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      hits.push(`${file}:${index + 1}  ${what}${count > 1 ? ` (+${count - 1} more on this line)` : ''}`);
    }
  });
}

if (hits.length) {
  console.error(
    `ascii: ${hits.length} line(s) carry typographic non-ASCII.\n` +
      'House rule: plain ASCII in prose and strings. Replacements: dash -> comma/colon/" - ", ' +
      'arrow -> "->", ellipsis -> "...", times -> "x", curly quotes -> straight.\n' +
      'Under src/ the rule is stricter and simpler: NOTHING above U+007F. A glyph ' +
      'that is genuinely dev-facing output belongs in src/glyphs.ts, imported as a ' +
      'const - see that file.\n' +
      'A verbatim upstream quote that must stay byte-exact goes in ALLOW with a reason.\n',
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`ascii: OK (${files.length} files, no typographic non-ASCII)`);

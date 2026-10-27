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
 * Scope: the ROOTS directories plus the text files in the repository root, by
 * the EXTENSIONS list. Under src/ every character above U+007F fails (only
 * src/glyphs.ts is exempt); elsewhere the OFFENDERS alphabet fails. SKIP_DIRS
 * (node_modules, coverage, dist, .astro, __ref) are generated or not ours and
 * are not scanned. A file whose extension is not in EXTENSIONS is not read.
 * Genuine exceptions (verbatim upstream quotes that must stay byte-exact) go
 * in ALLOW below with a reason.
 *
 * Run: node scripts/check-ascii.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checked against git's top-level directories by tests/ascii-guard.test.ts:
// contract/ and php/ landed without joining this list, and nothing noticed.
export const ROOTS = ['src', 'tests', 'scripts', 'bin', 'docs', 'examples', '.github', 'assets', 'contract', 'php'];
/**
 * Root-level files, DERIVED from the directory rather than listed.
 *
 * The root is read one level deep and the only list is what to LEAVE OUT, so a
 * new root file is scanned by default and an exemption has to be written down
 * with a reason. Inclusion is decided by CONTENT, not by extension: anything
 * that decodes as text is read, so `.DS_Store` is skipped for what it is.
 */
export const ROOT_EXEMPT = new Map([
  ['package-lock.json', 'npm writes it; a dependency name is not ours to re-spell'],
  ['LICENSE', 'the LGPL v2.1 text, verbatim and byte-exact'],
]);

const REPLACEMENT = String.fromCodePoint(0xfffd);

/** Decodes as UTF-8 with no NUL and no replacement character. */
function isTextFile(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return false;
  }
  if (buf.includes(0)) return false;
  return !buf.toString('utf8').includes(REPLACEMENT);
}

/** Every text file in the repository root that is not exempt. */
export function rootFiles() {
  let entries;
  try {
    entries = readdirSync('.');
  } catch {
    return [];
  }
  return entries.filter((name) => {
    if (ROOT_EXEMPT.has(name)) return false;
    try {
      if (!statSync(name).isFile()) return false;
    } catch {
      return false;
    }
    return isTextFile(name);
  });
}
// The FILE alphabet. A list of extensions is as short as its author's memory:
// `.astro`, `.sh` and `.tsx` were once missing, and 28 lines across three files
// carried em dashes, an ellipsis and a times sign while this script printed
// "ascii: OK (425 files, ...)". A guard that reports a clean sweep over a
// violation is worse than no guard.
//
// The list is TESTED rather than trusted: tests/ascii-guard.test.ts walks the
// same roots, decodes every file, and fails if a text extension exists that
// this array does not name.
export const EXTENSIONS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.vue', '.yml', '.yaml',
  '.html', '.css', '.php', '.astro', '.sh', '.svg', '.webmanifest',
];
/**
 * Generated and vendor trees. Nothing here is written by hand, so there is no
 * character in it for anyone to have chosen.
 *
 * `.astro` is Astro's generated cache under examples/exo-astro, gitignored and
 * rebuilt by `astro build`; scanning it made the file count in the OK line
 * depend on whether the example had been built.
 *
 * `__ref` is the one that had to be earned. Each `tests/*-ab.test.ts` writes
 * `tests/__ref/<name>/` while it runs and removes it afterwards (.gitignore says
 * so), and a vitest run has several of them going at once - so a walk of
 * `tests/` races the writer. `tests/ascii-guard.test.ts` collects paths into one
 * list and reads them later, which turned a race into an ENOENT on
 * `__ref/before-cancel/before-cancel-pre.ts` in a full suite run, while the same
 * file passed 15/15 on its own. Skipping the tree fixes both readers at once,
 * and it keeps the rule total: a directory name, not a file allowlist that would
 * need upkeep on every new A/B test.
 *
 * Deliberately NOT fixed by catching ENOENT in the reader. That would make the
 * guard able to skip a real file silently, which is the one failure mode a guard
 * must not have.
 */
export const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', '.astro', '__ref']);

/**
 * file-path substring -> reason. Earn every entry.
 *
 * The one entry exists because four console glyphs were deliberate but outside
 * this guard's alphabet, and sat in SHIPPED strings in three modules (one of
 * them `logger()`, in all three IIFE variants). Collecting them in one module
 * lets NON_ASCII below fail EVERY other file under `src/`, whatever the
 * character, so the exception is one reviewable path.
 */
const ALLOW = new Map([
  ['src/glyphs.ts', 'the project\'s only non-ASCII characters, by design - see that file'],
]);

// Written as \u escapes, not literal characters, so this file (which defines
// the forbidden set) stays ASCII itself.
//
// The second group is INVISIBLE characters: a zero-width space can escape a
// block-comment terminator inside a docblock, is undetectable by eye and
// survives copy-paste into a consumer's code. NBSP and the BOM ride along for
// the same reason.
//
// The zero-width JOINERS (U+200C/U+200D) are deliberately NOT in the set.
// Biome's noMisleadingCharacterClass rejects them in a character class (a
// joiner is half of a grapheme), and unlike the others they carry real meaning
// in scripts that need them.
//
// The ARROW family is the third group. The set once held the RIGHTWARDS arrow
// alone, so "no arrows" was enforced as "no rightwards arrow" and 48 arrows in
// 15 files (three in shipped `src`) walked through. A guard is worth exactly its
// alphabet. Each replacement is an ASCII digraph (`<-`, `->`, `<->`, `=>`).
const OFFENDERS =
  /[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00d7\u200b\u2060\ufeff\u00a0\u2190\u2191\u2192\u2193\u2194\u21a9\u21aa\u21d2]/;

/**
 * `src/` IS HELD TO PLAIN ASCII, not to a list.
 *
 * Everywhere else this guard bans an alphabet, which is a list of the
 * characters somebody thought of; a census once found 9,300 characters it had
 * no opinion about (box drawing, bullets, section signs, math symbols, emoji).
 * Inside `src/` the rule inverts: everything above U+007F fails, and
 * `src/glyphs.ts` is the one file allowed to hold a character; every other
 * module imports the const from it.
 *
 * The wider tree keeps the alphabet. Box-drawing rules in test files and status
 * markers in a README are not a cost: `src` is what ships in dist, and the only
 * place a stray character can reach a consumer's bundle.
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

export function walk(dir, out = []) {
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

/**
 * Every file this guard is responsible for. Exported so the test can ask the
 * TREE what exists and compare it against EXTENSIONS, rather than asking the
 * list to confirm itself.
 */
export function collectFiles() {
  return [
    ...ROOTS.flatMap((root) => walk(root)),
    ...rootFiles(),
  ];
}

/** The banned set for a given path: plain ASCII under src/, the alphabet elsewhere. */
export function bannedFor(file) {
  const inSrc = file.startsWith(`src${sep}`) || file.startsWith('src/');
  return inSrc ? NON_ASCII : OFFENDERS;
}

/**
 * Scan `files` and return one line per offending source line. Exported so the
 * test can feed it a file of its own and confirm the guard actually FIRES -
 * an alphabet that matches nothing reports a clean sweep, which is the failure
 * mode this whole file is a record of.
 */
export function scan(files) {
  const hits = [];
  for (const file of files) {
    if ([...ALLOW.keys()].some((substring) => file.includes(substring))) continue;
    // src/ is held to plain ASCII; everywhere else, to the alphabet.
    const banned = bannedFor(file);
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
  return hits;
}

// Run only as a CLI. Importing this module must not scan the tree and must not
// call process.exit() - tests/ascii-guard.test.ts imports EXTENSIONS and scan().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = collectFiles();
  const hits = scan(files);

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
}

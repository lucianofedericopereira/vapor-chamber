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
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOTS = ['src', 'tests', 'scripts', 'bin', 'docs', 'examples', '.github', 'assets'];
/**
 * Root-level files, DERIVED from the directory rather than listed.
 *
 * This was a hand-typed list of twelve names, and it was the FIFTH time a list
 * in this file came up short. `.gitignore` carried two em dashes and
 * `ascii: OK` was printed over them for as long as the list existed - a dotfile
 * has no extension, so it was on nobody's list and the test below could not see
 * it either. `tsconfig.tests.json` and `vitest.probes.config.ts` arrived in
 * v1.22.0 and were never opened for the same reason. Same failure as `.astro`,
 * `.sh` and `.tsx` below: the list has to be re-typed by whoever adds the next
 * file, and nothing says so.
 *
 * The root is read now, one level deep, and the only list left is what to LEAVE
 * OUT. That inverts the risk: a new root file is scanned by default, and an
 * exemption has to be written down with a reason, which is visible in a way a
 * missing name never is. Inclusion is decided by CONTENT, not by an alphabet -
 * anything that decodes as text is read, so `.DS_Store` is skipped for what it
 * is rather than for what it is called.
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
// THE FOURTH TIME THIS LIST WAS WRONG, and the first three are recorded below
// against the CHARACTER alphabet: the arrows, the console glyphs, the census
// that found 9,300 more. This one is the FILE alphabet, which nothing had ever
// questioned, and it failed the same way. `.astro`, `.sh` and `.tsx` were not
// here, so 28 lines across three files carried em dashes, an ellipsis and a
// times sign while this script printed "ascii: OK (425 files, no typographic
// non-ASCII)". A guard that reports a clean sweep over a violation is worse
// than no guard, because it is the reason nobody looks.
//
// `.svg` and `.webmanifest` join them clean, not dirty. Both are text, both sit
// under `assets/`, and neither had any reason to be exempt except that nobody
// had listed them - which is exactly the property that made the other three
// dangerous.
//
// The list is now TESTED rather than trusted: tests/ascii-guard.test.ts walks
// the same roots, decodes every file, and fails if a text extension exists that
// this array does not name. An alphabet cannot audit itself, so something that
// reads the tree instead has to.
export const EXTENSIONS = [
  '.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.vue', '.yml', '.yaml',
  '.html', '.css', '.php', '.astro', '.sh', '.svg', '.webmanifest',
];
// `.astro` is Astro's generated cache under examples/exo-astro, gitignored and
// rebuilt by `astro build`. It belongs here for the reason the header gives for
// `dist/`: it is generated, and a clean source regenerates it clean. It was
// NOT here until tests/ascii-guard.test.ts walked the tree and tripped over a
// `preview.log` inside it - and the guard had in fact been scanning three of
// its files (`content.d.ts`, `preview.json`, `types.d.ts`) all along, which
// made the "N files" in the OK line depend on whether anyone had run the
// example's build. Both of this guard's lists turned out to be short; this is
// the second one.
/**
 * Generated and vendor trees. Nothing here is written by hand, so there is no
 * character in it for anyone to have chosen.
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

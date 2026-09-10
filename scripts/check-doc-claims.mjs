/**
 * check-doc-claims - three mechanical checks on what the source SAYS.
 *
 * This repo tests its behaviour exhaustively and does not test its sentences.
 * A review pass over ~5,000 lines found fourteen defects and every one of them
 * was in prose - stale stamps, inverted defaults, comments attached to nothing.
 * None could fail a test, because none of them run.
 *
 * The case for automating it is not that reading is unreliable in general; it
 * is one specific measurement. Check 1 below was found by reading `schema.ts`,
 * then swept for - and the sweep returned two more, one of which sat in
 * `command-bus.ts` in a passage that had been read attentively enough that same
 * hour to quote its neighbours. Two stacked comments read as one comment. A
 * regex found in a second what an attentive read had just walked past.
 *
 * Scope, stated so it is not over-trusted: these three catch three shapes.
 * They say nothing about whether a sentence is TRUE - only that it is attached
 * to something, that a documented literal exists in the file, and that release
 * status is not being tracked in a comment. Everything else still needs eyes.
 *
 * Run: node scripts/check-doc-claims.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'tests', 'scripts'];
const EXTENSIONS = ['.ts', '.mjs'];

/**
 * CHECK 2 exemptions: `path -> reason`. Earn every entry - a default documented
 * in one file and implemented in another is a real indirection, and naming it
 * here is the point rather than the cost.
 */
const DEFAULT_ALLOW = new Map([
  [
    'src/transports.ts',
    "csrfCookieUrl's default lives in http.ts (DEFAULT_CSRF_COOKIE_URL) - the bridge " +
      'passes the option through undefined and postCommand applies it',
  ],
]);

/**
 * CHECK 3: words that track where a thing is in its release cycle. They belong
 * in CHANGELOG.md, which is regenerated per release and reviewed at the cut - a
 * comment carrying them goes stale the moment the release ships and nothing
 * looks at it again. `src/transports.ts` banner-ed a shipped API with a
 * parenthesised unreleased marker beside its version for eight minor versions.
 * A bare version number is fine and is what these banners should carry.
 *
 * The marker is described rather than quoted, deliberately: the first draft of
 * this comment used the literal form and the check flagged its own docblock.
 * `check-ascii.mjs` writes its forbidden characters as \u escapes for the same
 * reason, and `check-env-guards.mjs` records the lesson in one line - a guard
 * that fires on its own explanation is not a guard.
 */
const STATUS_WORDS = /\((?:unreleased|not yet released|upcoming|pending release)\)|\bnot yet shipped\b|\bcoming in v\d/i;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root));
const problems = [];

/**
 * CHECK 1 - a docblock attached to nothing.
 *
 * A block-comment terminator on one line and `/**` on the next, with no
 * declaration between: an
 * editor attaches only the LOWER block to whatever follows, so the upper one
 * documents nothing and the declaration it was written for shows no tooltip at
 * all. Found three times in this repo, each hiding the docblock of a PUBLIC
 * export behind the one below it.
 */
function checkStackedDocblocks(file, lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === '*/' && lines[i + 1].trim().startsWith('/**')) {
      problems.push(
        `${file}:${i + 1}  docblock attached to nothing - the block above this one ` +
          'documents no declaration (move it to the thing it describes)',
      );
    }
  }
}

/**
 * CHECK 2 - a documented default whose value is nowhere in the file.
 *
 * `Default: 0` on a type shared by two callers, where one of them uses 2, is
 * not catchable by any test: both values are correct somewhere. What IS
 * mechanically checkable is that the literal appears in the file at all - if it
 * does not, either the default moved or it was always describing another
 * module's behaviour. Both happened here (`retry`, `timeout` on `HttpConfig`).
 *
 * Literals only. `Default: no TTL` and `Default: all actions` are prose, and
 * prose is out of scope for a regex.
 */
const DEFAULT_CLAIM = /Default:\s*`?((?:-?\d[\d_]*(?:\.\d+)?)|'[^']*'|"[^"]*"|true|false|null)`?/g;

/**
 * A STANDALONE TOKEN, not a substring. `rest.includes('5')` is true of almost
 * any file - a version, an offset, an identifier ending in 5 - so for small
 * numeric literals the check was close to vacuous: `Default: 3` passed while
 * the real default was 7. Measured across all 68 `Default:` claims in the
 * repo, the two tests agree on every one, so this closes a latent hole rather
 * than fixing a live miss. That is the same trade this file's own CHECK 1
 * docblock describes, and the reason check-line-citations widened its anchor.
 */
function appearsAsToken(haystack, literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w])`).test(haystack);
}

function checkDocumentedDefaults(file, source) {
  if (DEFAULT_ALLOW.has(file)) return;
  for (const match of source.matchAll(DEFAULT_CLAIM)) {
    const literal = match[1];
    const rest = source.slice(0, match.index) + source.slice(match.index + match[0].length);
    if (!appearsAsToken(rest, literal)) {
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(
        `${file}:${line}  documents "Default: ${literal}" but ${literal} appears ` +
          'nowhere else in the file (moved, or it describes another module)',
      );
    }
  }
}

/** CHECK 3 - release status in a comment. See STATUS_WORDS. */
function checkReleaseStatus(file, lines) {
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    if (isComment && STATUS_WORDS.test(line)) {
      problems.push(
        `${file}:${i + 1}  release status in a comment - that belongs in CHANGELOG.md; ` +
          'a bare version number is enough here',
      );
    }
  });
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  checkStackedDocblocks(file, lines);
  checkDocumentedDefaults(file, source);
  checkReleaseStatus(file, lines);
}

if (problems.length) {
  console.error(`doc-claims: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nThese three shapes are mechanical, so they are checked rather than reviewed.\n' +
      'A genuine cross-file default goes in DEFAULT_ALLOW with the reason.\n',
  );
  process.exit(1);
}
console.log(
  `doc-claims: OK (${files.length} files - no orphaned docblocks, ` +
    `no absent documented defaults, no release status in comments)`,
);

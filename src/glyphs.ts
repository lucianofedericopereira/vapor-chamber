/**
 * vapor-chamber - every non-ASCII character the project prints, in one place.
 *
 * The house rule is ASCII everywhere (see scripts/check-ascii.mjs). These four
 * glyphs are the only characters that survive it, and they survive on one
 * condition: they are DEV-FACING OUTPUT. A symbol is scanned faster than a word
 * in a busy console. Nothing else earns them - not prose, not comments, not doc
 * tables, not UI labels. Those were swept, and the swept count was 9,300
 * characters across 85 files.
 *
 * Every other file imports the const instead of typing the character, so the
 * guard can ban the literal everywhere but here. Before this file existed the
 * guard's alphabet simply did not include these, so it reported a clean sweep
 * while four glyphs sat in shipped strings - the same way it once passed while
 * 48 arrows sat in 15 files.
 *
 * THE SCRIPTS CANNOT IMPORT THIS: they are .mjs, they run before any build
 * exists, and type stripping is not guaranteed at this package's engines
 * floor. They type the character itself instead, which the guard allows -
 * plain ASCII is enforced under `src/` only, and everywhere else it bans an
 * alphabet these four are not in. The reason for the stricter rule does not
 * reach `scripts/` either: nothing there is bundled into a consumer's app,
 * which is the only place a stray character costs bytes.
 *
 * These are CONSTANTS, not a formatting layer. Adding a helper that wrapped
 * them would put an indirection on `logger()`'s per-dispatch path for no gain;
 * a bare const reference minifies to the same thing as the literal it replaced.
 */

/** High voltage. Prefixes a dispatched command in `logger()` and `schemaLogger()`. */
export const GLYPH_COMMAND = '⚡';

/** Warning sign. Marks a validation failure in `schemaLogger()`. */
export const GLYPH_WARN = '⚠';

/** Check mark. Marks a passing field in `schemaLogger()`, and a successful command in devtools. */
export const GLYPH_OK = '✓';

/** Ballot X. Marks a failed command in the devtools timeline. */
export const GLYPH_FAIL = '✗';

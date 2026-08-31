/**
 * What does `vue`'s BUNDLER entry actually export, and does the exports map
 * carry a vapor condition?
 *
 * WHY THIS IS A FIXTURE AND NOT A PARAGRAPH. ROADMAP.md's "Thin Vapor wrappers"
 * section turns on this question - it is the stated **reopen condition** for the
 * withdrawn `vue36` build flavor - and the section instructs each cycle to
 * settle it "by enumerating the module's real exports, not by grepping for the
 * name: a substring hit in that file is not an export."
 *
 * It was then answered, for two cycles, by hand-quoting the entry's named-export
 * line into the roadmap. That quote omitted the `export * from
 * "@vue/runtime-vapor"` line sitting directly above it, so the roadmap recorded
 * "1 of 4 wrapped APIs statically importable" while the true answer was 4 of 4
 * - the same error the instruction warns about with the sign flipped, because a
 * star re-export has no name to grep for and no name to quote.
 *
 * So the enumeration lives here now. It reads the real module through the same
 * bundler resolution a consumer's build uses, and prints the list it asserts on,
 * so the next cycle reads a number instead of re-deriving one.
 *
 * WHAT IT DOES NOT DO. It does not assert a specific count. Vue may add or
 * rename Vapor exports in any RC, and a test that fails on that would be noise.
 * It pins the two things the roadmap's decision actually rests on:
 *
 *   1. Whether the four APIs this library wraps (plus `vaporInteropPlugin`) are
 *      statically importable from bare `vue`. If this flips back to false, the
 *      reopen condition un-meets itself and the roadmap needs to say so.
 *   2. Whether the exports map has grown a vapor condition or subpath - the
 *      other half of the reopen condition, and still absent.
 *
 * Note that neither answer revives the flavor on its own: the two facts that
 * killed it (the `__vapor` marker is set by the real `defineVaporComponent`, and
 * the entire probe+registry region measures <0.9 KB brotli) are independent of
 * this one and unchanged. See ROADMAP.md §"What is transitional".
 */

import { describe, expect, it } from 'vitest';
import pkg from 'vue/package.json' with { type: 'json' };

/** The four wrappers in `chamber-vapor.ts` / `chamber.ts`, plus the interop plugin. */
const WRAPPED = [
  'createVaporApp',
  'defineVaporComponent',
  'defineVaporCustomElement',
  'defineVaporAsyncComponent',
  'vaporInteropPlugin',
] as const;

describe("vue's bundler entry - Vapor surface", () => {
  it('statically exports every Vapor API this library wraps', async () => {
    // The bundler entry specifically: `vue.runtime.esm-bundler.js` is what a
    // consumer's bundler resolves bare `vue` to. The `esm-browser` dists are a
    // separate question and were never in doubt.
    const mod = (await import(/* @vite-ignore */ 'vue/dist/vue.runtime.esm-bundler.js')) as Record<string, unknown>;
    const names = Object.keys(mod);
    const vapor = names.filter((n) => /[Vv]apor/.test(n)).sort();

    console.log(
      `\n  vue@${pkg.version} bundler entry - ${vapor.length} Vapor exports:\n    ` +
        vapor.join(', ') +
        '\n',
    );

    // Guard the enumeration itself: a resolution failure must fail loudly rather
    // than vacuously reporting "no Vapor exports found".
    expect(names.length).toBeGreaterThan(100);

    const missing = WRAPPED.filter((n) => !names.includes(n));
    // If this fails, the roadmap's reopen condition has un-met itself - record
    // the new count in ROADMAP.md §"What is transitional" fact 2.
    expect(missing).toEqual([]);
  });

  it('exports map still has no vapor condition or subpath', () => {
    const subpaths = Object.keys(pkg.exports as Record<string, unknown>);
    console.log(`  vue@${pkg.version} exports map subpaths: ${subpaths.join(', ')}\n`);

    // The other half of the reopen condition. A `./vapor` subpath - or a
    // `"vapor"` condition inside `.` - would be Vue explicitly blessing a
    // static Vapor import path, which is a stronger signal than the star
    // re-export above.
    expect(subpaths.some((s) => /vapor/i.test(s))).toBe(false);

    const dot = (pkg.exports as Record<string, unknown>)['.'];
    expect(JSON.stringify(dot).toLowerCase()).not.toContain('vapor');
  });
});

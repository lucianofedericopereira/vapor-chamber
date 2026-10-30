/**
 * What `vue`'s bundler entry exports for Vapor, and whether its exports map carries a vapor condition or subpath.
 * Why: a star re-export has no name to grep for, so a hand-quoted export list would misreport which wrapped APIs a consumer's build can import statically; the roadmap's reopen condition rests on this answer.
 * Shows: the bundler entry, resolved as a consumer's build resolves it, exports every API this library wraps (no fixed count is asserted); the exports map has no vapor subpath or condition.
 * See: ROADMAP.md ("What is transitional")
 */

import { describe, expect, it } from 'vitest';
import pkg from 'vue/package.json' with { type: 'json' };
import { bundlerEntryExports } from './bundler-entry';

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
    // vue.runtime.esm-bundler.js is what a consumer's bundler resolves bare `vue` to.
    const names = await bundlerEntryExports();
    const vapor = names.filter((n) => /[Vv]apor/.test(n)).sort();

    console.log(
      `\n  vue@${pkg.version} bundler entry - ${vapor.length} Vapor exports:\n    ` +
        vapor.join(', ') +
        '\n',
    );

    // A resolution failure must fail loudly rather than report "no Vapor exports found".
    expect(names.length).toBeGreaterThan(100);

    const missing = WRAPPED.filter((n) => !names.includes(n));
    expect(missing).toEqual([]);
  });

  it('exports map still has no vapor condition or subpath', () => {
    const subpaths = Object.keys(pkg.exports as Record<string, unknown>);
    console.log(`  vue@${pkg.version} exports map subpaths: ${subpaths.join(', ')}\n`);

    // A `./vapor` subpath or a "vapor" condition inside `.` would be Vue blessing a static Vapor import path.
    expect(subpaths.some((s) => /vapor/i.test(s))).toBe(false);

    const dot = (pkg.exports as Record<string, unknown>)['.'];
    expect(JSON.stringify(dot).toLowerCase()).not.toContain('vapor');
  });
});

/**
 * Every entry must share ONE chamber instance.
 *
 * `chamber.ts` keeps the Vue registry in module-level state: `configureVue()`
 * writes it, `isVaporAvailable()` / `getVaporAppFn()` read it. Two copies of
 * that module means writes land in one and reads come from the other, and the
 * symptom is the worst kind — `createVaporChamberApp()` throwing
 * "No Vue detected" on a page that just called `configureVue()` successfully.
 *
 * This happened. `src/vue.ts` was briefly built in its own Vite pass (to keep
 * an optional peer out of the main build's `external` list). A separate pass
 * cannot share the main pass's chunks, so it inlined a private copy of
 * chamber — `dist/vue.js` was 41 KB instead of 1 KB — and any app importing
 * from both the root and the subpath got two registries.
 *
 * Unit tests cannot catch this: vitest resolves `src/`, where there is only
 * ever one module. It is a property of the BUILT package, so it is asserted
 * against dist.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');
const haveDist = existsSync(join(distDir, 'index.js'));

/** ESM entries that can reach the Vue registry. */
const ENTRIES = ['index.js', 'vue.js', 'reactive.js', 'router/index.js'];

/** A string that exists exactly once per copy of chamber.ts. */
const CHAMBER_FINGERPRINT = 'Vue lacks the Vapor build';

function distFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return distFiles(full);
    return e.isFile() && full.endsWith('.js') && !full.includes('.iife.') ? [full] : [];
  });
}

describe.skipIf(!haveDist)('dist — one chamber instance across all entries', () => {
  it('chamber.ts is emitted exactly once in the ESM output', () => {
    const holders = distFiles(distDir)
      .filter((f) => readFileSync(f, 'utf8').includes(CHAMBER_FINGERPRINT))
      .map((f) => f.slice(process.cwd().length + 1));

    expect(
      holders,
      `chamber.ts must live in exactly one chunk — found ${holders.length}. ` +
      'More than one means entries get separate Vue registries: configureVue() ' +
      'writes to one, isVaporAvailable() reads the other.',
    ).toHaveLength(1);
  });

  it.each(ENTRIES.filter((e) => existsSync(join(distDir, e))))(
    '%s reaches chamber by import, never by inlining it',
    (entry) => {
      const file = join(distDir, entry);
      const code = readFileSync(file, 'utf8');

      // The entry either IS the chunk holding chamber, or imports it. What it
      // must never do is carry its own copy.
      const holdsChamber = code.includes(CHAMBER_FINGERPRINT);
      const chamberChunk = distFiles(distDir).find((f) =>
        readFileSync(f, 'utf8').includes(CHAMBER_FINGERPRINT),
      );
      const isTheChunk = chamberChunk === file;

      expect(
        holdsChamber && !isTheChunk,
        `${entry} inlined its own copy of chamber.ts instead of importing the shared chunk`,
      ).toBe(false);
    },
  );

  it('the vue subpath is a thin re-export, not a second bundle', () => {
    const vue = join(distDir, 'vue.js');
    if (!existsSync(vue)) return;
    const bytes = readFileSync(vue).length;

    // It wires two things and re-exports; ~1 KB. The regression made it 41 KB.
    expect(
      bytes,
      `dist/vue.js is ${bytes} B — an order of magnitude over a re-export shim, ` +
      'which is what inlining chamber.ts looks like.',
    ).toBeLessThan(8_000);
  });
});

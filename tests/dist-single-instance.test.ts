/**
 * Every built entry shares one chamber instance.
 * Why: chamber.ts keeps the Vue registry in module state; with two copies configureVue() writes one and createVaporChamberApp() reads the other and throws. Only dist can show this, as src has one module.
 * Shows: chamber.ts is emitted in exactly one chunk; each entry imports it instead of inlining it; the vue subpath stays a thin re-export.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireDist } from './require-dist';

const distDir = join(process.cwd(), 'dist');
requireDist(existsSync(join(distDir, 'index.js')));

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

describe('dist - one chamber instance across all entries', () => {
  it('chamber.ts is emitted exactly once in the ESM output', () => {
    const holders = distFiles(distDir)
      .filter((f) => readFileSync(f, 'utf8').includes(CHAMBER_FINGERPRINT))
      .map((f) => f.slice(process.cwd().length + 1));

    expect(
      holders,
      `chamber.ts must live in exactly one chunk - found ${holders.length}. ` +
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

    // It wires two things and re-exports, about 1 KB; an inlined chamber is far larger.
    expect(
      bytes,
      `dist/vue.js is ${bytes} B - an order of magnitude over a re-export shim, ` +
      'which is what inlining chamber.ts looks like.',
    ).toBeLessThan(8_000);
  });
});

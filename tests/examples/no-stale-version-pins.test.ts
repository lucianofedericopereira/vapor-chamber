/**
 * No hardcoded vapor-chamber version in the examples or docs.
 *
 * WHY. The CDN snippets carried `vapor-chamber@1.9` (five places) and
 * `vapor-chamber@1.12` (two) while the package was at 1.14.0 and not yet
 * published — so every one of them pointed at something older than the code it
 * sat next to, and two pointed at a version a reader could not install. Nothing
 * failed, because a stale doc is invisible to a test suite: it only misleads
 * the person copying it.
 *
 * The advice those snippets give is right and stays — an UNPINNED CDN URL
 * (`npm/vapor-chamber/...`) resolves to whatever is published now and is
 * edge-cached, which is worse. So they keep recommending a pin, written as the
 * placeholder `vapor-chamber@<version>` for the reader to substitute. A
 * placeholder cannot go stale; a literal number silently does, every release.
 *
 * This test is the ratchet: reintroducing a literal pin fails here rather than
 * being noticed three releases later.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { version } from '../../package.json';

const root = process.cwd();
const SCAN = ['examples', 'docs'];
const EXTS = ['.html', '.md', '.ts', '.tsx', '.vue', '.astro'];
/** A literal pin: `vapor-chamber@1`, `@1.9`, `@1.12.0`, … The placeholder passes. */
const LITERAL_PIN = /vapor-chamber@\d+(?:\.\d+)*/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe('docs and examples carry no hardcoded vapor-chamber version', () => {
  const files = SCAN.flatMap((d) => walk(join(root, d)));

  it('scans a non-trivial set of files', () => {
    // Guards the walker itself — a broken path must fail, not vacuously pass.
    expect(files.length).toBeGreaterThan(10);
  });

  it('any literal pin matches package.json — no drift', () => {
    // Deliberately not "no pins allowed". Once the package is published a real
    // number is useful, and a rule that bans it would just be worked around.
    // The rule that actually holds is: if you write a version, it must be THE
    // version — tied to the same source of truth `scripts/measure-size.mjs`
    // stamps into docs/BUNDLE-SIZES.md, so it cannot drift silently the way
    // @1.9 and @1.12 did.
    const current = `vapor-chamber@${version}`;
    const stale: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const found of line.match(LITERAL_PIN) ?? []) {
          if (found !== current) stale.push(`${relative(root, file)}:${i + 1} → ${found} (package.json is ${version})`);
        }
      });
    }
    // If this fires: either bump the literal to the current version, or use the
    // placeholder `vapor-chamber@<version>` — correct before a release, since a
    // CDN URL for an unpublished version 404s for the reader.
    expect(stale).toEqual([]);
  });
});

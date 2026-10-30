/**
 * No hardcoded vapor-chamber version in the examples or docs, unless it is the current one.
 * Why: a literal pin silently goes stale every release and misleads whoever copies it; the placeholder `vapor-chamber@<version>` cannot.
 * Shows: the walker scans a real set of files; any literal pin equals package.json's version.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { version } from '../../package.json';

const root = process.cwd();
const SCAN = ['examples', 'docs'];
const EXTS = ['.html', '.md', '.ts', '.tsx', '.vue', '.astro'];
/** A literal pin: `vapor-chamber@1`, `@1.9`, `@1.12.0`, ... The placeholder passes. */
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
    // Guards the walker itself - a broken path must fail, not vacuously pass.
    expect(files.length).toBeGreaterThan(10);
  });

  it('any literal pin matches package.json - no drift', () => {
    // Not "no pins": once published a real number is useful, so a written version must be THE version.
    const current = `vapor-chamber@${version}`;
    const stale: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const found of line.match(LITERAL_PIN) ?? []) {
          if (found !== current) stale.push(`${relative(root, file)}:${i + 1} -> ${found} (package.json is ${version})`);
        }
      });
    }
    // To fix: bump the literal, or use the placeholder; a CDN URL for an unpublished version 404s.
    expect(stale).toEqual([]);
  });
});

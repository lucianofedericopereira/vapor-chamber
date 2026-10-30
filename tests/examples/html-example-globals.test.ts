// @vitest-environment happy-dom
/**
 * The `<script>`-tag examples and Blade views call `VaporChamber.*` globals off an IIFE bundle; each must exist in the bundle that page loads.
 * Why: a missing global is just `undefined`, so the page loads and dies later on that code path, and the three IIFE variants do not share one surface.
 * Shows: the walker finds pages, the Blade tier included; each bundle is built; running the real IIFE defines every name the page calls. Comments are stripped first: prose is not a call.
 * See: tests/examples/html-example-imports.test.ts, tests/require-dist.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

const root = process.cwd();
requireDist(existsSync(join(root, 'dist', 'index.js')));

/** Every server-rendered view that could carry a `<script src>`: plain HTML and Blade. */
function findViews(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findViews(full, out);
    else if (entry.endsWith('.html') || entry.endsWith('.blade.php')) out.push(full);
  }
  return out;
}

/** Drops HTML and Blade comments, so documented but inactive markup is not treated as live. */
const stripComments = (s: string) =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{--[\s\S]*?--\}\}/g, '');

type Page = { file: string; bundle: string; globals: string[] };

function analyse(file: string): Page | null {
  const src = stripComments(readFileSync(file, 'utf8'));

  const script = /<script[^>]*\ssrc=["']([^"']*vapor-chamber[^"']*\.js)["']/i.exec(src);
  if (!script) return null;

  const globals = [...src.matchAll(/VaporChamber\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // Served from the repo root (examples/static-server.mjs), so a leading `/` means the repo root, as in the browser.
  const src0 = script[1];
  // A Blade view's `/js/<name>` is the same built file: examples/laravel-app/setup.sh copies the IIFEs from dist/ into public/js/.
  const fromRoot = src0.startsWith('/js/') ? `/dist/${src0.slice('/js/'.length)}` : src0;
  const bundle = fromRoot.startsWith('/')
    ? join(root, fromRoot.slice(1))
    : resolve(dirname(file), fromRoot);
  return {
    file: relative(root, file),
    bundle,
    globals: [...new Set(globals)],
  };
}

describe('HTML examples call real IIFE globals', () => {
  const pages = findViews(join(root, 'examples'))
    .map(analyse)
    .filter((p): p is Page => p !== null && p.globals.length > 0);

  it('finds script-tag examples to check', () => {
    // Guards the walker: if these pages move or change shape, fail loudly
    // rather than silently verifying nothing.
    expect(pages.length).toBeGreaterThan(0);
  });

  // Naming the tier means dropping `.blade.php` from the walker fails loudly, as tests/ascii-guard.test.ts does for check-ascii.
  it('covers the Blade tier, not only plain .html', () => {
    const blade = pages.filter((p) => p.file.endsWith('.blade.php'));
    expect(blade.map((p) => p.file).sort()).toEqual([
      'examples/laravel-app/resources/views/cart.blade.php',
      'examples/laravel-app/resources/views/widget.blade.php',
    ]);
    // widget.blade.php is the one that needs the `elements` variant: its two
    // identifying globals are absent from `core`.
    const widget = blade.find((p) => p.file.endsWith('widget.blade.php'));
    expect(widget?.globals).toEqual(
      expect.arrayContaining(['defineWidget', 'emitDOMEvent']),
    );
  });

  it('each page loads a bundle that exists in dist/', () => {
    for (const p of pages) {
      expect(existsSync(p.bundle), `${p.file} loads ${relative(root, p.bundle)}, which is not built`).toBe(true);
    }
  });

  it('every VaporChamber.* the page calls exists on the bundle it loads', () => {
    const missing: string[] = [];
    for (const p of pages) {
      if (!existsSync(p.bundle)) continue; // reported above

      // The IIFE assigns globalThis.VaporChamber itself; clear it first so a
      // previous page's (larger) bundle cannot satisfy this page's lookups.
      (globalThis as Record<string, unknown>).VaporChamber = undefined;
      new Function(readFileSync(p.bundle, 'utf8'))();
      const api = (globalThis as Record<string, unknown>).VaporChamber as Record<string, unknown> | undefined;

      expect(api, `${p.file}: ${relative(root, p.bundle)} did not define globalThis.VaporChamber`).toBeTruthy();
      for (const name of p.globals) {
        if (!api || !(name in api)) {
          missing.push(`${p.file}: VaporChamber.${name} is missing from ${relative(root, p.bundle)}`);
        }
      }
    }
    (globalThis as Record<string, unknown>).VaporChamber = undefined;
    expect(missing).toEqual([]);
  });
});

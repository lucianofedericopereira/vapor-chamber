// @vitest-environment happy-dom
/**
 * The `<script>`-tag examples call `VaporChamber.*` globals off an IIFE bundle.
 * This asserts every global they call actually exists in the bundle they load.
 *
 * WHY IT IS A SEPARATE RISK from the ESM examples (covered by
 * html-example-imports.test.ts). Those fail loudly: a missing named import is a
 * module-resolution error the moment the page loads. A missing GLOBAL is just
 * `undefined`, so the page loads fine and dies later at
 * `VaporChamber.persist is not a function` — only on the code path that touches
 * it, only at runtime, in a browser nobody runs during CI.
 *
 * And the failure is live, not theoretical: the three IIFE variants do NOT have
 * the same surface. `persist` ships in `full` but is absent from `core` and
 * `elements` (measured). `examples/sprinkled-blade` loads `core` today and only
 * calls `connect`, which core has — but an example gaining one `persist` call,
 * or switching to the smaller bundle to save bytes, breaks with nothing to
 * catch it. That is exactly the kind of silent-negative this cycle spent its
 * time removing.
 *
 * METHOD: execute the real built IIFE (it assigns `globalThis.VaporChamber`),
 * then check the names the page actually references against it. Not a regex
 * over the bundle text — an earlier hand-check of this did use a regex on the
 * export tail, which is brittle and can quietly match nothing.
 *
 * HTML comments are stripped first: `pattern-1-blade-cdn.html` documents CDN
 * alternatives inside a comment, including a version-pinned `<script>` tag, and
 * counting those as real loads would resolve a URL that is prose.
 *
 * Skipped when `dist/` is absent, matching the other `dist-*` suites.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const haveDist = existsSync(join(root, 'dist', 'index.js'));

function findHtml(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Drop HTML comments so documented-but-inactive markup is not treated as live. */
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

type Page = { file: string; bundle: string; globals: string[] };

function analyse(file: string): Page | null {
  const src = stripComments(readFileSync(file, 'utf8'));

  const script = /<script[^>]*\ssrc=["']([^"']*vapor-chamber[^"']*\.js)["']/i.exec(src);
  if (!script) return null;

  const globals = [...src.matchAll(/VaporChamber\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // These pages are served from the REPO ROOT (examples/static-server.mjs), so
  // a leading `/` means repo root, not filesystem root — resolve it the way the
  // browser will. `pattern-1-blade-cdn.html` previously used `../../dist/…`,
  // which from `examples/` points ABOVE the repo and only worked because
  // browsers clamp excess `..` to the origin root; it now uses `/dist/…` like
  // its siblings, verified live at http://localhost:3000.
  const src0 = script[1];
  const bundle = src0.startsWith('/') ? join(root, src0.slice(1)) : resolve(dirname(file), src0);
  return {
    file: relative(root, file),
    bundle,
    globals: [...new Set(globals)],
  };
}

describe.skipIf(!haveDist)('HTML examples call real IIFE globals', () => {
  const pages = findHtml(join(root, 'examples'))
    .map(analyse)
    .filter((p): p is Page => p !== null && p.globals.length > 0);

  it('finds script-tag examples to check', () => {
    // Guards the walker: if these pages move or change shape, fail loudly
    // rather than silently verifying nothing.
    expect(pages.length).toBeGreaterThan(0);
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

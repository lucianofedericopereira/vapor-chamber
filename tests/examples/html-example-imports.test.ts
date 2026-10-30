/**
 * The no-build HTML examples import named exports straight out of `dist/`: a link check, since running them needs a browser and a static server.
 * Why: these pages use the files npm publishes, so a renamed or removed export breaks them silently, as it would a consumer; no typecheck or build covers them.
 * Shows: the walker finds pages; every `/dist/` specifier resolves to a built module; every named import exists on it.
 * See: tests/examples/html-example-globals.test.ts, tests/require-dist.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

const root = process.cwd();
requireDist(existsSync(join(root, 'dist', 'index.js')));

/** Every .html under examples/, at any depth, ignoring node_modules and build output. */
function findHtml(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

type Ref = { file: string; spec: string; names: string[] };

function extractDistImports(file: string): Ref[] {
  const src = readFileSync(file, 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  const refs: Ref[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const spec = m[2];
    if (!spec.startsWith('/dist/')) continue;
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    refs.push({ file: relative(root, file), spec, names });
  }
  return refs;
}

describe('HTML examples import real exports from dist', () => {
  const htmlFiles = findHtml(join(root, 'examples'));
  const refs = htmlFiles.flatMap(extractDistImports);

  it('finds HTML examples that import from dist', () => {
    // Guards the walker itself: if a refactor moves or renames these pages,
    // this suite must fail loudly rather than silently checking nothing.
    expect(htmlFiles.length).toBeGreaterThan(0);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('every /dist/ specifier resolves to a built module', async () => {
    for (const ref of refs) {
      const abs = join(root, ref.spec.slice(1));
      expect(existsSync(abs), `${ref.file} imports ${ref.spec}, which does not exist in dist/`).toBe(true);
    }
  });

  it('every named import exists on the built module', async () => {
    const missing: string[] = [];
    for (const ref of refs) {
      const abs = join(root, ref.spec.slice(1));
      if (!existsSync(abs)) continue; // reported by the test above
      const mod = await import(pathToFileURL(abs).href);
      for (const name of ref.names) {
        if (!(name in mod)) missing.push(`${ref.file}: '${name}' is not exported by ${ref.spec}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

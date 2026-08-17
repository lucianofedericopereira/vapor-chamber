/**
 * The no-build HTML examples import named exports straight out of `dist/`.
 * Nothing else checks them.
 *
 * WHY THIS EXISTS. `examples/` has three tiers of enforcement, and until this
 * file the third tier was empty:
 *   1. the top-level `.ts` snippets  → `examples/tsconfig.patterns.json`, run
 *      by `npm run typecheck`
 *   2. the three package.json projects → real `vite build` / `astro build`
 *   3. the plain-HTML examples        → nothing
 *
 * Tier 3 is not a lesser tier. `feature-directives.html` and
 * `router-demo/index.html` are runnable ESM pages that `import { … } from
 * '/dist/index.js'` — the same files npm publishes — so a renamed or removed
 * export breaks them exactly as it would break a consumer, silently, with no
 * gate to notice. That is not hypothetical: `useCommandBus()` was removed in
 * this cycle, and the only reason no example broke is that none happened to
 * use it. Confirming that by hand does not scale to the next removal.
 *
 * So this walks every HTML example, extracts each named import from a `/dist/`
 * specifier, and asserts the built module actually exports it. It is a link
 * check, not a behavior test — running these pages needs a browser and a static
 * server (`node examples/static-server.mjs`), which is out of scope here.
 *
 * Skipped when `dist/` is absent, matching `tests/dist-*.test.ts`: a fresh
 * clone has no build, and this must not fail before `npm run build` has run.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const haveDist = existsSync(join(root, 'dist', 'index.js'));

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

describe.skipIf(!haveDist)('HTML examples import real exports from dist', () => {
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

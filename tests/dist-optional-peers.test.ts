/**
 * Optional peer dependencies stay unresolvable in the built output; the list is read from package.json, so a new optional peer joins automatically.
 * Why: a literal `import("peer")` kills any Vite or Astro app without that peer at dep-optimize time; `@vite-ignore` does not help, since the pre-bundled dep is re-analyzed.
 * Shows: no dist chunk holds a literal dynamic import of an optional peer outside its opt-in subpath; the root probe tells webpack to leave its import alone.
 * See: log 36.F26, tests/root-no-vue-dev-server.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireDist } from './require-dist';

const distDir = join(process.cwd(), 'dist');
requireDist(existsSync(join(distDir, 'index.js')));

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const optionalPeers: string[] = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => (meta as { optional?: boolean }).optional)
  .map(([name]) => name);

/** The `<script>`-tag bundles: no bundler pre-bundles them, and on a page the literal fails inside the probe, which catches it. */
const isIife = (file: string) => /\.iife(\.min)?\.js$/.test(file);

function distFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return distFiles(full);
    return entry.isFile() && full.endsWith('.js') && !isIife(full) ? [full] : [];
  });
}

describe('dist - optional peers are never statically resolvable', () => {
  it('declares the optional peers it guards', () => {
    expect(optionalPeers).toEqual(expect.arrayContaining(['@vue/devtools-api', 'vue']));
  });

  /** An opt-in subpath may resolve its peer: the rule is about reach from the root, which every bundler pre-bundles. */
  const OPT_IN = new Map([['@vue/devtools-api', ['dist/devtools.js']]]);

  it.each(optionalPeers)('never emits a literal dynamic import of %s', (peer) => {
    // Comments are stripped first: a magic comment may sit inside the call, and prose may quote one.
    const literalImport = new RegExp(`import\\(\\s*['"\`]${peer.replace(/[/@.]/g, '\\$&')}['"\`]`);

    const allowed = OPT_IN.get(peer) ?? [];
    const offenders = distFiles(distDir)
      .filter((file) => literalImport.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((file) => file.slice(process.cwd().length + 1))
      .filter((file) => !allowed.includes(file));

    expect(
      offenders,
      `${peer} may only be statically imported from its opt-in subpath (${allowed.join(', ') || 'none'})`,
    ).toEqual([]);
  });

  it('the root probe tells webpack to leave its import alone', () => {
    // webpack folds a module-scope `const` into a literal and resolves it.
    const chamber = readFileSync(join(distDir, 'chamber.js'), 'utf8');
    expect(chamber).toMatch(/import\(\s*\/\* webpackIgnore: true \*\/\s*\/\* @vite-ignore \*\/\s*VUE_PKG\s*\)/);
  });
});

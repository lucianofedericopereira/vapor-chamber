/**
 * Optional peer dependencies must stay UNRESOLVABLE in the built output.
 *
 * `src/devtools.ts` loads `@vue/devtools-api` through a variable specifier so
 * no bundler can resolve it statically. That indirection is easy to lose: the
 * build once constant-folded the variable back into
 * `import("@vue/devtools-api")`, and every consuming Vite/Astro app that had
 * not installed the optional peer died at dep-optimize time with
 * "Failed to resolve import" - a 500 on the dep bundle, an unhandled rejection
 * in the browser, and a dev-server reload loop. `@vite-ignore` does not save
 * it, because the pre-bundled dep is re-analyzed.
 *
 * `vue` is under the same rule. The root's probe was exempt until 36.F26, on
 * the premise that an app pulling in a Vue library has Vue installed. The root
 * has to work with no Vue in the tree, and the literal gave a Vue-less app a
 * 500 under the Vite dev server (tests/root-no-vue-dev-server.test.ts).
 *
 * The peer list is read from package.json, so marking a new peer optional
 * automatically puts it under this guard.
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

/**
 * The `<script>`-tag bundles. No bundler pre-bundles them from the package
 * root, and their minifier inlines the probe's name back into a literal. On a
 * page it is a bare specifier the browser cannot resolve, caught by the probe.
 */
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

  /**
   * Opt-in subpaths may resolve the peer statically - that is what makes the
   * feature work for someone who installed it. The rule is about REACH: the
   * specifier must not travel in anything a consumer gets by importing the
   * package root, because the root is what every bundler pre-bundles.
   */
  const OPT_IN = new Map([['@vue/devtools-api', ['dist/devtools.js']]]);

  it.each(optionalPeers)('never emits a literal dynamic import of %s', (peer) => {
    // `import(` + the bare specifier as a string or template literal. Comments
    // go first: a magic comment may sit inside the call, and prose may quote one.
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

/**
 * Optional peer dependencies must stay UNRESOLVABLE in the built output.
 *
 * `src/devtools.ts` loads `@vue/devtools-api` through a variable specifier so
 * no bundler can resolve it statically. That indirection is easy to lose: the
 * build once constant-folded the variable back into
 * `import("@vue/devtools-api")`, and every consuming Vite/Astro app that had
 * not installed the optional peer died at dep-optimize time with
 * "Failed to resolve import" — a 500 on the dep bundle, an unhandled rejection
 * in the browser, and a dev-server reload loop. `@vite-ignore` does not save
 * it, because the pre-bundled dep is re-analyzed.
 *
 * The peer list is read from package.json, so marking a new peer optional
 * automatically puts it under this guard.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');
const haveDist = existsSync(join(distDir, 'index.js'));

/**
 * `vue` is deliberately exempt. Its literal is load-bearing, not an accident:
 * the Vue probe must be rewritten by the bundler into a real URL, because a
 * browser cannot resolve the bare specifier "vue" at runtime. Hiding it would
 * turn Vue detection off everywhere instead of protecting anyone — and an app
 * that pulls in a *Vue* library almost always has Vue installed. The rule
 * applies to peers whose absence must degrade silently.
 */
const EXEMPT = new Set(['vue']);

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const optionalPeers: string[] = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => (meta as { optional?: boolean }).optional)
  .map(([name]) => name)
  .filter((name) => !EXEMPT.has(name));

function distFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return distFiles(full);
    return entry.isFile() && full.endsWith('.js') ? [full] : [];
  });
}

describe.skipIf(!haveDist)('dist — optional peers are never statically resolvable', () => {
  it('declares at least one optional peer to guard', () => {
    expect(optionalPeers).toContain('@vue/devtools-api');
  });

  /**
   * Opt-in subpaths may resolve the peer statically — that is what makes the
   * feature work for someone who installed it. The rule is about REACH: the
   * specifier must not travel in anything a consumer gets by importing the
   * package root, because the root is what every bundler pre-bundles.
   */
  const OPT_IN = new Map([['@vue/devtools-api', ['dist/devtools.js']]]);

  it.each(optionalPeers)('never emits a literal dynamic import of %s', (peer) => {
    // `import(` + optional comments/whitespace + the bare specifier as a literal.
    const literalImport = new RegExp(
      `import\\(\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*['"]${peer.replace(/[/@.]/g, '\\$&')}['"]`,
    );

    const allowed = OPT_IN.get(peer) ?? [];
    const offenders = distFiles(distDir)
      .filter((file) => literalImport.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(process.cwd().length + 1))
      .filter((file) => !allowed.includes(file));

    expect(
      offenders,
      `${peer} may only be statically imported from its opt-in subpath (${allowed.join(', ') || 'none'})`,
    ).toEqual([]);
  });
});

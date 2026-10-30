/**
 * The base `vapor-chamber/router` entry keeps Vue's vDOM bindings out of a consumer's entry chunk.
 * Why: a Vapor app that only calls createRouter() would otherwise retain the vDOM runtime through `defineComponent` or `h` from `outlet.ts` or `blade.ts`.
 * Shows: createRouter() alone imports none of the vDOM marker names from `vue`, the vdom subpath does import `defineComponent` and `h`, and the entry types do not export `RouterOutlet` or `makeBladeComponent`.
 * See: tests/router/vapor-boundary.test.ts
 *
 * Fails when dist/ is not built (tests/require-dist.ts); skips when esbuild is unavailable.
 * "Built" includes the `.d.ts` files from `tsc`, which the Vite pass that writes the `.js` files does not produce.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireDist } from '../require-dist';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const routerTypes = resolve(process.cwd(), 'dist', 'router', 'index.d.ts');
requireDist(existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(routerTypes));

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

/**
 * Named bindings the consumer's entry chunk imports from 'vue'.
 * `splitting: true` keeps the on-demand blade chunk out of the entry chunk, as a real bundler would.
 */
async function vueImportsOf(source: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-vdom-'));
  const entry = join(dir, 'consumer.mjs');
  const outdir = join(dir, 'out');
  writeFileSync(entry, source);
  try {
    await (esbuild as typeof import('esbuild')).build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: ['vue'],
      outdir,
      splitting: true,
      treeShaking: true,
      minify: false,
    });
    const code = readFileSync(join(outdir, 'consumer.js'), 'utf8');
    const names = new Set<string>();
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']vue["']/g)) {
      for (const part of (m[1] as string).split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VDOM_MARKERS = ['defineComponent', 'h', 'createVNode', 'onMounted', 'onBeforeUnmount'];

describe.skipIf(!esbuild)('vDOM boundary', () => {
  it('createRouter() alone does not pull vDOM bindings from vue', async () => {
    const imports = await vueImportsOf(`
      import { createRouter } from '${routerEntry.replace(/\\/g, '\\\\')}';
      globalThis.__vc = createRouter;
    `);
    console.log('vue bindings retained by createRouter():', imports.join(', ') || '(none)');
    const leaked = imports.filter((name) => VDOM_MARKERS.includes(name));
    expect(leaked).toEqual([]);
  });

  it('the vdom subpath DOES pull vDOM - the cost is opt-in, not default', async () => {
    const imports = await vueImportsOf(`
      import { RouterOutlet } from '${vdomEntry.replace(/\\/g, '\\\\')}';
      globalThis.__vc = RouterOutlet;
    `);
    console.log('vue bindings retained by router/vdom  :', imports.join(', ') || '(none)');
    expect(imports).toContain('defineComponent');
    expect(imports).toContain('h');
  });

  it('router entry does not re-export the vDOM components', async () => {
    const entryTypes = readFileSync(resolve(process.cwd(), 'dist', 'router', 'index.d.ts'), 'utf8');
    expect(entryTypes).not.toMatch(/\bRouterOutlet\b/);
    expect(entryTypes).not.toMatch(/\bmakeBladeComponent\b/);
  });
});

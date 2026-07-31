/**
 * vDOM boundary regression — the base `vapor-chamber/router` entry must not
 * drag Vue's virtual-DOM runtime in.
 *
 * A Vapor consumer that only calls createRouter() should end up importing
 * reactivity from `vue` and nothing else. `defineComponent` / `h` are the vDOM
 * tell: they live in `outlet.ts` and `blade.ts`, and if either is reachable
 * from the entry's live bindings, the vDOM runtime is retained.
 *
 * (`vue` is an optional peer, so it stays external in this bundle — what we
 * assert on is WHICH named bindings the router still asks `vue` for.)
 *
 * Skips when dist/ hasn't been built or esbuild is unavailable.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const haveDist = existsSync(routerEntry) && existsSync(vdomEntry);

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

/**
 * Named bindings the consumer's ENTRY chunk still imports from 'vue'.
 *
 * `splitting: true` matters: without it esbuild inlines dynamic `import()`
 * back into the single output, which would hide exactly the on-demand blade
 * chunk this boundary depends on. A real consumer bundler (Vite/Rollup) code-
 * splits it, so the entry is what a Vapor app actually pays on first load.
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

describe.skipIf(!haveDist || !esbuild)('vDOM boundary', () => {
  it('createRouter() alone does not pull vDOM bindings from vue', async () => {
    const imports = await vueImportsOf(`
      import { createRouter } from '${routerEntry.replace(/\\/g, '\\\\')}';
      globalThis.__vc = createRouter;
    `);
    console.log('vue bindings retained by createRouter():', imports.join(', ') || '(none)');
    const leaked = imports.filter((name) => VDOM_MARKERS.includes(name));
    expect(leaked).toEqual([]);
  });

  it('the vdom subpath DOES pull vDOM — the cost is opt-in, not default', async () => {
    const imports = await vueImportsOf(`
      import { RouterOutlet } from '${vdomEntry.replace(/\\/g, '\\\\')}';
      globalThis.__vc = RouterOutlet;
    `);
    console.log('vue bindings retained by router/vdom  :', imports.join(', ') || '(none)');
    expect(imports).toContain('defineComponent');
    expect(imports).toContain('h');
  });

  it('router entry no longer re-exports the vDOM components', async () => {
    const entryTypes = readFileSync(resolve(process.cwd(), 'dist', 'router', 'index.d.ts'), 'utf8');
    expect(entryTypes).not.toMatch(/\bRouterOutlet\b/);
    expect(entryTypes).not.toMatch(/\bmakeBladeComponent\b/);
  });
});

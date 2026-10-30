/**
 * The `vapor-chamber/router/vapor` entry keeps vDOM interop bindings out of a consumer's entry chunk.
 * Why: if the Vapor outlet reached `vaporInteropPlugin`, `defineComponent`, `h` or `createVNode`, the subpath would stop saving the interop cost.
 * Shows: the bundled entry imports none of those names from `vue`, the interop outlet does (positive control), the vapor outlet alone imports exactly the listed helpers, and the base router types do not export `RouterOutlet`.
 * See: docs/router.md, tests/router/vdom-boundary.test.ts, tests/vapor/vapor-outlet-size.test.ts
 *
 * Fails when dist/ is not built (tests/require-dist.ts); skips when esbuild is unavailable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const vaporEntry = resolve(process.cwd(), 'dist', 'router', 'vapor.js');
requireDist(existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(vaporEntry));

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

const esm = (p: string) => p.replace(/\\/g, '\\\\');

/**
 * Named bindings the consumer's entry chunk imports from 'vue'.
 * `splitting: true` keeps the dynamic `import()` of `blade.ts` out of the entry chunk, as a real bundler would.
 */
async function vueImportsOf(source: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-vapor-bound-'));
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
      logLevel: 'silent',
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

const INTEROP_MARKERS = ['vaporInteropPlugin', 'defineComponent', 'h', 'createVNode'];

describe.skipIf(!esbuild)('Vapor boundary', () => {
  it('the vapor subpath retains no interop binding from vue', async () => {
    const imports = await vueImportsOf(`
      import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
      import { RouterOutlet } from '${esm(vaporEntry)}';
      globalThis.__vc = [createRouter, createMemoryHistory, RouterOutlet];
    `);
    console.log('vue bindings retained by router/vapor :', imports.join(', ') || '(none)');
    expect(imports.filter((name) => INTEROP_MARKERS.includes(name))).toEqual([]);
    // An empty enumeration would pass the assertion above vacuously.
    expect(imports).toContain('createDynamicComponent');
    expect(imports).toContain('defineVaporComponent');
  });

  it('the interop arm DOES retain them - the cost the vapor subpath drops', async () => {
    // Positive control: proves the harness still detects bindings.
    const imports = await vueImportsOf(`
      import { vaporInteropPlugin } from 'vue';
      import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
      import { RouterOutlet } from '${esm(vdomEntry)}';
      globalThis.__vc = [createRouter, createMemoryHistory, RouterOutlet, vaporInteropPlugin];
    `);
    console.log('vue bindings retained by the interop arm:', imports.join(', ') || '(none)');
    expect(imports).toContain('vaporInteropPlugin');
    expect(imports).toContain('defineComponent');
    expect(imports).toContain('h');
  });

  it('the outlet alone retains exactly the bindings docs/router.md and manual chapter 6, "Pick an outlet"', async () => {
    // The `vapor-chamber/router/vapor` row of both retained-bindings tables.
    const imports = await vueImportsOf(`
      import { RouterOutlet } from '${esm(vaporEntry)}';
      globalThis.__vc = [RouterOutlet];
    `);
    expect(imports).toEqual(['createDynamicComponent', 'createIf', 'createSlot', 'defineVaporComponent', 'inject', 'provide']);
  });
});

/**
 * Vapor boundary regression - `vapor-chamber/router/vapor` must not reach the
 * vDOM renderer.
 *
 * `tests/router/vdom-boundary.test.ts` with the markers INVERTED. That file
 * asserts the base router entry retains no vDOM binding; this one asserts the
 * same of the Vapor outlet, which is the stronger claim: the outlet actually
 * renders route components, and the whole point of the subpath is that doing
 * so pulls in no `vaporInteropPlugin`, no `defineComponent`, no `h`, no
 * `createVNode`. If any of those is reachable from the entry's live bindings,
 * the interop machinery is back and the subpath has stopped paying for itself.
 *
 * Binding assertions rather than byte thresholds, deliberately: which names
 * survive tree-shaking is CI-stable where size numbers drift between toolchain
 * versions. The bytes are measured in `tests/vapor/vapor-outlet-size.test.ts`,
 * where the accepting decision needs them.
 *
 * (`vue` is an optional peer, so it stays external here - what we assert on is
 * WHICH named bindings each entry still asks `vue` for.)
 *
 * Skips when dist/ hasn't been built or esbuild is unavailable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const vaporEntry = resolve(process.cwd(), 'dist', 'router', 'vapor.js');
const haveDist = existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(vaporEntry);

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

const esm = (p: string) => p.replace(/\\/g, '\\\\');

/**
 * Named bindings the consumer's ENTRY chunk still imports from 'vue'.
 *
 * `splitting: true` matters: without it esbuild inlines the dynamic `import()`
 * of `blade.ts` back into the single output, which would report vDOM bindings
 * a real consumer's entry chunk never loads. A real bundler code-splits it, so
 * the entry is what an app actually pays on first load.
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

describe.skipIf(!haveDist || !esbuild)('Vapor boundary', () => {
  it('the vapor subpath retains no interop binding from vue', async () => {
    const imports = await vueImportsOf(`
      import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
      import { RouterOutlet } from '${esm(vaporEntry)}';
      globalThis.__vc = [createRouter, createMemoryHistory, RouterOutlet];
    `);
    console.log('vue bindings retained by router/vapor :', imports.join(', ') || '(none)');
    expect(imports.filter((name) => INTEROP_MARKERS.includes(name))).toEqual([]);
    // Guard the harness itself: an enumeration that found nothing at all would
    // pass the assertion above vacuously. The outlet must still be asking
    // `vue` for the helpers it renders through.
    expect(imports).toContain('createDynamicComponent');
    expect(imports).toContain('defineVaporComponent');
  });

  it('the interop arm DOES retain them - the cost the vapor subpath drops', async () => {
    // Positive control. Without this, the assertion above could pass because
    // the harness stopped detecting bindings rather than because the outlet
    // stopped needing them.
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

  it('the router entry does not re-export the Vapor outlet either', async () => {
    // The same discipline `vdom-boundary` pins for the vDOM side: a static
    // re-export from the base entry would be a static reference, and would put
    // the Vapor runtime in the graph of every consumer including 3.5 ones,
    // for whom these helpers do not exist at all.
    const entryTypes = readFileSync(resolve(process.cwd(), 'dist', 'router', 'index.d.ts'), 'utf8');
    expect(entryTypes).not.toMatch(/\bRouterOutlet\b/);
  });
});

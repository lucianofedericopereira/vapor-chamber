/**
 * http boundary regression - the base `vapor-chamber/router` entry must not
 * drag the chamber http client in.
 *
 * Two optional features need one: a `{ url }` route table and blade rows. The
 * router used to build the client itself, so every consumer carried it - the
 * whole multi-method client, CSRF and retry and cache included - to support
 * code most apps never call. It moved to `vapor-chamber/router/remote`, which
 * is the same subpath-per-cost shape `./vdom` and `./vapor` already use.
 *
 * That is a property of the import graph, not of anyone's discipline, so it is
 * asserted the way the renderer boundaries are: build a consumer that calls
 * `createRouter()` and nothing else, and look at what came with it.
 *
 * Skips when dist/ hasn't been built or esbuild is unavailable.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const remoteEntry = resolve(process.cwd(), 'dist', 'router', 'remote.js');
const haveDist = existsSync(routerEntry) && existsSync(remoteEntry);

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

/**
 * Bundle a consumer and report every dist module that ended up reachable.
 *
 * `splitting: true` for the same reason vdom-boundary.test.ts uses it: without
 * it esbuild inlines dynamic `import()` back into one output, which would make
 * an on-demand module look statically retained and this assertion meaningless.
 */
async function modulesOf(source: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-remote-'));
  const entry = join(dir, 'consumer.mjs');
  writeFileSync(entry, source);
  try {
    const result = await (esbuild as typeof import('esbuild')).build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      external: ['vue', '@vue/devtools-api'],
      splitting: true,
      outdir: join(dir, 'out'),
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    return Object.values(result.metafile.outputs)
      .flatMap((output) => Object.keys(output.inputs))
      .map((path) => path.replace(/\\/g, '/'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!haveDist || !esbuild)('http boundary', () => {
  it('createRouter() alone does not pull in the http client', async () => {
    const modules = await modulesOf(
      `import { createRouter } from ${JSON.stringify(routerEntry)};\nglobalThis.__probe = createRouter;\n`,
    );

    // The client and everything it drags with it: cache, query helpers, error
    // mapping. Before the move, all four rode along with every router.
    expect(modules.filter((m) => /dist\/http(-|\.)/.test(m))).toEqual([]);
    // Sanity: the probe really did bundle the router, so an empty result above
    // cannot be an empty build passing vacuously.
    expect(modules.some((m) => m.includes('dist/router'))).toBe(true);
  });

  it('the remote subpath is where the http client lives', async () => {
    const modules = await modulesOf(
      `import { routerHttp, bladeFetcher } from ${JSON.stringify(remoteEntry)};\nglobalThis.__probe = [routerHttp, bladeFetcher];\n`,
    );

    expect(modules.some((m) => /dist\/http(-|\.)/.test(m))).toBe(true);
  });
});

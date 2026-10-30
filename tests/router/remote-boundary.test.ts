/**
 * The base `vapor-chamber/router` entry does not pull in the chamber http client; `vapor-chamber/router/remote` does.
 * Why: only a `{ url }` route table and blade rows need the client (CSRF, retry, cache included), so a consumer using neither would carry its bytes anyway.
 * Shows: an esbuild bundle of a consumer calling only `createRouter()` reaches no dist/http module while still bundling the router; a bundle of the remote entry does reach one. Needs dist/ built (tests/require-dist.ts); skipped when esbuild is unavailable.
 * See: tests/router/vdom-boundary.test.ts
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireDist } from '../require-dist';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const remoteEntry = resolve(process.cwd(), 'dist', 'router', 'remote.js');
requireDist(existsSync(routerEntry) && existsSync(remoteEntry));

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

/**
 * Bundle a consumer and report every dist module that ended up reachable.
 * `splitting: true`: without it esbuild inlines dynamic `import()`, making an on-demand module look statically retained.
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

describe.skipIf(!esbuild)('http boundary', () => {
  it('createRouter() alone does not pull in the http client', async () => {
    const modules = await modulesOf(
      `import { createRouter } from ${JSON.stringify(routerEntry)};\nglobalThis.__probe = createRouter;\n`,
    );

    // The client and what it drags with it: cache, query helpers, error mapping.
    expect(modules.filter((m) => /dist\/http(-|\.)/.test(m))).toEqual([]);
    // The probe bundled the router, so the empty result above is not an empty build.
    expect(modules.some((m) => m.includes('dist/router'))).toBe(true);
  });

  it('the remote subpath is where the http client lives', async () => {
    const modules = await modulesOf(
      `import { routerHttp, bladeFetcher } from ${JSON.stringify(remoteEntry)};\nglobalThis.__probe = [routerHttp, bladeFetcher];\n`,
    );

    expect(modules.some((m) => /dist\/http(-|\.)/.test(m))).toBe(true);
  });
});

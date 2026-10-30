/**
 * ESM tree-shake: a typical Blade consumer (createAsyncCommandBus, httpTransport, logger) stays small and carries no Vue registry.
 * Why: a side-effect import dragging chamber.ts into transports or plugins consumers makes every such app pay for Vue detection it never uses.
 * Shows: the Vite production bundle stays under its brotli ceiling; none of chamber.ts's symbols appear in an unminified build of the same entry.
 * See: scripts/check-size.mjs, docs/BUNDLE-SIZES.md, tests/require-dist.ts.
 */
import { describe, it, expect } from 'vitest';
import { build as viteBuild } from 'vite';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { requireDist } from './require-dist';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
requireDist(existsSync(dist('index.js')) && existsSync(dist('transports.js')));

// Try to load esbuild's JS API. It's a transitive dep via Vite, so it's
// almost always available in dev/CI; if not, we skip the test cleanly.
let esbuild: any = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

describe.skipIf(!esbuild)('ESM tree-shake regression', () => {
  it('typical Blade consumer bundle stays under its brotli ceiling + drops Vapor registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-treeshake-'));
    const entry = join(dir, 'consumer.mjs');
    const out = join(dir, 'consumer.bundle.js');
    const plain = join(dir, 'consumer.plain.js');

    writeFileSync(entry, `
      import { createAsyncCommandBus, logger } from '${dist('index.js').replace(/\\/g, '\\\\')}';
      import { httpTransport } from '${dist('transports.js').replace(/\\/g, '\\\\')}';
      const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api' }) });
      bus.use(logger());
      globalThis.__vc_test = bus;
    `);

    try {
      const shared = {
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        treeShaking: true,
        external: ['vue', '@vue/devtools-api'],
        logLevel: 'silent',
      };
      await esbuild.build({ ...shared, minify: true, outfile: out });
      // The same consumer, not minified - what the symbol check below reads.
      await esbuild.build({ ...shared, minify: false, outfile: plain });

      // The ceiling reads a Vite production build, what a consumer ships: esbuild here has no NODE_ENV define, so it keeps every DEV branch.
      const viteRes = await viteBuild({
        configFile: false, root: dir, logLevel: 'silent', mode: 'production',
        define: { 'process.env.NODE_ENV': '"production"' },
        build: { write: false, minify: true, target: 'es2022', modulePreload: false,
          rollupOptions: { input: entry, external: ['vue', '@vue/devtools-api'], output: { format: 'es' } } },
      });
      const viteChunks = (Array.isArray(viteRes) ? viteRes : [viteRes]).flatMap((r) => ('output' in r ? r.output : []));
      const viteCode = viteChunks.filter((o) => o.type === 'chunk').map((c) => c.code).join('\n');
      const viteBr = brotliCompressSync(Buffer.from(viteCode), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });

      const buf = readFileSync(out);
      const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      const src = readFileSync(plain, 'utf8');

      // A ratchet: a rise goes to the measured size with its pieces recorded in the log; a lower reading locks the win. If this fails, read the import graph first.
      expect(viteBr.length, `vite production brotli grew unexpectedly (${viteBr.length} bytes)`).toBeLessThan(13_718);

      // chamber.ts-only names, read off the unminified build, since a minifier renames module-local names.
      const forbidden = [
        'probeVue',
        'applyVueModule',
        'waitForVueDetection',
        'defineVaporCustomElement',
        'defineVaporAsyncComponent',
        'defineVaporComponent',
        '_vueOnScopeDispose',
      ];
      for (const sym of forbidden) {
        expect(src.includes(sym), `consumer bundle leaked '${sym}' from chamber.ts`).toBe(false);
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
    }
  });
});

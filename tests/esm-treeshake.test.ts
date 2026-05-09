/**
 * ESM tree-shake regression test — locks the v1.2.0 signal-extraction win.
 *
 * Builds a synthetic consumer entry that imports a typical Blade-style API
 * surface (createCommandBus + createHttpBridge + logger) and asserts:
 *   1. The bundled output stays under a brotli budget (currently 6.5 KB).
 *   2. The Vapor feature-detection registry from chamber.ts is fully tree-
 *      shaken — zero references to probeVue / applyVueModule /
 *      defineVaporCustomElement / waitForVueDetection / _vueOnScopeDispose.
 *
 * If this test fails, something added a side-effect import that drags
 * chamber.ts back into transports/plugins consumers. Investigate the
 * import graph before bumping the budget.
 *
 * Skips when dist/ hasn't been built or esbuild is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
const haveDist = existsSync(dist('index.js')) && existsSync(dist('transports.js'));

// Try to load esbuild's JS API. It's a transitive dep via Vite, so it's
// almost always available in dev/CI; if not, we skip the test cleanly.
let esbuild: any = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

describe.skipIf(!haveDist || !esbuild)('ESM tree-shake regression', () => {
  it('typical Blade consumer bundle stays under 6.5 KB brotli + drops Vapor registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-treeshake-'));
    const entry = join(dir, 'consumer.mjs');
    const out = join(dir, 'consumer.bundle.js');

    writeFileSync(entry, `
      import { createCommandBus, logger } from '${dist('index.js').replace(/\\/g, '\\\\')}';
      import { createHttpBridge } from '${dist('transports.js').replace(/\\/g, '\\\\')}';
      const bus = createCommandBus();
      bus.use(logger());
      bus.use(createHttpBridge({ endpoint: '/api' }));
      globalThis.__vc_test = bus;
    `);

    try {
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        minify: true,
        treeShaking: true,
        outfile: out,
        external: ['vue', '@vue/devtools-api'],
        logLevel: 'silent',
      });

      const buf = readFileSync(out);
      const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      const src = buf.toString();

      // Size budget. Locks the v1.2.0 signal-extraction win.
      // If this fails, look for a new side-effect import dragging chamber.ts in.
      expect(br.length, `brotli bundle size grew unexpectedly (${br.length} bytes)`).toBeLessThan(6_500);

      // Symbol budget. These are all chamber.ts-only — should NOT appear in a
      // consumer bundle that doesn't import Vue composables.
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

/**
 * ESM tree-shake regression test — locks the v1.2.0 signal-extraction win.
 *
 * Builds a synthetic consumer entry that imports a typical Blade-style API
 * surface (createCommandBus + createHttpBridge + logger) and asserts:
 *   1. The bundled output stays under a brotli budget (currently 7.1 KB).
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
  it('typical Blade consumer bundle stays under 7.1 KB brotli + drops Vapor registry', async () => {
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
      // If this fails, look for a new side-effect import dragging chamber.ts in
      // (the forbidden-symbol list below is the precise guard for that).
      // Ceiling 6_500 → 6_700: the v1.7.0 commandKey canonical-key fix (recursive
      // key-sort replacer, +~3 B brotli) is in the core path — a deliberate
      // correctness change, not accidental bloat.
      // Ceiling 6_700 → 6_900: v1.7.x HTTP bridge body-error surfacing (feature)
      // + the sync-bus async-plugin dev warning (~+107 B brotli combined). This
      // synthetic build has no NODE_ENV define, so the dev-warning branch stays;
      // consumers' prod builds define it and DCE the warning.
      // Ceiling 6_900 → 7_100: logger() level filtering + [ OK ]/[ FAIL ]
      // badges (~+100 B brotli, feature — logger is in this consumer entry).
      // Symbol assertions below still pass, so no tree-shake regression.
      // Ceiling 7_100 → 6_300: /* @__PURE__ */ on ERROR_CODE_REGISTRY's freeze
      // made the whole registry shakeable — it had been silently pinned into
      // every barrel-import bundle since v1.0 (~1 KB brotli recovered; measured
      // 6_083 after the fix). This LOWER ceiling locks the win.
      expect(br.length, `brotli bundle size grew unexpectedly (${br.length} bytes)`).toBeLessThan(6_300);

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

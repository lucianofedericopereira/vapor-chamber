/**
 * ESM tree-shake regression test - locks the v1.2.0 signal-extraction win.
 *
 * Builds a synthetic consumer entry that imports a typical Blade-style API
 * surface (createCommandBus + createHttpBridge + logger) and asserts:
 *   1. The bundled output stays under a brotli budget (currently 7.1 KB).
 *   2. The Vapor feature-detection registry from chamber.ts is fully tree-
 *      shaken - zero references to probeVue / applyVueModule /
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
      // Ceiling 6_500 -> 6_700: the v1.7.0 commandKey canonical-key fix (recursive
      // key-sort replacer, +~3 B brotli) is in the core path - a deliberate
      // correctness change, not accidental bloat.
      // Ceiling 6_700 -> 6_900: v1.7.x HTTP bridge body-error surfacing (feature)
      // + the sync-bus async-plugin dev warning (~+107 B brotli combined). This
      // synthetic build has no NODE_ENV define, so the dev-warning branch stays;
      // consumers' prod builds define it and DCE the warning.
      // Ceiling 6_900 -> 7_100: logger() level filtering + [ OK ]/[ FAIL ]
      // badges (~+100 B brotli, feature - logger is in this consumer entry).
      // Symbol assertions below still pass, so no tree-shake regression.
      // Ceiling 7_100 -> 6_300: /* @__PURE__ */ on ERROR_CODE_REGISTRY's freeze
      // made the whole registry shakeable - it had been silently pinned into
      // every barrel-import bundle since v1.0 (~1 KB brotli recovered; measured
      // 6_083 after the fix). This LOWER ceiling locks the win.
      // Ceiling 6_300 -> 6_450 (v1.13.0): dev guards moved from an inline
      // `typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'`
      // at each site to a shared `DEV` const in src/dev.ts, fed by the
      // `__VC_DEV__` build define. THIS bundle deliberately omits the define
      // (see the note above), so it keeps every dev branch AND pays the small
      // fixed cost of the extra module - the one configuration where the
      // change reads as a regression.
      //
      // The configuration that ships tells the opposite story, measured: all
      // three production IIFE bundles came out SMALLER than v1.12.0 (full
      // 11,367 -> 11,325 B brotli, core 7,885 -> 7,716, elements 8,294 -> 8,193)
      // because the define now folds the branches away and takes ~500-1,100 B
      // of warning STRINGS with them, which the old inline guard never managed
      // (rolldown will not fold `typeof process < "u" && !1`).
      // Ceiling 6_450 -> 6_400 (v1.13.0): net WIN from the licence rework, which
      // pulled in two directions and came out ahead. Cost: the notice is now a
      // LEGAL comment (`/*!`), which minifiers keep on purpose - the plain
      // `/* ... */` banner it replaced was being stripped, so both .min.js IIFEs
      // were shipping with no licence reference at all. Saving: that notice is
      // a 22 B pointer to dist/LICENSE.txt rather than a ~150 B block, and the
      // build now strips JSDoc from emitted ESM (dist/index.js 56.0 -> 45.9 KB;
      // the prose still reaches editors via the .d.ts). Measured 6_382, below
      // the old 6_450. This LOWER ceiling locks it.
      // Ceiling 6_400 -> 6_500: on()/once() gained `{ signal }` (auto-unsubscribe
      // on AbortSignal, matching DOM addEventListener) and every returned
      // unsubscribe fn is now tagged with a self-polyfilled Symbol.dispose, so
      // `using off = bus.on(...)` works with or without native Explicit Resource
      // Management. Both live in `on()`, which this consumer always reaches
      // through `createCommandBus()` even though it never calls `.on()` itself -
      // the cost is unavoidable, not accidental (isolated: signal path alone
      // ~70 B, Symbol.dispose alone ~45 B; already tightened to one
      // removeEventListener site shared by the abort and manual-off paths, and
      // one module-level polyfill instead of a per-call one). Measured 6_456.
      // Ceiling 6_500 -> 6_520: `meta.ts` moved from a per-command `Date.now()`
      // to one clock read per microtask turn, shared by every command dispatched
      // in that turn. Measured on the real dispatch path
      // (tests/clock-source-ab.test.ts, interleaved A/B): 1.42-1.67x on a bare
      // bus, 1.42-1.57x on dispatchBatch, 1.38-1.50x with an ordinary handler,
      // 1.18-1.24x with three plugins, and nothing once 50 listeners dominate -
      // ~15-25 ns per command, fixed. The cost here is the closure plus its two
      // module-level slots: measured 6_514, i.e. **14 bytes**.
      //
      //
      // 20 bytes of headroom, and the raise was argued down rather than taken:
      //   6_531  first cut - flag `typeof`-guarded, so unfoldable
      //   6_514  flag referenced bare + defined in build.mjs -> folds, costs 0
      //   6_508  cached clock reduced to ONE module slot (0 as the stale
      //          sentinel, since Date.now() cannot return 0)
      //   −2 B   inlining dict() at its one reachable call site - REJECTED,
      //          two bytes is not worth un-DRYing the prototype-key rule
      //   −3 B   dropping the `_clockFn` test hook - REJECTED, it is what lets
      //          clock-source-contained.test.ts prove no TTL can be frozen
      // 6_508 is the floor. Verified along the way that `dict()` is genuinely
      // reachable here (commandKey backs throttle + request dedup), so it is
      // not dead weight to be shaken out.
      // Ceiling 6_520 -> 6_540: the one-shot origin slot in stampMeta
      // (`_nextOrigin`, set by `_withOrigin`). Measured with a rebuilt dist at
      // each step: baseline 6_507 -> 6_532, i.e. **25 bytes**.
      //
      // This one is a genuine core tax and worth naming as such. It replaced
      // three PER-SITE workarounds that each lived in an OPTIONAL entry point
      // - a depth counter in plugins-io's sync(), a one-shot identity match
      // (`expectedRedo`) in chamber's history, and a payload spread in all
      // three - so a consumer importing none of them used to pay zero. Now
      // stampMeta consults the slot unconditionally and everyone pays.
      //
      // Taken anyway, because `meta.origin` is core surface, not an optional
      // -module concern: it is a documented field on every Command, and
      // `agentOrigin`'s deprecation note already promises the CORE stamps it.
      // The payload-key mechanism could only mark payloads that hold keys, so
      // primitives and arrays arrived unattributed - an infinite cross-tab
      // broadcast loop in sync(), a double-recorded redo, and an MCP command
      // invisible to an `origin === 'agent'` audit filter. Correct attribution
      // for every payload shape is worth 25 bytes; net source is −35 code lines.
      //
      // Argued down first, and both cheaper options rejected:
      //   6_521  read-only slot (drop the clear; let _withOrigin's `finally`
      //          scope it) - saves 11 B and STILL exceeds the old ceiling, so
      //          it does not avoid this raise. REJECTED anyway: scope
      //          semantics mark every dispatch made synchronously inside the
      //          callback, so a nested dispatch (a reaction firing during the
      //          marked one) would inherit the origin and have its own
      //          broadcast wrongly suppressed. One-shot matches the payload-key
      //          semantics it replaces; 11 bytes is not worth a new echo bug.
      //    ~0 B  `if (_nextOrigin !== undefined)` vs the branchless
      //          read-and-clear - measured identical after brotli. Kept the
      //          branchless form for the hot path, not for the bytes.
      // Perf, interleaved A/B (5 alternating reps, medians, per this repo's
      // clock-source-ab convention): dispatch with a history installed
      // 3_983 -> 3_978 hz (−0.14%), undo+redo cycle 10_421 -> 10_460 hz
      // (+0.37%) - both inside the run-to-run spread. NEUTRAL, not a win; the
      // deleted `expectedRedo` compare was already a null check in the common
      // case. Recorded so nobody re-derives this hoping for a speedup.
      // Ceiling 6_540 -> 6_560: `headersToObject()` - one owner for turning a
      // Response's headers into a plain object, replacing the same guard
      // written out longhand in `doFetch` and `doClientFetch`. Measured in
      // three steps, rebuilding dist each time:
      //   6_532  baseline (two inline guards; defect present)
      //   6_539  helper extracted, no key normalization        (+7)
      //   6_545  helper lower-cases keys                       (+6)
      //
      // Both increments were argued, not waved through:
      //   +7  DRY does NOT pay for itself in bytes here - brotli already
      //       de-duplicates the two identical expressions, so extraction buys
      //       maintainability only. Taken because the duplication is what let
      //       the two copies DRIFT: doFetch never re-read `raw.headers` and
      //       stayed correct, while doClientFetch's responseType handling went
      //       back to the raw object and reintroduced the crash the guard
      //       exists to prevent. One owner closes that channel.
      //   +6  Key normalization. A compliant `Headers` already lower-cases, so
      //       this is a no-op against a real Response - the argument for
      //       skipping it assumes EVERY implementation in every consumer's
      //       environment is compliant. If one is not, `res.headers
      //       ['retry-after']` / `['content-disposition']` miss with no error
      //       at all: backoff silently not honoured, filename silently lost.
      //       A silent mis-behaviour is worth more than six bytes to rule out.
      //       Correctness over the byte, deliberately.
      //
      // Not offset by anything: `doClientFetch` tree-shakes OUT of this bundle
      // (the consumer reaches `doFetch` via createHttpBridge), so its own
      // content-type fix costs this bundle nothing. 15 bytes of headroom.
      expect(br.length, `brotli bundle size grew unexpectedly (${br.length} bytes)`).toBeLessThan(6_560);

      // Symbol budget. These are all chamber.ts-only - should NOT appear in a
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

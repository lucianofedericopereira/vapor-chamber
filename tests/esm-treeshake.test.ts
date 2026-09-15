/**
 * ESM tree-shake regression test - locks the v1.2.0 signal-extraction win.
 *
 * Builds a synthetic consumer entry that imports a typical Blade-style API
 * surface (createCommandBus + createHttpBridge + logger) and asserts:
 *   1. The minified bundle stays under a brotli ceiling (the value and its
 *      ledger are at the assertion).
 *   2. The Vapor feature-detection registry from chamber.ts is fully tree-
 *      shaken - zero references to probeVue / applyVueModule /
 *      defineVaporCustomElement / waitForVueDetection / _vueOnScopeDispose -
 *      checked on an UNMINIFIED build of the same entry, since a minifier
 *      renames module-local names (see the note at the list).
 *
 * If this test fails, something added a side-effect import that drags
 * chamber.ts back into transports/plugins consumers. Investigate the
 * import graph before bumping the budget.
 *
 * Skips when dist/ hasn't been built or esbuild is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { build as viteBuild } from 'vite';
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
  it('typical Blade consumer bundle stays under its brotli ceiling + drops Vapor registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-treeshake-'));
    const entry = join(dir, 'consumer.mjs');
    const out = join(dir, 'consumer.bundle.js');
    const plain = join(dir, 'consumer.plain.js');

    writeFileSync(entry, `
      import { createCommandBus, logger } from '${dist('index.js').replace(/\\/g, '\\\\')}';
      import { createHttpBridge } from '${dist('transports.js').replace(/\\/g, '\\\\')}';
      const bus = createCommandBus();
      bus.use(logger());
      bus.use(createHttpBridge({ endpoint: '/api' }));
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

      // The SIZE ceiling is measured on a VITE production build - what a
      // consumer actually ships. The esbuild build above omits a NODE_ENV
      // define, so it keeps every DEV-warning branch a real app folds out; on
      // this consumer that was ~660 B of code no one receives (esbuild 6,775 vs
      // Vite 6,116, 2026-09-14). The esbuild bundles above stay for the
      // symbol check below; only the number the ceiling guards moved to Vite.
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
      // Ceiling UNCHANGED at 6_560, and that is the point - it is a ratchet
      // that makes a change pay for itself rather than a number to raise.
      // Measured in three steps, rebuilding dist each time:
      //   6_545  baseline
      //   6_563  + the one-shot CAUSATION slot in stampMeta (`_nextCausation`,
      //          set by `_withCausation`)                            +18
      //   6_554  - four pass-through wrappers in command-bus.ts       -9
      // Net +9, headroom 15 -> 6. The raise was proposed, then withdrawn: the
      // bytes came out of the code instead.
      //
      // The wrappers were `syncQuery`, `syncEmit`, `asyncQuery` and
      // `asyncEmit`, each forwarding its arguments to an `_inner` twin and
      // doing nothing else. `asyncQuery` was more than dead weight: an `async`
      // wrapper whose entire body was `return await inner(...)`, so every query
      // allocated a second promise and resumed a second async frame - one extra
      // microtask turn on top of the awaits it genuinely needs. `dispatch`
      // keeps its split, because there the outer half owns the depth guard's
      // `try/finally` and the inner half stays optimizable without it.
      //
      // The same core tax as `_nextOrigin`'s 25 B two rows above, for the same
      // reason and by the same mechanism: `__causationId` in the payload can
      // only mark payloads that hold keys, so a number, string, boolean or
      // array arrived with no causation at all. `createReaction`'s `maxHops`
      // cap counted hops off that key, so `mapPayload: () => 42` made every hop
      // read as hop 1 and the cap never fired - measured, an indirect cycle ran
      // to MAX_DISPATCH_DEPTH (16) instead of stopping at 4 on a sync bus, and
      // `ReactionOptions.allowSelfMatch` documents that the async case has no
      // depth backstop at all and spins forever. A cycle guard that silently
      // stops guarding is worth 18 bytes.
      //
      // Argued down first, and the cheaper shape was REJECTED by measurement:
      //   6_564  clearing both slots in one chained assignment
      //          (`_nextOrigin = _nextCausation = undefined`) - reads cheaper,
      //          measured one byte WORSE than two separate clears, because
      //          brotli is not linear in source length. Reverted.
      //   6_563  two separate read-and-clear pairs. Shipped.
      // `_withCausation` itself tree-shakes out of this bundle - nothing here
      // imports `utilities.ts` - so the 18 B is the slot and its two reads.
      // 6_560 -> 6_590, and this is the FIRST raise rather than a payback. The
      // rule here has been "the bytes come out of the code instead", and twice
      // in this cycle they did (a `WeakMap` that turned out to be identifier
      // noise; a `countOption` import swapped for a negated comparison). This
      // time they do not, and the reason is worth writing down rather than
      // hiding in a smaller number.
      //
      // Five shipped plugins read `next()`'s return value as a CommandResult.
      // On the ASYNC bus that value is a PROMISE, so `promise.ok` is undefined
      // and every one of them took the wrong branch, silently. Measured through
      // the public API:
      //
      //   logger()          console.error on EVERY command, `error: undefined`,
      //                     successes included; the result value never printed
      //   history()         recorded nothing - undo/redo inert
      //   circuitBreaker()  OPEN after five consecutive SUCCESSES, refusing
      //                     traffic that was working
      //   metrics()         `ok: undefined`, 0.02ms recorded for a 30ms handler
      //   persist()         never saved
      //
      // `src/settled.ts` is the one rule they now share. Its cost in THIS
      // bundle, which imports `logger`, measured in two steps:
      //
      //   6_593  the helper plus a `dualPlugin()` wrapper
      //   6_588  wrapper deleted - it was an identity function shipped to carry
      //          a type, so a plain cast is the same thing for free
      //
      // 28 B over, in a 6.5 KB budget, to stop a circuit breaker tripping on
      // success. The ceiling is a ratchet against sprawl, not against fixing a
      // defect it happens to sit in front of - but it did its job here twice
      // before this, which is why the raise is 28 and not more.
      // Ceiling on the VITE production number (6,116 measured 2026-09-14);
      // 6_300 leaves headroom for queued features. The esbuild ledger above is
      // history: it tracked the old esbuild-no-define number, retired here.
      // Ceiling 6_300 -> 6_310: dispose() settles waiting request()s and the
      // sync request() honours its caller's signal (CHANGELOG v1.20.0). The
      // queued features had used the headroom (6,240 on the base). Measured
      // on this consumer, one build each:
      //   6_240  base
      //   6_247  + the `waiting` field, its init and the dispose() loop     +7
      //   6_249  + the async request()'s cancel - the async bus is not in
      //          this bundle; shared text moves                            +2
      //   6_307  + the sync request(): the pre-flight abort check, the
      //          listener add and remove, the Set add and delete          +58
      // abortedResult was already here through the HTTP bridge, so the sync
      // bus pays only its calls. Squeezed before this raise: one closure for
      // the dispose cancel and the abort listener (-4 here, one allocation
      // fewer), `||=` for the lazy Set (+1 here, -4 / -4 / -8 on the three
      // IIFEs), a forEach dispose line (+5, declined). What remains is the
      // feature: 3 B of headroom.
      // 6_299 after q2/2: the VC_CORE_ABORTED message loses "before it ran",
      // which was false for every mid-flight abort. The ceiling stays 6_310.
      // Ceiling 6_310 -> 6_360: a before-hook's throw is a
      // VC_CORE_BEFORE_CANCEL result (q3/1). Measured on this consumer:
      // 6_345 with the helper and both call sites (+46), 6_351 with the
      // stack-capture guard the cancelled path needed (+6, net of a dropped
      // explicit severity). 9 B of headroom.
      // Ceiling 6_360 -> 6_380: dispose() runs each installed plugin's
      // dispose() (cancel/1). The loop inlined in both dispose functions,
      // 6_351 -> 6_373 (+22; as a helper with typeof and .call +38, with an
      // optional call +34). retry() is not in this bundle. 7 B of headroom.
      // 6_376 after undo/1: the scoped-origin read in stampMeta (+3; the
      // history code that uses it is not in this bundle). Ceiling unchanged,
      // 4 B of headroom.
      expect(viteBr.length, `vite production brotli grew unexpectedly (${viteBr.length} bytes)`).toBeLessThan(6_380);

      // Symbol budget. These are all chamber.ts-only - should NOT appear in a
      // consumer bundle that doesn't import Vue composables.
      //
      // Read off the UNMINIFIED build. Until batch 3 this list was checked
      // against the minified output, where a minifier renames every
      // module-local identifier - so `probeVue`, `applyVueModule` and
      // `_vueOnScopeDispose` could never appear there, and three of these
      // seven names guarded nothing. Measured on a consumer that ALSO imports
      // `vapor-chamber/vue` (which pulls chamber.ts in): minified, it carried
      // four of the seven (`waitForVueDetection` and the three `defineVapor*`
      // property names); unminified, all seven, and this check fails on it.
      // The ceiling above still reads the minified build, and did not move.
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

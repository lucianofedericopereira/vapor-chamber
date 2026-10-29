/**
 * ESM tree-shake regression test - locks the v1.2.0 signal-extraction win.
 *
 * Builds a synthetic consumer entry that imports a typical Blade-style API
 * surface (createAsyncCommandBus + httpTransport + logger) and asserts:
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
 * Fails when dist/ hasn't been built (tests/require-dist.ts); skips when
 * esbuild is unavailable.
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
      // reachable here (commandKey backs request dedup), so it is
      // not dead weight to be shaken out.
      // Ceiling 6_520 -> 6_540: the one-shot origin slot in stampMeta
      // (`_nextOrigin`, set by `_withOrigin`). Measured with a rebuilt dist at
      // each step: baseline 6_507 -> 6_532, i.e. **25 bytes**.
      //
      // This one is a genuine core tax and worth naming as such. It replaced
      // three PER-SITE workarounds that each lived in an OPTIONAL entry point
      // - a depth counter in plugins-io's createChannel(), a one-shot identity match
      // (`expectedRedo`) in chamber's history, and a payload spread in all
      // three - so a consumer importing none of them used to pay zero. Now
      // stampMeta consults the slot unconditionally and everyone pays.
      //
      // Taken anyway, because `meta.origin` is core surface, not an optional
      // -module concern: it is a documented field on every Command, and
      // the MCP layer relies on the CORE stamping it.
      // The payload-key mechanism could only mark payloads that hold keys, so
      // primitives and arrays arrived unattributed - an infinite cross-tab
      // broadcast loop in createChannel(), a double-recorded redo, and an MCP command
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
      // (the consumer reaches `doFetch` via httpTransport), so its own
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
      // sync request() honours its caller's signal (v1.20.0). The
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
      // 6_299 after q2/2: the core:aborted:dispatch message loses "before it ran",
      // which was false for every mid-flight abort. The ceiling stays 6_310.
      // Ceiling 6_310 -> 6_360: a before-hook's throw is a
      // core:refused:hook result (q3/1). Measured on this consumer:
      // 6_345 with the helper and both call sites (+46), 6_351 with the
      // stack-capture guard the cancelled path needed (+6, net of a dropped
      // explicit severity). 9 B of headroom.
      // Ceiling 6_360 -> 6_380: dispose() runs each installed plugin's
      // dispose() (cancel/1). The loop inlined in both dispose functions,
      // 6_351 -> 6_373 (+22; as a helper with typeof and .call +38, with an
      // optional call +34). The retry plugin was not in this bundle. 7 B of headroom.
      // 6_376 after undo/1: the scoped-origin read in stampMeta (+3; the
      // history code that uses it is not in this bundle). Ceiling unchanged,
      // 4 B of headroom.
      // 6_363 after v1.24.0's RFC 9457 problem documents (+7 against the
      // published v1.23.0, one build each: the `+json` test, `detail` in
      // responseError, the wider Accept). Ceiling unchanged, 17 B of headroom.
      // Ceiling 6_380 -> 6_280 (v1.25.0). The fixes first measured 6_413
      // (register()'s ownership-checked cleanup, the catalogue's severity on
      // the throttled and aborted refusals, the Idempotency-Key as a
      // Structured Field String), over the old ceiling. Not raised: advice
      // moved to DEV (docs/contract.md rule 5, the fix text is the catalogue's)
      // and register({ throttle }) and throttle() share one gate. Measured
      // 6_260, below v1.24.0's 6_363. This LOWER ceiling locks it; 20 B of
      // headroom.
      // Ceiling 6_280 -> 6_340 (Unreleased, owner-by-wiring failures, plan
      // 4.5). Measured 6_328 against 6_260, +68: `toJSON` with only the needed
      // members (~25; a `type` docs URL would have cost 77 more and was left
      // out), the stack decision made once in the constructor, the owner slot
      // and each plugin's bound `fail`, the private `#code` and its getter, the
      // `remote` refusal. Squeezed first: a shared `failsFor`, `pluginThrew`
      // taking the runner's `fail`, `backendError` losing its dead `emitter`
      // (-37 raw, 0 brotli: brotli already folded the repeats). 12 B headroom.
      // Ceiling 6_340 -> 6_425 (Unreleased, the wire contract, docs/contract.md 4):
      // the status table, the transport readers of one answer shape,
      // net of the readers and catch paths they replaced. Measured 6_412
      // against 6_328, after the redirect advice moved to DEV and
      // `Retry-After` parsing lost its null. 13 B headroom.
      // Ceiling 6_425 -> 6_440: the HTTP client's retry back to 1.24 (5xx
      // retried, `X-RateLimit-Reset` as the wait's fallback). Measured 6_427.
      // Ceiling 6_440 -> 6_460: the retry model (docs/retry.md). The
      // policy lives in the async bus, not in this bundle; what reaches it is
      // the bridges' `transport` declaration and the status table's new home
      // in the core. Measured 6_445 (+18).
      // Ceiling 6_460 -> 6_648, to the measured size (owner, log s35.67):
      // three correctness fixes, measured one at a time from 6_453: query
      // nests on the depth counter +4; async depth by parent, not by
      // dispatches in flight (17 concurrent were refused; three endless
      // loops) +126; one fan-out rule, the listeners that existed when a
      // dispatch started (a skip and a double call) +64.
      // Ceiling 6_648 -> 6_661, to the measured size (owner: "12 B is
      // acceptable", log s35.77): every plugin declares its id, the owner of
      // its failures. In this bundle: logger's id and the bridges' shared
      // TRANSPORT id. Measured alone (brotli is not additive): neither <=
      // 6_647, TRANSPORT only 6_648, logger only 6_664, both 6_660.
      // Ceiling 6_661 -> 6_671, to the measured size (owner: "no sweat size
      // increase", log s35.79): the status table's two new conditions
      // (409/412 conflict, 401/419 unauthenticated, 403 refused alone),
      // measured 6_670.
      // Ceiling 6_671 -> 6_765, to the measured size (owner: "no sweat size
      // increase", log s35.80): a problem's RFC 9457 `type`, the docs URL of
      // its condition (+93: the 83-character prefix barely compresses; plan
      // the ownership prototype measured 77 for a code-level URL in 2026-09).
      // Ceiling 6_765 -> 6_770, to the measured size (log s35.81): meta's
      // `idempotencyKey` slot, present from stampMeta (one meta map), +4.
      // Ceiling 6_770 -> 6_779, to the measured size (log s35.82): the
      // response's `url` and `redirected` from Fetch (#17), +9.
      // Ceiling 6_779 -> 6_810, to the measured size (log s35.83): a 304
      // resolved on opt-in, and the GET dedupe key carrying the request's
      // headers (a plain read was joined to a conditional one), +31.
      // Ceiling 6_810 -> 6_812, to the measured size (owner: "no sweat", log
      // s35.89): a Retry-After past 30 s read as declared, the client ending
      // a request on a wait over its own 30 s instead of the parser dropping
      // it. Measured 6_811 (+2).
      // Ceiling 6_812 -> 7_084, to the measured size (owner: "worth the
      // rise", log s35.100): Retry-After's HTTP-date read by RFC 9110 5.6.7,
      // the three forms in GMT and nothing else; the attribution is beside
      // BUDGETS in scripts/check-size.mjs. Measured 7_083 (+272).
      // Raised to measured for canUndo (s35.113), undo as a command and $ commands kept local (s35.114), an app's $ name refused (s35.117).
      // Raised to measured for the client's failures as the core's BusError, one answer reader, one retry rule (s35.131).
      // Raised to measured for one JSON body reader and a 2xx that is not the envelope failing (s35.132).
      // Raised to measured for actionFilter (s35.152): the bus reads it per action +17, the bridges pass it on +5 (the compiler stays out: +304 inside the bus).
      // Raised to measured for one abort shape (s35.154): AbortError name +9, the reason as cause +3, a rethrown reason read as the abort +41.
      // Raised to measured for a batch rolling back the Command that ran (s35.155): sync +33, async +7.
      // Raised to measured for history never undoing a bridged command locally (s35.159): the mark +27, the ledger 0.
      // Raised to measured for no reply on an unidentified command not re-sent (s35.162): the rule +61, the RateLimit read +70, the held-back report +46 (each left out alone; brotli is not additive, total +177).
      // Raised to measured for one spelling per request header name (s35.163): the check and its rebuild +95, deleting every spelling +28.
      // Raised to measured for async request() (s35.167): +13, the async execute line the sync bus shares a module with.
      // Raised to measured for a landed undo making every plugin forget the command (s35.181): the `{ ok: false }` check +8, onSettled +7 (logger already brings it in), each left out alone; total +41. Then the plugin walk as the index loop the hook runners use (s35.183): +6.
      // Raised to measured for a transport's answer handed to a handler's `answer` (s35.184): the `answers` map in register and the bus state +28, the async runner's settle +6 (shaken out, brotli context), each left out alone; total +32.
      // Raised to measured for sync dispatch building its Command before the depth's try (s35.204): one piece, +5.
      // Raised to measured for a batched result's or a frame's own `headers`, their Retry-After read as a response's (s35.205): the reader +54, the single bridge passing its response's -3, each left out alone; total +51. The two-copies hint 0 (DEV), the route table not in this bundle.
      // Raised to measured for hooks removed during a dispatch by the listeners' rule (s35.209): 8_346 -> 8_374, +28.
      // Raised to measured for commandKey keeping a BigInt or a circular target apart (1.30): the BigInt tag and the identity fallback 8_374 -> 8_434, +60. The ':' naming warning 0 (DEV).
      // Raised to measured for maxBufferSize read by countOption (audit D7, s36.11): read once when the bus is made, countOption's body enters this bundle, 8_434 -> 8_472, +38. Owner: the right fix over the size trade.
      // Raised to measured for request()'s timeout read by countOption (audit D8, s36.11): the sync bus's read, in its timer branch, 8_472 -> 8_519, +47. The async bus and the ws bridge are not in this bundle: 0 each, left out alone.
      // Raised to measured for every timer delay as a checked Delay (audit D10, s36.11): the http client's two hand-rolled readers, the directive's timeout and the throttle gate through delayOption, 8_518 -> 8_521, +3.
      // Raised to measured for a request JSON cannot encode, transport:invalid:json (audit D11, s36.11): the encoder and the http bridge encoding through it, 8_521 -> 8_586, +65 (+64 left out alone). The registry row and the client's check are not in this bundle: 0 each.
      // Raised to measured for a malformed XSRF-TOKEN cookie read as no cookie (audit HT-24, s36.11): a try around the cookie's decode, 8_586 -> 8_592, +6.
      // Raised to measured for two abort signals combined as AbortSignal.any does on every target, one helper (complexity review F1, log 36.13): the helper's fallback +21 (an input already aborted and its own detach +20 left out alone), the bridge's two sites through it +6, the per-request detach +8 left out alone; 8_592 -> 8_619, +27.
      // Raised to measured for each request building its own transport:missing:csrf after a shared refresh, marked by its own silent (complexity review B3, log 36.13): one piece, 8_619 -> 8_621, +2.
      // Raised to measured for the HTTP `retry` count read by the count rule, where a negative or NaN sent nothing (log 36.17): one piece, `countOption` at postCommand's read, 8_617 -> 8_627, +10.
      // Then runWithRetry's resend-or-leave written once and its cleanup in one `send` (complexity review F12, log 36.17): 8_627 -> 8_566, -61. This LOWER ceiling locks it.
      // Raised to measured for the two HTTP bridges' send and answer steps written once (complexity review F2, log 36.17). This bundle has the single bridge only, so it carries the helpers without the second copy they replace: `readAnswer` alone +20, `httpSender` (one send, one bridge signal) the rest; 8_566 -> 8_623, +57. Bundles with both bridges are 340 B smaller (min).
      // Raised to measured for commandKey keeping NaN and Infinity apart from null (compat step 1, log 36.25, owner: "rise budget here"): the tag alone +12, the shared keyText (src/canonical.ts) the rest; 8_623 -> 8_673, +50.
      // Then commandKey's key writer built once per caller and `typeof` tested where it is compared (V8 round item 1, log 36.36): the typeof tests -12, the writer built once +1; 8_673 -> 8_662, -11. This LOWER ceiling locks it.
      // Raised to measured for commandKey keeping function, symbol and wrapper targets apart (log 36.41, owner: size is no issue): the wrapper check alone +121, the identity key alone +51; 8_662 -> 8_835, +173.
      // Raised to measured for one reader of a response's declared wait (log 36.42): the epoch rule left out alone +28, a batched result's headers through the reader +7, the reader through `_answered` the rest; 8_835 -> 8_871, +36.
      // Raised to measured for the transport declared at the async bus (step 3a, log 36.45). The entry names the async bus and httpTransport now: e0c7e86 builds it to 9_881. Each piece left out alone: batch built into httpTransport +511 (owner: kept), the answers and store states written at the send +93 (moved from the runner), use()'s refusal +59, transport:failed:send +31, sendFrom +27 and the lookup's inlined hit path +19 (both speed), the lookup by pattern 0 (retry already brings it); 9_881 -> 10_614, +733 (the lookup without its undefined fallback -5, the 1.31 shape).
      // Raised to measured for the wire facts (step 3b, log 36.47). Each piece left out alone: the key in a batched command's `headers` member, appended as text (speed) +53, the unreserved scan that skips the encode (speed) +24, a batched result's own status +2, a command's `Accept` in place of X-Requested-With -3, the key out of `meta` -11; 10_614 -> 10_727, +113.
      // Raised to measured for one idempotency key (log 36.48). One piece in this bundle (no idempotent, no outbox): the retry stamps through the one rule, `_keyed`, 10_727 -> 10_744, +17.
      // Raised to measured for a 202 answering an `Accepted` (step 3c, log 36.49): every HTTP bundle follows a 202 now, where pollWith was opt-in. Each piece left out alone: the Accepted and its follow, with the poll's GET, +440, the batched result's 202 +4, `dispose` +2, the single answer's +1; 10_744 -> 11_269, +525.
      // Raised to measured for the hold (step 3e, log 36.51). Each piece left out alone: the single send's check +7, its two records -25, the batched send's check +10, its three records +17, the sender's `dispose` -6, the refusal's message +24 (brotli moves with the arrangement), the two shared functions the rest; 3d's 11_254 -> 11_438, +184.
      // Raised to measured for inbound pushes (step 3f, log 36.52): one piece in this bundle, the async bus giving each declared transport itself (`Transport.attach`), +94 raw, 11_438 -> 11_464, +26. The push applier stays with the transports that read pushes (WS, SSE, Echo), none in this bundle.
      // Raised to measured for cache groups (step 3g, log 36.53): the transports' read of a batched result's or a frame's group header +58, the plugin `attach` +14, the DEV-only call sites the rest (no warning text in production). The field reader stays in the client, out of this bundle (it cost +164 here first). 11_464 -> 11_563, +99.
      // Raised to measured for a store's creation cost recovered (step 4e, log 36.62, owner: "land it"): register() building only what a call uses (speed: -40 to -122 ns a store creation) +15, the store registry folded into the bus's receivers map (-77 ns) -11; 11_563 -> 11_567, +4.
      // Raised to measured for the outbox as a bus option (step 4i, log 36.69): the async bus's hooks, in every async bundle with or without an outbox: the option read and `attach`, the resolve's `adapt` parameter, the outbox's `dispose` and the key symbol, creation code only. The wrapper, its map and the replay's send stay in outbox.ts (moving them out of the bus took this from +98 to +54). 11_567 -> 11_621, +54.
      // Lowered to measured for the buffer as a bus option (step 4i, log 36.73): the queue left the bus for createBuffer, which this bundle does not import. 11_621 -> 11_179, -442.
      // Raised to measured for `register(..., { optimistic })` (step 4k part 1, log 36.78). Each piece left out alone: optimisticRun, reached from every async dispatch's gate +134; the gate, the declared map and the register refusal +98. The sync bus's undo on a throw stays out: the sync factory hands it to register (in register directly, it pulled the whole sync dispatch in, +492). 11_179 -> 11_411, +232.
      // Raised to measured for `register(..., { exclusive })` (step 4k part 2, log 36.79). Each piece left out alone: `exclusively` with the scheduler's lanes +198; the lane read in dispatch and query, the field and the register rule +45; the run apart in its own function, so the common run keeps its one runner call (speed: async hooked +4.1 ns counted, recovered to +1.9 within MDE) +16. Cold code: it runs only for an action declared exclusive. 11_411 -> 11_670, +259.
      // Raised to measured for the store's optimistic and exclusive (step 4k part 3, log 36.80). The bus's half in this bundle: the turn taken at dispatch and waited for by the work (enterTurn, keyOf, atDepth), so a refused command never shows and the change shows before the turn (plan-architecture rows 5 and 112); the prediction of a sent action in optimisticRun; the async bus registering its sends check for the store. Cold code. 11_670 -> 11_864, +194.
      // Raised to measured for the bus's facts observer (step 5a, log 36.84), the command state's source: every bus tells it each command's start and settle once a command state listens. Each piece left out alone, raw/brotli: the two starts +35/+5, the two settles +37/-10 (brotli moves with the arrangement), the state's `facts` slot the rest. A fast lane in the observer's place cost +218/+70 here (and +16.8 ns a tracked dispatch); the observer's setter reads the inspect state, so no bus carries one. 11_864 -> 11_872, +8.
      // Raised to measured for a plugin made of parts (step 7a, log 36.98, 11_700 -> 11_759, +59: `use()` placing a `settled` part, logger smaller) and the rules before the work (step 7b, log 36.99, 11_759 -> 12_058, +299). 7b, each piece cut alone from the minified bundle, raw/brotli: `_rulesOf` 487/96, `_refusal` 211/59, `asyncRefused` 144/28, `ruleThrew` 115/7, the two run sites in dispatch and query, `use()` keeping the rules and its rule check the rest (about 500/110). A bus reaches them because `use()` may be given a rule part; a bus without one runs one null read per dispatch. One helper for the two run sites and one loop for the two kinds read +28 brotli worse, not kept.
      // Raised to measured for the one scope reader (step 7c, log 36.100): `_scoped`, which `_settledHook` calls to scope a plugin by `actions` and `actionFilter`, the patterns' answers kept per action, the call the rest; 12_058 -> 12_104, +46.
      // Raised to measured for `_scoped` classifying the patterns once (log 36.100, speed: the lone recorded history record +17 -> +6 ns against a per-action Map). `_scoped` cut alone 351 raw / 87 brotli; 12_104 -> 12_154, +50.
      // Raised to measured for one pattern classifier (step 8a, log 36.103): raw 37,422 -> 37,364 (-58). Each piece cut alone, raw/brotli, base then head: the classifier 61/15 -> 72/21, `matchesPattern` 209/60 -> 161/54, `_scoped` 362/104 -> 342/97; brotli moves with the arrangement (every reader smaller, the bundle +13). Cold code: a pattern is classified at subscribe and resolve time. 12_154 -> 12_167, +13.
      // Raised to measured for the facts slot with more than one observer (step 8b, log 36.105): every bus reaches it through `use()`. Each piece cut alone, raw/brotli: `_composeFacts` 461/100, a part's throw message 131/39, an `actionFilter` asked once per action 120/28, the one part loop 182/27, `recompose` and the command state's observer kept beside the state 59/8; `_settledHook` left. 12_167 -> 12_392, +225.
      // Raised to measured for the work's steps (step 8c, log 36.107): every bus reaches them through `use()` and the runner's bottom. Each piece cut alone, raw/brotli: `_stepped` 601/146, the tickets' signal, landing and answer 467/191 (signals folded without a detach: -48), `_stepsOf` 340/124, `land` 72/54; the five plugins as steps sit in plugins-extra, out of this bundle. 12_392 -> 12_754, +362.
      // Lowered to measured for the chain's removal (step 8d, log 36.108): the runners, `perAction`, the per-level throw boundary and `priority` left every bus. 12_754 -> 12_477, -277 (raw 39,853 -> 38,752). This LOWER ceiling locks it.
      // Lowered to measured for the public onBefore's removal (step 8e, log 36.109): the before-hook loops, their cancel and its code left every bus. 12_477 -> 12_368, -109 (raw 38,752 -> 38,261). This LOWER ceiling locks it.
      // Raised to measured for the per-action record (step 8f, log 36.110): one read per command for the handler, the rules, the steps, the transport and `declared`. Each piece cut alone, raw/brotli: the four clears (register, its cleanup, use, clear) 72/10, the record and its reads 220/92. Speed: plugins3_listener1 -9 to -12 ns FASTER. 12_368 -> 12_470, +102 (raw 38,261 -> 38,553).
      // Raised to measured for the rules following a plugin's scope (log 36.111): `_rulesOf` asks `_inScope` once per part and action, cold. 12_470 -> 12_478, +8 (raw 38,553 -> 38,597).
      // Raised to measured for the pattern reader in its own module (log 36.112): the same statements, raw unchanged at 38,597; the module's place in the bundle compresses 20 B worse (its import last in command-bus.ts, -2 against first). 12_478 -> 12_498, +20.
      // Lowered to measured for one header reader (log 36.114): the resend's Idempotency-Key check and the refresh's If-None-Match check read `_headerOf`. 12_498 -> 12_480, -18 (raw 38,597 -> 38,570). This LOWER ceiling locks it.
      // Raised to measured for one install per plugin (step 8g, log 36.115): `use()` refuses a plugin already installed, its check and message 134/60 raw/brotli; the shared-id warning is development only, out of this build. Cold: once per use(). 12_480 -> 12_540, +60 (raw 38,570 -> 38,704).
      // Raised to measured for the reporter (step 8h, log 36.118): every warning and error the core detects goes to `_report` with its code. Each piece left out alone, raw/brotli: the context objects a sink receives 284/80, the plugin's parts in its throw report 164/-11, the reporter module, the codes and the rewritten sites 297/184. Failure and warning paths only; the formatter reads no registry (log 36.121). 12_540 -> 12_793, +253 (raw 38,704 -> 39,449).
      // Raised to measured for the level tag and the floor (log 36.126): each left out alone, raw/brotli, the tag 59/30, the floor 37/13. 12_793 -> 12_835, +42 (raw 39,449 -> 39,553).
      // Raised to measured for the stores' fact lane (1-7 fix-up, log 36.F1, attributed in 36.F3): every async bus carries the reply's `stores` emit, the `{ entries, lane }` record, its clear and the size check of the send. A factory for the record cost +13 more and was dropped. 12_835 -> 12_861, +26 (raw 39,553 -> 39,626).
      // Raised to measured for use() refusing a transport that carries `attach` (log 36.F11): one piece, the `send` test in the plugin check, cold (once per use()). 12_861 -> 12_867, +6 (raw 39,626 -> 39,653).
      // Raised to measured for local cache groups, one group hub per bus (1-7 fix-up M2, log 36.F12): register's `cacheGroups` and `cacheGroupInvalidation`. Cold code: registration and creation. Each piece cut alone from the minified bundle, raw/brotli: the declaration, its register call and cleanup 327/118, the bus's group record and accessor 145/52, the transport's attach joining its client 110/49, the answers without a client calling the hub (development only before) 46/30, clear() dropping the members 27/12; all together 655/221, the rest is groupsTo's one hub branch. 12_867 -> 13_096, +229 (raw 39,653 -> 40,309).
      // Raised to measured for the group listener only with a hub (log 36.F13): a declaration waits for the bus's hub, so a bus with none keeps its bare path. Cold code: registration and the hub's creation. Each piece cut alone, raw/brotli: the declaration's start literal and its wait 98/31, clear() dropping the declared 67/15, the record's declared set 17/6, `_setHub` 68/4, the cleanup deleting the declared 35/-14 (brotli moves with the arrangement); all together 285/82. 13_096 -> 13_143, +47 (raw 40,309 -> 40,538).
      // Raised to measured for the library's own commands an app names (a form's, history's trigger) staying local under any transport (step 9 shadow fix): cold code, registration and the action's record. Each piece left out alone, brotli: register's mark and the reader it imports 34, clear() 5, the cleanup 3, the record's check -1, the state's map 0; all together 59. 13_143 -> 13_202, +59.
      // Raised to measured for register() refusing a handler that could never run (step 9 shadow fix, `_checkHandler`): cold code, once per registration. Each piece left out alone, brotli: the rule and its three messages 119, `optimistic` needing a handler 17, the literal's `localFallback` 4, the transport's lookup at register 3, `null` removing the handler -1; the rest is the function's own boundary. 13_202 -> 13_372, +170.
      // Raised to measured for a 202's `Accepted` applying when its `done` settles (log 36.F28): the answer path's `Accepted` branch, `later` and its new `Accepted` 19, the check that follows nothing when nothing would apply 15. The 202 path only. 13_372 -> 13_406, +34.
      // Raised to measured for the bundler alone, rolldown 1.2.12 -> 1.2.15 (vite 8.3.5 pulls it, vite 8.3.4 on 1.2.15 gives the same bytes): no source changed. 13_406 -> 13_411, +5 (raw 41,481 -> 41,475).
      // Raised to measured for the action's live registrations (B4 f, log 36.F42): the newer owner leaving gives the action back to the one it covered. Cold code: registration and its cleanup. Each piece read from the minified bundle, raw/brotli: register's writes and removals as one closure per call, the held list and the give-back 392/137 (register alone, 912/426 -> 1,304/563), the state's `owners` and `held` and their clear 52/5. A smaller arrangement (two closures in a record and one list per action, 13_516) cost +236 ns per store create and dispose in a pilot, so speed took this one (+34, a no result). The hot update's check is development only, out of this build. 13_411 -> 13_553, +142 (raw 41,475 -> 41,919).
      // Lowered to measured for the paths the live registration made unreachable (log 36.F42): exclusiveRun's catch, optimisticRun's send with no change shown and its handler check, `dropOwn`. 13_553 -> 13_500, -53 (raw 41,919 -> 41,767). This LOWER ceiling locks it.
      // Raised to measured for after-hooks with no async frame (phase 2 C1, log 36.F45; owner 2026-10-24: "Raise to 13,524, land C1"). Each piece left out alone, raw/brotli: a hook's thenable handed to its settling 73/35, one plain loop in place of the wrapper and the async runner 0/-11, `hookFailed` shared against the report inline twice -12. Speed: async_hooks2_2 -61 ns at 4n, nothing slower. 13_500 -> 13_524, +24 (raw 41,767 -> 41,771).
      // Raised to measured for the retry's success with no `.then` and no thunk (phase 2 C2, log 36.F46; owner 2026-10-24: "Raise to measured, land C2"). Left out alone, raw/brotli: the no-step branch that calls the work itself and `retried`'s use of the retry's end 115/25; the rest, the retrier's two halves (`begin`, `end`, the refund and the policy read shared with `run`), asyncWork's own thunk and the callers' check, 293/94. Speed: app_async_local -71 ns at n, nothing slower. 13_524 -> 13_643, +119 (raw 41,771 -> 42,179).
      // Raised to measured for a sync handler answering with no async frame (phase 2 C3, log 36.F47; owner 2026-10-24: "i prefer speed over bytes"). Left out alone, raw/brotli: `runLocal` wrapping the answer in a promise for the contracts that take one 47/-1; the rest, the handler's call apart from its thenable's settling, the thunks that may answer at once and `run`'s Promise.resolve, 137/+10. Speed: app_async_local leans -66 / -78 ns, nothing slower. 13_643 -> 13_652, +9 (raw 42,179 -> 42,363).
      // Raised to measured for `_postJson` with no async frame (phase 2 C4, log 36.F48; owner 2026-10-24: "i prefer speed over bytes"). One piece: the try around its body that keeps a throw a rejection, 33/11 raw/brotli. A wrapper with the body as its own function read 13_681 and was dropped. Speed: bridge_ok -203 ns at n, the sent rows lean faster, nothing slower. 13_652 -> 13_663, +11 (raw 42,363 -> 42,396).
      // Lowered to measured for use() calling a part's attach before it places the plugin (log 36.F55): an attach that throws refuses the install with no try (a try in use() read 13_753). 13_663 -> 13_658, -5 (raw 42,396 -> 42,397). This LOWER ceiling locks it.
      // Raised to measured for one command map on both buses (log 36.F56; owner 2026-10-24: "do both"): `signal: undefined` in the sync dispatch, query, batch and request literals and the async query's, 14 raw / 7 brotli. Speed: every row no result, a bare sync dispatch 0.999x. 13_658 -> 13_665, +7 (raw 42,397 -> 42,411).
      expect(viteBr.length, `vite production brotli grew unexpectedly (${viteBr.length} bytes)`).toBeLessThan(13_666);

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

/**
 * Bundle-size budget guard.
 *
 * Fails CI if any IIFE variant exceeds its brotli budget. Locks the perf wins
 * from v1.2.0 (audience-split + signal extraction + listener bucketing) so a
 * future change can't silently regress the headline numbers.
 *
 * Adjust thresholds in BUDGETS when an intentional size change lands - the
 * goal is "intentional only", not "never grow".
 *
 * Run: node scripts/check-size.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

// Brotli q=11 budgets, in bytes. Values are intentionally a bit above current
// measurements to absorb minifier output drift between Vite versions.
// Budgets updated for v1.4.0: AlienSignalWrapper class in alien-signals.ts
// (class refactor for V8 hidden class stability). alien-signals is a regular dep
// but NOT auto-bundled - opt in via configureAlienSignals from vapor-chamber/alien-signals.
const BUDGETS = {
// All bumps below are v1.6.0, across all three IIFE variants:
  //  • +~60-120 B for the shared useCommandState core refactor backing the
  //    vapor-chamber/reactive companion;
  //  • +~120-230 B (brotli) for onMissing:'buffer' deferred dispatch in
  //    command-bus.ts (the exo island-hydration feature);
  //  • +~75-160 B raw for createEchoBridge in transports.ts (Reverb/Echo realtime,
  //    bundled into the IIFEs alongside createHttpBridge).
  //   The idempotent plugin lives in plugins-extra and is NOT in these bundles.

  // Vite 8 (rolldown-based, replacing esbuild) shifted minified output: brotli got
  // SMALLER across all three (full 10.4->10.2, core 7.1->7.0, elements 7.5->7.4) but raw
  // nudged up - core raw crossed 25_000 by ~46 B. Raw ceiling absorbs that toolchain
  // drift; brotli ceilings stay put (the meaningful metric, and it improved).

  // v1.7.x bumps, two batches:
  //  • raw ~+0.3-0.6 KB - leak/correctness fixes: idempotent() eviction cap,
  //    useCommandError ring buffer, abort-listener detach in http retries, WS
  //    reconnect guards, directive timeout clear, schema validator precompile,
  //    CommandResult union.
  //  • raw ~+0.7 KB / brotli ~+0.2 KB - HTTP bridge surfaces backend body
  //    error messages (feature code), plus the sync-bus async-plugin dev
  //    warning. The warning is inert in these bundles (its env check folds to
  //    false at runtime) but rolldown's minifier doesn't constant-fold
  //    `typeof process < "u" && !1`, so its string ships as dead bytes -
  //    revisit if oxc gains that fold.
  // v1.8.0 bumps: logger level filtering + [ OK ]/[ FAIL ] badges (+~295 B min
  // in plugins-core), RETRYABLE_CODES beside BusError (+~170 B), retry()
  // registry-aware default (+~100 B). The outbox/mcp/typed-contract modules are
  // subpath-only and do NOT ship in these bundles.
  // TODO burn-down bumps (33 findings closed). rev 28 of the working list
  // predicted this check would need them - the budgets had ~0.1 KB brotli
  // headroom left and four of the items touch IIFE-bundled modules - and
  // recorded the decision up front: **correctness goes over size**, grant the
  // bumps rather than shave the fixes to fit. Measured deltas, brotli:
  // full +0.17 KB, core +0.11 KB, elements +0.08 KB. What is in them:
  //  • command-bus.ts - re-entrant plugin runners (one closure per level in
  //    place of a shared cursor, both sync and async), identity-based cursor
  //    correction in `fanOutListeners`, `__origin` in `stampMeta`, the
  //    transactional/continueOnError dev-warn.
  //  • http.ts / http-cache.ts - the response cache moved into
  //    `createHttpClient`'s closure (per client), literal-substring
  //    invalidation with metachar escaping, and the non-transient re-throw
  //    that stops 4xx re-entering retry.
  //  • freeze.ts - new shared module (dev-only deep freeze) pulled in by both
  //    caches.
  //  • stream-parser.ts - chunked `flush()`.
  //  • schema.ts - non-object target/payload rejection + the `'object'` arm.
  //  • directives.ts - per-document delegation map + the composedPath walk.
  // Dev-only strings (the new warnings) ship as dead bytes in these bundles
  // for the reason already noted above: rolldown does not constant-fold
  // `typeof process < "u" && !1`, so the messages survive minification even
  // though the branch cannot run. Same caveat, same revisit condition.
  // rc.3: NO bump needed. Vapor detection gained a library-owned global slot,
  // `configureVue()`, and a three-way `vueDetectionHint()`. First cut went 35 B
  // raw / 50 B brotli over the ceiling; tightening the hint to one shared tail
  // plus three short causes (and dropping a single-use helper) recovered
  // 190 B raw / 65 B brotli, landing at 39_445 / 11_485 - inside the existing
  // budgets. The hint is deliberately NOT dev-gated: the audience that hits
  // this failure is the no-bundler <script>-tag page, which only ever runs a
  // production IIFE, so stripping it in prod would delete the diagnosis
  // precisely where it is needed.
  // v1.13.0 - composable dispatches now suspend reactive tracking, so a
  // handler's reads stop becoming dependencies of the caller's effect. Only
  // `full` moves (+71 B raw / +44 B brotli): it is the variant that carries the
  // composables, which is exactly the audience the fix is for.
  //
  // `core` and `elements` did NOT move, and that is the design rather than
  // luck. Whether a bundle is a <script>-tag build is a BUILD-time fact, so
  // `scripts/build.mjs` defines `__VC_IIFE__` and the probe for
  // `@vue/reactivity` const-folds away - verified: the specifier string
  // appears 0 times in all three IIFE bundles. Nobody pays for a code path
  // their build can never take.
  // 11_600 -> 11_700 (2026-09-14): the per-target loading feature (isLoading)
  // adds ~200 B br; the size + perf audits gave back 268 (BusError declare,
  // helper dedup) + 32 (shared result hidden class), so the net merged full
  // IIFE is 11,625 - 25 over the old bar. Raised with ~75 B headroom because
  // more features are queued. core/elements stayed under and are unchanged.
  // 2026-09-15, one block for all three moves - full brotli 11_700 -> 11_810,
  // full raw 39_800 -> 39_900, elements brotli 8_450 -> 8_480: the plugin-throw
  // work. A plugin's throw or rejection becomes a VC_PLUGIN_THREW result at
  // each plugin's boundary, and onMissing:'throw' is settled before it is
  // re-thrown. Squeezed BEFORE this raise, every piece measured by reverting it
  // in the minified bundle (brotli q11, full / core / elements): async runner
  // per-level 38/42/45, pluginThrew 55/57/61 (of it the NO_HANDLER pass-through
  // 17/19/23), sync settle + onMissing gate 24/29/29, async settle 17/21/27,
  // sync runner try 5/3/8, chamber dedupe 7/-/-. Four squeeze variants were
  // measured and declined (try/await per level: -45 B, and far slower - the
  // declinedAwait arm of tests/plugin-throw-ab.test.ts; the others under 20 B
  // or no speed gain). Measured: full 11,803 br / 39,862 raw, elements 8,449.
  // elements moves with it rather than staying at 8,449/8,450, so the next
  // unrelated byte there does not fail CI for someone with no context.
  // 2026-09-15, full only - brotli 11_810 -> 11_817, raw 39_900 -> 39_933:
  // history() recorded a redo twice on an ASYNC bus (its recorder runs when
  // the dispatch settles, after redo()'s `finally` cleared `_replaying`) and
  // wiped the redo stack. The redo dispatch now carries origin 'redo'
  // (`_withOrigin`) and the recorder skips it; the flag stays for the sync
  // bus. Every piece measured on the full IIFE, brotli (base 11,803): the
  // wrap alone +5, the check alone +13, both +14 with the check first (+20
  // with it after the action tests, +17 with `!=`; `cmd.meta.origin` without
  // `?.` does not typecheck). The origin-only form the composable uses is +8
  // but would record an undo handler's own dispatches on the sync bus -
  // declined. The next 7 B would have to come from unrelated code. Measured:
  // full 11,817 br / 39,933 raw. core and elements carry no history() and
  // did not move.
  // 2026-09-15, full brotli 11_817 -> 11_825 (raw unchanged): a sealed bus
  // refuses clear() (VC_CORE_SEALED). seal() commits the ledger, and clear()
  // on a sealed bus deleted the undo handlers, so history().undo() rolled back
  // nothing. Measured on the full IIFE (base 11,817 br / 39,933 raw): the
  // guard at both public clear() sites +10 / +44; one guard inside the shared
  // clearState +12; the same guard as a comma expression +12; guards inside
  // syncClear/asyncClear with dispose() calling clearState itself +22 / +95.
  // Shipped: the first, plus assertNotSealed/addHook taking the state object
  // instead of `s.sealed` at all twelve call sites - 11,825 / 39,907, so raw
  // stays under its ceiling. core 7,957 and elements 8,448 stay under theirs.
  // 2026-09-15, full brotli 11_825 -> 11_905 and raw 39_933 -> 40_261,
  // elements brotli 8_480 -> 8_519 (core stays under, 8,020 / 27,254):
  // dispose() settles waiting request()s as VC_CORE_ABORTED, and the sync
  // request() honours its caller's signal (its type declared one; its body
  // read only timeout). One cancel per waiting request, in a state field that
  // is null until the first one; dispose() runs them. Every piece measured on
  // the committed base, brotli full / core / elements: the field, its init
  // and the two dispose() loops +16 / +12 / +13; the sync request() on top of
  // that +68 / +77 / +77; the async request() on top of the field +46 / +37 /
  // +38; all three together +89 / +81 / +83 (shared text is paid once).
  // Squeezed, one build each: the sync path's abort listener and its dispose
  // cancel as ONE closure -5 / -14 / -4, and one allocation fewer; `||=` for
  // the lazy Set -4 / -4 / -8 (+1 on the Blade consumer bundle, see
  // tests/esm-treeshake.test.ts); the dispose line as `s.waiting?.forEach`
  // +7 / +8 / +15, declined; the listener closure always created -7 / -3 / -3
  // but an allocation per waiting request that has no signal, declined. The
  // first design, a bus-owned AbortController composed with the caller's
  // signal on every request, fit here (full 11,822) and measured 1.7-1.9x on
  // the sync waiting path and 1.24x on the async request - declined
  // (rc-alignment-work.md s33). Measured: full 11,905 / 40,261, core 8,020 /
  // 27,254, elements 8,519 / 29,018.
  // Then q2/2, all three smaller: the VC_CORE_ABORTED message read "was
  // aborted before it ran" for every abort, mid-flight ones included (a
  // caller's abort while a request or a bridge waited, and dispose()); it
  // reads "was aborted" now. Measured: full 11,900 / 40,247, core 8,014 /
  // 27,240, elements 8,514 / 29,004; the full and elements budgets follow
  // the measurement down.
  // Then q3/1, all three larger - full brotli 11_900 -> 11_960 and raw
  // 40_247 -> 40_503, core brotli 8_050 -> 8_084 (raw stays under 27_600),
  // elements brotli 8_514 -> 8_582 and raw 29_100 -> 29_260: a before-hook's
  // throw is a VC_CORE_BEFORE_CANCEL result (beforeCancel at both catch
  // sites, exported for the TestBus), the code the union had declared since
  // v1.0 and never produced. Measured, brotli full / core / elements: the
  // helper and its two call sites, with an explicit severity and the stack
  // captured, +52 / +67 / +60; then the stack-capture guard the cold path
  // needed (a cancelled dispatch cost 2.2x with the capture, 1.05-1.09x
  // without - tests/before-cancel-ab.test.ts), net of the dropped severity,
  // +8 / +3 / +8. Measured: full 11,960 / 40,503, core 8,084 / 27,496,
  // elements 8,582 / 29,260.
  // Then cancel/1 - full brotli 11_960 -> 12_033 and raw 40_503 -> 40_878,
  // core brotli 8_084 -> 8_170 and raw 27_600 -> 27_871, elements brotli
  // 8_582 -> 8_661 and raw 29_260 -> 29_635: dispose() runs each installed
  // plugin's dispose(), and retry() tracks its backoff sleeps so dispose()
  // can end them as VC_CORE_ABORTED. Measured, brotli full / core / elements,
  // retry included in all three: the loop as a helper with typeof and .call
  // +82 / +99 / +97; the helper with an optional call +3 / -7 / -4 on that;
  // the loop INLINED in both dispose functions with the optional call -9 /
  // -13 / -18 on the first - SHIPPED; the Blade consumer bundle carries +22
  // of it, retry not being in that bundle. Measured: full 12,033 / 40,878,
  // core 8,170 / 27,871, elements 8,661 / 29,635.
  // Then undo/1 - full brotli 12_033 -> 12_094 and raw 40_878 -> 40_944,
  // core 8_170 -> 8_177 (raw 27_891), elements 8_661 -> 8_673 (raw 29_655):
  // one rule for dispatches made inside an undo handler or a redo - a scoped
  // origin read in stampMeta (`_withOriginScope`), the history plugin's
  // `_replaying` flag gone, the composable scoped the same way. core and
  // elements carry the slot read only (+7 / +12); full carries the plugin
  // and composable changes too. Measured: full 12,094 / 40,944, core 8,177 /
  // 27,891, elements 8,673 / 29,655.
  'vapor-chamber.iife.min.js':          { rawMax: 40_944, brotliMax: 12_094 },
  'vapor-chamber-core.iife.min.js':     { rawMax: 27_891, brotliMax: 8_177  },
  'vapor-chamber-elements.iife.min.js': { rawMax: 29_655, brotliMax: 8_673  },
};

const BR_OPTS = { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

let failed = false;
const rows = [];

for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = `dist/${file}`;
  if (!existsSync(path)) {
    console.error(`✗ missing: ${path} - did you run \`npm run build\`?`);
    failed = true;
    continue;
  }
  const buf = readFileSync(path);
  const raw = statSync(path).size;
  const br = brotliCompressSync(buf, BR_OPTS).length;
  const overRaw = raw > budget.rawMax;
  const overBr  = br  > budget.brotliMax;
  if (overRaw || overBr) failed = true;
  rows.push({ file, raw, br, budget, overRaw, overBr });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n  ${pad('variant', 38)} ${pad('raw', 12)} ${pad('budget', 12)} ${pad('brotli', 10)} ${pad('budget', 10)}`);
for (const r of rows) {
  const rawCell = pad(kb(r.raw), 12) + (r.overRaw ? ' ✗' : '');
  const brCell  = pad(kb(r.br), 10)  + (r.overBr  ? ' ✗' : '');
  console.log(
    `  ${pad(r.file, 38)} ${rawCell.padEnd(12)} ${pad(kb(r.budget.rawMax), 12)} ${brCell.padEnd(10)} ${pad(kb(r.budget.brotliMax), 10)}`,
  );
}
console.log();

if (failed) {
  console.error('✗ Bundle-size budget exceeded.\n');
  console.error('  If the increase is intentional (e.g. you added a feature):');
  console.error('  1. Confirm the new size is what you expect with `npm run build`.');
  console.error('  2. Update BUDGETS in scripts/check-size.mjs.');
  console.error('  3. Note the size change in CHANGELOG.md under the relevant version.\n');
  process.exit(1);
}

console.log('✓ All variants under budget.\n');

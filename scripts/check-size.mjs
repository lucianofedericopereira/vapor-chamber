/**
 * Bundle-size budget guard.
 *
 * Scope: the three IIFE files in dist/ (BUDGETS lists them), each against a
 * raw ceiling AND a brotli q=11 ceiling. Exit 1 when either is exceeded or a
 * file is missing (run `npm run build` first). It does not measure the ESM
 * entries or the subpaths; `npm run size` (measure-size.mjs) reports those.
 * Runs in the CI `check` and macOS jobs and in `npm run gate`.
 *
 * Adjust thresholds in BUDGETS when an intentional size change lands - the
 * goal is "intentional only", not "never grow". The comments inside BUDGETS are
 * the ledger of each move: what grew, what was measured, what was declined.
 *
 * Run: node scripts/check-size.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

// Raw and brotli q=11 ceilings, in bytes. Values are intentionally a bit above
// current measurements to absorb minifier output drift between Vite versions.
// alien-signals is an optional peer dependency and is NOT bundled into these
// files - opt in via configureAlienSignals from vapor-chamber/alien-signals.
const BUDGETS = {
// All bumps below are v1.6.0, across all three IIFE variants:
  //  • +~60-120 B for the shared useCommandState core refactor backing the
  //    vapor-chamber/reactive companion;
  //  • +~120-230 B (brotli) for onMissing:'buffer' deferred dispatch in
  //    command-bus.ts (the exo island-hydration feature);
  //  • +~75-160 B raw for createEchoBridge in transports.ts (Reverb/Echo realtime,
  //    bundled into the IIFEs alongside the HTTP transport).
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
  // (docs/rc-alignment-log.md s33). Measured: full 11,905 / 40,261, core 8,020 /
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
  // Then rc9/47-54, all three SMALLER, and the budgets follow the measurement
  // down - full brotli 12_094 -> 11_884 and raw 40_944 -> 39_938, core 8_177
  // -> 8_056 and raw 27_891 -> 27_364, elements 8_673 -> 8_554 and raw 29_655
  // -> 29_128. Three contributors, none of them a size exercise:
  //   • sync() stopped being a bus plugin and became a bridge over an event
  //     channel, which deleted its echo-suppression and async-promise arms;
  //   • two plugins that hand-rolled the thenable check went through
  //     `onSettled`, which removed a body each of them had written twice;
  //   • the inspect symbol stopped carrying `() => inspect(s)` and carries the
  //     STATE instead, so `inspect()` is reachable only from `inspectBus` -
  //     the biggest single piece, and the one two docblocks already promised.
  // These are LOWER ceilings and they lock the wins: the budgets had sat at
  // zero headroom since undo/1, so nothing here was bought with slack.
  // 2026-09-23, full only - raw 39_938 -> 39_947, brotli 11_884 -> 11_886.
  // `sync` was renamed `createChannel`, and this is the whole of it: the name
  // appears ONCE in the built full IIFE, as the export key, so 13 characters
  // replace 4. Verified by grep - one occurrence in `vapor-chamber.iife.min.js`
  // and zero in core and elements, which stay byte-identical and are the
  // control. The one other string the rename touched, the non-cloneable
  // payload warning, is DEV-gated and folds out of this build.
  // Raised rather than squeezed because there is nothing to squeeze: the cost
  // IS the public name, once, and no dead weight sits next to it to trade.
  // 2026-09-23, all three - the backend's `code` now survives an envelope
  // failure. Both HTTP bridges enriched an error when the failure THREW and
  // built a bare one when the same failure arrived as DATA, twelve lines apart
  // in the same function, so a 200 carrying `{ ok: false, code }` and every
  // batched failure (batch() answers 200, nothing throws) lost the field the
  // example controller promises reaches `HttpError.code`.
  //
  // MEASURED, per piece, against the previous ceilings:
  //   + the fix (4 envelope sites + one builder)   raw +64 / +61 / +61
  //                                             brotli  +2 / +13 / +14
  //   + sharing the two catch blocks               raw +30 / +33 / +33  NOT TAKEN
  //
  // The squeeze was attempted twice and is in the numbers above: assigning
  // `code` unconditionally rather than behind a `!== undefined` guard is
  // -14 B raw (and is the shape-stable form `okResult`/`errResult` already
  // use), and the shared-catch extraction was reverted because it COSTS 30 B
  // rather than paying for the fix. That second one re-derived a verdict
  // `transports.ts` already recorded; the note there now carries the number so
  // the next reader does not repeat it.
  //
  // What remains is the feature itself: four call sites carrying a field, and
  // a builder used by all four. Raised rather than squeezed further because
  // there is nothing left that is not the fix.
  // 2026-09-23, all three - `.code` on a transport error gets ONE owner.
  //
  // `defaultIsRetryable` read a `VC_` prefix on `.code` as proof the library
  // minted it, while both HTTP bridges copied the BACKEND's body code into that
  // same field. A backend therefore chose which branch of the retry predicate
  // ran: `code: 'VC_CORE_THROTTLED'` re-sent a 422 the HTTP layer had refused to
  // re-send, and `code: 'VC_VALIDATION_FAILED'` suppressed the retry of a 503.
  // Separately, seven library-minted transport failures (an unhandled redirect,
  // a batch result that never came back, a full offline queue, a dead socket, a
  // WS timeout) carried no code at all, so each was retried to exhaustion as an
  // unclassified error. All of it is counted in fetch calls by
  // tests/transport-code-owner.test.ts.
  //
  // MEASURED, per piece, one build each, against the previous ceilings. Raw and
  // brotli, full / core / elements:
  //
  //   1 provenance from `emitter`, not a `VC_` prefix   raw  -25 / -25 / -25
  //     (drops a `typeof` and a `startsWith`)        brotli   -8 /  -2 /  -5
  //   2 the 7 codeless sites through `transportError`   raw +174 / +89 / +89
  //     (a BusError, emitter 'transport', 4 new codes) brotli +54 / +35 / +42
  //   3 `action` + `context` on those sites             raw +150 / +57 / +57
  //                                                  brotli  +52 / +16 / +15
  //   4 the 2xx refusal tagged `emitter: 'transport'`,  raw  +55 / +49 / +49
  //     so the rule in 2 answers it                brotli   0 / +10 / +12
  //   5 `HttpError` as a class, 4 hand-assembled        raw  +72 / +71 / +71
  //     sites collapsed onto its constructor         brotli   +8 /  -9 /  +2
  //
  // Squeezed first, and these are the arms NOT taken:
  //   • `transportError` without its `context` parameter: -12 raw and -12 / -5 /
  //     -8 brotli. Declined once the parameter was used - `context` is where the
  //     dropped envelope and the unmatched batch id travel, and a value a reader
  //     would inspect does not belong inside the sentence.
  //   • no factory at all, one shared `{ emitter: 'transport' }` const inlined at
  //     each site: full +19 raw / 0 brotli, core -6 / -7, elements -6 / +5. A
  //     wash, so the named function stays - it is the one place stating which
  //     kind of error the transports mint.
  //   • `HttpError` as a plain factory function: 34 B smaller RAW in all three
  //     and 19 / 3 / 7 B LARGER brotli. As one `Object.assign` expression: 33 B
  //     smaller raw, 10 / 6 / 4 larger brotli. Brotli decides, and the class is
  //     also the only one of the three that can be extended.
  //   • row 4 as a `retryable: false` BOOLEAN on the error, which is what this
  //     carried for one commit: 19 B raw and 17 B brotli DEARER on full, 22/6
  //     and 22/4 on core and elements. It also added a string-keyed field to an
  //     error built from a response body - the precondition that broke `.code`.
  //     Reverted on both counts; `src/transports.ts` carries the reasoning.
  //
  // Step 1 pays for nothing here - it is a win, and it is the piece that fixes
  // the defect. Steps 2-5 are features: every transport failure now carries a
  // code a consumer can switch on and `getErrorEntry(code).fix` can explain, an
  // emitter a logger can route on, and an `action`. Step 5 buys no bytes at all
  // (+8 brotli on full, and -9 on core) and is taken for correctness: four sites
  // spelled the same four assignments out by hand, which is how the envelope
  // paths came to drop `code` while the catch path twelve lines away kept it.
  //
  // The new registry rows cost ZERO IN THESE BUNDLES, and that scope is the whole
  // claim - verified by grep, the `fix` strings appear 0 times in all three,
  // because `/* @__PURE__ */` on ERROR_CODE_REGISTRY's freeze still shakes the
  // whole table out of a build that never reads it.
  //
  // A CONSUMER WHO IMPORTS THE REGISTRY PAYS FOR IT, and that is not a caveat on
  // the sentence above, it is the other half of it. `docs/BUNDLE-SIZES.md` is
  // where that number lives: the root barrel row moved 23.3 -> 23.8 KB brotli
  // across this work, which is the rows plus the new code strings together. The
  // split between them is not stated here because it was not measured; that table
  // is regenerated every run and is the only place a size should be read from.
  //
  // The fifth budget did NOT need raising: the Blade consumer ESM bundle
  // (tests/esm-treeshake.test.ts) measures 6,342 against its 6,380 ceiling.
  //
  // Row 2's four codes became five: `VC_TRANSPORT_TIMEOUT` replaced the two WS
  // timeout sites' reuse of `VC_CORE_REQUEST_TIMEOUT`, whose registry row says
  // emitter 'core' and "request() timed out" - both false from a transport. A
  // row costs nothing here, so this trades a half-true row for two true ones.
  //
  // Then, smaller again, and the budgets follow it DOWN: `VC_CORE_HANDLER_THREW`
  // left RETRYABLE_CODES. With `.code` staying the backend's on a tagged refusal,
  // every member of that set is a string a backend can send to get a permanent
  // refusal retried - and that one was minted by no site in `src/`, so it could
  // only ever have matched a backend's string. MEASURED: -24 raw in all three and
  // -2 / -8 / -7 brotli. Shrinking a wire-facing surface pays here, because a set
  // member is a string plus a comma.
  //
  // v1.24.0, RFC 9457 problem documents (tests/problem-details.test.ts): the
  // `+json` media-type test, `detail` in `responseError`, the wider `Accept`,
  // and `resultFailure()` - the one reading of a result shared by the batch and
  // WebSocket bridges, which only the full IIFE carries. MEASURED against the
  // published v1.23.0 IIFEs: +136 / +21 / +21 raw, +62 / +3 / -1 brotli.
  //
  // Squeezed before landing, each measured on all three: `detail` is read ONCE,
  // in `responseError` - the bridges' catch paths hand that HttpError on as it
  // is, so reading `detail` there too was a second copy (-100 raw each); the
  // unreachable `!res.ok` branches were left alone rather than taught `detail`;
  // `resultFailure()` is one expression (-20 raw on the full). The single
  // bridge does NOT route through it: that put the `problem` branch into core
  // and elements for +128 raw / +65 brotli, for a shape a single bridge's 2xx
  // never carries - there a problem is the error RESPONSE, an HttpError.
  //
  // Unreleased, undo that tells the truth (tests/history-undo-lands.test.ts):
  // an undo or redo that does not land moves the stacks BACK, in the history()
  // plugin and in useCommandHistory, which both carry the full IIFE. MEASURED
  // against this budget: +787 raw / +278 brotli, full IIFE only (core and
  // elements unchanged, at their budgets exactly). In two steps, each measured:
  // the fix written into each history, 41,008 / 12,210 (+459 / +156); then ONE
  // implementation (src/ledger.ts) shared by both instead, 41,336 / 12,332
  // (+328 / +122 more). Accepted by the owner as "better architecture for
  // free": on ESM, what modern apps ship, the two measured the same (import
  // everything 24.9 KB brotli), and the IIFEs are a legacy bridge that does not
  // decide a design. Squeezed before landing: one logging site in the shared
  // helper instead of four template strings (-39 raw, +12 brotli; kept for the
  // single site, not the bytes). The ledger's own cost is its options object,
  // change callback and signal mirroring, which outweighed the lines it removed.
  //
  // Unreleased, Phase 0 of the failures plan ((v1.25.0)), and all three
  // budgets follow it DOWN. The fixes cost, measured one at a time on the core
  // IIFE: the Idempotency-Key as a Structured Field String +116 / +48 (one
  // regex pass was bigger, 6,479 on the ESM consumer, dropped), register()'s
  // ownership-checked cleanup +58 / +17 (then one `drop` helper for both
  // maps), validator()'s coded VC_VALIDATION_FAILED +58 / +15, the
  // catalogue's `warn` severity on three refusals +48 / +14, retry()'s
  // happy path -29 / -12. That put all three over (full 41,906 / 12,539).
  // Paid for by rule, not by a raise:
  //   - Advice only in DEV (docs/contract.md rule 5). Five core messages
  //     (sealed, max depth, request timeout, naming, no handler) and two
  //     elsewhere (createVaporChamberApp's VDOM tail, persist's "stale after
  //     a deploy") carried a fix sentence in production that the catalogue
  //     (ERROR_CODE_REGISTRY `fix`) already holds. Production keeps the fact;
  //     vueDetectionHint stays, it is a diagnosis. -454 raw on the full.
  //   - One throttle gate (`_throttleGate`). register({ throttle }) and the
  //     throttle() plugin were the same gate written twice; the plugin now
  //     also skips the stack capture on its hot rejected path. -280 raw on
  //     every IIFE.
  // MEASURED: full 41,172 / 12,303, core 27,164 / 7,992, elements
  // 28,928 / 8,499 - each below the budget it started from.
  //
  // Unreleased, owner-by-wiring failures (docs/contract.md 5) and the IIFE
  // target raised to a 2022 floor (Chrome 100, Firefox 100,
  // Safari 16; owner). Measured on the SAME 2022 target, the target alone took
  // the old code to 39,351 / 11,835 full, 25,911 / 7,669 core, 27,617 / 8,169
  // elements, because `?.`, `??`, class fields and private fields stop being
  // lowered into helpers. The new failure shape on top of that: +79 / +57
  // full, +12 / +58 core, +12 / +46 elements, with `toJSON` carrying only the
  // members it needs (a `type` docs URL cost 113 / 77 more and was left out,
  // `type` implicit). Squeezed on the way: a private `#owner` lowered to
  // WeakMap helpers (~450 raw) until a `super()` inside `try/finally` was
  // removed; freezing or a non-writable `code` cost 10-30% on the refusal
  // path and was dropped for a private `#code` with a getter.
  //
  // Unreleased, the wire contract and retries by it (docs/contract.md 4):
  // the status table, `failureCondition`, the transport readers of one answer
  // shape, and `retrying()` on an engine shared with `retry()`, net of what
  // they replaced (the old readers, both bridges' re-wrapping catch paths,
  // `noRetry`). MEASURED from 39,322 / 11,892 full, 25,923 / 7,727 core,
  // 27,629 / 8,215 elements: +994 / +275, +1,162 / +344, +1,162 / +357.
  // Squeezed first: `Retry-After` parsed to undefined, not null (the
  // `?? undefined` at each site went), and the redirect's "no onRedirect
  // handler" advice DEV-only (contract rule 5): -91 / -32 core.
  //
  // Unreleased, retries back to what 1.24 shipped ((v1.25.0)):
  // re-sent unless a 4xx verdict, an abort, a depth bound or a plugin's own
  // throw (the owner check pulls ownerOf into the IIFEs), a declared
  // `Retry-After` honoured, 5xx retried again by the HTTP client, and
  // `X-RateLimit-Reset` read again as the wait's fallback. MEASURED:
  // +207 / +67 full, core and elements alike.
  //
  // Unreleased, one scheduler and one code path per bus operation: retry's
  // waits on the shared scheduler (+79 / +25), paid for by the sync and async
  // buses sharing use(), respond() and dispose(), the async request() settling
  // one promise, debounce keeping one map, and the `typeof globalThis` guards
  // gone (every target has it). MEASURED: -682 / -69 full, -579 / -50 core,
  // -616 / -53 elements.
  //
  // Unreleased, one rule for a party's own throw (`_isBug`, retry and the
  // circuit breaker), read off the code's owner prefix. MEASURED: -71 / -10
  // full, -71 / -20 core, -71 / -12 elements.
  //
  // Unreleased, `HttpError.status` gone (its `response.status` is the one
  // place a status lives), `applyVueModule`'s dead `vue &&` guards. MEASURED:
  // -73 / -10 full, -34 / -11 core, -73 / -16 elements.
  //
  // Unreleased, `authGuard` refusing with its own coded failure (a fix: it was
  // a plain Error that retry() re-sent and a breaker counted), paid for by the
  // buses sharing their common members (`busParts`) and the IIFEs dropping a
  // `bind` on an arrow. MEASURED: -354 / -32 full, -351 / -15 core, -351 / 0
  // elements.
  //
  // Unreleased, a redirect is `transport:refused:redirect` (it was re-sent as
  // `unexpected`, firing onRedirect per attempt). MEASURED: raw -3 in all
  // three, brotli +2 full / -2 core / +3 elements - compression variance on a
  // shorter string; a shared listener-error reporter was tried against it and
  // measured +22 brotli (brotli folds the duplicate for free), so the two
  // ceilings follow the measurement.
  //
  // Unreleased, the retry model (docs/retry.md): the policy is the
  // async bus's own, on by default, so every IIFE carries it (the bundles
  // create an async bus); `retry()` and `retrying()` are gone from them, and
  // the bridges declare `transport`. MEASURED: +163 / +129 full, +162 / +136
  // core, +163 / +114 elements.
  //
  // Unreleased, the 1.26 bug fixes (log s35.42), raised to measured by the
  // owner (2026-10-01); each fix built at its own commit. MEASURED:
  // isLoading across its last holder and on a sealed bus (B3+B4) +178 / +60
  // full; Retry-After by RFC 9110's grammar (B8) -9 / +21 full, -9 / +14
  // core, -9 / +15 elements (shorter code, worse brotli); persist() throwing
  // without getState (B12) +61 / +13 full; the root probe's
  // __VC_WIRED_BUILD__ guard and the probe-free shared bus (B1+B2+B11)
  // -4 / -3 full, 0 core, -3 / 0 elements (the IIFEs define the flag false).
  // The router and HTTP-cache fixes (B5, B6) are in no IIFE. Then the
  // shared-state observer subscribed in its literal (no placeholder): -15 / -2
  // full.
  //
  // Unreleased, the perf-1.26 audit (log s35.44), raised to measured by the
  // owner (2026-10-01: "iife is justified", speed over size). MEASURED, full
  // only: useSharedCommandState dispose() counted once per holder (a bug fix)
  // +19 / +9; useCommand().dispatch and query without a thunk (M-g,
  // 0.915-0.934x, -2.7 to -3.9 ns, log s35.53) +27 / +5. The filter loop (C1)
  // is in no IIFE. Then warnUnwired's cheap test outside the build flag's
  // `typeof` (V-e: composable creation back to v1.25.0's speed, was 7-8%
  // slower) +0 / +8. Then per-key isLoading tracking: a slot's signal only
  // once read (D1, tracked dispatch -3.6 to -6.1 ns, log s35.53) +35 / +4; the
  // start -> settle pairing in a Map, not a WeakMap (D2, -24 to -26 ns) -4 / +8.
  // Then (log s35.60) isLoading's slots by action, then target, no key string
  // per dispatch (item 4a, tracked dispatch 0.892-0.905x, -15 to -18 ns)
  // +199 / +51. Then (log s35.62) the build profile and isLoading option b
  // behind it: an unread slot kept at 0 while its action's bucket holds 256
  // or fewer (the IIFEs are performance; 0.848-0.865x, -21 to -22 ns in the
  // constant form, log s35.61) +43 / +14. Then (log s35.66) isLoading option
  // c: on a sync bus the start -> settle pairing is an identity-checked stack,
  // not the Map (tracked dispatch 0.645x, -44 ns on top of b; owner: speed
  // over a size this small) +427 / +107. Then (log s35.67) three correctness
  // fixes, owner: raised to measured, built one at a time (full / core /
  // elements): query nests on the depth counter (a self-querying handler
  // overflowed the stack) +122 / +19, +123 / +11, +123 / +7; async depth by
  // parent, not by dispatches in flight (17 concurrent were refused; three
  // endless loops) +451 / +161, +452 / +140, +451 / +146; one fan-out rule,
  // the listeners that existed when a dispatch started (a skip and a double
  // call) +129 / +40, +128 / +59, +128 / +69.
  // Then (log s35.70) a store's $reset as a command: the naming check skips a
  // name with `$` (the library's), owner: raised to measured, +17 / +15 full,
  // +17 / +4 core, +17 / +3 elements (the store is in no IIFE).
  // Then (log s35.77) every plugin factory declares its id, the owner of its
  // failures (shape rule 3), owner: "no sweat size increase", raised to
  // measured: +119 / +18 full, +59 / +11 core, +59 / +7 elements (the ids of
  // logger, history, debounce, optimistic, optimisticUndo, persist and the
  // bridges' shared TRANSPORT marker).
  // Then (log s35.79) the conditions `conflict` (409, 412) and
  // `unauthenticated` (401, 419) in the status table, owner: "no sweat size
  // increase", raised to measured: +27 / -2 full, +27 / +11 core, +27 / -2
  // elements (brotli budgets kept where they shrank).
  // Then (log s35.80) a problem's RFC 9457 `type`, the docs URL of its
  // condition (the 83-character prefix barely compresses), owner: "no sweat
  // size increase", raised to measured: +180 / +78 full, +180 / +75 core,
  // +180 / +80 elements.
  // Then (log s35.81) meta's `idempotencyKey` slot, present from stampMeta
  // (one meta map whether a command is keyed or not), raised to measured:
  // +22 / +9 full, +22 / +2 core, +22 / +7 elements.
  // Then (log s35.82) HttpResponse carries Fetch's `url` and `redirected`
  // (#17), raised to measured: +34 / +11 full, +34 / +8 core, +34 / +9
  // elements.
  // Then (log s35.83) a 304 resolves when a request opts in
  // (`resolveNotModified`), and a GET joins another in flight only when its
  // headers match (a plain read received a conditional read's 304), raised
  // to measured: +80 / +32 full, +80 / +38 core, +80 / +35 elements.
  // Then (log s35.89) a Retry-After past 30 s is read as declared (RFC 9110:
  // a minimum, no ceiling in the grammar): the parser keeps only the timer
  // bound, the HTTP client ends a request on a wait over its 30 s, and the
  // async bus returns a declared wait over maxDelay instead of re-sending
  // early. Owner: raised to measured ("no sweat"): +58 / -6 full, +58 / +12
  // core, +58 / +23 elements (full's brotli budget kept where it shrank).
  // Then (log s35.100) Retry-After's HTTP-date read by RFC 9110 5.6.7: the
  // three forms, all GMT (asctime was read as local time), anything else
  // ignored, a two-digit year its next occurrence. Owner: "worth the rise",
  // raised to measured: +570 / +286 full, +571 / +264 core, +571 / +250
  // elements. Attributed first, three variants built: asctime-as-GMT alone
  // +62 / +43 full (still takes ISO, `10/1/2026`, made-up names); a shape
  // gate over Date.parse +151 / +91 (still takes a made-up weekday, V8's
  // two-digit years); the rest is the names, the RFC's year rule and the
  // GMT arithmetic no Date.parse gives.
  // Then the 1.26 dependency update within ranges (vite 8.2.2 -> 8.3.2, vitest
  // 5.0.3, ...), no library code changed: full IIFE brotli +3 from the
  // minifier's output, raw, core and elements unchanged. Owner: raised to
  // measured ("3 B is nothing").
  // Then canUndo beside undo in register() (log s35.113). Owner: raised to measured.
  // Then every undo a command, <action>$undo, and $ commands kept local (log s35.114). Owner: raised to measured.
  // Then an app's $ name refused, the naming check coded (log s35.117). Owner: raised to measured.
  // Then authGuard's unauthenticated code, problemOf (log s35.119-121). Owner: raised to measured.
  // Then the HTTP client's failures as the core's BusError, one answer reader, one retry rule (log s35.131). Owner: raised to measured.
  // Then one JSON body reader, status first, and a 2xx that is not the envelope failing (log s35.132). Owner: raised to measured.
  // Then meta.response (log s35.136). Owner: raised to measured.
  // Then one command envelope on every wire (log s35.138). Owner: raised to measured.
  // Then meta.request (log s35.139). Owner: raised to measured.
  // Then P1, a chain per action for plugins that declare actions (log s35.141). Owner: raised to measured.
  // Then a sync dispatch with no plugin skips the runner (log s35.143). Owner: raised to measured.
  // Then debounce([]), throttle([]), optimisticUndo(bus, []) act on nothing
  // again (log s35.146, s35.148): `forList` (about 40 B) and its three wraps,
  // +62 raw in all three; brotli full +53, core +44, elements +27. perAction is
  // byte-identical to the release. Raised to measured; attribution in the log.
  // Then debounce hands a $ command on (log s35.150): its one line, +26 raw in
  // all three; brotli full -17, core -9, elements -9 (budgets kept). cache and
  // idempotent are not in these bundles. Raw raised to measured.
  // Then actionFilter (log s35.152), raw/brotli full, core, elements: the bus
  // reads it per action +55/+17, +55/+32, +55/+16; the bridges pass it on
  // +56/+9, +28/+11, +28/0; total +111/+12, +83/+42, +83/+28. The filter
  // compiler is not in these bundles (createActionFilter, imported by the
  // app; inside the bus it cost every app +296 brotli here). Raised to measured.
  // Then one abort shape (log s35.154), raw/brotli full, core, elements: the
  // AbortError name +34/+32, +34/+10, +34/+16; the reason as cause +8/-16,
  // +8/-11, +8/+6; a rethrown reason read as the abort +103/+83, +102/+21,
  // +102/+43; total +145/+99, +144/+20, +144/+65. Raised to measured.
  // Then a transactional batch rolls back the Command that ran (log s35.155):
  // each dispatch builds its Command, then runs it; the batch runs the one it
  // keeps. Raw/brotli full, core, elements: sync +183/-6, +183/+46, +184/+39;
  // async +171/+69, +171/+56, +170/+49; total +354/+63, +354/+102, +354/+88.
  // Raised to measured.
  // Then history never undoes locally a command a bridge carried out (log
  // s35.159). Raw/brotli full, core, elements: the mark (a WeakSet, `answerOf`
  // adds to it, the WebSocket record keeps the command) +34/+36, +31/+17,
  // +32/+10; the ledger reading it (one precondition for canUndo and undo)
  // +13/-5, 0/0, 0/0; total +47/+31, +31/+17, +32/+10. Raised to measured.
  // Then no reply on an unidentified command is not re-sent, and a declared
  // wait sets when, never whether (log s35.162). Brotli, full IIFE, each
  // piece left out of the build: the rule (no reply uncertain, a wait only
  // when identified) +47; the RateLimit read +72; the held-back report (the
  // outcome mark, the bus's and the client's call; the DEV warning folds)
  // +83. Total raw/brotli full, core, elements +521/+188, +520/+188,
  // +519/+187. Raised to measured.
  // Then one spelling per request header name (log s35.163). Brotli, full
  // IIFE, each piece left out alone: the spelling check and its rebuild +78;
  // deleting every spelling (the 419 refresh, FormData) +24. Total raw/brotli
  // full, core, elements +354/+102, +354/+114, +354/+109. Raised to measured.
  // Then authGuard reads 'admin*' and '*' as the prefixes they name (log s35.165):
  // the list compiled once in the factory, raw/brotli full, core, elements
  // +42/+29, +42/+21, +42/+33. Raised to measured.
  // Then async request(): the payload in its key, each caller its own wait, the
  // responder the chain's command (log s35.167). Brotli, full IIFE, each piece
  // left out alone: the payload in the key +9; the shared controller, aborted
  // when every caller has aborted, +28; the per-caller race and the command
  // handed through +39. Total raw/brotli full, core, elements +167/+76,
  // +167/+89, +167/+84. Raised to measured.
  // Then composables observe a sealed bus (log s35.173): one helper,
  // pastSeal, and its two new call sites, full only: +58/+14. Raised to measured.
  // Then a NaN option reads as its default (log s35.174): full +2/-7. Raw
  // raised to measured, brotli kept.
  // Then one sync batch rule for the bus and createTestBus (log s35.176):
  // _syncBatch takes run, undoable and dispatch; raw/brotli full, core,
  // elements +12/+36, +12/+42, +12/+25. Raised to measured.
  // Then retry.actionPolicies, the most specific match resolved once per
  // action (log s35.179). Raw/brotli full, each piece left out alone: the
  // ranking +66/+58, the per-action cache +99/+33. Total full, core,
  // elements +165/+91, +165/+55, +164/+68. Raised to measured.
  // Then a landed undo makes every plugin forget the command (log s35.181).
  // Brotli full, core, elements, each piece left out alone: the `{ ok: false }`
  // check +14, +10, +6; settling an async inverse through onSettled +11, -16,
  // +15 (brotli is not additive). The plugin walk is the index loop every
  // hook runner here uses (log s35.183): +33/-1, +33/+13, +33/+9 over a
  // forEach, kept for one shape and the speed rule. Total raw/brotli full,
  // core, elements +118/+46, +114/+51, +115/+64. Raised to measured.
  // Then a transport's answer handed to the handler's `answer`, a store's
  // `answer` option (log s35.184). Brotli full, core, elements, each piece
  // left out alone: the `answers` map in register and the bus state +48,
  // +17, +21; the settle at the transport's level +71, +56, +44 (brotli is
  // not additive). Total raw/brotli full, core, elements +268/+109,
  // +270/+84, +270/+82. Raised to measured.
  // Then a server's reply declares store states, `stores` (log s35.186).
  // Brotli full, core, elements, each piece left out alone: the bus's store
  // receivers (the map, publishing it, the loop at the transport's level) +3,
  // +50, +32; `answerOf` keeping the reply's `stores` +1, +9, +3. Total
  // raw/brotli full, core, elements +187/+15, +189/+69, +190/+48. Raised to
  // measured.
  // Then one name for a cap on retained entries (log s35.188). Raw/brotli,
  // each piece left out alone: the bus's `maxBufferSize` (was `bufferLimit`)
  // full +2/+9, core +2/-6, elements +2/+13; the composables' `maxSize` (was
  // `errorCap`) full -6/+1. The cost is the name. Raised to measured.
  // Then one name for teardown, `dispose` (log s35.189), full only: the SSE
  // and Echo bridges' (was `teardown`) and createChannel's (was `close`)
  // together +1/+16; each left out alone, the other costs +2/+48 and -1/+47
  // (a repeated `dispose` compresses, brotli is not additive). Raised to
  // measured.
  // Then sync dispatch guards, builds, then runs the Command (log s35.204),
  // one piece: raw/brotli full, core, elements +7/-39, +7/-13, +7/-11. Raw
  // raised to measured, brotli kept.
  // Then a batched result's or a frame's own `headers`, their Retry-After read
  // as a response's (log s35.205). Raw/brotli full, core, elements, each piece
  // left out alone: the reader (a name in any case, a string value) and the
  // batch and frame passing theirs +199/+70, +188/+53, +189/+53; the single
  // bridge passing its response's +10/-7, +10/+6, +10/+2. Total +209/+63,
  // +198/+59, +199/+55 (brotli is not additive). The two-copies hint is DEV
  // (0 here). Raised to measured.
  // Then persist's storage lookup moved inside its try (log s35.208): raw
  // -14, brotli +3. Three other shapes measured: none under +3 brotli.
  // Then bus hooks removed by the listeners' rule (log s35.209). Raw/brotli
  // full, core, elements, each piece left out alone: the four loops skipping
  // an entry marked off +92/+8, +92/+9, +92/+13; addHook's entries +31/+3,
  // +31/-2, +31/-2; clearState marking and replacing +59/+7, +59/+12,
  // +59/+11. Total +182/+28, +182/+30, +182/+28. Raised to measured.
  // Then persist declares `actions` and `actionFilter` (log s35.214), one
  // piece, full only: +46/+12. Raised to measured.
  // Then persist reads an async storage (log s35.216), full only: hydrate,
  // the read load() and hydrate() share, load()'s refusal of a promise, and
  // the rejection checks in save and clear, together +285/+95. Raised to
  // measured. The IndexedDB storage itself is in no IIFE.
  // Then every bus composable takes a `bus`, read by one function,
  // resolveBus (log s35.221), full only: raw/brotli +39/-14. Raw, piece by
  // piece: resolveBus +30, useCommand's option +7, defineVaporCommand's +6,
  // the two composables that already took a bus -2 each, a longer minified
  // name +1. Core and elements byte-identical. Raw raised to measured,
  // brotli kept.
  // Then a dispatch's result type follows its bus (log s35.222), full only:
  // raw/brotli +100/+40. Two pieces, both on a failed dispatch only:
  // _isAsyncBus +66, and runDispatch's catch returning a promise on an async
  // bus +30; +4 is minified names. Raised to measured.
  // Then useSharedCommandState's opening writes moved inside its try (log
  // s35.227), one piece on the failure path: the catch returning a promise on
  // an async bus, raw/brotli +33/+3. Raised to measured.
  // Then the runtime lookup wires only the Vue the app already has (log
  // s35.233), one piece, once per page: raw/brotli full +24/+7, elements
  // +38/+18, core byte-identical. Raised to measured.
  // Then composables stopped calling probeVue() on creation (log s35.234),
  // full only: raw -10, brotli +57. Each call removed alone is -5/-1 and
  // -5/-2. Both together, the minifier renames `_vueDeepRefFn` to `$`, and
  // the renaming, not code, moves brotli. Brotli raised to measured.
  // Then (1.30) commandKey keeps a BigInt or a circular target apart: the
  // BigInt tag in the key's replacer and the identity fallback for a cycle,
  // one piece. raw/brotli full +155/+5, core +141/+65, elements +141/+68. The
  // ':' naming warning is DEV and folds out. Raised to measured.
  // Then (1.30) a failed half-open probe reopens circuitBreaker, and
  // rateLimit({ max: 0 }) declares no NaN retryIn: full only, +34/+10 (core
  // and elements do not carry either plugin). Raised to measured.
  // Then (1.30) the ws bridge encodes an envelope before queueing it,
  // and a second SSE install() closes the first stream: full only, +14/+7.
  // Raised to measured.
  // Then (1.30) one rule for a declared retryIn (isDelay) in the bus's
  // retry: +50 raw in all three; brotli full +77, core +14, elements +8.
  // Raised to measured.
  // Then (1.30) composables count overlapping dispatches (the counts made at
  // the first dispatch) and keep the latest query's data; toTools builds its
  // schemas with the MCP generator: full only, +151/+1. Set to measured.
  // Then (audit D4, log s36.11) one cancel reader, `_isCancel`: a failure
  // that IS the caller's abort reason reads as a cancel in failureCondition,
  // the retry loop and circuitBreaker. Failure path only. raw +61 in all
  // three (the reader and failureCondition's signal argument); brotli full
  // +84 (circuitBreaker's call site rearranges its chunk), core +6, elements
  // +17. Raised to measured.
  // Then audit D7 (see the core IIFE's note): raw +54, brotli -51, raw raised.
  // Then audit D8 (log s36.11): request()'s timeout and the ws bridge's read
  // by countOption. Raw/brotli, each piece left out alone: the ws read
  // +17/-1, request's reader +22/+13. Total +39/-2. Raw raised to measured,
  // brotli kept.
  // Then audit D9: the throttle gate reads its wait once by countOption, one
  // piece, raw/brotli +17/-4. Raw raised to measured, brotli kept.
  // Then debounce reads its wait the same way, one piece, +13/+17. Raw raised
  // to measured, brotli kept.
  // Then audit D10: every timer delay a checked `Delay` (delayOption), the
  // http client's two hand-rolled readers replaced, the batching window and
  // the directive's timeout read by the rule: +14/+31. Raw raised to
  // measured, brotli kept.
  // Then audit D11: a request JSON cannot encode is transport:invalid:json.
  // Raw/brotli, each piece left out alone: the encoder and the http bridge
  // through it +42/+9, the ws bridge +42/+13. Total +248/+66 (brotli is not
  // additive). The registry row and the client's check are in no IIFE.
  // Raised to measured.
  // Then audit HT-24: a malformed XSRF-TOKEN cookie reads as no cookie (a
  // try around its decode, the CSRF read path only): +33/+8. Raised to measured.
  // Then complexity review F1 (log 36.13): two abort signals combine as
  // `AbortSignal.any` does on every target, through one helper. Raw/brotli:
  // the helper's fallback against the old one +59/+19 (of it, an input
  // already aborted and its own detach, left out alone, +59/+20); the two
  // http-bridge sites through it -64/-6; their per-request detach, left out
  // alone, +22/+4. Total -5/+13 (brotli is not additive). Brotli raised to
  // measured, raw kept.
  // Then complexity review B3 (log 36.13): each request builds its own
  // transport:missing:csrf after a shared refresh, marked by its own
  // `silent`, one piece: +5/+4. Raised to measured.
  // Then log 36.16 item 1: the http client waits the async bus's retry
  // schedule, one function both loops call. Raw/brotli, each piece left out
  // alone: the bus through it +55/+12, the client through it +18/0. Total
  // -10/-7 (brotli is not additive). Kept.
  // Then log 36.17: the http `retry` count read by the count rule, where a
  // negative or NaN sent nothing, one piece (countOption at postCommand's
  // read): +7/+16. Brotli raised to measured.
  // Then complexity review F12 (log 36.17): runWithRetry's resend-or-leave
  // written once, its timer and signal cleanup in one `send`: -117/-57.
  // Lowered to measured, which locks it.
  // Then complexity review F2 (log 36.17): the two HTTP bridges' send and
  // answer steps written once. These bundles hold the single bridge only, so
  // they carry the helpers without the second copy: `readAnswer` alone
  // +13/+16, `httpSender` (one send, one bridge signal) the rest, total
  // +45/+37. Bundles with both bridges are -343 min. Raised to measured.
  // Then compat step 1 (log 36.25, owner: "rise budget here"): commandKey
  // keeps NaN and Infinity apart from null, through keyText
  // (src/canonical.ts), the one key text commandKey and the HTTP client's key
  // share. The tag alone, written inline as BigInt's was: +72 min. The shared
  // keyText (a module function and the caller's tag passed in) the rest,
  // total +126/+53. The HTTP key is not in the IIFEs. Raised to measured.
  // Then compat step 6 (log 36.35): persist's `version` and `migrate`, a
  // state saved by another version of the app goes through migrate or loads
  // as null, one piece: +424/+158. The outbox check and the error registry
  // row are in no IIFE. Core and elements unchanged. Raised to measured.
  // Then the V8 round, item 1 (log 36.36): commandKey's key writer built once
  // per caller, and `typeof` tested where it is compared. The typeof tests
  // -9/0, the writer built once +10/-6, total +1/-6. Raw raised to
  // measured, brotli kept.
  // Then log 36.41: commandKey keeps function, symbol and wrapper targets
  // apart (owner: size is no issue). Each piece built alone, raw/brotli: the
  // wrapper check +417/+107, the identity key +210/+39, total +627/+139. The
  // new top-level names take the minifier's one-letter slots. Raised to
  // measured.
  // Then log 36.42: one reader for a response's declared wait. Each piece left
  // out alone, raw/brotli: the epoch rule for X-RateLimit-Reset +156/+46, a
  // batched result's headers through the reader +27/+18, the reader through
  // `_answered` the rest. Total +205/+60. Raised to measured.
  // Then an app's own client's header names read in any case at the bridges'
  // three failure sites, and pollWith through the one reader, one piece:
  // +9/+54. Raised to measured.
  // Then log 36.45: the transport declared at the async bus. Each piece left
  // out alone, brotli: `batch` built into httpTransport +411 (owner: kept),
  // the answers and store states written at the send +79 (moved from the
  // runner), use()'s refusal +26, transport:failed:send +20, the lookup's
  // inlined hit path +10 and sendFrom +6 (both speed), disposing the
  // transports 0, the rest the wsTransport reshape. Total +2341/+646.
  // Raised to measured.
  // Then log 36.47: the wire facts. Each piece left out alone, raw/brotli: the
  // key in a batched command's or a frame's `headers`, appended as text
  // (speed) +142/+2, the unreserved scan that skips the encode (speed)
  // +28/+40, a batched result's or a frame's own status +30/+9, a command's
  // `Accept` in place of X-Requested-With +21/-69 (brotli moves with the
  // arrangement), the key out of `meta` -50/-1. Total +327/+137. Raised to
  // measured.
  // Then log 36.48: one idempotency key. One piece in these bundles (no
  // idempotent, no outbox): the retry stamps through the one rule, `_keyed`,
  // +16/+36. Raised to measured.
  // Then log 36.49: a 202 answers an `Accepted`, in every HTTP bundle (pollWith
  // was in none). Each piece left out alone, raw/brotli: the Accepted and its
  // follow, with the poll's GET, +1364/+461; the batched result's 202 +51/-19
  // (brotli moves with the arrangement); the single answer's +74/+7; `dispose`
  // +18/+9. Total +1683/+516. Raised to measured.
  // Then log 36.51: the hold (L5), a held action refused unsent. Each piece
  // left out alone, raw/brotli: the single send's check +50/-53, its two
  // records +28/-65, the batched send's check +67/+10, its three records
  // +62/-61, the sender's `dispose` +10/-43, the WebSocket transport's
  // check, record and `dispose` +129/+18, the refusal's message +55/-14
  // (brotli moves with the arrangement). The two shared functions the rest.
  // From 3d's 54,596/17,100: total +745/+189. Raised to measured.
  // Then log 36.52: inbound pushes, a store state written and a fact emitted,
  // never dispatched. Each piece left out alone, raw/brotli: the bus giving
  // each transport itself (`attach`) +94/+17, the SSE bridge's push and
  // `events` +153/+47, the WebSocket push frame +113/+17 (brotli moves with
  // the arrangement). The push applier the rest. Total +686/+191. Raised to
  // measured.
  // Then log 36.53: cache groups (RFC 9875). Each piece left out alone,
  // raw/brotli: the transports' group header read +133/+45, the plugin
  // `attach` +25/+0 (brotli moves with the arrangement). The field reader
  // stays in the client. Total +276/+106. Raised to measured.
  // Then log 36.55 (plan 1.32 step 4b, owner 2026-10-19: the full IIFE carries the
  // store, persist an imported value, raised to measured). Each piece left out
  // alone, raw/brotli: the store (`defineChamberStore`, the core store with its
  // one watcher and the field-event lane of 4a) +6,302/+2,041; `saveTo`
  // +2,032/+646; the `persist()` plugin removed -1,876/-534. Total +6,458/+2,153.
  // Then log 36.57: `saveTo` lost `version` and `migrate`, +1,607/+525 now. Total
  // from 56,303/17,586: +6,033/+2,032. Lowered to measured.
  // Then log 36.60 (4c): `shareTabs` exported, under budget (62,262/19,588). Log
  // 36.62 (4e, owner 2026-10-19: "land it"), raw/brotli per arm: the store's
  // `coalesce` and `deep` +346/+119; action names per definition (speed) +52/+22;
  // register() building only what a call uses (speed) +13/+23; the registry
  // folded into the receivers map -91/-46; closures built only when used +76/-9.
  // 62,262/19,588 -> 62,658/19,697. Raised to measured.
  // Then log 36.63 (4f): the fast lane's onError single-listener path (speed)
  // +57 raw; the form on the store and the core cell's watcher field -4 raw;
  // 62,711/19,725 (+53/+28). Raised to measured.
  // Then log 36.64 (4g): one piece here, a store's creation writing a state the
  // page seeded (the entry's `seeded` field and its check) +92/+17; the SSR
  // module is not in this bundle. 62,803/19,742. Raised to measured.
  // Then log 36.65: the entry's raw cell and first state (`storeStates` reads
  // only a written store) +21/+21; 62,824/19,763. Raised to measured.
  // Then log 36.66 (4h-1), each piece left out alone, raw/brotli: history's
  // recorder an after-hook, not a chain level, -28/-5; installed past a seal,
  // as useCommandHistory's, +10/+48 (brotli moves with the arrangement).
  // 62,806/19,806. Raised to measured.
  // Then log 36.67 (4h-2): one piece here, the origins history skips read
  // through one rule the reaction shares (`_unrecorded`) +4/-34 (brotli moves
  // with the arrangement); no reaction in this bundle. 62,810/19,772. Set to
  // measured.
  // Then log 36.68 (4h-3), one undo per click, each piece left out alone,
  // raw/brotli: the press (members in order, each after the one before landed,
  // `moveUnlessRefused` answering whether it landed) +208/+63; the two member
  // walks, read from the stacks at press time, +285/+48; the speed recovery (a
  // press of one step builds no chain, the walks allocate nothing; undo+redo
  // 270.3 -> 208.8 ns) +180/+51. 63,483/19,934. Raised to measured.
  // Then log 36.69 (4i): the async bus's outbox hooks (as in core and
  // elements) and the ledger leaving an `Accepted` out of the history (the
  // check and its import) +160/+113, no outbox in this bundle. 63,643/20,047.
  // Raised to measured.
  // Then log 36.70 (4h-4, B3: a declared handler child), each piece left out
  // alone, raw/brotli: a redo carrying the child back after its parent lands
  // +539/+168; a refused step put back in its place +139/+28; the one `related`
  // walk with the root lookup the rest (+131 raw). Undo and redo paths only.
  // 64,452/20,200. Raised to measured.
  // Then log 36.71, its speed recovery (undo+redo -11.5 ns): a step's place
  // read top-first and the grouped redo as its own function, +57/+7 together.
  // 64,509/20,207. Raised to measured.
  // Then log 36.72 (undo+redo -50 ns against 9d835c3): the move reads its
  // step top-first, pops it and hands its index to the revert, +14/+36.
  // 64,523/20,243. Raised to measured.
  // Then log 36.73 (4i): the buffer queue leaves the bus for its own module,
  // createBuffer, which this bundle exports. Each piece left out alone,
  // raw/brotli: the queue out of the bus -741/-149; the module, its Accepted
  // answer, coded drops and pending count +1245/+374. Net +504/+225.
  // 65,027/20,468. Raised to measured.
  // Then log 36.74 (4j): the WS queue goes into the outbox. Built without
  // wsTransport, c3f28d2 and this tree are byte-identical (62,075/19,617), so
  // the whole move is the WS piece: its own queue 2,952/851, its own outbox
  // 7,651/2,312, +4,699/+1,461. 69,726/21,929. Raised to measured.
  // Then log 36.78 (4k part 1): `register(..., { optimistic })`, the home of
  // the optimistic and optimisticUndo plugins. The async run apart
  // (optimisticRun, Blade +134 br), the gate, the declared map and the
  // register refusal (Blade +98 br), the sync bus's undo on a throw. Cold code:
  // it runs only for an action declared optimistic. +1,057/+227.
  // 70,783/22,156. Raised to measured.
  // Then log 36.79 (4k part 2): `register(..., { exclusive })`, the home of
  // the serialize plugin: `exclusively` with the scheduler's lanes (Blade
  // +198 br), the lane read in dispatch and query (+45 br). Cold code.
  // +988/+263, the run apart (speed) included. 71,771/22,419. Raised to measured.
  // Then log 36.80 (4k part 3): the store's optimistic and exclusive, and the
  // bus's turn reshaped so plugins run before the turn and the prediction
  // shows before it (Blade +194 br). Cold code. +738/+252. 72,509/22,671.
  // Raised to measured.
  // Then log 36.81 (4k part 4): the optimistic plugin leaves the full IIFE's
  // exports, -293/-72. 72,216/22,599. Lowered to measured.
  // Then log 36.82 (step 4 close, coverage): the ledger's rootOf as one walk,
  // its unreachable fallback gone, -10/+5. 72,206/22,604. Set to measured.
  // Then log 36.84 (5a): the command state as the bus's facts observer. Each
  // piece left out alone, raw/brotli: the two starts +70/+10, the two settles
  // +74/+14, the sync bare read +32/+2, the slot the rest: the bus +198/+40,
  // in every IIFE. A fast lane in the observer's place cost the bus +282/+71 (and
  // +16.8 ns a tracked dispatch). Its setter reads the inspect state, so no bus
  // carries one. The tracker moved from chamber.ts into command-state.ts with
  // `subscribe`, and commandState is exported: +192/+82. 72,596/22,726.
  // Raised to measured.
  // Then log 36.86 (5b): useCommand and useVaporAsyncCommand lose their own
  // `loading` and `lastError` (a lazy `pending` on the command state in their
  // place), useCommandQuery its `lastError`: -320/-89. 72,276/22,637. Lowered to
  // measured.
  // Then log 36.87 (step 5 close): each command-state write its own catch, one
  // helper in place of two try blocks: -33/+10. 72,243/22,647. Set to measured.
  // Then log 36.90 (6a): pacing leaves the bus for the sender. The debounce and
  // throttle plugins, register's throttle gate and its timers go, `pace` and the
  // composables' pace options come in: +217/+98. 72,460/22,745. Raised to
  // measured (the IIFE rule: legacy, measured).
  // Then log 36.91 (6b): `bindCommands` carries the command binding (busy,
  // error, announce, optimistic, the keyboard, the delegation) into the IIFE,
  // with the form controls and `data-vc-debounce` / `-throttle`: +5,589/+1,824.
  // 78,049/24,569. Raised to measured.
  // Then log 36.92 (6c): `bindDisplay` and its store reader: +2,065/+525.
  // 80,114/25,094. Raised to measured.
  // Then log 36.93 (6d): `defineWidget`'s three strategies, one shared
  // IntersectionObserver and a loader, from src/widget.ts: +788/+220.
  // 80,902/25,314. Raised to measured.
  // Then log 36.95 (6f): latest wins in `pace` (a controller per key, the
  // signal handed on) and the IME guard: +767/+208. 81,669/25,522. Raised to
  // measured.
  // Then log 36.98 (7a): a plugin made of parts, `use()` placing its `settled`
  // part as an after-hook (`_settledHook` ~160 raw, `_chainOf` ~110, the rule
  // and its message ~90, the placement ~70); `logger` and `schemaLogger`
  // smaller as parts. 81,855/25,715. Raised to measured.
  // Then log 36.99 (7b): the rules before the work (`_rulesOf`, `_refusal`, `asyncRefused`, `ruleThrew`, the run sites in dispatch and query, `use()` keeping the rules), +1,709/+274, and the five factories as parts. 83,564/25,989. Raised to measured.
  // Then log 36.100 (7c): the one scope reader `_scoped` for the logger, history and the two composables: +230/+55. 83,794/26,044. Raised to measured.
  // Then log 36.100 (7c, recovery): `_scoped` classifies the patterns once instead of keeping an answer per action (speed: the lone recorded record +17 -> +6 ns): +177/+6. 83,971/26,050. Raised to measured.
  // Then log 36.103 (8a): one pattern classifier read by every pattern reader: -77/+85. The classifier cut alone reads -38 brotli in the base and +41 in the head, so brotli moves with the arrangement; raw shrinks. 83,894/26,135. Brotli raised to measured.
  // Then log 36.105 (8b): the facts slot with more than one observer (`_composeFacts`, the part loop, a part's throw message, an `actionFilter` asked once per action), `metrics` as parts, a query's start: +960/+158. 84,854/26,293. Raised to measured.
  // Then log 36.106: the sync bus's request() runs the rules (the refusal settled inside `syncRefused` for its three sites): +78/+60. 84,932/26,353. Raised to measured.
  // Then log 36.107 (8c): the work's steps around the work (`_stepped`, the tickets, `_stepsOf`): +1,735/+352. 86,667/26,705. Raised to measured.
  // Then log 36.108 (8d): the chain, its runners, `perAction` and `priority` out: -1,355/-356. 85,312/26,349. Lowered to measured.
  // Then log 36.109 (8e): the public onBefore out, its loops and its cancel: -665/-134. 84,647/26,215. Lowered to measured.
  // Then log 36.110 (8f): the per-action record, one read per command: +241/+128. 84,888/26,343. Raised to measured.
  // Then log 36.111: the rules follow a plugin's scope: +42/+35. 84,930/26,378. Raised to measured.
  // Then log 36.112: the pattern reader in its own module, the same statements in a new order: +1/-2. 84,931/26,376. To measured.
  // Then log 36.113: the outbox record's key through one writer, `_recordKeyed`: +9/-52. 84,940/26,324. To measured.
  // Then log 36.114: two header checks read `_headerOf`: -27/+11. 84,913/26,335. To measured.
  // Then log 36.115 (8g): one install per plugin, inspect's `parts`: +134/+84. 85,047/26,419. Raised to measured.
  // Then step 8h (log 36.116-36.124): the reporter and its codes. Set to what the build reads (no IIFE work).
  // Then the 1-7 fix-up, per commit, raw/brotli: 36.F1 the stores' fact lane (the reply's `stores` emit, the `{ entries, lane }` record, its clear, the store's one `write`, `land`, share's agreed state) +284/+76; 36.F2 0; 36.F3 one registry-entry factory +67/+64; 36.F4 the state half as one function +274/+39; 36.F5 the outbox on a state half, its tab locks +888/+377; 36.F6 history's stacks on a state half +486/+207; 36.F7 the buffer's queue on one +201/+53. 88,326/27,626. Raised to measured.
  // Then the 1-7 fix-up close (36.F9 to 36.F14, IIFEs legacy: no per-commit reading): set to what the build reads. 89,238/27,910.
  // Then log 36.F16, the outbox dropping the ids it removed from another tab's queue: +176/-4. 89,414/27,906.
  // Then log 36.F18, the outbox's merge of another tab's queue, its clear count and the share that takes every state: +311/+145. 89,725/28,051.
  // Then log 36.F30, tabs carry commands and undo (owner 2026-10-22: "sizes ok"), IIFEs raised to measured, all three. 93,922/29,253.
  // Then log 36.F32, the answer covers what its tab sent before it: +23/+6. 93,945/29,259. Raised to measured.
  // Then log 36.F38, VaporChamber.mount creates its stores, binds its element, returns unmount(): +160/+52. 94,003/29,285. Raised to measured.
  // Then log 36.F39, every tab on the lead's runs (the Web Lock, the relay, both rebases in store-share): +2,316/+742. 96,319/30,027. Raised to measured.
  // Then log 36.F40, every tab's history the same after a meeting (the ledger's `under`, the store's `hear`): +204/+47. 96,523/30,074. Raised to measured.
  // Then log 36.F41, `store.$ready` (the member, its shared promise, the share's settle): +163/+37. 96,686/30,111. Raised to measured.
  // Then log 36.F42 (B4), the action's live registrations, the typed Vapor app off the root, form.aria's ids and reads: +373/+91. 97,059/30,202. Raised to measured.
  // Then log 36.F46 (phase 2 C2, the retry's success with no .then and no thunk): 97,389/30,331. Raised to measured.
  // Then log 36.F47 (phase 2 C3, a sync handler with no async frame): 97,573/30,367. Raised to measured.
  // Then log 36.F48 (phase 2 C4, _postJson with no async frame): 97,606/30,380. Raised to measured.
  // Then log 36.F49 (phase 2 C5, useCommand reads once whether its bus can reject): 97,760/30,436. Raised to measured.
  // Then log 36.F50 (phase 2 C7, syncQuery builds its command before the depth's try): raw 97,767. Raised to measured.
  // Then log 36.F55 (supersede refuses a sync bus, attach before the plugin is placed): raw 97,768. Raised to measured.
  // Then log 36.F56 (one command map on both buses, the signal slot): raw 97,866. Raised to measured.
  // Then log 36.F57 (a thunk out of the dispatch functions, counted faster; performance decides over size): 98,063/30,471. Raised to measured.
  // Then a plain store action's result, the state it wrote (tests/store-result-own-write.test.ts): raw -10, brotli +3, 98,053/30,474. Brotli raised to measured. Core and elements moved down and stay under.
  'vapor-chamber.iife.min.js':          { rawMax: 98_063, brotliMax: 30_474 },
  // Then (log s35.107) BusError and its vocabulary moved to src/failure.ts so
  // the router raises the core's failure without importing the bus. A pure
  // move: raw bytes identical in all three IIFEs once the import sits where
  // the code was; brotli moves with the arrangement: full -8 (budget kept),
  // core +5, elements +7. Owner: raised to measured ("size no issue").
  // Then audit D4 (see the full IIFE's note): core +61/+6, elements +61/+17.
  // Then audit D7: maxBufferSize read once by countOption when the bus is
  // made (a `bufferLimit` slot on both bus states), raw +54 in all three,
  // brotli full -51 (budget kept), core +7, elements +6. Raised to measured.
  // Then audit D8: request()'s timeout read by countOption, one piece (the
  // ws bridge is in neither): core +22/+24, elements +22/+12. Raised to
  // measured.
  // Then audit D9: the throttle gate reads its wait once by countOption, one
  // piece: core +17/0, elements +17/+1. Raised to measured.
  // Then debounce reads its wait the same way, one piece: core +13/+14,
  // elements +13/+22. Raised to measured.
  // Then audit D10 (see the full IIFE's note): core +17/+11, elements
  // +17/-4. Raised to measured, elements brotli kept.
  // Then audit D11: the encoder and the http bridge through it, one piece
  // (no ws bridge here): core +206/+62, elements +206/+73. Raised to measured.
  // Then audit HT-24 (see the full IIFE's note): core +33/-2, elements +33/-2.
  // Raw raised to measured, brotli kept.
  // Then complexity review F1 (see the full IIFE's note), raw/brotli: the
  // helper +59/+32 core, +59/+24 elements; the sites through it -64/-2 core,
  // -64/+2 elements; the detach +22/+6 core, +22/+8 elements. Total -5/+30
  // core, -5/+26 elements. Brotli raised to measured, raw kept.
  // Then complexity review B3 (see the full IIFE's note): core +5/+2,
  // elements +5/-1. Core brotli raised to measured.
  // Then log 36.16 item 1 (see the full IIFE's note): the bus through it
  // +51/+21 core, +51/+36 elements; the client +15/+6 core, +15/+2 elements.
  // Total -12/+5 core, -12/-4 elements. Core brotli raised to measured.
  // Then log 36.17, the http `retry` count (see the full IIFE's note): core
  // +7/+7, elements +7/+19. Brotli raised to measured.
  // Then complexity review F12 (see the full IIFE's note): core -118/-55,
  // elements -118/-58. Lowered to measured, which locks it.
  // Then complexity review F2 (see the full IIFE's note): `readAnswer` alone
  // core +13/+9, elements +13/+3; total core +45/+47, elements +45/+47.
  // Raised to measured.
  // Then compat step 1 (see the full IIFE's note): the tag alone +72 min,
  // total core +126/+40, elements +126/+42. Raised to measured.
  // Then the V8 round, item 1 (see the full IIFE's note): the typeof tests
  // core -8/-5, elements -8/-4, the writer built once core +10/+14, elements
  // +10/+5. Total core +2/+9, elements +2/+1. Raised to measured.
  // Then log 36.41 (see the full IIFE's note): the wrapper check core
  // +412/+107, elements +412/+130, the identity key core +210/+35, elements
  // +210/+44. Total core +622/+158, elements +622/+168. Raised to measured.
  // Then log 36.42 (see the full IIFE's note): the epoch rule core +157/+34,
  // elements +157/+28, the batched result's headers core +27/-2, elements
  // +27/+1. Total core +206/+39, elements +206/+40. Raised to measured.
  // Then the custom client's header names (see the full IIFE's note): core
  // +8/-2, elements +8/+6. Raw raised to measured, core brotli kept.
  // Then log 36.45 (see the full IIFE's note), brotli, each left out alone:
  // `batch` core +509, elements +490, the answers at the send core +75,
  // elements +77, use()'s refusal core +47, elements +36, failed:send core
  // +26, elements +28, disposing the transports core +17, elements +23,
  // sendFrom core +19, elements +5, the inlined hit path core +14, elements
  // +16. Total core +2399/+723, elements +2399/+703. Raised to measured.
  // Then log 36.47 (see the full IIFE's note), raw/brotli, each left out
  // alone: the `headers` member core +142/+57, elements +142/+51, the scan
  // core +29/+30, elements +29/+17, the result's status core +30/+19,
  // elements +30/+10, `Accept` core +22/+9, elements +22/-5, the key out of
  // `meta` core -50/-5, elements -50/-13. Total core +325/+121, elements
  // +325/+125. Raised to measured.
  // Then log 36.48 (see the full IIFE's note), one piece: core +16/+11,
  // elements +16/+24. Raised to measured.
  // Then log 36.49 (see the full IIFE's note), raw/brotli: the Accepted and its
  // follow core +1366/+450, elements +1366/+453; the batched 202 core +51/+19,
  // elements +51/+21; the single 202 core +74/+10, elements +74/+13; `dispose`
  // core +18/+7, elements +18/+5. Total core +1683/+550, elements
  // +1683/+541. Raised to measured.
  // Then log 36.51 (see the full IIFE's note), raw/brotli, each left out
  // alone: the single check core +50/+6, elements +50/+14, its records
  // core +28/-7, elements +28/+7, the batched check core +67/+7, elements
  // +67/+23, its records core +62/+7, elements +62/+18, `dispose` core
  // +10/-1, elements +10/+4, the message core +55/+15, elements +55/+35. No
  // WebSocket transport here. Total core +615/+167, elements +615/+185 from
  // 3d's. Raised to measured.
  // Then log 36.52 (see the full IIFE's note): one piece here, the bus
  // giving each transport itself (`attach`), core +94/+33, elements +94/+16.
  // No push reader in either. Raised to measured.
  // Then log 36.53 (see the full IIFE's note): the transports' group header
  // read and the plugin `attach`, core +220/+96, elements +220/+107.
  // Then log 36.62 (4e): one piece here, register() building only what a call
  // uses (speed, -40 to -122 ns a store creation), core +19/-6, elements
  // +19/-4. Raw raised to measured, brotli kept.
  // Then log 36.69 (4i): one piece here, the async bus's outbox hooks (the
  // option read and `attach`, the resolve's `adapt`, its `dispose`, the key
  // symbol, the one scope reader), creation code only; no outbox in either.
  // Core +140/+57, elements +140/+59. Raised to measured.
  // Then log 36.73 (see the full IIFE's note): the queue out of the bus,
  // core -741/-212, elements -741/-202; the createBuffer module, core
  // +1338/+489, elements +1364/+494. Raised to measured.
  // Then log 36.74 (4j): no WS here, raw identical. The outbox module's import
  // moved one `var` boundary (the same statements, counted), brotli core +37,
  // elements +5 from the arrangement. Brotli raised to measured.
  // Then log 36.78 (see the full IIFE's note): `register(..., { optimistic })`,
  // core +1,048/+264, elements +1,048/+276. Raised to measured.
  // Then log 36.79 (see the full IIFE's note): `register(..., { exclusive })`,
  // core +986/+251 (the brotli -55 from the arrangement once the run moved apart), elements +986/+276. Raised to measured.
  // Then log 36.80 (see the full IIFE's note): core +505/+176, elements
  // +505/+181. Raised to measured.
  // Then log 36.84 (see the full IIFE's note): the bus's facts observer, core
  // +198/+40, elements +198/+33. Raised to measured.
  // Then log 36.90 (6a): the two plugins and register's throttle gate out, `pace`
  // in: core -91/-33, elements -91/-49. Lowered to measured.
  // Then log 36.91 (6b): `bindCommands` and the command binding, new in both:
  // core +5,648/+1,829, elements +5,648/+1,826. Raised to measured.
  // Then log 36.92 (6c): `bindDisplay`, and the core store and `commandState` it
  // reads, new in both: core +11,468/+3,680, elements +11,468/+3,710. Raised to
  // measured.
  // Then log 36.93 (6d): elements only, `defineWidget`'s strategies: +788/+226.
  // Then log 36.95 (6f): latest wins and the IME guard, core +736/+159,
  // elements +736/+226. Raised to measured.
  // Then log 36.98 (7a, see the full IIFE's note): core +276/+89, elements
  // +276/+92. Raised to measured.
  // Then log 36.99 (7b, see the full IIFE's note): core +1,706/+352, elements +1,706/+344. Raised to measured.
  // Then log 36.100 (7c, see the full IIFE's note): core +189/+75, elements +189 raw (brotli -9, the budget kept). Raised to measured.
  // Then log 36.100 (7c, recovery) (see the full IIFE's note): core +179/+61, elements +179/+53. Raised to measured.
  // Then log 36.103 (8a, see the full IIFE's note): core -79/-47 (budget kept), elements -80/+26. Elements brotli raised to measured.
  // Then log 36.105 (8b, see the full IIFE's note): core +961/+316, elements +962/+211. Raised to measured.
  // Then log 36.106 (see the full IIFE's note): core +80/-5 (budget kept), elements +80/+12. Raised to measured.
  // Then log 36.107 (8c, see the full IIFE's note): core +1,720/+366, elements +1,719/+424. Raised to measured.
  // Then log 36.108 (8d, see the full IIFE's note): core -1,358/-402, elements -1,356/-401. Lowered to measured.
  // Then log 36.109 (8e, see the full IIFE's note): core -664/-81, elements -662/-81. Lowered to measured.
  // Then log 36.110 (8f, see the full IIFE's note): core +234/+109, elements +232/+109. Raised to measured.
  // Then log 36.111 (the rules follow a plugin's scope): core +44/+10, elements +44/+23. Raised to measured.
  // Then log 36.112 (the pattern reader's module, a new order only): core 0/+8, elements 0/-52. To measured.
  // Then log 36.114 (two header checks read `_headerOf`): core -26/+22, elements -25/+69. To measured.
  // Then log 36.115 (8g, see the full IIFE's note): core +134/-32, elements +134/+15. To measured.
  // Then step 8h (see the full IIFE note): set to what the build reads.
  // Then the 1-7 fix-up (see the full IIFE's note), core and elements raw/brotli: 36.F1 +284/+135 and +284/+115; 36.F3 +63/+43 and +63/+125; 36.F4 +244/+123 and +245/+12; 36.F5 -3/-34 and -4/+72; 36.F6 +4/+45 and +4/-22; 36.F7 +227/+47 and +227/+81. Raised to measured.
  // Then the 1-7 fix-up close (36.F9 to 36.F14): set to what the build reads.
  // Then log 36.F41, `store.$ready` (see the full IIFE's note): 69,872/21,896. Raised to measured.
  // Then log 36.F42 (B4, see the full IIFE's note): 70,187/21,984. Raised to measured.
  // Then log 36.F45 (phase 2 C1, after-hooks with no async frame): 70,108/21,985. Brotli raised to measured.
  // Then log 36.F46 (phase 2 C2, see the full IIFE's note): 70,517/22,126. Raised to measured.
  // Then log 36.F47 (phase 2 C3, see the full IIFE's note): 70,701/22,070. Raw raised to measured.
  // Then log 36.F48 (phase 2 C4, see the full IIFE's note): 70,734/22,125. Raw raised to measured.
  // Then log 36.F50 (phase 2 C7): raw 70,741. Raised to measured.
  // Then log 36.F55: 70,742/22,147. Raised to measured.
  // Then log 36.F56: raw 70,826. Raised to measured.
  // Then log 36.F57 (a thunk out of the dispatch functions, counted faster; performance decides over size): 71,020/22,207. Raised to measured.
  'vapor-chamber-core.iife.min.js':     { rawMax: 71_020, brotliMax: 22_207 },
  // Then the bundler alone (rolldown 1.2.12 -> 1.2.15 with vite 8.3.5, no source changed): elements brotli 22,542 -> 22,581 (+39), raw 72,256 -> 72,208. Raised to measured. Full and core moved down and stay under.
  // Then log 36.F41, `store.$ready` (see the full IIFE's note): 72,321/22,634. Raised to measured.
  // Then log 36.F42 (B4, see the full IIFE's note): 72,636/22,719. Raised to measured.
  // Then log 36.F45 (phase 2 C1, after-hooks with no async frame): 72,556/22,727. Brotli raised to measured.
  // Then log 36.F46 (phase 2 C2, see the full IIFE's note): 72,966/22,870. Raised to measured.
  // Then log 36.F47 (phase 2 C3, see the full IIFE's note): 73,149/22,901. Raised to measured.
  // Then log 36.F48 (phase 2 C4, see the full IIFE's note): 73,182/22,932. Raised to measured.
  // Then log 36.F50 (phase 2 C7): raw 73,189. Raised to measured.
  // Then log 36.F55: raw 73,190. Raised to measured.
  // Then log 36.F56: raw 73,274. Raised to measured.
  // Then log 36.F57 (a thunk out of the dispatch functions, counted faster; performance decides over size): 73,469/22,892. Raised to measured.
  'vapor-chamber-elements.iife.min.js': { rawMax: 73_469, brotliMax: 22_932 },
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

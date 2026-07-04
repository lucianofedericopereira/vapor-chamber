/**
 * Bundle-size budget guard.
 *
 * Fails CI if any IIFE variant exceeds its brotli budget. Locks the perf wins
 * from v1.2.0 (audience-split + signal extraction + listener bucketing) so a
 * future change can't silently regress the headline numbers.
 *
 * Adjust thresholds in BUDGETS when an intentional size change lands — the
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
// but NOT auto-bundled — opt in via configureAlienSignals from vapor-chamber/alien-signals.
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
  // SMALLER across all three (full 10.4→10.2, core 7.1→7.0, elements 7.5→7.4) but raw
  // nudged up — core raw crossed 25_000 by ~46 B. Raw ceiling absorbs that toolchain
  // drift; brotli ceilings stay put (the meaningful metric, and it improved).

  // v1.7.x bumps, two batches:
  //  • raw ~+0.3-0.6 KB — leak/correctness fixes: idempotent() eviction cap,
  //    useCommandError ring buffer, abort-listener detach in http retries, WS
  //    reconnect guards, directive timeout clear, schema validator precompile,
  //    CommandResult union.
  //  • raw ~+0.7 KB / brotli ~+0.2 KB — HTTP bridge surfaces backend body
  //    error messages (feature code), plus the sync-bus async-plugin dev
  //    warning. The warning is inert in these bundles (its env check folds to
  //    false at runtime) but rolldown's minifier doesn't constant-fold
  //    `typeof process < "u" && !1`, so its string ships as dead bytes —
  //    revisit if oxc gains that fold.
  // v1.8.0 bumps: logger level filtering + [ OK ]/[ FAIL ] badges (+~295 B min
  // in plugins-core), RETRYABLE_CODES beside BusError (+~170 B), retry()
  // registry-aware default (+~100 B). The outbox/mcp/typed-contract modules are
  // subpath-only and do NOT ship in these bundles.
  'vapor-chamber.iife.min.js':          { rawMax: 38_400, brotliMax: 11_150 },
  'vapor-chamber-core.iife.min.js':     { rawMax: 26_800, brotliMax: 7_800  },
  'vapor-chamber-elements.iife.min.js': { rawMax: 28_400, brotliMax: 8_250  },
};

const BR_OPTS = { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

let failed = false;
const rows = [];

for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = `dist/${file}`;
  if (!existsSync(path)) {
    console.error(`✗ missing: ${path} — did you run \`npm run build\`?`);
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

/**
 * EXPERIMENT: where does `meta.ts` come from, and what does that source cost?
 *
 * docs/performance.md states the per-dispatch costs and concludes "none of those
 * are free, all are unavoidable for the bus pattern's semantics." That is right
 * about the meta ALLOCATION. It never asks a narrower question: `stampMeta` reads
 * the clock with `Date.now()` on every dispatch, and a clock read is not an
 * allocation. This measures whether that read is a material share of a dispatch.
 *
 * WHY IT IS SHAPED THIS WAY. An isolated loop over `Date.now()` versus a cached
 * variable is exactly the micro-bench docs/performance.md warns is worthless:
 * `Date.now()` has an observable side effect and survives, while a loop-invariant
 * variable read is hoisted or dead-code-eliminated, so the "saving" is inflated by
 * an unknown amount. (Measured that way first, it reported ~28ns recoverable —
 * treat that number as garbage.) The same doc explains the fix: measure through
 * the real bus, because "the command bus is opaque indirection" and defeats
 * folding. So both arms here run the REAL `bus.dispatch` / `bus.query` path, and
 * the only thing that changes between them is what `Date.now` resolves to.
 *
 * NO SOURCE CHANGE is required to run it: `stampMeta` calls the global
 * `Date.now`, so swapping the global swaps the clock source for the real code
 * path. That keeps this an experiment rather than a commitment — nothing ships
 * unless the number justifies it.
 *
 * Conventions follow tests/signal-shallow-ab.test.ts: interleaved A/B reps to
 * cancel thermal drift, medians (never a single run), the table PRINTED as the
 * evidence, and deliberately NO timing-threshold assertion — single-host ratios
 * are unstable under parallel load and asserting them only makes CI flaky.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { _configureClock, createCommandBus } from '../src/command-bus';

const REAL_NOW = Date.now;
afterAll(() => { _configureClock(); });

/** A clock refreshed once per microtask drain: reads become a variable load. */
function makeCachedClock(): () => number {
  let now = REAL_NOW();
  let scheduled = false;
  const bump = () => { now = REAL_NOW(); scheduled = false; };
  return () => {
    if (!scheduled) { scheduled = true; queueMicrotask(bump); }
    return now;
  };
}

type Mode = 'dispatch' | 'query' | 'loaded' | 'realistic' | 'listeners' | 'batch' | 'emit';

/**
 * A deliberately ORDINARY app-level handler: build a small object, touch a few
 * fields, return it. Not a stress test and not a no-op — the point is to find
 * out whether a fixed ~16ns clock saving still shows up once the handler does
 * the kind of work a real `cartAdd` does. Claiming it "disappears into noise"
 * without measuring it is the same mistake as the isolated loop above.
 */
function realisticHandler(cmd: { target: any }): unknown {
  const t = cmd.target as { id: number };
  const line = { id: t.id, qty: 1, price: 19.99, total: 0, label: 'item-' + t.id };
  line.total = line.qty * line.price;
  return line;
}

function runOnce(mode: Mode, n: number): void {
  const bus = createCommandBus();
  if (mode === 'realistic') {
    bus.register('test', realisticHandler as never);
    for (let i = 0; i < n; i++) bus.dispatch('test', { id: i });
    return;
  }
  bus.register('test', (cmd) => cmd.target);

  // Consuming shapes. A fixed per-command cost is only interesting where it is
  // still a visible share of the work — and only worth paying for if it does
  // not COST anything on paths that read the clock rarely or not at all.
  // `emit` is the control: it deliberately skips stampMeta entirely, so it must
  // show ~1.00x. If it moves, the harness is measuring something other than the
  // clock and every other row here is suspect.
  if (mode === 'listeners') {
    for (let i = 0; i < 50; i++) bus.on('test', () => {});
    for (let i = 0; i < 5; i++) bus.on('te*', () => {});
    for (let i = 0; i < n; i++) bus.dispatch('test', i);
    return;
  }
  if (mode === 'batch') {
    const cmds = Array.from({ length: 20 }, (_, i) => ({ action: 'test', target: i }));
    for (let i = 0; i < n / 20; i++) bus.dispatchBatch(cmds);
    return;
  }
  if (mode === 'emit') {
    bus.on('evt', () => {});
    for (let i = 0; i < n; i++) bus.emit('evt', i);
    return;
  }
  if (mode === 'loaded') {
    // The honest counterweight to the bare-bus row: a clock read is a FIXED
    // cost, so its share shrinks as the rest of the dispatch grows. Same shape
    // as perf.bench.ts's "3 plugins + 1 listener" case.
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.on('test', () => {});
  }
  if (mode === 'query') for (let i = 0; i < n; i++) bus.query('test', i);
  else for (let i = 0; i < n; i++) bus.dispatch('test', i);
}

/**
 * ops/sec where one "op" = `n` commands through a fresh bare bus.
 *
 * Swaps the REAL injectable clock rather than patching the global, so both arms
 * exercise the shipped code path exactly as a consumer would.
 */
function opsPerSec(clock: (() => number) | undefined, mode: Mode, n: number, iters: number): number {
  _configureClock(clock);
  try {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) runOnce(mode, n);
    const t1 = process.hrtime.bigint();
    return iters / (Number(t1 - t0) / 1e9);
  } finally {
    _configureClock();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('meta.ts clock source — real dispatch path A/B', () => {
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('measures what Date.now() costs inside a real dispatch', () => {
    const cached = makeCachedClock();
    const N = 2_000;
    const cases: Array<{ key: string; mode: Mode; iters: number }> = [
      { key: 'bus.dispatch — bare bus', mode: 'dispatch', iters: 120 },
      { key: 'bus.query — bare bus', mode: 'query', iters: 120 },
      { key: 'dispatch — 3 plugins + 1 listener', mode: 'loaded', iters: 120 },
      { key: 'dispatch — ordinary handler', mode: 'realistic', iters: 120 },
      { key: 'dispatch — 50 listeners + 5 wild', mode: 'listeners', iters: 40 },
      { key: 'dispatchBatch — 20 per batch', mode: 'batch', iters: 80 },
      { key: 'emit — CONTROL, no stampMeta', mode: 'emit', iters: 120 },
    ];

    for (const c of cases) { opsPerSec(undefined, c.mode, N, 10); opsPerSec(cached, c.mode, N, 10); }

    // THIRD ARM, and the one due diligence actually requires: what does making
    // the clock swappable cost the DEFAULT path? `undefined` is the shipped
    // default (a wrapper reading the global each call); REAL_NOW is the same
    // clock without the wrapper. The gap between them is the price everyone
    // pays for an option most consumers will never turn on — and if that price
    // is not ~zero, the whole feature is a net loss no matter how good the
    // cached arm looks.
    const rows: Array<{ key: string; real: number; cached: number; ratio: number; nsSaved: number; wrapper: number }> = [];
    for (const c of cases) {
      const a: number[] = [];
      const b: number[] = [];
      const d: number[] = [];
      for (let rep = 0; rep < 5; rep++) {
        // interleave, alternating order so drift hits both arms equally
        if (rep % 2 === 0) {
          a.push(opsPerSec(undefined, c.mode, N, c.iters));
          b.push(opsPerSec(cached, c.mode, N, c.iters));
          d.push(opsPerSec(REAL_NOW, c.mode, N, c.iters));
        } else {
          d.push(opsPerSec(REAL_NOW, c.mode, N, c.iters));
          b.push(opsPerSec(cached, c.mode, N, c.iters));
          a.push(opsPerSec(undefined, c.mode, N, c.iters));
        }
      }
      const real = median(a);
      const cach = median(b);
      const direct = median(d);
      // one "op" is N commands, so convert to nanoseconds per command
      const nsReal = 1e9 / (real * N);
      const nsCached = 1e9 / (cach * N);
      rows.push({
        key: c.key, real, cached: cach, ratio: cach / real,
        nsSaved: nsReal - nsCached,
        wrapper: real / direct, // <1.00 means the swappable default costs throughput
      });
    }

    console.log('\n  meta.ts clock source — real path, median of 5 interleaved reps, ' + N + ' commands/op');
    for (const r of rows) {
      console.log(
        '   ' + r.key.padEnd(26),
        'Date.now=' + Math.round(r.real).toLocaleString().padStart(7),
        'cached=' + Math.round(r.cached).toLocaleString().padStart(7),
        'ratio=' + r.ratio.toFixed(3) + 'x',
        'saved=' + r.nsSaved.toFixed(1) + 'ns/cmd',
        'defaultVsDirect=' + r.wrapper.toFixed(3) + 'x',
      );
    }
    console.log(
      '   NOTE: an isolated Date.now-vs-variable loop reports a much larger saving;\n' +
      '         it is inflated by hoisting. These real-path numbers are the honest ones.\n',
    );

    // Evidence is the printed table. No timing threshold asserted, per the
    // house rule — only that the measurement genuinely ran.
    for (const r of rows) {
      expect(Number.isFinite(r.ratio)).toBe(true);
      expect(r.real).toBeGreaterThan(0);
      expect(r.cached).toBeGreaterThan(0);
    }
  }, 60_000);
});

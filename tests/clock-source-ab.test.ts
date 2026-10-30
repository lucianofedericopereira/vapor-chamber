/**
 * A/B on the real dispatch path: what stampMeta's `Date.now()` read costs, against a cached clock and the bare global.
 * Why: a clock read is a fixed per-command cost only a real-path A/B can size; an isolated Date.now-vs-variable loop is inflated by hoisting.
 * Shows: ns per command saved per path shape, emit as the control (no stampMeta, ~1.00x), the swappable default's cost; interleaved medians printed, no threshold.
 * See: docs/performance.md, tests/signal-shallow-ab.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { _configureClock, createCommandBus } from '../src/command-bus';
import { runTiming } from './under-coverage';

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

/** An ordinary app handler, neither a stress test nor a no-op: does a fixed clock saving survive real handler work? */
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

  // `emit` is the control: it skips stampMeta, so it must read ~1.00x; if it moves, the harness measures something else.
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
    // A fixed cost's share shrinks as the dispatch grows; the shape of perf.bench.ts's `dispatch.sync.parts3`.
    bus.use({ started: () => {} });
    bus.use({ settled: () => {} });
    bus.use({ begin: () => undefined });
    bus.on('test', () => {});
  }
  if (mode === 'query') for (let i = 0; i < n; i++) bus.query('test', i);
  else for (let i = 0; i < n; i++) bus.dispatch('test', i);
}

/** ops/sec, one op = `n` commands on a fresh bus; swaps the real injectable clock, so both arms run the shipped path. */
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

describe('meta.ts clock source - real dispatch path A/B', () => {
  it.skipIf(!runTiming)('measures what Date.now() costs inside a real dispatch', () => {
    const cached = makeCachedClock();
    const N = 2_000;
    const cases: Array<{ key: string; mode: Mode; iters: number }> = [
      { key: 'bus.dispatch - bare bus', mode: 'dispatch', iters: 120 },
      { key: 'bus.query - bare bus', mode: 'query', iters: 120 },
      { key: 'dispatch - 3 plugins + 1 listener', mode: 'loaded', iters: 120 },
      { key: 'dispatch - ordinary handler', mode: 'realistic', iters: 120 },
      { key: 'dispatch - 50 listeners + 5 wild', mode: 'listeners', iters: 40 },
      { key: 'dispatchBatch - 20 per batch', mode: 'batch', iters: 80 },
      { key: 'emit - CONTROL, no stampMeta', mode: 'emit', iters: 120 },
    ];

    for (const c of cases) { opsPerSec(undefined, c.mode, N, 10); opsPerSec(cached, c.mode, N, 10); }

    // Third arm: what the swappable clock costs the default path (`undefined` wraps the global; REAL_NOW is it bare).
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

    console.log('\n  meta.ts clock source - real path, median of 5 interleaved reps, ' + N + ' commands/op');
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

    // The printed table is the evidence; only that the measurement ran is asserted.
    for (const r of rows) {
      expect(Number.isFinite(r.ratio)).toBe(true);
      expect(r.real).toBeGreaterThan(0);
      expect(r.cached).toBeGreaterThan(0);
    }
  });
});

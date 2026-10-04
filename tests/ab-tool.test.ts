// The A/B tool's verdicts on synthetic replicates, and one real run of it.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundler, main, parseArgs } from '../scripts/ab/ab.mjs';
import { collect, combineLengths, fitLine, judge, judgeControl, rng, signFlipP } from '../scripts/ab/stats.mjs';

type Spec = { a: number; b: number; proc?: number; arm?: number; off?: number; bias?: (first: string) => number; aFirst?: number };

/** K replicates of one function `f`: per process a common factor, per round a small jitter. */
function replicates(K: number, spec: Spec, seed: number, rounds = 40) {
  const r = rng(seed);
  const z = () => {
    // Box-Muller from the seeded uniform source.
    const u = Math.max(r(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const reps = [];
  for (let k = 0; k < K; k++) {
    const aFirst = spec.aFirst === undefined ? k % 2 === 0 : k < spec.aFirst;
    const order = aFirst ? ['A', 'B'] : ['B', 'A'];
    const procF = 1 + (spec.proc ?? 0.003) * z();
    const arm = (base: number) => {
      const own = base * procF * (1 + (spec.arm ?? 0.002) * z());
      const wall = Array.from({ length: rounds }, () => own * (1 + Math.abs(0.01 * z())));
      const thr = wall.map((w) => w * (1 - (spec.off ?? 0)));
      return { wall, thr, cpu: thr.map((t) => t * 1.01), gc: wall.map(() => ({})) };
    };
    const bias = spec.bias?.(order[0]) ?? 1;
    reps.push({ order, fns: { f: { n: 40_000, A: arm(spec.a), B: arm(spec.b * bias) } } });
  }
  return collect(reps).f;
}

const verdict = (control: Spec, ba: Spec, seed = 1) => judge(replicates(10, ba, seed + 100), judgeControl(replicates(10, control, seed)));

describe('ab stats: verdicts', () => {
  it('finds a seeded 5% effect, in ns as well', () => {
    const r = verdict({ a: 200, b: 200 }, { a: 200, b: 190 });
    expect(r.verdict).toBe('faster');
    expect(r.ratio).toBeGreaterThan(0.94);
    expect(r.ratio).toBeLessThan(0.96);
    expect(r.delta).toBeCloseTo(-10, 0);
  });

  it('finds a seeded slowdown', () => {
    expect(verdict({ a: 50, b: 50 }, { a: 50, b: 52 }).verdict).toBe('slower');
  });

  it('finds nothing in an A/A run', () => {
    for (let seed = 1; seed <= 5; seed++) expect(verdict({ a: 200, b: 200 }, { a: 200, b: 200 }, seed).verdict).toBe('no result');
  });

  it('refuses a wide control, however large the effect', () => {
    const r = verdict({ a: 200, b: 200, arm: 0.04 }, { a: 200, b: 160 });
    expect(r.verdict).toBe('no result');
    expect(r.why.join()).toMatch(/control spread/);
  });

  it('refuses an off-centre control with a narrow spread', () => {
    const ctl = judgeControl(replicates(10, { a: 200, b: 190 }, 3));
    expect(ctl.spread * 2).toBeLessThan(0.03);
    expect(ctl.ok).toBe(false);
    expect(ctl.why.join()).toMatch(/control centre/);
  });

  it('refuses a row whose wall time holds off-CPU time', () => {
    const r = verdict({ a: 200, b: 200 }, { a: 200, b: 180, off: 0.03 });
    expect(r.verdict).toBe('no result');
    expect(r.why.join()).toMatch(/off-CPU/);
  });

  it('refuses an effect whose sign depends on the load order', () => {
    // 8 processes load A first: the median and its CI are theirs; the 2 B-first ones disagree.
    const r = verdict({ a: 200, b: 200 }, { a: 200, b: 200, aFirst: 8, bias: (first) => (first === 'A' ? 0.9 : 1.03) });
    expect(r.ci[1]).toBeLessThan(1);
    expect(r.verdict).toBe('no result');
    expect(r.why).toEqual(['load orders disagree']);
  });

  it('refuses an effect beyond the MDE whose interval includes 1', () => {
    // Exact per-process log-ratios: median -0.035, both load orders negative, 4 of 10 positive.
    const ds = [-0.1, -0.09, -0.08, -0.07, -0.04, -0.03, 0.02, 0.03, 0.04, 0.05];
    const arm = (wall: number) => ({ wall, thr: wall, off: 0, other: 0, gcRounds: {}, rounds: 40 });
    const rows = ds.map((d, i) => ({ n: 1000, first: i % 2 ? 'B' : 'A', a: arm(200), b: arm(200 * Math.exp(d)), d }));
    const r = judge(rows, judgeControl(replicates(10, { a: 200, b: 200 }, 1)));
    expect(r.why).toEqual(['CI includes 1']);
  });

  it('refuses an effect with a narrow interval that is within the MDE', () => {
    const r = verdict({ a: 200, b: 200, arm: 0.011 }, { a: 200, b: 199, arm: 0.0005, proc: 0.0005 });
    expect(r.ci[1]).toBeLessThan(1);
    expect(r.why.join()).toMatch(/within MDE/);
    expect(r.why).toHaveLength(1);
  });
});

describe('ab stats: pieces', () => {
  it('fits the paired line exactly on exact points', () => {
    const f = fitLine([10_000, 20_000, 40_000, 80_000].map((n) => ({ n, y: 280_000 - 18.4 * n })));
    expect(f.slope).toBeCloseTo(-18.4, 6);
    expect(f.intercept).toBeCloseTo(280_000, 3);
    expect(f.maxResidual).toBeLessThan(1e-6);
  });

  it('counts a claim only when every length agrees', () => {
    expect(combineLengths([{ verdict: 'faster' }, { verdict: 'faster' }]).verdict).toBe('faster');
    expect(combineLengths([{ verdict: 'faster' }, { verdict: 'no result' }]).verdict).toBe('no result');
    expect(combineLengths([{ verdict: 'no result' }]).why).toEqual(['no length counted']);
  });

  it('sign-flip test of the median: all one sign is significant, mixed signs are not', () => {
    // Flipping any subset of 1..4, or the mirror of such a pattern, keeps |median| at 5.5: 32 of 1,024.
    expect(signFlipP([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(32 / 1024, 6);
    expect(signFlipP([1, -1, 2, -2, 3, -3, 4, -4, 5, -5])).toBeGreaterThan(0.5);
  });

  it('parses options, repeatable flags, and a pinned n per function', () => {
    const o = parseArgs(['a', 'b', 'w.mjs', '--k=4', '--flags=--single-threaded', '--flags=--no-opt', '--n=p0:1000,p4:2000', '--lengths=1']);
    expect(o).toMatchObject({ distA: 'a', distB: 'b', workload: 'w.mjs', k: 4, lengths: 1, flags: ['--single-threaded', '--no-opt'], n: { p0: 1000, p4: 2000 } });
    expect(parseArgs(['a', 'b', 'w', '--n=5000']).n).toBe(5000);
    expect(() => parseArgs(['a', 'b'])).toThrow(/usage/);
    expect(() => parseArgs(['a', 'b', 'w', '--bogus=1'])).toThrow(/unknown option/);
    expect(() => parseArgs(['a', 'b', 'w', '--lengths=3'])).toThrow(/lengths/);
  });
});

describe('ab tool: a fresh install', () => {
  it('bundles with no node_modules/.cache yet, as after npm ci on CI', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'vc-ab-fresh-')), 'node_modules', '.cache');
    const b = await bundler(root);
    expect(existsSync(root)).toBe(true);
    b.dispose();
  });
});

describe('ab tool: smoke', () => {
  it('runs end to end: bundle, warm sizing, minor gc children, report', async () => {
    const w = resolve(__dirname, '../scripts/ab/workloads/smoke.mjs');
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      const summary = await main([__dirname, __dirname, w, '--k=2', '--rounds=4', '--ms=1', '--lengths=2']);
      expect(Object.keys(summary)).toEqual(['sum']);
      expect(['faster', 'slower', 'no result']).toContain(summary.sum.verdict);
      expect(summary.sum.ratios).toHaveLength(2);
      expect(summary.sum.fit).not.toBeNull();
    } finally {
      console.log = log;
    }
    expect(lines.join('\n')).toMatch(/pinned: --n=sum:\d+ \(and 4x\)/);
  });
});

// Why synthetic replicates: the verdict logic is what decides whether a speed
// claim is made, and a timing run cannot be seeded. Each refusal test seeds the
// one defect it names (a wide control, an off-centre control, off-CPU time,
// load-order dependence) under an effect large enough that only the gate can
// stop it, so a gate removed or loosened turns that test red. The off-centre
// case is the one log s35.48 found: an A/A control of 0.953 with a 1.3% spread
// passed a gate that checked the spread only. The smoke test asserts shape, not
// speed: two processes per phase and four rounds measure nothing.

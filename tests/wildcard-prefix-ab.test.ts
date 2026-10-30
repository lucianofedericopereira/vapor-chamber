/**
 * A/B of wildcard fan-out in `createCommandBus`: precomputed listener prefix against the `matchesPattern` baseline, on the real dispatch path.
 * Why: a wildcard listener that fans out to a different set of actions than the baseline would mis-route commands, and the prefix optimization is only worth keeping if it is measurably no slower.
 * Shows: for six patterns, the shipped bus and a baseline built at run time from the shipped source (fan-out line reverted) deliver the same actions; a timing table prints under `npm run test:timing`, with only finite positive rates asserted and no ratio threshold.
 * See: docs/performance.md, tests/clock-source-ab.test.ts, scripts/ab-vue.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { runTiming } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'wildcard-prefix');
const BASELINE = resolve(REF_DIR, 'command-bus-wildcard-baseline.ts');

/** The shipped fan-out line, and the form the baseline arm reverts it to. */
const SHIPPED_LINE = 'if (!entry.off && action.startsWith(entry.prefix)) {';
const BASELINE_LINE = 'if (!entry.off && matchesPattern(entry.pattern, action)) {';

function buildBaseline(): void {
  const src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  if (!src.includes(SHIPPED_LINE)) {
    throw new Error(
      `wildcard-prefix-ab: could not find the shipped fan-out line to revert.\n` +
        `Expected: ${SHIPPED_LINE}\n` +
        `If the fan-out was refactored, update SHIPPED_LINE/BASELINE_LINE here - ` +
        `otherwise this A/B silently measures the same code twice.`,
    );
  }
  const reverted = src
    .replace(SHIPPED_LINE, BASELINE_LINE)
    .replace(/from '\.\/([\w-]+)'/g, "from '../../../src/$1'");
  mkdirSync(REF_DIR, { recursive: true });
  writeFileSync(BASELINE, reverted);
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

type Factory = typeof createCommandBus;

/**
 * One "op" is `n` dispatches through a fresh bus carrying `wilds` wildcard
 * listeners; a fresh bus per op keeps setup cost identical across arms.
 */
function opsPerSec(factory: Factory, wilds: string[], n: number, iters: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    const bus = factory();
    bus.register('cartAdd', (cmd) => cmd.target);
    for (const p of wilds) bus.on(p, () => {});
    for (let j = 0; j < n; j++) bus.dispatch('cartAdd', j);
  }
  const t1 = process.hrtime.bigint();
  return iters / (Number(t1 - t0) / 1e9);
}

describe('wildcard listener prefix - real dispatch path A/B', () => {
  it('matches the baseline exactly, and measures the difference', async () => {
    buildBaseline();
    const base = (await import(/* @vite-ignore */ BASELINE)) as { createCommandBus: Factory };
    const baseline = base.createCommandBus;

    // Equivalence first: a faster wrong answer is not an optimization.
    const patterns = ['*', 'cart*', 'user*', 'c*', '**', 'cartAdd*'];
    const actions = ['cartAdd', 'cartRemove', 'userLogin', 'c', 'x', '*starred'];
    for (const pattern of patterns) {
      const hitsNew: string[] = [];
      const hitsOld: string[] = [];
      const a = createCommandBus({ naming: undefined });
      const b = baseline({ naming: undefined });
      a.on(pattern, (cmd) => hitsNew.push(cmd.action));
      b.on(pattern, (cmd) => hitsOld.push(cmd.action));
      for (const action of actions) {
        a.emit(action);
        b.emit(action);
      }
      expect(hitsOld).toEqual(hitsNew);
    }
    // '*' slices to '' and every action startsWith(''): match-all relies on it.
    expect(''.length).toBe(0);
    expect('anything'.startsWith('')).toBe(true);

    // Timing runs on `npm run test:timing` only, never instrumented (tests/under-coverage.ts).
    if (!runTiming) return;

    const N = 2_000;
    const cases: Array<{ key: string; wilds: string[]; iters: number }> = [
      // Control: the fast path skips fan-out entirely, so it must stay ~1.00x.
      { key: 'CONTROL - no wildcard listeners', wilds: [], iters: 120 },
      { key: '1 wildcard listener', wilds: ['cart*'], iters: 100 },
      { key: '5 wildcard listeners', wilds: ['*', 'cart*', 'user*', 'order*', 'ship*'], iters: 60 },
      { key: `1 '*' listener (logger shape)`, wilds: ['*'], iters: 100 },
    ];

    // warm both arms on every case before timing anything
    for (const c of cases) {
      opsPerSec(baseline, c.wilds, N, 10);
      opsPerSec(createCommandBus, c.wilds, N, 10);
    }

    const rows: Array<{ key: string; old: number; neu: number; ratio: number; nsSaved: number }> = [];
    for (const c of cases) {
      const A: number[] = [];
      const B: number[] = [];
      for (let rep = 0; rep < 7; rep++) {
        if (rep % 2 === 0) {
          A.push(opsPerSec(baseline, c.wilds, N, c.iters));
          B.push(opsPerSec(createCommandBus, c.wilds, N, c.iters));
        } else {
          B.push(opsPerSec(createCommandBus, c.wilds, N, c.iters));
          A.push(opsPerSec(baseline, c.wilds, N, c.iters));
        }
      }
      const oldOps = median(A);
      const newOps = median(B);
      rows.push({
        key: c.key,
        old: oldOps,
        neu: newOps,
        ratio: newOps / oldOps,
        nsSaved: 1e9 / (oldOps * N) - 1e9 / (newOps * N),
      });
    }

    console.log('\n  wildcard fan-out - real bus.dispatch, median of 7 interleaved reps, ' + N + ' dispatches/op');
    for (const r of rows) {
      console.log(
        '   ' + r.key.padEnd(30),
        'matchesPattern=' + Math.round(r.old).toLocaleString().padStart(6),
        'prefix=' + Math.round(r.neu).toLocaleString().padStart(6),
        'ratio=' + r.ratio.toFixed(3) + 'x',
        'saved=' + r.nsSaved.toFixed(1) + 'ns/dispatch',
      );
    }
    console.log('');

    for (const r of rows) {
      expect(Number.isFinite(r.ratio)).toBe(true);
      expect(r.old).toBeGreaterThan(0);
      expect(r.neu).toBeGreaterThan(0);
    }
  });
});

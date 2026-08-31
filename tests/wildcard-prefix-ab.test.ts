/**
 * EXPERIMENT -> SHIPPED: does precomputing a wildcard listener's prefix at
 * subscribe time pay for itself on the real dispatch path?
 *
 * WHERE THE IDEA CAME FROM. Vue 3.6.0-rc.6's `29ed4b0` ("perf(runtime-vapor):
 * cache template adopt target") hoists a per-call template-string scan into an
 * `AdoptTarget` descriptor that `template()` computes once per template factory
 * and hands back on every adoption, turning a hot-path re-parse into integer and
 * identity compares. Reading it turned the question on this repo's own fan-out:
 * `on()` classifies a pattern as a wildcard in order to pick a bucket, then
 * THROWS THAT RESULT AWAY, and every dispatch re-derives it inside
 * `matchesPattern` - `=== '*'`, a `charCodeAt`, and an LRU `Map.get`.
 *
 * WHY IT IS SHAPED THIS WAY - and this is the part the house rules force.
 * `_syncDispatchInner` carries a recorded counter-example: a cached `isBare`
 * boolean was tried there and measured **25% WORSE**, because adding a field
 * changed the hidden class of a hot object for no benefit. So "storing the
 * parse must be faster" is exactly the kind of claim this repo does not accept
 * unmeasured, and an isolated matcher loop will not settle it either -
 * docs/performance.md warns that isolated micro-benches inflate savings by
 * hoisting loop-invariant work. (Measured that way first, this one reported
 * 3.66x on the matcher alone. Treat that number as an upper bound, not a
 * result.)
 *
 * So both arms here run the REAL `bus.dispatch`, in ONE process, interleaved
 * AB/BA to cancel thermal drift, medians of several reps - the same method as
 * `tests/clock-source-ab.test.ts` and `scripts/ab-vue.mjs`.
 *
 * HOW THE BASELINE ARM IS BUILT. Arm A must be the real pre-change module, not
 * a hand-written imitation of it, or the measurement compares this file's
 * transcription skills rather than the two implementations. So the baseline is
 * DERIVED from the shipped source at run time: `src/command-bus.ts` is copied
 * into `tests/__ref/` with the fan-out line reverted to its previous
 * `matchesPattern(...)` form and its two sibling imports repointed. That copy
 * exports a real `createCommandBus`, so arm A is the genuine old dispatch path.
 * `tests/__ref/` is the same scratch location `ab-vue.mjs` uses; it is never
 * published (package.json `files` ships dist/src/scripts) and is removed here in
 * `afterAll`. If the revert target ever stops matching the source the transform
 * throws, so this file cannot silently degrade into measuring one arm twice.
 *
 * NO TIMING THRESHOLD IS ASSERTED, per the house rule - single-host ratios are
 * unstable under parallel load and asserting them only makes CI flaky. The
 * printed table is the evidence. What IS asserted is equivalence: both arms
 * must fan out to exactly the same listeners for the same actions, including
 * the `'*'`-slices-to-`''` edge that the whole optimization rests on.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_DIR = resolve(HERE, '__ref');
const BASELINE = resolve(REF_DIR, 'command-bus-wildcard-baseline.ts');

/** The line this change introduced, and the line it replaced. */
const SHIPPED_LINE = 'if (action.startsWith(entry.prefix)) {';
const BASELINE_LINE = 'if (matchesPattern(entry.pattern, action)) {';

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
    .replace(/from '\.\/dev'/g, "from '../../src/dev'")
    .replace(/from '\.\/dict'/g, "from '../../src/dict'");
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
 * listeners. A fresh bus per op is deliberate: it matches `clock-source-ab`'s
 * shape and keeps setup cost identical across arms.
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
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('matches the baseline exactly, and measures the difference', async () => {
    buildBaseline();
    const base = (await import(/* @vite-ignore */ BASELINE)) as { createCommandBus: Factory };
    const baseline = base.createCommandBus;

    // --- equivalence first. A faster wrong answer is not an optimization. ----
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
    // The edge the optimization rests on: '*' slices to '' and every action
    // startsWith(''). If that ever stopped holding, match-all would silently
    // stop matching.
    expect(''.length).toBe(0);
    expect('anything'.startsWith('')).toBe(true);

    // --- measurement --------------------------------------------------------
    const N = 2_000;
    const cases: Array<{ key: string; wilds: string[]; iters: number }> = [
      // The shape the fast path already skips entirely - must show ~1.00x, and
      // is the control: if it moves, the harness is measuring something else.
      { key: 'CONTROL - no wildcard listeners', wilds: [], iters: 120 },
      { key: '1 wildcard listener', wilds: ['cart*'], iters: 100 },
      { key: '5 wildcard listeners', wilds: ['*', 'cart*', 'user*', 'order*', 'ship*'], iters: 60 },
      // A logging/devtools bus: one '*' listener is the single most common
      // real-world wildcard shape.
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
  }, 120_000);
});

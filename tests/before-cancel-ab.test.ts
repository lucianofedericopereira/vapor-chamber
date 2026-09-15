/**
 * Real-path A/B for VC_CORE_BEFORE_CANCEL, in the house three-arm shape
 * (tests/plugin-throw-ab.test.ts): a baseline DERIVED from the shipped
 * src/command-bus.ts with the change reverted, a byte-identical second copy
 * of that baseline as the self-control, and the shipped source - every timed
 * arm a derived copy, loaded the same way.
 *
 * WHAT IS REVERTED for the baseline: the two before-hook catch sites go back
 * to `errResult(e as Error)`; the unused `beforeCancel` helper stays in the
 * module, which changes nothing a dispatch runs.
 *
 * WHAT IS MEASURED: the catch sites sit inside `_syncDispatchInner` and
 * `_asyncDispatchInner`, so a dispatch that runs a before-hook WITHOUT a throw
 * executes the same text on every arm - the rows with one hook read whether
 * the changed catch body moved anything around it (function size, inlining).
 * The throwing rows are the cold path the change is on: a BusError built
 * per cancelled dispatch, on top of the Error the hook threw.
 *
 * READ EVERY ROW AGAINST ITS SELF-CONTROL ROW. NO TIMING THRESHOLD IS
 * ASSERTED; the printed table is the evidence. Asserted: the arms agree on
 * every non-throwing result, and differ where intended (a hook's throw is a
 * VC_CORE_BEFORE_CANCEL BusError on the shipped arm, the raw throw on the
 * baseline). Numbers quoted anywhere come from three runs of:
 *
 *   NODE_ENV=production NODE_OPTIONS=--expose-gc npx vitest run tests/before-cancel-ab.test.ts --silent=false
 *
 * Ratios are TIME ratios: above 1.00 is slower than the denominator arm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type * as ShippedMod from '../src/command-bus';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_DIR = resolve(HERE, '__ref');

/** [shipped text, baseline text, expected occurrences] */
const REVERTS: Array<[string, string, number]> = [
  ['      const result = errResult(beforeCancel(e, action));\n', '      const result = errResult(e as Error);\n', 2],
];

function derive(revert: boolean): string {
  let src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  if (revert) {
    for (const [shipped, baseline, n] of REVERTS) {
      const parts = src.split(shipped);
      if (parts.length - 1 !== n) {
        throw new Error(`before-cancel-ab: expected ${n} x ${JSON.stringify(shipped)}, found ${parts.length - 1} - update REVERTS, otherwise this A/B silently measures the same code twice.`);
      }
      src = parts.join(baseline);
    }
  }
  return src.replace(/from '\.\/([\w-]+)'/g, "from '../../src/$1'");
}

const written: string[] = [];
afterAll(() => {
  for (const f of written) if (existsSync(f)) rmSync(f, { force: true });
});

type Mod = typeof ShippedMod;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const gc = (globalThis as { gc?: () => void }).gc;
const noop = () => {};

function syncNs(m: Mod, hook: 'none' | 'pass' | 'throw', n: number): number {
  const bus = m.createCommandBus();
  if (hook === 'pass') bus.onBefore(noop);
  if (hook === 'throw') bus.onBefore(() => { throw new Error('blocked'); });
  bus.register('t', (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

async function asyncNs(m: Mod, hook: 'none' | 'pass' | 'throw', n: number): Promise<number> {
  const bus = m.createAsyncCommandBus();
  if (hook === 'pass') bus.onBefore(noop);
  if (hook === 'throw') bus.onBefore(() => { throw new Error('blocked'); });
  bus.register('t', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

const ROWS: Array<[string, (m: Mod) => number | Promise<number>]> = [
  ['CONTROL sync dispatch, no hook', (m) => syncNs(m, 'none', 200_000)],
  ['sync dispatch, 1 before-hook', (m) => syncNs(m, 'pass', 200_000)],
  ['async dispatch, 1 before-hook', (m) => asyncNs(m, 'pass', 40_000)],
  ['sync dispatch, hook throws (cold path)', (m) => syncNs(m, 'throw', 20_000)],
  ['async dispatch, hook throws (cold path)', (m) => asyncNs(m, 'throw', 10_000)],
];
const ROUNDS = 11;

describe('VC_CORE_BEFORE_CANCEL - real path A/B', () => {
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('agrees where nothing throws, differs where a hook throws, and measures both', async () => {
    mkdirSync(REF_DIR, { recursive: true });
    const arms: Record<string, Mod> = {};
    const load = async (name: string, revert: boolean) => {
      const file = resolve(REF_DIR, `before-cancel-${name}.ts`);
      writeFileSync(file, derive(revert));
      written.push(file);
      arms[name] = await import(/* @vite-ignore */ file);
    };
    await load('pre', true);
    await load('self', true);
    await load('shipped', false);

    // --- equivalence: nothing throws -------------------------------------------
    const shape = (r: any) => ({ ok: r.ok, value: r.value, code: r.error?.code, msg: r.error?.message });
    const settled = async (m: Mod) => {
      const out: unknown[] = [];
      const s = m.createCommandBus();
      s.onBefore(noop);
      s.register('t', (c) => c.target);
      s.register('bad', () => { throw new Error('boom'); });
      for (const a of ['t', 'bad', 'missing']) out.push(shape(s.dispatch(a, 1)));
      const as = m.createAsyncCommandBus();
      as.onBefore(noop);
      as.register('t', async (c) => c.target);
      as.register('bad', async () => { throw new Error('boom'); });
      for (const a of ['t', 'bad', 'missing']) out.push(shape(await as.dispatch(a, 1)));
      return out;
    };
    expect(await settled(arms.shipped)).toEqual(await settled(arms.pre));

    // --- intended difference: a hook's throw carries the code --------------------
    for (const [m, expected] of [[arms.pre, undefined], [arms.shipped, 'VC_CORE_BEFORE_CANCEL']] as const) {
      for (const make of [() => m.createCommandBus(), () => m.createAsyncCommandBus()]) {
        const bus: any = make();
        bus.register('t', () => 1);
        bus.onBefore(() => { throw new Error('blocked'); });
        const r: any = await bus.dispatch('t', 1);
        expect(r.ok).toBe(false);
        expect(r.error.message).toBe('blocked');
        expect(r.error.code).toBe(expected);
      }
    }

    // --- measurement --------------------------------------------------------
    const order = Object.keys(arms);
    const lines: string[] = [];
    for (const [label, row] of ROWS) {
      for (const k of order) { await row(arms[k]); await row(arms[k]); } // warm every arm
      const ns: Record<string, number[]> = {};
      for (const k of order) ns[k] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const rot = order.slice(r % order.length).concat(order.slice(0, r % order.length));
        for (const k of rot) { gc?.(); ns[k].push(await row(arms[k])); }
      }
      lines.push(`   ${label}  (pre ${median(ns.pre).toFixed(1)} ns/op)`);
      for (const [pl, num] of [['self-control', 'self'], ['shipped', 'shipped']] as const) {
        const ratios = ns[num].map((v, i) => v / ns.pre[i]);
        lines.push(`      ${pl.padEnd(14)} ${median(ratios).toFixed(3)}x [${Math.min(...ratios).toFixed(3)}, ${Math.max(...ratios).toFixed(3)}]`);
        expect(Number.isFinite(median(ratios))).toBe(true);
      }
    }
    console.log(`\n  VC_CORE_BEFORE_CANCEL - real path, ${ROUNDS} rotated rounds, gc=${!!gc}, NODE_ENV=${process.env.NODE_ENV}; time ratios, >1 slower\n${lines.join('\n')}\n`);
  }, 600_000);
});

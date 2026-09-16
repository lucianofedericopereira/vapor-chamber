/**
 * Real-path A/B for the scoped origin slot in stampMeta, in the house
 * three-arm shape (tests/plugin-throw-ab.test.ts): a baseline DERIVED from
 * the shipped src/command-bus.ts with the change reverted, a byte-identical
 * second copy of that baseline as the self-control, and the shipped source -
 * every timed arm a derived copy, loaded the same way.
 *
 * WHAT IS REVERTED for the baseline: the one line of stampMeta that reads
 * `_originScope` between the one-shot slot and the payload key. The
 * `_withOriginScope` function stays in the module and, on the baseline, has
 * no effect - which is the intended difference asserted below.
 *
 * WHAT IS MEASURED: stampMeta runs in the synchronous prologue of every
 * dispatch, so this is a hot-path read - one module slot and one nullish
 * test more per command. The rows are bare dispatches on both buses and a
 * sync dispatch with a listener; read them against the self-control row.
 *
 * NO TIMING THRESHOLD IS ASSERTED; the printed table is the evidence.
 * Numbers quoted anywhere come from three runs of:
 *
 *   NODE_ENV=production NODE_OPTIONS=--expose-gc npx vitest run tests/origin-scope-ab.test.ts --silent=false
 *
 * Ratios are TIME ratios: above 1.00 is slower than the denominator arm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type * as ShippedMod from '../src/command-bus';
import { underCoverage } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'origin-scope');

const REVERTS: Array<[string, string, number]> = [
  [
    '  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? _originScope ?? payload?.__origin };\n',
    '  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? payload?.__origin };\n',
    1,
  ],
];

function derive(revert: boolean): string {
  let src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  if (revert) {
    for (const [shipped, baseline, n] of REVERTS) {
      const parts = src.split(shipped);
      if (parts.length - 1 !== n) {
        throw new Error(`origin-scope-ab: expected ${n} x ${JSON.stringify(shipped)}, found ${parts.length - 1} - update REVERTS, otherwise this A/B silently measures the same code twice.`);
      }
      src = parts.join(baseline);
    }
  }
  return src.replace(/from '\.\/([\w-]+)'/g, "from '../../../src/$1'");
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

type Mod = typeof ShippedMod;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const gc = (globalThis as { gc?: () => void }).gc;
const noop = () => {};

function syncNs(m: Mod, listener: boolean, n: number): number {
  const bus = m.createCommandBus();
  if (listener) bus.on('*', noop);
  bus.register('t', (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

async function asyncNs(m: Mod, n: number): Promise<number> {
  const bus = m.createAsyncCommandBus();
  bus.register('t', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

const ROWS: Array<[string, (m: Mod) => number | Promise<number>]> = [
  ['sync dispatch, bare', (m) => syncNs(m, false, 200_000)],
  ['sync dispatch, 1 listener', (m) => syncNs(m, true, 200_000)],
  ['async dispatch, bare', (m) => asyncNs(m, 40_000)],
];
const ROUNDS = 11;

describe('scoped origin in stampMeta - real path A/B', () => {
  it.skipIf(underCoverage)('agrees outside a scope, differs inside one, and measures the read', async () => {
    mkdirSync(REF_DIR, { recursive: true });
    const arms: Record<string, Mod> = {};
    const load = async (name: string, revert: boolean) => {
      const file = resolve(REF_DIR, `origin-scope-${name}.ts`);
      writeFileSync(file, derive(revert));
      arms[name] = await import(/* @vite-ignore */ file);
    };
    await load('pre', true);
    await load('self', true);
    await load('shipped', false);

    // --- equivalence: no scope, the payload key, the one-shot slot ------------
    const origins = (m: Mod) => {
      const bus = m.createCommandBus();
      const seen: unknown[] = [];
      bus.register('t', (c) => { seen.push(c.meta?.origin); return 1; });
      bus.dispatch('t', 1);
      bus.dispatch('t', 1, { __origin: 'remote' });
      m._withOrigin('agent', () => bus.dispatch('t', 1));
      return seen;
    };
    expect(origins(arms.shipped)).toEqual(origins(arms.pre));
    expect(origins(arms.shipped)).toEqual([undefined, 'remote', 'agent']);

    // --- intended difference: every dispatch inside a scope carries it ------
    for (const [m, expected] of [[arms.pre, [undefined, undefined]], [arms.shipped, ['undo', 'undo']]] as const) {
      const bus = m.createCommandBus();
      const seen: unknown[] = [];
      bus.register('t', (c) => { seen.push(c.meta?.origin); return 1; });
      m._withOriginScope('undo', () => { bus.dispatch('t', 1); bus.dispatch('t', 2); });
      expect(seen).toEqual(expected);
      bus.dispatch('t', 3);
      expect(seen[2]).toBeUndefined(); // the scope ended with its callback
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
    console.log(`\n  scoped origin - real path, ${ROUNDS} rotated rounds, gc=${!!gc}, NODE_ENV=${process.env.NODE_ENV}; time ratios, >1 slower\n${lines.join('\n')}\n`);
  });
});

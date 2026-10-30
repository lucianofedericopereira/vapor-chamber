/**
 * A/B of the scoped origin read in stampMeta: a baseline derived from src/command-bus.ts with that read reverted, a second copy as self-control, and the shipped source.
 * Why: stampMeta runs on every dispatch, so a scope that leaked outside its callback would misattribute commands, and the extra read must not slow the hot path.
 * Shows: outside a scope shipped and baseline give the same origins (none, payload key, one-shot slot); inside `_withOriginScope` only shipped marks every dispatch, and the scope ends with its callback; the timing rows only assert a finite ratio, and run on `npm run test:timing`.
 * See: src/command-bus.ts, tests/under-coverage.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type * as ShippedMod from '../src/command-bus';
import { runTiming } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'origin-scope');

// Baseline = the stampMeta line that reads `_originScope` removed; `_withOriginScope` then has no effect.
const REVERTS: Array<[string, string, number]> = [
  [
    '  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? _originScope ?? payload?.__origin, idempotencyKey: undefined, response: undefined, request: undefined };\n',
    '  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? payload?.__origin, idempotencyKey: undefined, response: undefined, request: undefined };\n',
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
  it('agrees outside a scope, differs inside one, and measures the read', async () => {
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

    for (const [m, expected] of [[arms.pre, [undefined, undefined]], [arms.shipped, ['undo', 'undo']]] as const) {
      const bus = m.createCommandBus();
      const seen: unknown[] = [];
      bus.register('t', (c) => { seen.push(c.meta?.origin); return 1; });
      m._withOriginScope('undo', () => { bus.dispatch('t', 1); bus.dispatch('t', 2); });
      expect(seen).toEqual(expected);
      bus.dispatch('t', 3);
      expect(seen[2]).toBeUndefined(); // the scope ended with its callback
    }

    // Timing runs on `npm run test:timing` only, never instrumented (tests/under-coverage.ts).
    if (!runTiming) return;

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
      // Time ratios: above 1 is slower than the baseline arm.
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

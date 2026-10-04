// tests/v8.ts reads what it claims to, on this Node: one positive control per bit.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { inYoungGeneration, optimizationStatus, optimize, sameMap } from './v8';

// The suite runs without --expose-gc; a context created after the flag has `gc`.
setFlagsFromString('--expose-gc');
const fullGc = runInNewContext('gc') as () => void;

describe('tests/v8.ts', () => {
  it('sameMap: one literal shape is one map; another field order or a late field is another', () => {
    const make = (x: number) => ({ a: x, b: x });
    expect(sameMap(make(1), make(2))).toBe(true);
    expect(sameMap(make(1), { b: 1, a: 1 })).toBe(false);
    const late: Record<string, number> = make(1);
    late.c = 3;
    expect(sameMap(make(1), late)).toBe(false);
  });

  it('a function never called is lazy: no tier bit set, only isFunction', () => {
    const f = (x: number) => x + 1;
    const s = optimizationStatus(f);
    expect(s.isFunction).toBe(true);
    expect(s.optimized).toBe(false);
    expect(s.tier).toBe('unknown');
  });

  it('a called function is interpreted', () => {
    const f = (x: number) => x * 2;
    f(1);
    const s = optimizationStatus(f);
    expect(s.tier).toBe('interpreted');
    expect(s.optimized).toBe(false);
  });

  it('optimize() reaches TurboFan, and the optimized bit is set with it', () => {
    const f = (x: number) => x * 3 + 1;
    const s = optimize(f, [2]);
    expect(s.tier).toBe('turbofan');
    expect(s.optimized).toBe(true);
    expect(s.maglevved).toBe(false);
  });

  // A Node built without Maglev (v8_enable_maglev 0, e.g. NodeSource's 22.x on
  // Linux) cannot reach that tier with any flag: V8 prints "Maglev is not
  // enabled." and the function stays interpreted. Skipped only on that build
  // fact; a Node whose config omits the key still runs it (owner, 2026-10-03).
  const maglevBuilt = (process.config.variables as Record<string, unknown>).v8_enable_maglev !== 0;
  it.skipIf(!maglevBuilt)('optimize(..., "maglev") reaches Maglev', () => {
    const f = (x: number) => x * 5 - 1;
    const s = optimize(f, [2], 'maglev');
    expect(s.tier).toBe('maglev');
    expect(s.optimized).toBe(true);
    expect(s.turbofanned).toBe(false);
  });

  it('a deopt drops the tier: TurboFan code for numbers, then a string', () => {
    const f = (x: any) => x + 1;
    expect(optimize(f, [2]).tier).toBe('turbofan');
    f('s');
    expect(optimizationStatus(f).optimized).toBe(false);
  });

  it('optimize(..., "baseline") reaches Sparkplug, which is not an optimized tier', () => {
    const f = (x: number) => x - 7;
    const s = optimize(f, [1], 'baseline');
    expect(s.tier).toBe('baseline');
    expect(s.baseline).toBe(true);
    expect(s.optimized).toBe(false);
  });

  it('inYoungGeneration: a fresh object is young, and old after a full gc', () => {
    const o = { fresh: true };
    expect(inYoungGeneration(o)).toBe(true);
    fullGc();
    expect(inYoungGeneration(o)).toBe(false);
  });
});

// Why each test is a positive control: the bits are V8's internal
// OptimizationStatus enum (src/runtime/runtime-test.cc), renumbered across V8
// versions before. A helper that decoded a stale bit would answer "not
// optimized" for everything, and every test built on it would pass for the
// wrong reason; here each bit is driven to both values on the running Node.
// The young-generation check takes `gc` from a fresh VM context, since the
// suite runs without --expose-gc and only contexts made after the flag get it.

/**
 * V8 checks for tests, through the engine's own natives syntax: so a test asks
 * V8 about a hidden class or a tier in one line instead of a proxy (a key-order
 * comparison passes for maps V8 keeps apart; tests/v8-shapes.test.ts).
 *
 * `--allow-natives-syntax` is set at runtime and each `%` call is compiled
 * after it with `new Function`, because a natives call in this file's own
 * source would be a syntax error at load. Test-only: not a public API.
 *
 * The status bits are V8's internal `OptimizationStatus` enum, not a stable
 * interface; tests/v8-helper.test.ts pins each bit read here with a positive
 * control on the running Node, so a Node major that renumbers them turns that
 * test red rather than every caller silently wrong.
 */
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--allow-natives-syntax');

const natives = (body: string, ...params: string[]) => new Function(...params, body) as (...args: any[]) => any;

const haveSameMap = natives('return %HaveSameMap(a, b)', 'a', 'b');
const getStatus = natives('return %GetOptimizationStatus(f)', 'f');
const prepare = natives('return %PrepareFunctionForOptimization(f)', 'f');
const optimizeNext = natives('return %OptimizeFunctionOnNextCall(f)', 'f');
const optimizeMaglevNext = natives('return %OptimizeMaglevOnNextCall(f)', 'f');
const compileBaseline = natives('return %CompileBaseline(f)', 'f');
const inYoung = natives('return %InYoungGeneration(o)', 'o');

/** True when V8 gives `a` and `b` one hidden class (map). */
export const sameMap = (a: object, b: object): boolean => haveSameMap(a, b);

/** True while `o` is in the young generation (new space). */
export const inYoungGeneration = (o: object): boolean => inYoung(o);

// Bits of V8's OptimizationStatus (src/runtime/runtime-test.cc), the ones read
// here. Each is pinned by a positive control in tests/v8-helper.test.ts. Bit 1
// (kNeverOptimize) is left out: on Node 24.21 %NeverOptimizeFunction does not
// set it, and %PrepareFunctionForOptimization after it is a fatal CHECK.
const BIT = {
  isFunction: 1 << 0,
  optimized: 1 << 4,
  maglevved: 1 << 5,
  turbofanned: 1 << 6,
  interpreted: 1 << 7,
  baseline: 1 << 15,
} as const;

export type Tier = 'interpreted' | 'baseline' | 'maglev' | 'turbofan' | 'unknown';
export type OptimizationStatus = { raw: number; tier: Tier } & { [K in keyof typeof BIT]: boolean };

/** What V8 says about `fn` now: its tier, and the bits behind it. */
export function optimizationStatus(fn: (...args: any[]) => unknown): OptimizationStatus {
  const raw: number = getStatus(fn);
  const bits = Object.fromEntries(Object.entries(BIT).map(([k, v]) => [k, (raw & v) !== 0])) as { [K in keyof typeof BIT]: boolean };
  const tier: Tier = bits.turbofanned ? 'turbofan' : bits.maglevved ? 'maglev' : bits.baseline ? 'baseline' : bits.interpreted ? 'interpreted' : 'unknown';
  return { raw, tier, ...bits };
}

/**
 * Force `fn` to a tier: collect feedback with `args`, ask for the tier on the
 * next call, make that call. Returns the status after it, so a test reads
 * `expect(optimize(f, 1).tier).toBe('turbofan')` and then whether a later
 * call deoptimized it.
 */
export function optimize(fn: (...args: any[]) => unknown, args: unknown[], tier: 'turbofan' | 'maglev' | 'baseline' = 'turbofan'): OptimizationStatus {
  if (tier === 'baseline') {
    fn(...args); // compiled to bytecode first; Sparkplug compiles from it
    compileBaseline(fn);
    fn(...args);
    return optimizationStatus(fn);
  }
  prepare(fn);
  fn(...args);
  fn(...args);
  if (tier === 'maglev') optimizeMaglevNext(fn);
  else optimizeNext(fn);
  fn(...args);
  return optimizationStatus(fn);
}

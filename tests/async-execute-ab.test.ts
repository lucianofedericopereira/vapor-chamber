/**
 * Real-path A/B: the async bus's `execute` closure as a plain function
 * returning `tryCatchAsyncHandler`'s promise, against the `async` closure it
 * replaced.
 *
 * WHAT CHANGED. `_asyncDispatchInner` and `asyncQuery` built
 * `async () => { ...; return tryCatchAsyncHandler(handler, cmd); }`. An async
 * function whose body returns a promise allocates its own promise, resumes its
 * own frame, and resolves through a thenable job - two extra microtask turns -
 * all to pass along a promise it already had. The closure is now a plain
 * arrow; the missing-handler path goes through the `async` `asyncMissing`
 * helper so `onMissing: 'throw'` stays a rejection
 * (tests/async-missing-rejects.test.ts pins that).
 *
 * HOW THE BASELINE IS BUILT, per the house rule (see
 * tests/wildcard-prefix-ab.test.ts): derived from the shipped source at run
 * time, the two closures reverted to their previous `async` form, written to
 * tests/__ref/async-execute/ and imported as a real module. If a revert target stops
 * matching, the transform throws rather than measuring one arm twice.
 *
 * NO TIMING THRESHOLD IS ASSERTED; the printed table is the evidence. The
 * audit's verdict (rc-alignment-work.md s27) comes from the three-arm,
 * gc()-controlled, seven-process run, not from this single in-suite pass.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'async-execute');
const BASELINE = resolve(REF_DIR, 'command-bus-async-execute-baseline.ts');

const REVERTS: Array<[string, string]> = [
  [
    `  const execute = executeOverride ?? ((): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    return handler ? tryCatchAsyncHandler(handler, cmd) : asyncMissing(s, cmd, true);
  });`,
    `  const execute = executeOverride ?? (async (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s, cmd, true);
    return tryCatchAsyncHandler(handler, cmd);
  });`,
  ],
  [
    `  const execute = (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    return handler ? tryCatchAsyncHandler(handler, cmd) : asyncMissing(s, cmd, false);
  };`,
    `  const execute = async (): Promise<CommandResult> => {
    const handler = s.handlers.get(action);
    if (!handler) return handleMissing(s, cmd, false);
    return tryCatchAsyncHandler(handler, cmd);
  };`,
  ],
];

function buildBaseline(): void {
  let src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  for (const [shipped, baseline] of REVERTS) {
    if (!src.includes(shipped)) {
      throw new Error(
        'async-execute-ab: a shipped execute closure was not found - update REVERTS, ' +
          'otherwise this A/B silently measures the same code twice.\n' + shipped,
      );
    }
    src = src.replace(shipped, baseline);
  }
  src = src.replace(/from '\.\/dev'/g, "from '../../../src/dev'").replace(/from '\.\/dict'/g, "from '../../../src/dict'");
  mkdirSync(REF_DIR, { recursive: true });
  writeFileSync(BASELINE, src);
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

type Factory = typeof createAsyncCommandBus;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function opsPerSec(factory: Factory, mode: 'dispatch' | 'query', n: number, iters: number): Promise<number> {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    const bus = factory();
    bus.register('t', async (c) => c.target);
    if (mode === 'dispatch') for (let j = 0; j < n; j++) await bus.dispatch('t', j);
    else for (let j = 0; j < n; j++) await bus.query('t', j);
  }
  return iters / (Number(process.hrtime.bigint() - t0) / 1e9);
}

describe('async execute closure - real path A/B', () => {
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('matches the baseline exactly, and measures the difference', async () => {
    buildBaseline();
    const base = (await import(/* @vite-ignore */ BASELINE)) as { createAsyncCommandBus: Factory };

    // Equivalence first: values, errors, and the missing-handler modes.
    for (const onMissing of ['error', 'ignore', 'throw'] as const) {
      const a = createAsyncCommandBus({ onMissing });
      const b = base.createAsyncCommandBus({ onMissing });
      a.register('t', async (c) => c.target);
      b.register('t', async (c) => c.target);
      a.register('bad', async () => { throw new Error('boom'); });
      b.register('bad', async () => { throw new Error('boom'); });
      for (const action of ['t', 'bad', 'missing']) {
        const settle = (p: Promise<any>) => p.then((r) => ({ ok: r.ok, value: r.value, msg: r.error?.message }), (e: Error) => ({ threw: e.message }));
        expect(await settle(a.dispatch(action, 1))).toEqual(await settle(b.dispatch(action, 1)));
        expect(await settle(a.query(action, 1))).toEqual(await settle(b.query(action, 1)));
      }
    }

    const N = 2_000;
    const rows: string[] = [];
    for (const mode of ['dispatch', 'query'] as const) {
      await opsPerSec(base.createAsyncCommandBus, mode, N, 3);
      await opsPerSec(createAsyncCommandBus, mode, N, 3);
      const A: number[] = [];
      const B: number[] = [];
      for (let rep = 0; rep < 7; rep++) {
        if (rep % 2 === 0) { A.push(await opsPerSec(base.createAsyncCommandBus, mode, N, 10)); B.push(await opsPerSec(createAsyncCommandBus, mode, N, 10)); }
        else { B.push(await opsPerSec(createAsyncCommandBus, mode, N, 10)); A.push(await opsPerSec(base.createAsyncCommandBus, mode, N, 10)); }
      }
      const a = median(A);
      const b = median(B);
      rows.push(`   async ${mode.padEnd(9)} async-closure=${Math.round(a)} plain=${Math.round(b)} ratio=${(b / a).toFixed(3)}x saved=${(1e9 / (a * N) - 1e9 / (b * N)).toFixed(1)}ns/cmd`);
      expect(Number.isFinite(b / a)).toBe(true);
    }
    console.log(`\n  async execute closure - real path, median of 7 interleaved reps, ${N} commands/op\n${rows.join('\n')}\n`);
  }, 120_000);
});

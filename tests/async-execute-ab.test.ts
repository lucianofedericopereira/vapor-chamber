/**
 * A/B on the real path: the async bus's `execute` as a plain arrow returning the handler's promise, against an `async` closure.
 * Why: an async function returning a promise it already holds adds its own promise and two microtask turns per command.
 * Shows: both arms answer the same (values, errors, every onMissing mode, dispatch and query); timing prints a table, asserts no threshold.
 * See: log s27, log 36.F46, tests/wildcard-prefix-ab.test.ts, tests/async-missing-rejects.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { runTiming } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'async-execute');
const BASELINE = resolve(REF_DIR, 'command-bus-async-execute-baseline.ts');

// The baseline is src/command-bus.ts with these swaps: the async closure back, the retry's no-step half untouched.
const REVERTS: Array<[string, string]> = [
  [
    `  if (list === null && execute === undefined) {
    if (retry !== null) retry.begin(cmd);
    return work(s, rec, cmd, dispatching);
  }
`,
    '',
  ],
  [
    `  const call = execute ?? ((): CommandResult | Promise<CommandResult> => work(s, rec, cmd, dispatching));`,
    `  const call = execute ?? (async (): Promise<CommandResult> => {
    const transport = rec.transport;
    if (transport !== undefined) return send(transport, cmd, () => runLocal(s, rec, cmd, dispatching), s);
    const handler = rec.handler;
    if (!handler) return handleMissing(s, cmd, dispatching);
    return tryCatchAsyncHandler(handler, cmd);
  });`,
  ],
  [
    `  return retry === null || rec.steps !== null ? result : retry.end(result, cmd, s, rec, dispatching);`,
    `  return result;`,
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
  src = src.replace(/from '\.\/([\w-]+)'/g, "from '../../../src/$1'");
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
  it('matches the baseline exactly, and measures the difference', async () => {
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

    // Timing runs on `npm run test:timing` only, never instrumented (tests/under-coverage.ts).
    if (!runTiming) return;

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
  });
});

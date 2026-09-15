/**
 * Real-path A/B for the request() / dispose() work, in the house three-arm
 * shape (tests/plugin-throw-ab.test.ts): a baseline DERIVED from the shipped
 * src/command-bus.ts with the change reverted, a byte-identical second copy
 * of that baseline as the self-control, and the shipped source - every timed
 * arm a derived copy, loaded the same way.
 *
 * WHAT IS REVERTED for the baseline: both request() functions go back to
 * their v1.19 text (a timer armed first on every sync request; the async one
 * racing an abort promise only for a caller signal), the `waiting: null`
 * field leaves both state literals, and the two dispose() lines that run the
 * pending cancels go. So the CONTROL dispatch rows also read what the field
 * itself costs a bus that never waits. abortedResult's optional parameter
 * stays in every arm: a parameter's type is not runtime.
 *
 * WHAT IS MEASURED: request() throughput on both buses. Shipped, a sync
 * request whose responder answers at once takes no timer; one that waits
 * takes its timer plus one Set add and delete; an async request takes the
 * Set add and delete and one closure inside the timeout promise it already
 * had. Two dispatch rows are the controls, since dispatch is not touched.
 *
 * READ EVERY ROW AGAINST ITS SELF-CONTROL ROW. NO TIMING THRESHOLD IS
 * ASSERTED; the printed table is the evidence. Asserted: the arms agree on
 * every settled result and on the sync command's shape, and differ where
 * intended (dispose() settles a waiting request, and a sync request honours
 * its caller's signal, on the shipped arm only). Numbers quoted anywhere come
 * from three runs of:
 *
 *   NODE_ENV=production NODE_OPTIONS=--expose-gc npx vitest run tests/request-dispose-ab.test.ts --silent=false
 *
 * Ratios are TIME ratios: above 1.00 is slower than the denominator arm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type * as ShippedMod from '../src/command-bus';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'request-dispose');

const OLD_SYNC_REQUEST = `function syncRequest(s: SyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const responder = s.responders.get(action);
  if (!responder) return Promise.resolve(syncDispatch(s, action, target, payload));

  return new Promise((resolve) => {
    const timeoutId = setTimeout(
      () => resolve(requestTimeoutResult(action, timeout)),
      timeout
    );

    const cmd: Command = { action, target, payload, meta: stampMeta(payload) };
    const execute = (): CommandResult => {
      try { return okResult(responder(cmd)); }
      catch (e) { return errResult(e as Error); }
    };

    const pluginResult = s.runner(cmd, execute);

    syncRunHooks(s, cmd, pluginResult);

    if (!pluginResult.ok) { clearTimeout(timeoutId); resolve(pluginResult); return; }

    const maybeAsync = pluginResult.value;
    if (maybeAsync && typeof maybeAsync.then === 'function') {
      maybeAsync
        .then((v: any) => { clearTimeout(timeoutId); resolve(okResult(v)); })
        .catch((e: Error) => { clearTimeout(timeoutId); resolve(errResult(e)); });
    } else {
      clearTimeout(timeoutId);
      resolve(pluginResult);
    }
  });
}

`;

const OLD_ASYNC_REQUEST = `async function asyncRequest(s: AsyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const timeout = reqOpts.timeout ?? 5000;
  const signal = reqOpts.signal;
  const responder = s.responders.get(action);

  if (signal?.aborted) return abortedResult(action, signal);

  const dedupKey = commandKey(action, target);

  const inflight = s.pendingRequests.get(dedupKey);
  if (inflight) return inflight;

  const executeOverride = responder ? async (): Promise<CommandResult> => {
    try { return okResult(await responder({ action, target, payload, meta: stampMeta(payload), signal } as Command)); }
    catch (e) { return errResult(e as Error); }
  } : undefined;

  const dispatchPromise = asyncDispatch(s, action, target, payload, executeOverride, signal);

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<CommandResult>((resolve) => {
    timeoutId = setTimeout(
      () => resolve(requestTimeoutResult(action, timeout)),
      timeout
    );
  });

  let abortHandler: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<CommandResult>((resolve) => {
        abortHandler = () => resolve(abortedResult(action, signal));
        signal.addEventListener('abort', abortHandler);
      })
    : null;

  const competitors: Promise<CommandResult>[] = [
    dispatchPromise.then((r) => { clearTimeout(timeoutId!); return r; }),
    timeoutPromise,
  ];
  if (abortPromise) competitors.push(abortPromise);

  const racePromise = Promise.race(competitors).finally(() => {
    s.pendingRequests.delete(dedupKey);
    if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    clearTimeout(timeoutId!);
  });

  s.pendingRequests.set(dedupKey, racePromise);
  return racePromise;
}

`;

/** Lines the baseline drops, each with the number of times it must occur in the shipped source. */
const REVERTS: Array<[string, number]> = [
  ['    waiting: null,\n', 2],
  ['  if (s.waiting) for (const cancel of s.waiting) cancel();\n', 2],
];

/** Replace the span from `start` up to (not including) `end`; throws if either marker is missing. */
function replaceSpan(src: string, start: string, end: string, replacement: string): string {
  const a = src.indexOf(start);
  const b = a < 0 ? -1 : src.indexOf(end, a);
  if (a < 0 || b < 0) {
    throw new Error(`request-dispose-ab: marker "${a < 0 ? start : end}" not found - update the transforms, otherwise this A/B silently measures the same code twice.`);
  }
  return src.slice(0, a) + replacement + src.slice(b);
}

function derive(revert: boolean): string {
  let src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  if (revert) {
    src = replaceSpan(src, 'function syncRequest(', 'function syncRespond(', OLD_SYNC_REQUEST);
    src = replaceSpan(src, 'async function asyncRequest(', 'function asyncRespond(', OLD_ASYNC_REQUEST);
    for (const [line, n] of REVERTS) {
      const parts = src.split(line);
      if (parts.length - 1 !== n) {
        throw new Error(`request-dispose-ab: expected ${n} x ${JSON.stringify(line)}, found ${parts.length - 1} - update REVERTS, otherwise this A/B silently measures the same code twice.`);
      }
      src = parts.join('');
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

function dispatchNs(m: Mod, n: number): number {
  const bus = m.createCommandBus();
  bus.register('t', (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

async function asyncDispatchNs(m: Mod, n: number): Promise<number> {
  const bus = m.createAsyncCommandBus();
  bus.register('t', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

async function syncRequestNs(m: Mod, n: number, asyncResponder: boolean): Promise<number> {
  const bus = m.createCommandBus();
  bus.respond('q', asyncResponder ? (c) => Promise.resolve(c.target) : (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.request('q', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

async function asyncRequestNs(m: Mod, n: number): Promise<number> {
  const bus = m.createAsyncCommandBus();
  bus.respond('q', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.request('q', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

const ROWS: Array<[string, (m: Mod) => number | Promise<number>]> = [
  ['CONTROL sync dispatch', (m) => dispatchNs(m, 200_000)],
  ['CONTROL async dispatch', (m) => asyncDispatchNs(m, 40_000)],
  ['sync request, sync responder', (m) => syncRequestNs(m, 40_000, false)],
  ['sync request, async responder', (m) => syncRequestNs(m, 20_000, true)],
  ['async request', (m) => asyncRequestNs(m, 20_000)],
];
const ROUNDS = 11;

describe('request() / dispose() - real path A/B', () => {
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('agrees on every settled result and the sync command shape, differs where intended, and measures request()', async () => {
    mkdirSync(REF_DIR, { recursive: true });
    const arms: Record<string, Mod> = {};
    const load = async (name: string, revert: boolean) => {
      const file = resolve(REF_DIR, `request-dispose-${name}.ts`);
      writeFileSync(file, derive(revert));
      arms[name] = await import(/* @vite-ignore */ file);
    };
    await load('pre', true);
    await load('self', true);
    await load('shipped', false);

    // --- equivalence: every settled result, and the sync command's shape -------
    const shape = (r: any) => ({ ok: r.ok, value: r.value, code: r.error?.code, msg: r.error?.message });
    const settled = async (m: Mod) => {
      const out: unknown[] = [];
      const s = m.createCommandBus();
      s.respond('now', (c) => c.target);
      s.respond('later', (c) => Promise.resolve(c.target));
      s.respond('fails', () => { throw new Error('nope'); });
      s.respond('rejects', () => Promise.reject(new Error('nope')));
      s.respond('slow', () => new Promise((r) => setTimeout(() => r('late'), 50)));
      for (const a of ['now', 'later', 'fails', 'rejects', 'missing']) out.push(shape(await s.request(a, 1)));
      out.push(shape(await s.request('slow', 1, undefined, { timeout: 5 })));
      // A live caller signal changes nothing on either arm, and the sync command
      // has the same four fields with or without one: one shape, both arms.
      const live = new AbortController();
      let keys: string[] = [];
      s.respond('keys', (c) => { keys = Object.keys(c); return c.target; });
      out.push(shape(await s.request('later', 2, undefined, { signal: live.signal })));
      out.push(shape(await s.request('keys', 3, undefined, { signal: live.signal })), keys);
      out.push(shape(await s.request('keys', 4)), keys);
      const as = m.createAsyncCommandBus();
      as.respond('now', async (c) => c.target);
      as.respond('fails', async () => { throw new Error('nope'); });
      as.respond('slow', () => new Promise((r) => setTimeout(() => r('late'), 50)));
      for (const a of ['now', 'fails']) out.push(shape(await as.request(a, 1)));
      out.push(shape(await as.request('slow', 1, undefined, { timeout: 5 })));
      out.push(shape(await as.request('now', 2, undefined, { signal: live.signal })));
      return out;
    };
    const shipped = await settled(arms.shipped);
    expect(shipped).toEqual(await settled(arms.pre));
    expect(shipped.filter((v) => Array.isArray(v))).toEqual([['action', 'target', 'payload', 'meta'], ['action', 'target', 'payload', 'meta']]);

    // --- intended difference 1: dispose() settles a waiting request -----------
    for (const [m, expected] of [[arms.pre, undefined], [arms.shipped, 'VC_CORE_ABORTED']] as const) {
      for (const make of [() => m.createCommandBus(), () => m.createAsyncCommandBus()]) {
        const bus: any = make();
        bus.respond('q', () => new Promise(() => {}));
        let result: any;
        bus.request('q', 1, undefined, { timeout: 30 }).then((r: any) => { result = r; });
        bus.dispose();
        await new Promise((r) => setTimeout(r, 0));
        expect(result?.error?.code).toBe(expected);
        await new Promise((r) => setTimeout(r, 40)); // let the baseline's timer run out
      }
    }

    // --- intended difference 2: the sync request honours its caller's signal ---
    for (const [m, expectedCode, expectedCalls] of [[arms.pre, undefined, 1], [arms.shipped, 'VC_CORE_ABORTED', 0]] as const) {
      const bus = m.createCommandBus();
      let calls = 0;
      bus.respond('q', () => { calls++; return 'answered'; });
      const gone = new AbortController();
      gone.abort();
      const r: any = await bus.request('q', 1, undefined, { signal: gone.signal });
      expect(r.error?.code).toBe(expectedCode);
      expect(calls).toBe(expectedCalls);
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
    console.log(`\n  request() / dispose() - real path, ${ROUNDS} rotated rounds, gc=${!!gc}, NODE_ENV=${process.env.NODE_ENV}; time ratios, >1 slower\n${lines.join('\n')}\n`);
  }, 600_000);
});

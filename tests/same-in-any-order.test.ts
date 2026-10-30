/**
 * Pairs of built-in plugins (and rules) installed in both orders on an async bus.
 * Why: if an outcome depended on the order of bus.use calls, a logged refusal, a refusal versus a cached answer, or an aborted in-flight command would change with install order.
 * Shows: for six pairs, each order gives the one outcome the plugins exist to give; each pair but the metrics one has a control showing one order gives it, and the metrics pair's control is that metrics counts a command a rule lets through.
 * See: log s36.43, s36.99, s36.105, s36.107
 */
import { existsSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type AsyncCommandBus, type CommandResult, type PluginParts, createAsyncCommandBus } from '../src/command-bus';
import { authGuard, logger, validator } from '../src/plugins-core';
import { cache, metrics, rateLimit, supersede } from '../src/plugins-extra';
import { schemaLogger, schemaValidator } from '../src/schema';

const schema = { save: { target: { id: 'number' } } } as never;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Runs `start`, then `ms` of timers, on fake time: a debounce window cannot slip under load. */
async function onFakeTime<T>(start: () => T, ms: number): Promise<T> {
  vi.useFakeTimers();
  try {
    const out = start();
    await vi.advanceTimersByTimeAsync(ms);
    return out;
  } finally {
    vi.useRealTimers();
  }
}
const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);

/** One bus with local handlers that count their work and keep the last target. */
type Ctx = { bus: AsyncCommandBus; work: () => number; last: () => unknown; undone: () => number };
function ctx(): Ctx {
  let work = 0;
  let last: unknown;
  let undone = 0;
  const bus = createAsyncCommandBus({ retry: false });
  for (const action of ['save', 'load', 'search']) {
    bus.register(action, async (cmd) => {
      work++;
      await tick(5);
      if (cmd.signal?.aborted) throw cmd.signal.reason;
      last = cmd.target;
      lastPayload = (cmd.payload as { q?: number } | undefined)?.q;
      return 'ok';
    }, { undo: () => { undone++; } });
  }
  return { bus, work: () => work, last: () => last, undone: () => undone };
}

type Make = (bus: AsyncCommandBus) => PluginParts;
type Pair = { name: string; a: Make; b: Make; expected: unknown; run: (c: Ctx) => Promise<unknown>; fixed?: true; pinned?: true };

/** Builds the pair's plugins fresh for each order, installs them, runs the scenario. */
async function inOrder(p: Pair, first: Make, second: Make): Promise<unknown> {
  const c = ctx();
  c.bus.use(first(c.bus));
  c.bus.use(second(c.bus));
  return p.run(c);
}

// State a pair's plugins share with its scenario, reset per order.
let lastPayload: number | undefined;
let auth = true;
let counted: ReturnType<typeof metrics>;

const PAIRS: Pair[] = [
  { name: 'logger with validator: the refusal is logged', expected: 1, fixed: true,
    a: () => logger(), b: () => validator({ save: () => 'bad' }),
    run: async (c) => {
      const spy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
      await c.bus.dispatch('save', { id: 1 });
      return spy.mock.calls.filter((x) => String(x[0]).includes('save')).length;
    } },
  { name: 'schemaLogger with schemaValidator: the refusal is logged', expected: 1, fixed: true,
    a: () => schemaLogger(schema), b: () => schemaValidator(schema),
    run: async (c) => {
      const spy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
      await c.bus.dispatch('save', { id: 'x' });
      return spy.mock.calls.filter((x) => String(x[0]).includes('save')).length;
    } },
  { name: 'authGuard with cache: a signed-out caller is refused, not served the cached answer', expected: 'authGuard:unauthenticated:action', fixed: true,
    a: () => authGuard({ isAuthenticated: () => auth, protected: ['load'] }), b: () => cache(),
    run: async (c) => {
      auth = true;
      await c.bus.dispatch('load', { id: 1 });
      auth = false;
      return code(await c.bus.dispatch('load', { id: 1 }));
    } },
  { name: 'rateLimit with supersede: a refused command does not abort the one in flight', expected: 'ok', fixed: true,
    a: () => rateLimit({ max: 1, window: 1000 }), b: () => supersede(),
    run: async (c) => {
      const first = c.bus.dispatch('search', { q: 1 });
      void c.bus.dispatch('search', { q: 1 });
      return code(await first);
    } },
  { name: 'authGuard with validator: a signed-out caller hears the refusal, not the rule', expected: 'authGuard:unauthenticated:action', fixed: true,
    a: () => authGuard({ isAuthenticated: () => false, protected: ['save'] }), b: () => validator({ save: () => 'bad' }),
    run: async (c) => code(await c.bus.dispatch('save', { id: 1 })) },
  { name: 'metrics with validator: the refusal is counted', expected: 1, pinned: true, fixed: true,
    a: () => (counted = metrics()), b: () => validator({ save: () => 'bad' }),
    run: async (c) => {
      await c.bus.dispatch('save', { id: 1 });
      return counted.entries().length;
    } },
];

afterEach(() => { vi.restoreAllMocks(); });

const report: Array<{ pair: string; expected: unknown; observed: Record<string, unknown> }> = [];
afterAll(() => {
  // A local report only: .probes is not in a clean checkout.
  if (existsSync(new URL('../.probes/', import.meta.url))) writeFileSync(new URL('../.probes/same-in-any-order.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
});

async function bothOrders(p: Pair): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};
  for (const [label, first, second] of [['A then B', p.a, p.b], ['B then A', p.b, p.a]] as const) {
    observed[label] = await inOrder(p, first, second);
    vi.restoreAllMocks();
  }
  return observed;
}

describe('two built-in plugins give the same outcome in either install order', () => {
  for (const p of PAIRS) {
    // Control: the scenario works, so install order is the only variable. A pinned pair has its own control below.
    if (!p.pinned) {
      it(`${p.name} (control: one order gives it)`, async () => {
        const observed = await bothOrders(p);
        report.push({ pair: p.name, expected: p.expected, observed });
        expect(Object.values(observed)).toContainEqual(p.expected);
      });
    }
    // A pair not marked `fixed` runs as `it.fails`, which passes while one order differs.
    (p.fixed ? it : it.fails)(p.name, async () => {
      expect(await bothOrders(p)).toEqual({ 'A then B': p.expected, 'B then A': p.expected });
    });
  }
  // The pinned pair's control: metrics counts a command that passes.
  it('metrics counts a command a rule lets through (control)', async () => {
    const c = ctx();
    const m = metrics();
    c.bus.use(m);
    c.bus.use(validator({ save: () => null }));
    await c.bus.dispatch('save', { id: 1 });
    expect(m.entries().length).toBe(1);
  });
});
